const test = require("node:test");
const assert = require("node:assert/strict");
const { collectChanges, mimeType, publicChange } = require("../out/changes");
const { Status } = require("../out/git-api");

const uri = (path) => ({ fsPath: path, toString: () => `file://${path}` });
const change = (path, status, oldPath) => ({
  uri: uri(`/repo/${path}`),
  originalUri: uri(`/repo/${oldPath ?? path}`),
  renameUri: oldPath ? uri(`/repo/${path}`) : undefined,
  status,
});
const repository = (overrides) => ({
  rootUri: uri("/repo"),
  state: {
    HEAD: { commit: "abc123" },
    indexChanges: [],
    workingTreeChanges: [],
    untrackedChanges: [],
    mergeChanges: [],
    ...overrides,
  },
});

test("partially staged images have separate HEAD → index and index → worktree comparisons", () => {
  const changes = collectChanges(
    repository({
      indexChanges: [change("a.png", Status.INDEX_MODIFIED)],
      workingTreeChanges: [change("a.png", Status.MODIFIED)],
    }),
  );
  assert.equal(changes.length, 2);
  const staged = changes.find((c) => c.scope === "staged"),
    working = changes.find((c) => c.scope === "working");
  assert.notEqual(staged.id, working.id);
  assert.equal(staged.before.ref, "abc123");
  assert.equal(staged.after.ref, "");
  assert.equal(working.before.ref, "");
  assert.equal(working.after.ref, undefined);
});
test("added, deleted, and unborn repositories do not invent a missing image side", () => {
  const changes = collectChanges(
    repository({
      HEAD: undefined,
      indexChanges: [change("new.png", Status.INDEX_ADDED)],
      workingTreeChanges: [
        change("gone.png", Status.DELETED),
        change("intent.webp", Status.INTENT_TO_ADD),
      ],
    }),
  );
  assert.equal(changes.find((c) => c.path === "new.png").before, undefined);
  assert.equal(changes.find((c) => c.path === "gone.png").after, undefined);
  assert.equal(changes.find((c) => c.path === "intent.webp").before, undefined);
});
test("rename reads the original path in HEAD and the destination in the index", () => {
  const [entry] = collectChanges(
    repository({
      indexChanges: [
        change("nested/new # ü.PNG", Status.INDEX_RENAMED, "old.png"),
      ],
    }),
  );
  assert.equal(entry.before.uri.fsPath, "/repo/old.png");
  assert.equal(entry.after.uri.fsPath, "/repo/nested/new # ü.PNG");
  assert.equal(entry.previousPath, "old.png");
  assert.equal(entry.path, "nested/new # ü.PNG");
  assert.equal(publicChange(entry).before, undefined);
});
test("filters non-images and ignored paths and deduplicates Git API untracked groups", () => {
  const added = change("new.svg", Status.UNTRACKED);
  const changes = collectChanges(
    repository({
      workingTreeChanges: [
        added,
        change("notes.txt", Status.MODIFIED),
        change("ignored.png", Status.IGNORED),
      ],
      untrackedChanges: [added],
    }),
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, "Added");
  for (const ext of [
    "PNG",
    "jpg",
    "jpeg",
    "webp",
    "gif",
    "bmp",
    "svg",
    "ico",
    "avif",
  ])
    assert.ok(mimeType(`x.${ext}`));
  assert.equal(mimeType("x.tiff"), undefined);
});
test("conflicts use HEAD rather than the absent stage-zero index", () => {
  const [entry] = collectChanges(
    repository({
      mergeChanges: [change("conflict.png", Status.BOTH_MODIFIED)],
    }),
  );
  assert.equal(entry.scope, "conflict");
  assert.equal(entry.before.ref, "abc123");
  assert.equal(entry.after.ref, undefined);
});
test("same paths in separate repositories have separate identities", () => {
  const a = repository({
    workingTreeChanges: [change("a.png", Status.MODIFIED)],
  });
  const b = { ...a, rootUri: uri("/second") };
  assert.notEqual(collectChanges(a)[0].id, collectChanges(b)[0].id);
});
