const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const Module = require("node:module");
class Emitter {
  listeners = new Set();
  event = (fn) => {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  };
  fire = (value) => {
    for (const fn of this.listeners) fn(value);
  };
  dispose = () => this.listeners.clear();
}
const uri = (fsPath, scheme = "file") => ({
  fsPath,
  toString: () => `${scheme}:${fsPath}`,
});
let files, reads, objectReads;
const vscode = {
  EventEmitter: Emitter,
  TreeItem: class {
    constructor(label) {
      this.label = label;
    }
  },
  TreeItemCollapsibleState: { Expanded: 2, None: 0 },
  ThemeIcon: class {},
  FileType: { SymbolicLink: 64 },
  Uri: { parse: (value) => uri(value, "metric") },
  workspace: {
    fs: {
      stat: async (value) => {
        const f = files.get(value.toString());
        if (!f) throw new Error("Missing");
        return {
          type: f.type ?? 1,
          size: f.data.length,
          mtime: f.time,
          ctime: f.time,
        };
      },
      readFile: async (value) => {
        reads.push(value.toString());
        const f = files.get(value.toString());
        if (!f) throw new Error("Missing");
        return Buffer.from(f.data);
      },
    },
  },
};
const load = Module._load;
Module._load = function (name, ...args) {
  return name === "vscode" ? vscode : load.call(this, name, ...args);
};
const { ImageCache } = require("../out/image-cache");
const { ImageChangesTree } = require("../out/sidebar");
const { ImageStatistics } = require("../out/statistics");
const { imageRevision } = require("../out/images");
Module._load = load;
const { collectChanges } = require("../out/changes");
const { Status } = require("../out/git-api");

async function fixture(t, n = 1, budget) {
  files = new Map();
  reads = [];
  objectReads = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ff-cache-"));
  await fs.mkdir(path.join(root, ".git"));
  const index = path.join(root, ".git", "index");
  await fs.writeFile(index, "index");
  const changed = new Emitter();
  const repo = {
    rootUri: uri(root),
    state: {
      HEAD: { commit: "a".repeat(40) },
      indexChanges: [],
      mergeChanges: [],
      workingTreeChanges: [],
      onDidChange: changed.event,
    },
    status: async () => {},
    getObjectDetails: async (ref, file) => {
      assert.ok(
        file.startsWith(":(literal)"),
        "Git object metadata must use literal paths",
      );
      file = path.join(root, file.slice(10));
      objectReads.push(file);
      const data = files.get(uri(file, "git").toString()).data;
      return {
        mode: "100644",
        object: createHash("sha256").update(data).digest("hex"),
        size: data.length,
      };
    },
  };
  for (let i = 0; i < n; i++) {
    const file = uri(path.join(root, `folder/screen${i}.png`));
    repo.state.workingTreeChanges.push({
      uri: file,
      originalUri: file,
      status: Status.MODIFIED,
    });
    files.set(file.toString(), { data: Buffer.from(`after-${i}`), time: 1 });
    files.set(uri(file.fsPath, "git").toString(), {
      data: Buffer.from(`index-${i}`),
      time: 1,
    });
  }
  const api = {
    repositories: [repo],
    onDidOpenRepository: new Emitter().event,
    onDidCloseRepository: new Emitter().event,
    toGitUri: (file) => uri(file.fsPath, "git"),
  };
  const cache = new ImageCache(api, budget);
  t.after(async () => {
    cache.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    api,
    repo,
    cache,
    index,
    changed,
    changes: () => collectChanges(repo),
  };
}

test("hash, viewer and statistics share source reads; warm comparisons do not reread bytes or Git objects", async (t) => {
  const f = await fixture(t);
  const change = f.changes()[0];
  const [revision, preview, second] = await Promise.all([
    f.cache.revision(change),
    f.cache.comparison(change),
    f.cache.comparison(change),
  ]);
  assert.equal(revision, preview.revision);
  assert.deepEqual(second, preview);
  assert.equal(reads.length, 2);
  assert.equal(objectReads.length, 1);
  for (let i = 0; i < 100; i++) {
    assert.equal(await f.cache.revision(change), revision);
    assert.deepEqual(await f.cache.comparison(change, revision), {
      revision,
      unchanged: true,
    });
  }
  assert.equal(reads.length, 2);
  assert.equal(objectReads.length, 1);
  assert.equal(await imageRevision(f.api, change), revision);
  assert.equal(
    reads.length,
    4,
    "Mutation validation deliberately bypasses all preview caches",
  );
});

test("one modified image rereads only its working side; unrelated index rewrites reuse blob identities", async (t) => {
  const f = await fixture(t, 32);
  const changes = f.changes();
  const before = await Promise.all(
    changes.map((change) => f.cache.revision(change)),
  );
  assert.equal(reads.length, 64);
  reads.length = objectReads.length = 0;
  const file = changes[7].after.uri;
  // An event must invalidate the cache even if size and timestamps are preserved.
  files.set(file.toString(), { data: Buffer.from("changed"), time: 1 });
  f.cache.invalidate(file);
  const after = await Promise.all(
    changes.map((change) => f.cache.revision(change)),
  );
  assert.deepEqual(reads, [file.toString()]);
  assert.equal(objectReads.length, 0);
  assert.notEqual(before[7], after[7]);
  assert.equal(after.filter((value, i) => value !== before[i]).length, 1);
  reads.length = 0;
  await fs.writeFile(f.index, "unrelated staged text file");
  await Promise.all(changes.map((change) => f.cache.revision(change)));
  assert.equal(reads.length, 0);
  assert.equal(objectReads.length, 32);
  const indexFile = uri(changes[3].before.uri.fsPath, "git");
  files.set(indexFile.toString(), { data: Buffer.from("new-index"), time: 1 });
  await fs.writeFile(f.index, "image staged");
  const staged = await f.cache.revision(changes[3]);
  assert.notEqual(staged, before[3]);
  assert.deepEqual(reads, [indexFile.toString()]);
});

test("byte cache is bounded, fingerprint survives eviction and an evicted preview reloads correctly", async (t) => {
  const f = await fixture(t, 4, 16);
  const changes = f.changes();
  const revisions = [];
  for (const change of changes) revisions.push(await f.cache.revision(change));
  assert.ok(f.cache.byteSize <= 16);
  reads.length = 0;
  for (const [i, change] of changes.entries())
    assert.equal(await f.cache.revision(change), revisions[i]);
  assert.equal(
    reads.length,
    0,
    "Eviction of bytes does not evict the small fingerprint cache",
  );
  const preview = await f.cache.comparison(changes[0]);
  assert.equal(preview.revision, revisions[0]);
  assert.equal(
    Buffer.from(preview.after.data.split(",")[1], "base64").toString(),
    "after-0",
  );
  assert.equal(reads.length, 2);
  assert.ok(f.cache.byteSize <= 16);
});

test("warm status storms and changed metrics never refresh native tree nodes or reread image bytes", async (t) => {
  const f = await fixture(t, 32);
  const statistics = new ImageStatistics();
  const tree = new ImageChangesTree(f.api, undefined, statistics);
  t.after(() => {
    tree.dispose();
    statistics.dispose();
  });
  const roots = tree.getChildren();
  await tree.prepare(roots[0]);
  const leaves = tree.leaves();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const refreshes = [],
    decorations = [];
  tree.onDidChangeTreeData((value) => refreshes.push(value));
  tree.onDidChangeFileDecorations((value) => decorations.push(value));
  reads.length = objectReads.length = 0;
  for (let tick = 0; tick < 3; tick++) {
    for (const node of leaves)
      statistics.set(node.change.revision, { changed: tick + 1, total: 100 });
    f.changed.fire();
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  assert.equal(tree.getChildren(), roots);
  assert.deepEqual(tree.leaves(), leaves);
  assert.deepEqual(refreshes, []);
  assert.equal(reads.length, 0);
  assert.equal(objectReads.length, 0);
  assert.equal(decorations.length, 3);
  assert.equal(
    tree.provideFileDecoration(roots[0].resourceUri).tooltip,
    "3.00% changed pixels",
  );
});

test("membership reconciliation retains surviving nodes, revisions, selection handles and scope-specific decorations", async (t) => {
  const f = await fixture(t, 2);
  const statistics = new ImageStatistics();
  const tree = new ImageChangesTree(f.api, undefined, statistics);
  t.after(() => {
    tree.dispose();
    statistics.dispose();
  });
  const roots = tree.getChildren();
  await tree.prepare(roots[0]);
  const survivor = tree.leaves()[0];
  const revision = survivor.change.revision;
  const preparing = survivor.preparing;
  f.repo.state.workingTreeChanges.pop();
  await tree.refresh([]);
  assert.equal(tree.leaves()[0], survivor);
  assert.equal(survivor.change.revision, revision);
  assert.equal(survivor.preparing, preparing);
  assert.equal(tree.getChildren()[0], roots[0]);
  f.repo.state.indexChanges.push({
    ...f.repo.state.workingTreeChanges[0],
    status: Status.INDEX_MODIFIED,
  });
  await tree.refresh([]);
  const staged = tree.leaves().find((node) => node.change.scope === "staged");
  assert.notEqual(
    staged.resourceUri.toString(),
    survivor.resourceUri.toString(),
  );
  assert.equal(tree.findFile(survivor.change.after.uri, "working"), survivor);
});

test("index changes during a read cannot poison the cache for the previous blob", async (t) => {
  const f = await fixture(t);
  const change = f.changes()[0];
  const expected = await imageRevision(f.api, change);
  const originalRead = vscode.workspace.fs.readFile;
  const indexUri = uri(change.before.uri.fsPath, "git");
  let replace = true;
  vscode.workspace.fs.readFile = async (value) => {
    if (replace && value.toString() === indexUri.toString()) {
      replace = false;
      files.set(indexUri.toString(), {
        data: Buffer.from("replaced-during-read"),
        time: 1,
      });
      await fs.writeFile(f.index, "new index while reading");
    }
    return originalRead(value);
  };
  t.after(() => {
    vscode.workspace.fs.readFile = originalRead;
  });
  const edited = await f.cache.revision(change);
  assert.notEqual(edited, expected);
  assert.equal(edited, await imageRevision(f.api, change));
  files.set(indexUri.toString(), { data: Buffer.from("index-0"), time: 1 });
  await fs.writeFile(f.index, "previous blob restored");
  assert.equal(await f.cache.revision(change), expected);
});

test("statistics cache ignores duplicate results and retains recently used revisions", () => {
  const statistics = new ImageStatistics();
  const changes = [];
  statistics.onDidChange((revision) => changes.push(revision));
  statistics.set("favorite", { changed: 1, total: 100 });
  statistics.set("favorite", { changed: 1, total: 100 });
  assert.deepEqual(changes, ["favorite"]);
  for (let i = 0; i < 2100; i++) {
    statistics.get("favorite");
    statistics.set(`image-${i}`, { changed: i, total: 10000 });
  }
  assert.ok(statistics.get("favorite"));
  assert.equal(statistics.get("image-0"), undefined);
  assert.equal(statistics.values.size, 2000);
  statistics.dispose();
});

test("a new HEAD version does not join an in-flight read of the old tree item inputs", async (t) => {
  const f = await fixture(t);
  f.repo.state.indexChanges = f.repo.state.workingTreeChanges.map((change) => ({
    ...change,
    status: Status.INDEX_MODIFIED,
  }));
  f.repo.state.workingTreeChanges = [];
  const tree = new ImageChangesTree(f.api);
  t.after(() => tree.dispose());
  const node = tree.leaves()[0];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const readRefs = [];
  tree.images.revision = async (change) => {
    readRefs.push(change.before.ref);
    if (readRefs.length === 1) await gate;
    return `revision:${change.before.ref}`;
  };
  const first = tree.prepare(node);
  f.repo.state.HEAD.commit = "b".repeat(40);
  await tree.refresh([]);
  assert.equal(tree.leaves()[0], node);
  const next = tree.prepare(node);
  release();
  await Promise.all([first, next]);
  assert.deepEqual(readRefs, ["a".repeat(40), "b".repeat(40)]);
  assert.equal(node.change.revision, `revision:${"b".repeat(40)}`);
});
