const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
let content = Buffer.from([137, 80, 78, 71, 0, 255, 128]),
  statSize = content.length,
  reads = 0,
  statError,
  fileType = 1;
const fs = {
  stat: async () => {
    if (statError) throw statError;
    return { size: statSize, type: fileType };
  },
  readFile: async () => {
    reads++;
    return content;
  },
};
Module._load = function (name, ...rest) {
  return name === "vscode"
    ? { workspace: { fs }, FileType: { SymbolicLink: 64 } }
    : originalLoad.call(this, name, ...rest);
};
const {
  readImage,
  readComparison,
  imageRevision,
  maxImageBytes,
} = require("../out/images");
Module._load = originalLoad;
const calls = [];
const api = {
  toGitUri: (uri, ref) => {
    calls.push(ref);
    return uri;
  },
};
const source = { uri: { fsPath: "/repo/a.png" }, label: "Index", ref: "" };

test("binary image bytes survive without UTF-8 conversion and index empty ref is preserved", async () => {
  const result = await readImage(api, source);
  assert.deepEqual(Buffer.from(result.data.split(",")[1], "base64"), content);
  assert.deepEqual(calls, [""]);
  assert.equal(await readImage(api, undefined), null);
});
test("comparison revisions follow both contents and errors, not Git status or file size", async (t) => {
  const originalRead = fs.readFile;
  const versions = new Map([
    ["/repo/before.png", Buffer.from([0, 255, 128])],
    ["/repo/after.png", Buffer.from([0, 255, 129])],
  ]);
  fs.readFile = async (uri) => {
    const result = versions.get(uri.fsPath);
    if (result instanceof Error) throw result;
    return result;
  };
  t.after(() => {
    fs.readFile = originalRead;
  });
  const change = {
    before: { ...source, uri: { fsPath: "/repo/before.png" } },
    after: { uri: { fsPath: "/repo/after.png" }, label: "Working tree" },
    status: "Modified",
  };
  const first = await readComparison(api, change);
  assert.ok(first.before.data && first.after.data);
  const unchanged = await readComparison(api, { ...change }, first.revision);
  assert.deepEqual(unchanged, { revision: first.revision, unchanged: true });
  // Same path, status, size, and timestamps; only the working bytes change.
  versions.set("/repo/after.png", Buffer.from([0, 255, 130]));
  const edited = await readComparison(api, change, first.revision);
  assert.notEqual(edited.revision, first.revision);
  assert.ok(edited.after.data);
  versions.set("/repo/before.png", Buffer.from([0, 255, 131]));
  const staged = await readComparison(api, change, edited.revision);
  assert.notEqual(staged.revision, edited.revision);
  const deleted = await readComparison(
    api,
    { ...change, after: undefined },
    staged.revision,
  );
  assert.equal(deleted.after, null);
  assert.notEqual(deleted.revision, staged.revision);
  versions.set("/repo/after.png", new Error("Unavailable"));
  const failed = await readComparison(api, change, staged.revision);
  assert.match(failed.after.error, /Unavailable/);
  assert.equal(
    (await readComparison(api, change, failed.revision)).unchanged,
    true,
  );
  versions.set("/repo/after.png", Buffer.from([0, 255, 130]));
  const recovered = await readComparison(api, change, failed.revision);
  assert.equal(recovered.revision, staged.revision);
  assert.ok(recovered.after.data);
});
test("oversized image is rejected before reading its bytes", async () => {
  statSize = maxImageBytes + 1;
  const previous = reads;
  assert.match((await readImage(api, source)).error, /32 MiB/);
  assert.equal(reads, previous);
  statSize = content.length;
});
test("LFS pointers and missing versions remain explicit errors, not additions", async () => {
  content = Buffer.from(
    "version https://git-lfs.github.com/spec/v1\noid sha256:123\n",
  );
  assert.match((await readImage(api, source)).error, /Git LFS pointer/);
  statError = new Error("File not found");
  assert.match((await readImage(api, source)).error, /Index: File not found/);
  statError = undefined;
});
test("working tree symlinks are not followed for previews", async () => {
  fileType = 65;
  assert.match(
    (await readImage(api, { ...source, ref: undefined })).error,
    /Symbolic links/,
  );
});

test("action and viewer revisions agree without encoding base64 for hash-only or unchanged reads", async (t) => {
  fileType = 1;
  statError = undefined;
  content = Buffer.from([0, 128, 255, 10]);
  statSize = content.length;
  const change = { before: source, after: { ...source, ref: undefined } };
  const first = await readComparison(api, change);
  const toString = Buffer.prototype.toString;
  Buffer.prototype.toString = function (encoding, ...args) {
    assert.notEqual(
      encoding,
      "base64",
      "Hash-only and unchanged reads must not encode the image",
    );
    return toString.call(this, encoding, ...args);
  };
  t.after(() => {
    Buffer.prototype.toString = toString;
  });
  assert.equal(await imageRevision(api, change), first.revision);
  assert.deepEqual(await readComparison(api, change, first.revision), {
    revision: first.revision,
    unchanged: true,
  });
});
