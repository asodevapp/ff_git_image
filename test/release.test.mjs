import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { releaseMetadata } from "../scripts/release-metadata.mjs";

const manifest = {
  name: "ff-git-image",
  publisher: "gornivv",
  version: "0.1.14",
};
const lock = { version: "0.1.14", packages: { "": { version: "0.1.14" } } };
const changelog =
  "# Changelog\n\n## Unreleased\n\n- Future work.\n\n## 0.1.14\n\n- Color threshold slider.\n\n## 0.1.13\n\n- Old changes.\n";

test("release notes select only the current version and include VSIX installation", () => {
  const result = releaseMetadata(manifest, lock, changelog, "v0.1.14");
  assert.equal(result.filename, "ff-git-image-0.1.14.vsix");
  assert.match(result.notes, /Color threshold slider/);
  assert.match(result.notes, /Install from VSIX/);
  assert.doesNotMatch(result.notes, /Future work|Old changes/);
});

test("mismatched tags, lockfiles and missing release notes stop the build", () => {
  for (const tag of ["v0.1.13", "0.1.14", "v0.1.14-beta", "v0.1.14\nwrong"])
    assert.throws(
      () => releaseMetadata(manifest, lock, changelog, tag),
      /Tag must match/,
    );
  assert.throws(
    () => releaseMetadata(manifest, { ...lock, version: "0.1.13" }, changelog),
    /package-lock/,
  );
  assert.throws(
    () => releaseMetadata(manifest, { ...lock, packages: {} }, changelog),
    /Lockfile root/,
  );
  assert.throws(
    () => releaseMetadata(manifest, lock, "## 0.1.13\n\n- Old changes."),
    /First changelog/,
  );
  assert.throws(
    () => releaseMetadata(manifest, lock, "## 0.1.14\n\n"),
    /must not be empty/,
  );
  assert.throws(
    () =>
      releaseMetadata({ ...manifest, version: "0.1.14-beta" }, lock, changelog),
    /stable/,
  );
});

// The real publication script talks only to this fake gh executable in tests.
// A separate PATH and dummy token prevent any GitHub writes.
const publishScript = fileURLToPath(
  new URL("../scripts/publish-release.sh", import.meta.url),
);
function publication(t, scenario = "new", corrupt = false) {
  const root = mkdtempSync(path.join(tmpdir(), "ff-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(root, "dist"));
  const filename = "ff-git-image-0.1.14.vsix";
  const bytes = Buffer.from("test package");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(
    path.join(root, "dist", filename),
    corrupt ? "changed package" : bytes,
  );
  writeFileSync(
    path.join(root, "dist/SHA256SUMS"),
    `${checksum}  ${filename}\n`,
  );
  writeFileSync(path.join(root, "dist/release-notes.md"), "Example notes\n");
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(args) + '\\n');
if (args[1] === 'view') {
  if (process.env.MOCK_SCENARIO === 'new') process.exit(1);
  console.log(process.env.MOCK_SCENARIO === 'published' ? 'false' : 'true');
}
if (args[1] === 'upload' && process.env.MOCK_SCENARIO === 'upload-fails') process.exit(1);
`,
    { mode: 0o755 },
  );
  // macOS uses shasum; GitHub's Linux runner has sha256sum.
  if (spawnSync("sha256sum", ["--version"]).error)
    writeFileSync(
      path.join(bin, "sha256sum"),
      '#!/bin/sh\nexec shasum -a 256 "$@"\n',
      { mode: 0o755 },
    );
  const log = path.join(root, "calls.jsonl");
  writeFileSync(log, "");
  const result = spawnSync("bash", [publishScript], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GH_TOKEN: "unused-test-token",
      GH_REPO: "fixture/example",
      RELEASE_TAG: "v0.1.14",
      VSIX: filename,
      MOCK_LOG: log,
      MOCK_SCENARIO: scenario,
    },
  });
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { result, calls };
}

test("publish creates a draft, uploads the checked package, then makes it public", (t) => {
  const { result, calls } = publication(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    calls.map((args) => args[1]),
    ["view", "create", "upload", "edit"],
  );
  assert(calls[1].includes("--verify-tag"));
  assert(calls[1].includes("--draft"));
  assert(calls[2].includes("ff-git-image-0.1.14.vsix"));
  assert(calls[2].includes("SHA256SUMS"));
  assert(calls[3].includes("--draft=false"));
});

test("retry repairs an existing draft without creating another release", (t) => {
  const { result, calls } = publication(t, "draft");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    calls.map((args) => args[1]),
    ["view", "upload", "edit"],
  );
});

test("a failed upload never publishes the draft", (t) => {
  const { result, calls } = publication(t, "upload-fails");
  assert.notEqual(result.status, 0);
  assert.deepEqual(
    calls.map((args) => args[1]),
    ["view", "upload"],
  );
});

test("already published assets are never overwritten", (t) => {
  const { result, calls } = publication(t, "published");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already published/);
  assert.deepEqual(
    calls.map((args) => args[1]),
    ["view"],
  );
});

test("a corrupt package stops before any GitHub request", (t) => {
  const { result, calls } = publication(t, "new", true);
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, []);
});
