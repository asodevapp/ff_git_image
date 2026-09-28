const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
let dialog, document, shown;
const vscode = {
  window: {
    showWarningMessage: async (...args) => dialog(...args),
    showTextDocument: async (doc, options) => {
      shown = { doc, options };
    },
  },
  workspace: {
    openTextDocument: async (options) => (document = options),
  },
};
const load = Module._load;
Module._load = function (name, ...args) {
  return name === "vscode" ? vscode : load.call(this, name, ...args);
};
const { confirmImageAction } = require("../out/confirmation");
Module._load = load;

test("large deletion selections keep the modal bounded, including very long multiline paths", async () => {
  const paths = Array.from(
    { length: 5000 },
    (_, i) => `/repo/${"nested/".repeat(100)}failures/file\n${i}.png`,
  );
  dialog = async (title, options, accept, list) => {
    assert.equal(title, "Move 5000 failure images to Trash?");
    assert.equal(options.modal, true);
    assert(options.detail.length < 400, options.detail.length);
    assert(options.detail.split("\n").length <= 6);
    assert.match(options.detail, /4997 more files/);
    assert.equal(accept, "Move to Trash");
    assert.equal(list, "View File List");
    return accept;
  };
  assert.equal(
    await confirmImageAction(
      "Move 5000 failure images to Trash?",
      "12.34 MiB.",
      paths,
      "Move to Trash",
    ),
    true,
  );
});

test("viewing the complete list opens a scrollable document without approving deletion", async () => {
  const paths = Array.from(
    { length: 5000 },
    (_, i) => `/repo/failures/screen${i}.png`,
  );
  dialog = async () => "View File List";
  assert.equal(
    await confirmImageAction(
      "Move files to Trash?",
      "Selected failure images.",
      paths,
      "Move to Trash",
    ),
    false,
  );
  assert.equal(document.language, "plaintext");
  assert(document.content.includes("run the action again to confirm"));
  for (const file of paths)
    assert(document.content.includes(JSON.stringify(file)));
  assert.deepEqual(shown, { doc: document, options: { preview: true } });
});

test("closing the confirmation cancels the action without opening a document", async () => {
  document = shown = undefined;
  dialog = async () => undefined;
  assert.equal(
    await confirmImageAction(
      "Discard?",
      "Selected image.",
      ["screen.png"],
      "Discard Changes",
    ),
    false,
  );
  assert.equal(document, undefined);
  assert.equal(shown, undefined);
});
