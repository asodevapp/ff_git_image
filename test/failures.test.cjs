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
  fire = (value) => this.listeners.forEach((listener) => listener(value));
  dispose() {
    this.listeners.clear();
  }
}
class Uri {
  scheme = "file";
  authority = "";
  constructor(fsPath) {
    this.fsPath = path.resolve(fsPath);
  }
  toString() {
    return "file://" + this.fsPath;
  }
  static joinPath(root, ...parts) {
    return new Uri(path.join(root.fsPath, ...parts));
  }
  static parse(value) {
    return new Uri(value.replace(/^file:\/\//, ""));
  }
}
class FileSystemError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
let entries, calls, updates, removeError;
const fs = {
  stat: async (uri) => {
    const item = entries.get(uri.fsPath);
    calls.push(["stat", uri.fsPath]);
    if (!item) throw new FileSystemError("FileNotFound");
    return { ...item, size: item.bytes?.length ?? 0 };
  },
  readDirectory: async (uri) => {
    calls.push(["directory", uri.fsPath]);
    return [...entries]
      .filter(
        ([name]) => name !== uri.fsPath && path.dirname(name) === uri.fsPath,
      )
      .map(([name, item]) => [path.basename(name), item.type]);
  },
  readFile: async (uri) => {
    calls.push(["read", uri.fsPath]);
    return Buffer.from(entries.get(uri.fsPath).bytes);
  },
  delete: async (uri, options) => {
    calls.push(["delete", uri.fsPath, options]);
    if (removeError) throw removeError;
    entries.delete(uri.fsPath);
  },
};
const vscode = {
  EventEmitter,
  Uri,
  FileSystemError,
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  workspace: {
    fs,
    createFileSystemWatcher: () => ({
      onDidCreate: updates.event,
      onDidChange: updates.event,
      onDidDelete: updates.event,
      dispose() {},
    }),
  },
};
const load = Module._load;
Module._load = function (name, ...args) {
  return name === "vscode" ? vscode : load.call(this, name, ...args);
};
const {
  FailureArtifacts,
  artifactLabel,
  isFailurePath,
} = require("../out/failures");
const { ImageActionQueue } = require("../out/action-queue");
Module._load = load;

function put(name, bytes = "png", type = 1) {
  if (!entries.has(path.dirname(name)) && name !== "/")
    put(path.dirname(name), undefined, 2);
  entries.set(name, {
    type,
    bytes: type === 1 ? Buffer.from(bytes) : undefined,
    mtime: 1,
    ctime: 1,
  });
}
function setup(t, roots = ["/repo"]) {
  entries = new Map();
  calls = [];
  updates = new EventEmitter();
  removeError = undefined;
  roots.forEach((root) => put(root, undefined, 2));
  const api = {
    repositories: roots.map((root) => ({ rootUri: new Uri(root) })),
    onDidOpenRepository: new EventEmitter().event,
    onDidCloseRepository: new EventEmitter().event,
  };
  const artifacts = new FailureArtifacts(api);
  t.after(() => artifacts.dispose());
  return { artifacts, api };
}

test("scan finds ignored failure images as separate cached rows, skips symlinks and dependency folders", async (t) => {
  const { artifacts, api } = setup(t);
  for (const suffix of [
    "masterImage",
    "testImage",
    "isolatedDiff",
    "maskedDiff",
  ])
    put(`/repo/test/editor/failures/iPhone5S[dark]_${suffix}.png`);
  put("/repo/test/editor/failures/sub/custom.webp");
  put("/repo/test/editor/failures/notes.txt");
  put("/repo/test/not-failures/image.png");
  put("/repo/.gitignore", "**/failures/");
  put("/repo/node_modules/test/failures/no.png");
  put("/repo/.git/failures/no.png");
  put("/repo/test/editor/failures/link.png", undefined, 65);
  put("/repo/linked", undefined, 66);
  put("/repo/linked/failures/no.png");
  await artifacts.refresh();
  assert.equal(artifacts.count, 5);
  assert.equal(calls.filter((c) => c[0] === "read").length, 0);
  const rows = artifacts.changes(api.repositories[0]);
  assert.equal(rows.length, 5);
  assert(
    rows.every(
      (row) =>
        row.scope === "failure" && !row.before && row.after.ref === undefined,
    ),
  );
  assert.equal(
    rows.find((row) => row.path.endsWith("_masterImage.png")).after.label,
    "Expected · masterImage",
  );
  assert.equal(new Set(rows.map((row) => row.id)).size, 5);
  await artifacts.refresh();
  assert.equal(
    artifacts.changes(api.repositories[0]),
    rows,
    "Unchanged membership keeps cached rows",
  );
  assert.equal(artifactLabel("a_testImage.PNG"), "Actual · testImage");
  assert.equal(isFailurePath("not-failures/a.png"), false);
});

test("file event bursts rescan just their failure directory, without reading image bytes", async (t) => {
  const { artifacts, api } = setup(t);
  put("/repo/test/failures/a.png");
  put("/repo/other/failures/b.png");
  await artifacts.refresh();
  const rows = artifacts.changes(api.repositories[0]);
  calls = [];
  entries.get("/repo/test/failures/a.png").mtime++;
  for (let i = 0; i < 20; i++)
    updates.fire(new Uri("/repo/test/failures/a.png"));
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.deepEqual(
    calls.filter((c) => c[0] === "directory"),
    [["directory", "/repo/test/failures"]],
  );
  assert.equal(calls.filter((c) => c[0] === "read").length, 0);
  assert.equal(artifacts.changes(api.repositories[0]), rows);
});

test("nested and multiple open repositories never duplicate failure files", async (t) => {
  const { artifacts, api } = setup(t, ["/repo", "/repo/nested", "/other"]);
  put("/repo/test/failures/a.png");
  put("/repo/nested/test/failures/b.png");
  put("/other/test/failures/c.png");
  await artifacts.refresh();
  assert.equal(artifacts.count, 3);
  assert.deepEqual(
    api.repositories.map((repo) => artifacts.changes(repo).length),
    [1, 1, 1],
  );
  assert.equal(
    await artifacts.clean(
      artifacts.snapshot,
      () => {},
      async () => true,
    ),
    3,
  );
});

test("cleanup uses exact captured paths and Trash; preserves later files, notes, baselines and index", async (t) => {
  const { artifacts } = setup(t);
  put("/repo/test/failures/FullHd[dark]_testImage.png");
  put("/repo/test/failures/notes.txt");
  put("/repo/test/golden/FullHd[dark].png");
  put("/repo/.git/index", "index");
  await artifacts.refresh();
  const files = artifacts.snapshot;
  const progress = [];
  const count = await artifacts.clean(
    files,
    (message) => progress.push(message),
    async () => {
      put("/repo/test/failures/new_testImage.png");
      return true;
    },
  );
  assert.equal(count, 1);
  assert.deepEqual(
    calls.filter((c) => c[0] === "delete"),
    [["delete", files[0].uri.fsPath, { useTrash: true, recursive: false }]],
  );
  assert(entries.has("/repo/test/failures/new_testImage.png"));
  assert(entries.has("/repo/test/failures/notes.txt"));
  assert(entries.has("/repo/test/golden/FullHd[dark].png"));
  assert.equal(entries.get("/repo/.git/index").bytes.toString(), "index");
  assert(progress.some((message) => message.startsWith("Moving 1/1")));
});

test("cancel and changed image contents abort before deleting any captured file", async (t) => {
  const { artifacts } = setup(t);
  put("/repo/failures/a.png", "old");
  put("/repo/failures/b.png", "old");
  await artifacts.refresh();
  assert.equal(
    await artifacts.clean(
      artifacts.snapshot,
      () => {},
      async () => false,
    ),
    0,
  );
  await assert.rejects(
    artifacts.clean(
      artifacts.snapshot,
      () => {},
      async () => {
        // Same size and metadata: a hash still catches replacement during the dialog.
        entries.get("/repo/failures/b.png").bytes = Buffer.from("new");
        return true;
      },
    ),
    /changed while confirming/,
  );
  assert.equal(calls.filter((c) => c[0] === "delete").length, 0);
});

test("cleanup refuses replaced parents, closed repositories and malformed paths", async (t) => {
  const { artifacts, api } = setup(t);
  put("/repo/failures/a.png");
  await artifacts.refresh();
  const files = artifacts.snapshot;
  await assert.rejects(
    artifacts.clean(
      files,
      () => {},
      async () => {
        entries.get("/repo/failures").type = 66;
        return true;
      },
    ),
    /regular directory/,
  );
  entries.get("/repo/failures").type = 2;
  await assert.rejects(
    artifacts.clean(
      [{ ...files[0], path: "../failures/a.png" }],
      () => {},
      async () => true,
    ),
    /Invalid/,
  );
  await assert.rejects(
    artifacts.clean(
      files,
      () => {},
      async () => {
        api.repositories = [];
        return true;
      },
    ),
    /repository changed or closed/,
  );
  assert.equal(calls.filter((c) => c[0] === "delete").length, 0);
});

test("Trash errors report partial completion without permanent-delete fallback", async (t) => {
  const { artifacts } = setup(t);
  put("/repo/failures/a.png");
  await artifacts.refresh();
  removeError = new Error("Trash unavailable");
  await assert.rejects(
    artifacts.clean(
      artifacts.snapshot,
      () => {},
      async () => true,
    ),
    /Moved 0\/1.*Trash unavailable/,
  );
  assert.equal(calls.filter((c) => c[0] === "delete").length, 1);
  assert(entries.has("/repo/failures/a.png"));
});

test("failure cleanup shares FIFO order and duplicate pending tasks", async (t) => {
  const { artifacts } = setup(t);
  put("/repo/failures/a.png");
  await artifacts.refresh();
  const queue = new ImageActionQueue();
  let release;
  const first = queue.enqueue(
    "stage",
    "Stage",
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const clean = () =>
    artifacts.clean(
      artifacts.snapshot,
      () => {},
      async () => true,
    );
  const second = queue.enqueue("failures", "Cleanup", clean);
  assert.equal(queue.enqueue("failures", "Cleanup", clean), second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((c) => c[0] === "delete").length, 0);
  release(1);
  assert.equal(await first.result, 1);
  assert.equal(await second.result, 1);
});
