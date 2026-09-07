// Measures the real VS Code Git filesystem/API on disposable fixture images.
// No pixel rendering or repository background sweeps are included in these timings.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");
const vscode = require("vscode");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noopEvent = () => ({ dispose() {} });

function png(seed) {
  const size = 256;
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 1; x <= size * 4; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels[y * (size * 4 + 1) + x] = seed & 255;
    }
  const chunk = (name, bytes) => {
    const data = Buffer.concat([Buffer.from(name), bytes]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(bytes.length + 12);
    result.writeUInt32BE(bytes.length);
    data.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

exports.png = png;

exports.run = async () => {
  const gitExtension = await vscode.extensions
    .getExtension("vscode.git")
    .activate();
  const realAPI = gitExtension.getAPI(1);
  for (let i = 0; i < 100 && !realAPI.repositories.length; i++)
    await pause(100);
  const realRepo = realAPI.repositories[0];
  assert.ok(realRepo);
  const root = realRepo.rootUri.fsPath;
  const git = (...args) => execFileSync("git", args, { cwd: root });
  const names = Array.from(
    { length: 16 },
    (_, i) => `performance/screen${i}.png`,
  );
  const before = png(123),
    after = png(456);
  fs.mkdirSync(path.join(root, "performance"));
  for (const name of names) fs.writeFileSync(path.join(root, name), before);
  git("add", "--", "performance");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--only",
    "-qm",
    "Performance fixture",
    "--",
    "performance",
  );
  let counts;
  const countedFs = {
    ...vscode.workspace.fs,
    stat: async (uri) => {
      if (counts && uri.fsPath.endsWith(".png")) counts.stats++;
      return vscode.workspace.fs.stat(uri);
    },
    readFile: async (uri) => {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (counts && uri.fsPath.endsWith(".png")) {
        counts[uri.scheme === "git" ? "gitReads" : "workingReads"]++;
        counts.bytes += bytes.length;
      }
      return bytes;
    },
  };
  const shim = new Proxy(vscode, {
    get(target, key) {
      return key === "workspace"
        ? new Proxy(vscode.workspace, {
            get(workspace, property) {
              return property === "fs"
                ? countedFs
                : Reflect.get(workspace, property);
            },
          })
        : Reflect.get(target, key);
    },
  });
  const originalLoad = Module._load;
  Module._load = function (name, ...rest) {
    return name === "vscode" ? shim : originalLoad.call(this, name, ...rest);
  };
  const baseline =
    process.env.FF_GIT_IMAGE_BASELINE ??
    path.resolve(__dirname, "../.baseline");
  const versions = [
    ...(fs.existsSync(path.join(baseline, "out/actions.js"))
      ? [["baseline", baseline]]
      : []),
    ["current", path.resolve(__dirname, "..")],
  ]
    .filter(
      ([name]) =>
        !process.env.FF_GIT_IMAGE_BENCH_VERSIONS ||
        name === process.env.FF_GIT_IMAGE_BENCH_VERSIONS,
    )
    .map(([name, directory]) => ({
      name,
      ...require(path.join(directory, "out/actions")),
      ...require(path.join(directory, "out/sidebar")),
      ...require(path.join(directory, "out/changes")),
    }));
  Module._load = originalLoad;
  const repo = {
    rootUri: realRepo.rootUri,
    get state() {
      return {
        HEAD: realRepo.state.HEAD,
        indexChanges: realRepo.state.indexChanges,
        workingTreeChanges: realRepo.state.workingTreeChanges,
        untrackedChanges: realRepo.state.untrackedChanges,
        mergeChanges: realRepo.state.mergeChanges,
        onDidChange: noopEvent,
      };
    },
    status: async () => {
      if (counts) counts.status++;
      await realRepo.status();
    },
    add: async (paths) => {
      if (counts) counts.mutations++;
      await realRepo.add(paths);
    },
    revert: async (paths) => {
      if (counts) counts.mutations++;
      await realRepo.revert(paths);
    },
  };
  const api = {
    repositories: [repo],
    toGitUri: (uri, ref) => realAPI.toGitUri(uri, ref),
    onDidOpenRepository: noopEvent,
    onDidCloseRepository: noopEvent,
  };
  const results = [];
  const rounds = Number(process.env.FF_GIT_IMAGE_BENCH_ROUNDS ?? 3);
  for (let round = 0; round < rounds; round++)
    for (const action of ["stage", "unstage", "discard"])
      for (const version of versions) {
        git("reset", "-q", "HEAD", "--", "performance");
        for (const name of names)
          fs.writeFileSync(path.join(root, name), after);
        if (action === "unstage") git("add", "--", "performance");
        await realRepo.status();
        const ignores = {
          onDidChange: noopEvent,
          refresh: async () => {},
          changes: (repository) => {
            if (counts) counts.changeLists++;
            return version
              .collectChanges(repository)
              .filter((change) => change.path.startsWith("performance/"))
              .map((change) => ({ ...change, ignored: false }));
          },
        };
        const tree = new version.ImageChangesTree(api, ignores);
        const selected = tree
          .getChildren()
          .find((item) =>
            item.contextValue.endsWith(
              action === "unstage" ? ".staged" : ".working",
            ),
          );
        await tree.prepare(selected);
        counts = {
          status: 0,
          mutations: 0,
          gitReads: 0,
          workingReads: 0,
          stats: 0,
          bytes: 0,
          changeLists: 0,
        };
        const start = performance.now();
        assert.equal(
          await new version.ImageActions(
            api,
            ignores,
            tree,
            async () => true,
          ).run(action, selected),
          names.length,
        );
        const result = {
          version: version.name,
          action,
          round,
          milliseconds: +(performance.now() - start).toFixed(1),
          ...counts,
        };
        counts = undefined;
        tree.dispose();
        results.push(result);
        console.log("BENCH " + JSON.stringify(result));
        const staged = git(
          "diff",
          "--cached",
          "--name-only",
          "--",
          "performance",
        )
          .toString()
          .trim()
          .split("\n")
          .filter(Boolean);
        assert.equal(staged.length, action === "stage" ? names.length : 0);
        if (action === "discard")
          for (const name of names)
            assert.deepEqual(fs.readFileSync(path.join(root, name)), before);
      }
  const directory = path.resolve(__dirname, "../.test-host");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "performance.json"),
    JSON.stringify(
      {
        images: names.length,
        imageBytes: before.length,
        vscode: vscode.version,
        results,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(process.env.FF_GIT_IMAGE_TEST_RESULT, "passed");
};
