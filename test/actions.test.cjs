const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
class EventEmitter {
  listeners = new Set();
  event = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}
class FileSystemError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const uri = (fsPath, scheme = "file") => ({
  fsPath,
  toString: () => `${scheme}:${fsPath}`,
});
let files, calls, dialog;
const vscode = {
  EventEmitter,
  FileSystemError,
  TreeItem: class {
    constructor(label) {
      this.label = label;
    }
  },
  TreeItemCollapsibleState: { Expanded: 2, None: 0 },
  ThemeIcon: class {},
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: {
    parse: (value) => uri(value, "metric"),
    joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)),
  },
  window: { showWarningMessage: async (...args) => dialog(...args) },
  workspace: {
    fs: {
      stat: async (value) => {
        const bytes = files.get(value.toString());
        if (bytes === undefined) throw new FileSystemError("FileNotFound");
        return { type: typeof bytes === "number" ? bytes : 1 };
      },
      readFile: async (value) => {
        const bytes = files.get(value.toString());
        if (bytes === undefined) throw new FileSystemError("FileNotFound");
        return Buffer.from(bytes);
      },
      writeFile: async (value, bytes) => {
        calls.push(["write", value.fsPath]);
        files.set(value.toString(), bytes);
      },
      delete: async (value, options) => {
        calls.push(["delete", value.fsPath, options]);
        files.delete(value.toString());
      },
      createDirectory: async () => {},
    },
  },
};
const originalLoad = Module._load;
Module._load = function (name, ...rest) {
  return name === "vscode" ? vscode : originalLoad.call(this, name, ...rest);
};
const { ImageActions } = require("../out/actions");
const { ImageChangesTree, ImageTreeItem } = require("../out/sidebar");
const { ImageStatistics } = require("../out/statistics");
Module._load = originalLoad;
const { collectChanges } = require("../out/changes");
const { Status } = require("../out/git-api");

function setup(t, entries = {}) {
  files = new Map();
  calls = [];
  dialog = async () => undefined;
  const root = "/repo";
  const entry = (name, status = Status.MODIFIED, old) => ({
    uri: uri(`${root}/${name}`),
    originalUri: uri(`${root}/${old ?? name}`),
    status,
  });
  const stateChanged = new EventEmitter();
  const repo = {
    rootUri: uri(root),
    state: {
      HEAD: { commit: "abc" },
      indexChanges: [],
      workingTreeChanges: [entry("folder/FullHd[dark].png")],
      mergeChanges: [],
      onDidChange: stateChanged.event,
      ...entries,
    },
    status: async () => {},
    add: async (paths) => calls.push(["add", paths]),
    revert: async (paths) => calls.push(["revert", paths]),
  };
  const api = {
    // Actual VS Code returns fresh repository wrappers.
    get repositories() {
      return [{ ...repo }];
    },
    onDidOpenRepository: new EventEmitter().event,
    onDidCloseRepository: new EventEmitter().event,
    toGitUri: (value) => uri(value.fsPath, "git"),
  };
  let hidden = false;
  const ignores = {
    refresh: async () => {},
    changes: (r) => (hidden ? [] : collectChanges(r)),
    onDidChange: new EventEmitter().event,
  };
  const tree = new ImageChangesTree(api, ignores);
  t.after(() => tree.dispose());
  const folder = () => tree.getChildren()[0].children[0];
  files.set("file:/repo/folder/FullHd[dark].png", Buffer.from("working"));
  files.set("git:/repo/folder/FullHd[dark].png", Buffer.from("index"));
  return {
    repo,
    stateChanged,
    api,
    ignores,
    tree,
    folder,
    ready: async () => {
      const node = folder();
      await tree.prepare(node);
      return node;
    },
    entry,
    hide: () => {
      hidden = true;
    },
    actions: new ImageActions(api, ignores, tree),
  };
}

test("folder stage uses explicit literal image paths and scoped menus match real nodes", async (t) => {
  const f = setup(t);
  await f.actions.run("stage", await f.ready());
  assert.deepEqual(calls, [
    ["add", ["/repo/:(literal)folder/FullHd[dark].png"]],
  ]);
  const menus =
    require("../package.json").contributes.menus["view/item/context"];
  for (const menu of menus.filter((menu) =>
    /\.(stage|unstage|discard)$/.test(menu.command),
  )) {
    const pattern = new RegExp(menu.when.split(" =~ /")[1].slice(0, -1));
    const staged = menu.command.endsWith("unstage");
    for (const kind of ["image", "folder", "group"]) {
      assert.equal(pattern.test(`ff_git_image.${kind}.working`), !staged);
      assert.equal(pattern.test(`ff_git_image.${kind}.staged`), staged);
      assert.equal(pattern.test(`ff_git_image.${kind}.conflict`), false);
    }
  }
});

test("missing, hidden, stale, empty, and wrong-scope selections never invoke Git", async (t) => {
  const f = setup(t);
  const selected = await f.ready();
  await assert.rejects(f.actions.run("stage", undefined), /Right-click/);
  await assert.rejects(
    f.actions.run("stage", new ImageTreeItem("Empty", [])),
    /only available/,
  );
  await assert.rejects(f.actions.run("unstage", selected), /Staged Changes/);
  f.hide();
  await assert.rejects(f.actions.run("stage", selected), /no longer current/);
  assert.deepEqual(calls, []);
});

test("discard always asks with exact paths; cancellation preserves all bytes", async (t) => {
  const f = setup(t);
  dialog = async (message, options, button) => {
    assert.match(message, /1 image\?/);
    assert.equal(options.modal, true);
    assert.match(options.detail, /repo: folder\/FullHd\[dark\]\.png/);
    assert.match(options.detail, /Staged changes are preserved/);
    assert.equal(button, "Discard Changes");
    return undefined;
  };
  await f.actions.run("discard", await f.ready());
  assert.deepEqual(calls, []);
  assert.equal(
    files.get("file:/repo/folder/FullHd[dark].png").toString(),
    "working",
  );
});

test("changed index or ignore rules during confirmation cancel before any writes", async (t) => {
  for (const change of ["index", "ignore"]) {
    const f = setup(t);
    const actions = new ImageActions(f.api, f.ignores, f.tree, async () => {
      if (change === "index")
        files.set(
          "git:/repo/folder/FullHd[dark].png",
          Buffer.from("new index"),
        );
      else f.hide();
      return true;
    });
    await assert.rejects(
      actions.run("discard", await f.ready()),
      /changed while confirming|no longer current/,
    );
    assert.deepEqual(calls, []);
  }
});

test("accepting the real confirmation restores index bytes; LFS pointers are not written over images", async (t) => {
  const f = setup(t);
  dialog = async () => "Discard Changes";
  await f.actions.run("discard", await f.ready());
  assert.equal(
    files.get("file:/repo/folder/FullHd[dark].png").toString(),
    "index",
  );
  calls.length = 0;
  files.set(
    "git:/repo/folder/FullHd[dark].png",
    Buffer.from(
      "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n",
    ),
  );
  await assert.rejects(f.actions.run("discard", await f.ready()), /Git LFS/);
  assert.deepEqual(calls, []);
  assert.equal(
    files.get("file:/repo/folder/FullHd[dark].png").toString(),
    "index",
  );
});

test("directories and symlinks replacing an image cannot be staged or overwritten", async (t) => {
  const f = setup(t);
  const selected = await f.ready();
  for (const type of [2, 65]) {
    files.set("file:/repo/folder/FullHd[dark].png", type);
    await assert.rejects(
      f.actions.run("stage", selected),
      /directory or symbolic link/,
    );
    await assert.rejects(
      f.actions.run("discard", selected),
      /directory or symbolic link/,
    );
  }
  assert.deepEqual(calls, []);
});

test("unstaging a copy leaves its independently staged source untouched", async (t) => {
  const f = setup(t);
  files.set("git:/repo/outside/source.png", Buffer.from("source"));
  files.set("git:/repo/folder/copy.png", Buffer.from("copy"));
  f.repo.state.workingTreeChanges = [];
  f.repo.state.indexChanges = [
    f.entry("folder/copy.png", Status.INDEX_COPIED, "outside/source.png"),
  ];
  await f.tree.refresh();
  await f.actions.run("unstage", await f.ready());
  assert.deepEqual(calls, [["revert", ["/repo/:(literal)folder/copy.png"]]]);
});

test("actions queue while confirmation is pending and continue after cancellation", async (t) => {
  const f = setup(t);
  let release, ready;
  const pending = new Promise((resolve) => {
    ready = resolve;
  });
  const actions = new ImageActions(
    f.api,
    f.ignores,
    f.tree,
    () =>
      new Promise((resolve) => {
        release = resolve;
        ready();
      }),
  );
  const discard = actions.run("discard", await f.ready());
  await pending;
  const progress = [];
  const stage = actions.run("stage", await f.ready(), (message) =>
    progress.push(message),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, []);
  assert.ok(progress.some((message) => message.startsWith("Queued")));
  release(false);
  assert.equal(await discard, 0);
  assert.equal(await stage, 1);
  assert.deepEqual(calls, [
    ["add", ["/repo/:(literal)folder/FullHd[dark].png"]],
  ]);
});

test("stage refuses new bytes at the same path and Git status, including an older displayed revision", async (t) => {
  const f = setup(t);
  const selected = await f.ready();
  const viewedRevision = selected.children[0].change.revision;
  files.set("file:/repo/folder/FullHd[dark].png", Buffer.from("changed"));
  await assert.rejects(
    f.actions.run("stage", selected),
    /changed since it was selected or viewed/,
  );
  assert.deepEqual(calls, []);
  // Post-command decorations now refresh in the background, outside the write queue.
  await f.tree.refresh([selected.children[0]]);
  const refreshed = await f.ready();
  assert.notEqual(refreshed.children[0].change.revision, viewedRevision);
  const actions = new ImageActions(
    f.api,
    f.ignores,
    f.tree,
    undefined,
    () => viewedRevision,
  );
  await assert.rejects(
    actions.run("stage", refreshed),
    /changed since it was selected or viewed/,
  );
  assert.deepEqual(calls, []);
});

test("unstage refuses an index changed after selection", async (t) => {
  const f = setup(t);
  f.repo.state.indexChanges = [
    f.entry("folder/FullHd[dark].png", Status.INDEX_MODIFIED),
  ];
  f.repo.state.workingTreeChanges = [];
  await f.tree.refresh();
  const selected = await f.ready();
  files.set("git:/repo/folder/FullHd[dark].png", Buffer.from("new index"));
  await assert.rejects(
    f.actions.run("unstage", selected),
    /changed since it was selected or viewed/,
  );
  assert.deepEqual(calls, []);
});

test("multi-selection deduplicates overlapping folders and files and reports completion", async (t) => {
  const f = setup(t);
  const selected = await f.ready();
  const progress = [];
  assert.equal(
    await f.actions.run("stage", [selected, selected.children[0]], (message) =>
      progress.push(message),
    ),
    1,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].length, 1);
  assert.ok(progress.includes("Processed 1/1 images"));
});

test("tree statistics aggregate pixel counts and invalidate when the image revision changes", async (t) => {
  const f = setup(t);
  const statistics = new ImageStatistics();
  t.after(() => statistics.dispose());
  f.repo.state.workingTreeChanges.push(f.entry("folder/other.png"));
  files.set("file:/repo/folder/other.png", Buffer.from("different"));
  files.set("git:/repo/folder/other.png", Buffer.from("before"));
  const tree = new ImageChangesTree(f.api, f.ignores, statistics);
  t.after(() => tree.dispose());
  const selected = tree.getChildren()[0].children[0];
  await tree.prepare(selected);
  statistics.set(selected.children[0].change.revision, {
    changed: 1,
    total: 10,
  });
  statistics.set(selected.children[1].change.revision, {
    changed: 45,
    total: 90,
  });
  tree.getTreeItem(selected);
  assert.equal(selected.description, "2");
  assert.match(
    tree.provideFileDecoration(selected.resourceUri).tooltip,
    /46.00%/,
  );
  files.set("file:/repo/folder/other.png", Buffer.from("later"));
  await tree.refresh();
  const refreshed = tree.getChildren()[0].children[0];
  await tree.prepare(refreshed);
  tree.getTreeItem(refreshed);
  assert.equal(refreshed.description, "2");
  assert.match(
    tree.provideFileDecoration(refreshed.resourceUri).tooltip,
    /10.00%.*1\/2/,
  );
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("slow initial reads survive repeated status events and never hide Git actions", async (t) => {
  const f = setup(t);
  for (let i = 0; i < 31; i++) {
    const name = `folder/screen${i}.png`;
    f.repo.state.workingTreeChanges.push(f.entry(name));
    files.set(`file:/repo/${name}`, Buffer.from(`after${i}`));
    files.set(`git:/repo/${name}`, Buffer.from(`before${i}`));
  }
  const roots = f.tree.getChildren();
  const selected = f.folder();
  const originalRead = vscode.workspace.fs.readFile;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let reads = 0;
  vscode.workspace.fs.readFile = async (value) => {
    reads++;
    await gate;
    return originalRead(value);
  };
  t.after(() => {
    release();
    vscode.workspace.fs.readFile = originalRead;
  });
  const events = [];
  f.tree.onDidChangeTreeData((item) => events.push(item));
  f.tree.getTreeItem(selected);
  for (let i = 0; i < 3; i++) {
    f.stateChanged.fire();
    await pause(180);
    assert.equal(f.tree.getChildren(), roots);
    assert.equal(f.folder(), selected);
    assert.equal(
      f.tree.getTreeItem(selected).contextValue,
      "ff_git_image.folder.working",
    );
    assert.ok(
      !events.includes(undefined),
      "No root refresh while the same image list is loading",
    );
  }
  assert.equal(
    reads,
    2,
    "An in-flight read must not be repeatedly restarted or duplicated",
  );
  release();
  await f.tree.prepare(selected);
  assert.equal(reads, 64);
  assert.ok(selected.children.every((node) => node.change.revision));
});

test("diff results update decorations without any tree refresh and batch only affected ancestors", async (t) => {
  const f = setup(t);
  f.repo.state.workingTreeChanges.push(f.entry("other/unaffected.png"));
  files.set("file:/repo/other/unaffected.png", Buffer.from("other"));
  files.set("git:/repo/other/unaffected.png", Buffer.from("old"));
  const statistics = new ImageStatistics();
  const tree = new ImageChangesTree(f.api, f.ignores, statistics);
  t.after(() => {
    tree.dispose();
    statistics.dispose();
  });
  const group = tree.getChildren()[0];
  await tree.prepare(group);
  const target = group.children[0].children[0];
  const unaffected = group.children[1].children[0];
  await pause(300);
  const events = [];
  tree.onDidChangeTreeData((item) => events.push(item));
  const decorations = [];
  tree.onDidChangeFileDecorations((uris) => decorations.push(uris));
  statistics.set(target.change.revision, { changed: 1, total: 10 });
  statistics.set(target.change.revision, { changed: 2, total: 10 });
  statistics.set(target.change.revision, { changed: 3, total: 10 });
  await pause(300);
  assert.deepEqual(
    events,
    [],
    "Percent changes must not refresh even a single tree node",
  );
  assert.equal(decorations.length, 1);
  assert.ok(decorations[0].includes(target.resourceUri));
  assert.ok(decorations[0].includes(group.resourceUri));
  assert.ok(!decorations[0].includes(unaffected.resourceUri));
  assert.equal(
    tree.provideFileDecoration(target.resourceUri).tooltip,
    "30.00% changed pixels",
  );
  assert.equal(tree.getChildren()[0], group);
  events.length = 0;
  statistics.set(target.change.revision, { changed: 3, total: 10 });
  f.stateChanged.fire();
  await pause(450);
  assert.deepEqual(events, []);
  const previousRevision = target.change.revision;
  files.set("file:/repo/folder/FullHd[dark].png", Buffer.from("changed"));
  f.stateChanged.fire();
  await pause(500);
  assert.equal(tree.getChildren()[0], group);
  assert.notEqual(target.change.revision, previousRevision);
  assert.equal(tree.provideFileDecoration(target.resourceUri).badge, "…");
  assert.deepEqual(events, []);
});

test("stage waits for initial revision loading inside the operation and reports progress", async (t) => {
  const f = setup(t);
  const node = f.folder();
  const originalRead = vscode.workspace.fs.readFile;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  vscode.workspace.fs.readFile = async (value) => {
    await gate;
    return originalRead(value);
  };
  t.after(() => {
    release();
    vscode.workspace.fs.readFile = originalRead;
  });
  f.tree.getTreeItem(node);
  const progress = [];
  const operation = f.actions.run("stage", node, (message) =>
    progress.push(message),
  );
  await pause(20);
  assert.deepEqual(calls, []);
  assert.ok(progress.some((message) => message.startsWith("Reading ")));
  assert.equal(node.contextValue, "ff_git_image.folder.working");
  release();
  assert.equal(await operation, 1);
  assert.deepEqual(calls, [
    ["add", ["/repo/:(literal)folder/FullHd[dark].png"]],
  ]);
});

test("a single-file action does not wait for revision checks on unrelated images", async (t) => {
  const f = setup(t);
  f.repo.state.workingTreeChanges.push(f.entry("other/unaffected.png"));
  files.set("file:/repo/other/unaffected.png", Buffer.from("other"));
  files.set("git:/repo/other/unaffected.png", Buffer.from("old"));
  await f.tree.prepare(f.tree.getChildren()[0]);
  const node = f.folder().children[0];
  const originalRead = vscode.workspace.fs.readFile;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  vscode.workspace.fs.readFile = async (value) => {
    if (value.fsPath.includes("unaffected")) await gate;
    return originalRead(value);
  };
  let timeout;
  try {
    assert.equal(
      await Promise.race([
        f.actions.run("stage", node),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Action waited for an unrelated image")),
            1000,
          );
        }),
      ]),
      1,
    );
  } finally {
    clearTimeout(timeout);
    release();
    vscode.workspace.fs.readFile = originalRead;
  }
});

function addImage(f, name) {
  f.repo.state.workingTreeChanges.push(f.entry(name));
  files.set(`file:/repo/${name}`, Buffer.from(`working:${name}`));
  files.set(`git:/repo/${name}`, Buffer.from(`index:${name}`));
}
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("rapid commands run FIFO with one active mutation and a visible waiting count", async (t) => {
  const f = setup(t);
  addImage(f, "second.png");
  addImage(f, "third.png");
  await f.tree.prepare(f.tree.getChildren()[0]);
  const first = f.folder().children[0];
  const second = f.tree.findFile(uri("/repo/second.png"), "working");
  const third = f.tree.findFile(uri("/repo/third.png"), "working");
  const entered = deferred(),
    release = deferred();
  let active = 0,
    peak = 0;
  f.repo.add = async (paths) => {
    peak = Math.max(peak, ++active);
    calls.push(["add", paths]);
    if (paths[0].includes("FullHd")) {
      entered.resolve();
      await release.promise;
    }
    active--;
  };
  const task1 = f.actions.enqueue("stage", first);
  await entered.promise;
  const task2 = f.actions.enqueue("stage", second);
  const task3 = f.actions.enqueue("stage", third);
  assert.match(f.actions.queue.message, /2 waiting/);
  assert.match(task2.message, /Queued · 1 ahead/);
  assert.match(task3.message, /Queued · 2 ahead/);
  assert.equal(calls.length, 1);
  release.resolve();
  assert.deepEqual(
    await Promise.all([task1.result, task2.result, task3.result]),
    [1, 1, 1],
  );
  await f.actions.queue.whenIdle();
  assert.equal(peak, 1);
  assert.deepEqual(
    calls.map((call) => call[1][0]),
    [
      "/repo/:(literal)folder/FullHd[dark].png",
      "/repo/:(literal)second.png",
      "/repo/:(literal)third.png",
    ],
  );
  assert.equal(f.actions.queue.idle, true);
});

test("identical outstanding commands join one mutation, including initial revision loading", async (t) => {
  const f = setup(t);
  const node = f.folder();
  const entered = deferred(),
    release = deferred();
  f.repo.add = async (paths) => {
    calls.push(["add", paths]);
    entered.resolve();
    await release.promise;
  };
  const first = f.actions.enqueue("stage", node);
  const duplicateWhileLoading = f.actions.enqueue("stage", node);
  assert.equal(duplicateWhileLoading, first);
  await entered.promise;
  const duplicateAfterLoading = f.actions.enqueue("stage", [
    node.children[0],
    node,
  ]);
  assert.equal(duplicateAfterLoading, first);
  assert.equal(calls.length, 1);
  release.resolve();
  assert.equal(await first.result, 1);
  await f.actions.queue.whenIdle();
  // Deduplication lasts only while the command is outstanding.
  assert.notEqual(f.actions.enqueue("stage", node), first);
  await f.actions.queue.whenIdle();
  assert.equal(calls.length, 2);
});

test("a failed action releases the queue and retries do not reuse the failed task", async (t) => {
  const f = setup(t);
  addImage(f, "second.png");
  await f.tree.prepare(f.tree.getChildren()[0]);
  const first = f.folder().children[0];
  const second = f.tree.findFile(uri("/repo/second.png"), "working");
  const entered = deferred(),
    release = deferred();
  let fail = true;
  f.repo.add = async (paths) => {
    calls.push(["add", paths]);
    if (fail && paths[0].includes("FullHd")) {
      entered.resolve();
      await release.promise;
      throw new Error("Fixture Git failure");
    }
  };
  const failed = f.actions.enqueue("stage", first);
  const failure = assert.rejects(failed.result, /Fixture Git failure/);
  await entered.promise;
  const next = f.actions.enqueue("stage", second);
  release.resolve();
  await failure;
  assert.equal(await next.result, 1);
  fail = false;
  const retry = f.actions.enqueue("stage", first);
  assert.notEqual(retry, failed);
  assert.equal(await retry.result, 1);
  assert.equal(calls.length, 3);
});

test("queued selections keep clicked revisions and paths; stale work does not block later jobs", async (t) => {
  const f = setup(t);
  addImage(f, "second.png");
  addImage(f, "third.png");
  await f.tree.prepare(f.tree.getChildren()[0]);
  const first = f.folder().children[0];
  const second = f.tree.findFile(uri("/repo/second.png"), "working");
  const third = f.tree.findFile(uri("/repo/third.png"), "working");
  const entered = deferred(),
    release = deferred();
  f.repo.add = async (paths) => {
    calls.push(["add", paths]);
    if (paths[0].includes("FullHd")) {
      entered.resolve();
      await release.promise;
    }
  };
  const task1 = f.actions.enqueue("stage", first);
  await entered.promise;
  const task2 = f.actions.enqueue("stage", second);
  const failure = assert.rejects(
    task2.result,
    /changed since it was selected or viewed/,
  );
  const task3 = f.actions.enqueue("stage", third);
  files.set("file:/repo/second.png", Buffer.from("changed while queued"));
  await f.tree.refresh([second]);
  // The live tree now has the new hash; the queued selection must keep the old one.
  release.resolve();
  assert.equal(await task1.result, 1);
  await failure;
  assert.equal(await task3.result, 1);
  assert.deepEqual(
    calls.map((call) => call[1][0]),
    ["/repo/:(literal)folder/FullHd[dark].png", "/repo/:(literal)third.png"],
  );
});

test("queued folder commands never include files added to the folder after the click", async (t) => {
  const f = setup(t);
  const entered = deferred(),
    release = deferred();
  const actions = new ImageActions(f.api, f.ignores, f.tree, async () => {
    entered.resolve();
    await release.promise;
    return false;
  });
  const selected = await f.ready();
  const first = actions.enqueue("discard", selected);
  await entered.promise;
  const queued = actions.enqueue("stage", selected);
  addImage(f, "folder/arrived-later.png");
  await f.tree.refresh([]);
  release.resolve();
  assert.equal(await first.result, 0);
  assert.equal(await queued.result, 1);
  assert.deepEqual(calls, [
    ["add", ["/repo/:(literal)folder/FullHd[dark].png"]],
  ]);
});

test("bulk stage uses one comparison read per file and bounded change-list scans", async (t) => {
  const f = setup(t);
  for (let i = 1; i < 32; i++) addImage(f, `folder/screen${i}.png`);
  const selected = await f.ready();
  const read = vscode.workspace.fs.readFile,
    changes = f.ignores.changes;
  let reads = 0,
    scans = 0,
    statuses = 0;
  vscode.workspace.fs.readFile = async (uri) => {
    reads++;
    return read(uri);
  };
  f.ignores.changes = (repo) => {
    scans++;
    return changes(repo);
  };
  f.repo.status = async () => {
    statuses++;
  };
  t.after(() => {
    vscode.workspace.fs.readFile = read;
  });
  assert.equal(await f.actions.run("stage", selected), 32);
  assert.equal(
    reads,
    64,
    "Read each index/working pair only once before staging",
  );
  assert.equal(statuses, 2);
  assert.ok(scans <= 6, `Expected bounded scans, got ${scans}`);
  assert.equal(calls.length, 1);
});

test("commands refresh only their selected repositories", async (t) => {
  const f = setup(t);
  const selected = await f.ready();
  const unrelated = {
    ...f.repo,
    rootUri: uri("/unrelated"),
    state: { ...f.repo.state, workingTreeChanges: [] },
    status: async () => {
      throw new Error("Unrelated repository must not be refreshed");
    },
  };
  Object.defineProperty(f.api, "repositories", {
    get: () => [{ ...f.repo }, unrelated],
  });
  f.ignores.refresh = async (repos) =>
    assert.deepEqual(
      repos.map((repo) => repo.rootUri.fsPath),
      ["/repo"],
    );
  assert.equal(await f.actions.run("stage", selected), 1);
});

test("single-image discard reuses its checked bytes without extra image reads", async (t) => {
  const f = setup(t),
    selected = await f.ready();
  const read = vscode.workspace.fs.readFile;
  let reads = 0;
  vscode.workspace.fs.readFile = async (uri) => {
    reads++;
    return read(uri);
  };
  t.after(() => {
    vscode.workspace.fs.readFile = read;
  });
  const actions = new ImageActions(f.api, f.ignores, f.tree, async () => true);
  assert.equal(await actions.run("discard", selected), 1);
  assert.equal(
    reads,
    4,
    "One pair before confirmation and one immediately before the write",
  );
  assert.equal(
    files.get("file:/repo/folder/FullHd[dark].png").toString(),
    "index",
  );
});

test("an action promotes its initial read ahead of queued background images", async (t) => {
  const f = setup(t);
  for (const name of ["middle.png", "selected.png", "unrelated.png"])
    addImage(f, name);
  const root = f.tree.getChildren()[0];
  const all = root.children.flatMap((node) => node.children ?? [node]);
  const selected = all.find((node) => node.change.path === "selected.png");
  const read = vscode.workspace.fs.readFile;
  const entered = deferred(),
    release = deferred();
  const order = [];
  vscode.workspace.fs.readFile = async (value) => {
    order.push(value.fsPath);
    if (value.fsPath.includes("FullHd")) {
      entered.resolve();
      await release.promise;
    }
    return read(value);
  };
  t.after(() => {
    release.resolve();
    vscode.workspace.fs.readFile = read;
  });
  all.forEach((node) => f.tree.getTreeItem(node));
  await entered.promise;
  f.repo.add = async () => order.push("STAGE");
  const action = f.actions.run("stage", selected);
  release.resolve();
  assert.equal(await action, 1);
  assert.ok(order.indexOf("/repo/selected.png") < order.indexOf("STAGE"));
  const unrelated = order.findIndex((name) => name === "/repo/middle.png");
  assert.ok(
    unrelated < 0 || order.indexOf("STAGE") < unrelated,
    order.join(", "),
  );
});

test("cross-repository preflight still rejects a stale file before any repository is staged", async (t) => {
  const f = setup(t);
  const other = {
    ...f.repo,
    rootUri: uri("/other"),
    state: {
      ...f.repo.state,
      workingTreeChanges: [
        {
          uri: uri("/other/changed.png"),
          originalUri: uri("/other/changed.png"),
          status: Status.MODIFIED,
        },
      ],
    },
  };
  Object.defineProperty(f.api, "repositories", {
    get: () => [{ ...f.repo }, other],
  });
  files.set("file:/other/changed.png", Buffer.from("working-other"));
  files.set("git:/other/changed.png", Buffer.from("index-other"));
  const roots = f.tree.getChildren();
  await Promise.all(roots.map((node) => f.tree.prepare(node)));
  files.set("file:/other/changed.png", Buffer.from("changed after selection"));
  await assert.rejects(
    f.actions.run("stage", roots),
    /changed since it was selected or viewed/,
  );
  assert.deepEqual(calls, []);
});

test("a deleted image recreated while confirming is not overwritten", async (t) => {
  const f = setup(t);
  f.repo.state.workingTreeChanges[0].status = Status.DELETED;
  files.delete("file:/repo/folder/FullHd[dark].png");
  const selected = await f.ready();
  const actions = new ImageActions(f.api, f.ignores, f.tree, async () => {
    files.set(
      "file:/repo/folder/FullHd[dark].png",
      Buffer.from("recreated while confirming"),
    );
    return true;
  });
  await assert.rejects(
    actions.run("discard", selected),
    /changed since it was selected or viewed/,
  );
  assert.deepEqual(calls, []);
  assert.equal(
    files.get("file:/repo/folder/FullHd[dark].png").toString(),
    "recreated while confirming",
  );
});

test("a deleted image recreated without an updated status cannot be staged as the old selection", async (t) => {
  const f = setup(t);
  f.repo.state.workingTreeChanges[0].status = Status.DELETED;
  files.delete("file:/repo/folder/FullHd[dark].png");
  const selected = await f.ready();
  files.set(
    "file:/repo/folder/FullHd[dark].png",
    Buffer.from("recreated after selection"),
  );
  await assert.rejects(
    f.actions.run("stage", selected),
    /changed since it was selected or viewed/,
  );
  assert.deepEqual(calls, []);
});
