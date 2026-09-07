const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { Status } = require("../out/git-api");
class Emitter {
  listeners = new Set();
  event = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire = (value) => this.listeners.forEach((listener) => listener(value));
  dispose = () => this.listeners.clear();
}
class FileSystemError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const uri = (path) => ({ fsPath: path, toString: () => `file://${path}` });
const files = new Map();
const watchers = new Map();
const warnings = [];
const originalLoad = Module._load;
Module._load = function (name, ...rest) {
  return name === "vscode"
    ? {
        EventEmitter: Emitter,
        FileSystemError,
        Uri: { joinPath: (root, file) => uri(`${root.fsPath}/${file}`) },
        RelativePattern: class {
          constructor(baseUri, pattern) {
            this.baseUri = baseUri;
            this.pattern = pattern;
          }
        },
        TreeItem: class {
          constructor(label, collapsibleState) {
            this.label = label;
            this.collapsibleState = collapsibleState;
          }
        },
        TreeItemCollapsibleState: { None: 0, Expanded: 2 },
        ThemeIcon: class {
          constructor(id) {
            this.id = id;
          }
        },
        window: { showWarningMessage: (message) => warnings.push(message) },
        workspace: {
          fs: {
            readFile: async (uri) => {
              if (!files.has(uri.fsPath))
                throw new FileSystemError("FileNotFound");
              const value = await files.get(uri.fsPath);
              if (value instanceof Error) throw value;
              return Buffer.from(value);
            },
          },
          createFileSystemWatcher: (pattern) => {
            const created = new Emitter(),
              changed = new Emitter(),
              deleted = new Emitter();
            const watcher = {
              created,
              changed,
              deleted,
              onDidCreate: created.event,
              onDidChange: changed.event,
              onDidDelete: deleted.event,
              dispose: () => {
                created.dispose();
                changed.dispose();
                deleted.dispose();
              },
            };
            watchers.set(
              typeof pattern === "string"
                ? pattern
                : `${pattern.baseUri.fsPath}/${pattern.pattern}`,
              watcher,
            );
            return watcher;
          },
        },
      }
    : originalLoad.call(this, name, ...rest);
};
const { ImageIgnore } = require("../out/image-ignore");
const { ImageChangesTree, imageQuickPicks } = require("../out/sidebar");
Module._load = originalLoad;
const entry = (root, path, status = Status.MODIFIED, previous) => ({
  uri: uri(`${root}/${path}`),
  originalUri: uri(`${root}/${previous ?? path}`),
  renameUri: previous ? uri(`${root}/${path}`) : undefined,
  status,
});
const repo = (root, paths = []) => ({
  rootUri: uri(root),
  status: async () => {},
  state: {
    HEAD: { commit: "head" },
    indexChanges: [],
    workingTreeChanges: paths.map((path) => entry(root, path)),
    mergeChanges: [],
    onDidChange: new Emitter().event,
  },
});
const setup = (t, ...repositories) => {
  files.clear();
  watchers.clear();
  warnings.length = 0;
  const opened = new Emitter(),
    closed = new Emitter();
  const api = {
    repositories,
    onDidOpenRepository: opened.event,
    onDidCloseRepository: closed.event,
  };
  const ignores = new ImageIgnore(api);
  t.after(() => ignores.dispose());
  return { api, ignores, opened, closed };
};
const paths = (ignores, repo) =>
  ignores.changes(repo).map((change) => change.path);
const flush = () => new Promise(setImmediate);

test("root ignore file supports Git patterns, comments, exceptions, anchors, and CRLF", async (t) => {
  const repository = repo("/repo", [
    "src/dark/ru/screen@2x.png",
    "screen@2x.png",
    "src/generated/screen.png",
    "cover.png",
    "nested/cover.png",
    "sample.tmp.png",
    "keep.tmp.png",
    "#hash.png",
    "!literal.png",
    "shots/界面.png",
    "SCREEN@2X.PNG",
    "normal.png",
  ]);
  const { ignores } = setup(t, repository);
  files.set(
    "/repo/.image_ignore",
    "\uFEFF# ignored images\r\n\r\n**/*@2x.png\r\nsrc/**/generated/\r\n/cover.png\r\n*.tmp.png\r\n!keep.tmp.png\r\n\\#hash.png\r\n\\!literal.png\r\nshots/界面.png\r\n",
  );
  await ignores.refresh();
  assert.deepEqual(
    paths(ignores, repository).sort(),
    ["SCREEN@2X.PNG", "keep.tmp.png", "nested/cover.png", "normal.png"].sort(),
  );
  files.set(
    "/repo/.image_ignore",
    "src/generated/\n!src/generated/screen.png\n",
  );
  await ignores.refresh();
  assert.ok(
    !paths(ignores, repository).includes("src/generated/screen.png"),
    "Excluded parent directories must be re-included before their children",
  );
});

test("all staging scopes are filtered per repository using the rename destination", async (t) => {
  const first = repo("/one"),
    second = repo("/two", ["hidden.png"]);
  first.state.indexChanges = [
    entry("/one", "hidden.png", Status.INDEX_MODIFIED),
    entry("/one", "visible.png", Status.INDEX_RENAMED, "hidden.png"),
  ];
  first.state.workingTreeChanges = [
    entry("/one", "hidden.png"),
    entry("/one", "deleted.png", Status.DELETED),
  ];
  first.state.mergeChanges = [
    entry("/one", "conflict.png", Status.BOTH_MODIFIED),
  ];
  const { ignores } = setup(t, first, second);
  files.set("/one/.image_ignore", "hidden.png\ndeleted.png\nconflict.png\n");
  await ignores.refresh();
  assert.deepEqual(paths(ignores, first), ["visible.png"]);
  assert.deepEqual(
    paths(ignores, { ...first, rootUri: uri("/one") }),
    ["visible.png"],
    "Git API wrapper identity must not affect repository rules",
  );
  assert.deepEqual(paths(ignores, second), ["hidden.png"]);
});

test("creating, saving, and removing rules updates tree counts and search without changing Git status", async (t) => {
  const repository = repo("/repo", [
    "dark/en/screen.png",
    "dark/ru/screen.png",
  ]);
  const { api, ignores } = setup(t, repository);
  await ignores.refresh();
  const sidebar = new ImageChangesTree(api, ignores);
  t.after(() => sidebar.dispose());
  sidebar.getChildren();
  let changes = 0;
  ignores.onDidChange(() => changes++);
  const watcher = watchers.get("/repo/.image_ignore");
  files.set("/repo/.image_ignore", "dark/en/\n");
  watcher.created.fire();
  await flush();
  assert.equal(sidebar.count, 1);
  assert.equal(sidebar.getChildren()[0].description, "1");
  assert.deepEqual(
    imageQuickPicks(api, ignores).map((item) => item.description),
    ["dark/ru/screen.png"],
  );
  assert.equal(sidebar.findFile(uri("/repo/dark/en/screen.png")), undefined);
  watcher.changed.fire();
  await flush();
  assert.equal(
    changes,
    1,
    "Saving identical rules must not cause another refresh",
  );
  files.set("/repo/.image_ignore", "*.png\n");
  watcher.changed.fire();
  await flush();
  assert.equal(sidebar.count, 0);
  assert.deepEqual(sidebar.getChildren(), []);
  files.delete("/repo/.image_ignore");
  watcher.deleted.fire();
  await flush();
  assert.equal(sidebar.count, 2);
  assert.equal(repository.state.workingTreeChanges.length, 2);
});

test("stale reads cannot replace newer rules or resurrect a closed repository", async (t) => {
  const repository = repo("/repo", ["old.png", "new.png"]);
  const { ignores, closed } = setup(t, repository);
  let finish;
  files.set(
    "/repo/.image_ignore",
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = ignores.refresh();
  files.set("/repo/.image_ignore", "new.png\n");
  await ignores.refresh();
  finish("old.png\n");
  await pending;
  assert.deepEqual(paths(ignores, repository), ["old.png"]);
  files.set(
    "/repo/.image_ignore",
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const closing = ignores.refresh();
  closed.fire(repository);
  finish("*.png");
  await closing;
  assert.equal(paths(ignores, repository).length, 2);
});

test("new repositories load their own rules and unreadable files preserve the previous rules", async (t) => {
  const { ignores, opened } = setup(t);
  const repository = repo("/new", ["hidden.png", "visible.png"]);
  files.set("/new/.image_ignore", "hidden.png\n");
  opened.fire(repository);
  await flush();
  assert.deepEqual(paths(ignores, repository), ["visible.png"]);
  files.set("/new/.image_ignore", new FileSystemError("NoPermissions"));
  await ignores.refresh();
  await ignores.refresh();
  assert.deepEqual(paths(ignores, repository), ["visible.png"]);
  assert.equal(warnings.length, 1);
  files.set("/new/.image_ignore", "");
  await ignores.refresh();
  assert.equal(paths(ignores, repository).length, 2);
});
