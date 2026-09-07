const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { Status } = require("../out/git-api");

class EventEmitter {
  listeners = new Set();
  event = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire = () => this.listeners.forEach((listener) => listener());
  dispose = () => this.listeners.clear();
}
const originalLoad = Module._load;
Module._load = function (name, ...rest) {
  return name === "vscode"
    ? {
        EventEmitter,
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
      }
    : originalLoad.call(this, name, ...rest);
};
const { ImageChangesTree, imageQuickPicks } = require("../out/sidebar");
Module._load = originalLoad;
const uri = (value) => ({ fsPath: value, toString: () => `file://${value}` });
const file = (root, relative, status = Status.MODIFIED, oldPath) => ({
  uri: uri(`${root}/${relative}`),
  originalUri: uri(`${root}/${oldPath ?? relative}`),
  renameUri: oldPath ? uri(`${root}/${relative}`) : undefined,
  status,
});
const repo = (root, entries = {}) => ({
  rootUri: uri(root),
  status: async () => {},
  state: {
    HEAD: { commit: "abc" },
    indexChanges: [],
    workingTreeChanges: [],
    mergeChanges: [],
    onDidChange: new EventEmitter().event,
    ...entries,
  },
});
const api = (...repositories) => ({
  repositories,
  onDidOpenRepository: new EventEmitter().event,
  onDidCloseRepository: new EventEmitter().event,
});
const shape = (nodes) =>
  nodes.map((node) =>
    node.children ? [node.label, shape(node.children)] : node.label,
  );
const walk = (nodes) =>
  nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);

test("duplicate image names are separated by theme and locale in compact folders", (t) => {
  const root = "/repo";
  const paths = ["dark/en", "dark/ru", "light/en", "light/ru"].map(
    (folder) => `src/assets/images/feature/${folder}/measurements.png`,
  );
  const tree = new ImageChangesTree(
    api(repo(root, { workingTreeChanges: paths.map((p) => file(root, p)) })),
  );
  t.after(() => tree.dispose());
  assert.deepEqual(shape(tree.getChildren()), [
    [
      "Changes",
      [
        [
          "src/assets/images/feature",
          [
            [
              "dark",
              [
                ["en", ["measurements.png"]],
                ["ru", ["measurements.png"]],
              ],
            ],
            [
              "light",
              [
                ["en", ["measurements.png"]],
                ["ru", ["measurements.png"]],
              ],
            ],
          ],
        ],
      ],
    ],
  ]);
  const leaves = walk(tree.getChildren()).filter((node) => !node.children);
  assert.equal(new Set(leaves.map((node) => node.id)).size, 4);
  for (const leaf of leaves) {
    assert.equal(leaf.command.arguments[1], "working");
    assert.equal(
      leaf.command.arguments[2],
      true,
      "Sidebar preview must preserve focus for keyboard navigation",
    );
    assert.ok(
      leaf.tooltip.includes(leaf.resourceUri.fsPath.slice(root.length + 1)),
    );
    assert.equal(tree.getParent(leaf).description, "1");
    assert.equal(tree.findFile(leaf.resourceUri, "working"), leaf);
  }
  assert.equal(tree.getChildren()[0].description, "4");
  assert.equal(tree.count, 4);
});

test("root files, natural ordering, additions, deletions, and renamed paths stay navigable", (t) => {
  const root = "/repo";
  const tree = new ImageChangesTree(
    api(
      repo(root, {
        indexChanges: [
          file(root, "new/sub/new # ü.png", Status.INDEX_RENAMED, "old.png"),
        ],
        workingTreeChanges: [
          file(root, "gone.png", Status.DELETED),
          file(root, "new.png", Status.UNTRACKED),
          file(root, "folder/image10.png"),
          file(root, "folder/image2.png"),
        ],
      }),
    ),
  );
  t.after(() => tree.dispose());
  assert.deepEqual(shape(tree.getChildren()), [
    ["Staged Changes", [["new/sub", ["new # ü.png"]]]],
    [
      "Changes",
      [["folder", ["image2.png", "image10.png"]], "gone.png", "new.png"],
    ],
  ]);
  const deleted = tree.findFile(uri("/repo/gone.png"), "working");
  assert.ok(deleted.command.arguments[0]);
  assert.match(deleted.tooltip, /Deleted.*Index → Not present/);
  const renamed = tree.findFile(uri("/repo/new/sub/new # ü.png"), "staged");
  assert.match(renamed.tooltip, /Renamed from old.png/);
});

test("repositories and staging scopes have distinct stable nodes across status refreshes", async (t) => {
  const entry = (root) =>
    repo(root, {
      indexChanges: [file(root, "nested/partial.png", Status.INDEX_MODIFIED)],
      workingTreeChanges: [file(root, "nested/partial.png")],
    });
  const git = api(entry("/one"), entry("/two"));
  const tree = new ImageChangesTree(git);
  t.after(() => tree.dispose());
  const roots = tree.getChildren();
  assert.deepEqual(
    roots.map((node) => node.label),
    ["one", "two"],
  );
  const ids = walk(roots).map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
  const staged = tree.findFile(uri("/one/nested/partial.png"), "staged");
  const working = tree.findFile(uri("/one/nested/partial.png"), "working");
  assert.notEqual(staged.id, working.id);
  assert.equal(
    tree.getParent(tree.getParent(tree.getParent(staged))),
    roots[0],
  );
  await tree.refresh();
  assert.deepEqual(
    walk(tree.getChildren()).map((node) => node.id),
    ids,
  );
  git.repositories[0].state.workingTreeChanges.push(
    file("/one", "nested/another.png"),
  );
  await tree.refresh();
  assert.ok(tree.findFile(uri("/one/nested/another.png"), "working"));
  assert.equal(
    tree.findFile(uri("/one/nested/partial.png"), "working").id,
    working.id,
  );
});

test("search entries include full paths, repository, and staging scope for identical names", () => {
  const root = "/design-system";
  const picks = imageQuickPicks(
    api(
      repo(root, {
        indexChanges: [file(root, "dark/en/screen.png", Status.INDEX_MODIFIED)],
        workingTreeChanges: [
          file(root, "dark/en/screen.png"),
          file(root, "light/ru/screen.png"),
        ],
      }),
    ),
  );
  assert.equal(picks.length, 3);
  assert.ok(picks.every((pick) => pick.label === "screen.png"));
  assert.ok(
    picks.some(
      (pick) =>
        pick.description === "dark/en/screen.png" &&
        pick.detail.includes("design-system · Staged"),
    ),
  );
  assert.ok(
    picks.some(
      (pick) =>
        pick.description === "dark/en/screen.png" &&
        pick.detail.includes("design-system · Unstaged"),
    ),
  );
  assert.ok(picks.some((pick) => pick.description === "light/ru/screen.png"));
});
