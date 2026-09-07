import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function releaseMetadata(manifest, lock, changelog, tag) {
  const version = manifest.version;
  assert.equal(manifest.name, "ff-git-image", "Unexpected extension name");
  assert.equal(manifest.publisher, "gornivv", "Unexpected publisher");
  assert.match(
    version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    "Use a stable major.minor.patch version",
  );
  assert.equal(lock.version, version, "package-lock.json version differs");
  assert.equal(
    lock.packages?.[""]?.version,
    version,
    "Lockfile root version differs",
  );
  if (tag !== undefined)
    assert.equal(
      tag,
      `v${version}`,
      "Tag must match package.json version exactly",
    );

  const sections = changelog.replaceAll("\r\n", "\n").split(/^## /m).slice(1);
  const current = sections.find(
    (section) => !/^\[?Unreleased\]?\n/i.test(section),
  );
  assert(current, "CHANGELOG.md has no release entry");
  const [heading, ...lines] = current.split("\n");
  assert.equal(
    heading.trim(),
    version,
    "First changelog release must match package.json",
  );
  const changes = lines.join("\n").trim();
  assert(changes.length > 0, "Release notes must not be empty");
  const filename = `${manifest.name}-${version}.vsix`;
  return {
    version,
    filename,
    notes: `${changes}\n\n## Install\n\nDownload \`${filename}\` from the assets below. In VS Code, use **Extensions → … → Install from VSIX…** and reload the window if prompted.\n\n\`SHA256SUMS\` contains the package checksum.\n`,
  };
}

async function main() {
  const json = async (file) => JSON.parse(await readFile(file, "utf8"));
  const [manifest, lock, changelog] = await Promise.all([
    json("package.json"),
    json("package-lock.json"),
    readFile("CHANGELOG.md", "utf8"),
  ]);
  const tag =
    process.env.GITHUB_REF_TYPE === "tag"
      ? process.env.GITHUB_REF_NAME
      : undefined;
  if (process.env.GITHUB_REF_TYPE === "tag") assert(tag, "Missing release tag");
  const metadata = releaseMetadata(manifest, lock, changelog, tag);
  await mkdir("dist", { recursive: true });
  await writeFile("dist/release-notes.md", metadata.notes);
  const output = `version=${metadata.version}\nfilename=${metadata.filename}\n`;
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
