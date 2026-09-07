const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
let prompt,
  commands = [];
const load = Module._load;
Module._load = function (name, ...args) {
  return name === "vscode"
    ? {
        window: { showWarningMessage: (...args) => prompt(...args) },
        commands: { executeCommand: async (id) => commands.push(id) },
      }
    : load.call(this, name, ...args);
};
const {
  indexLockPath,
  removeConfirmedLock,
  recoverIndexLock,
} = require("../out/git-lock");
Module._load = load;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ff-image-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".git"));
  return { root, file: path.join(root, ".git", "index.lock") };
}

test("resolve the actual index lock for ordinary repositories and linked worktrees", async (t) => {
  const { root, file } = await fixture(t);
  assert.equal(await indexLockPath(root), file);
  const worktree = path.join(root, "linked");
  const gitdir = path.join(root, ".git", "worktrees", "linked");
  await fs.mkdir(worktree);
  await fs.mkdir(gitdir, { recursive: true });
  await fs.writeFile(
    path.join(worktree, ".git"),
    "gitdir: ../.git/worktrees/linked\n",
  );
  assert.equal(await indexLockPath(worktree), path.join(gitdir, "index.lock"));
});

test("lock deletion requires confirmation and refuses changed or replaced files", async (t) => {
  const { file } = await fixture(t);
  await fs.writeFile(file, "active");
  assert.equal(await removeConfirmedLock(file, async () => false), false);
  assert.equal(await fs.readFile(file, "utf8"), "active");
  await assert.rejects(
    removeConfirmedLock(file, async () => {
      await fs.writeFile(file + ".replacement", "active");
      await fs.rename(file + ".replacement", file);
      return true;
    }),
    /changed while confirming/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "active");
  assert.equal(await removeConfirmedLock(file, async () => true), true);
  await assert.rejects(fs.stat(file), (error) => error.code === "ENOENT");
});

test("symlinks are never deleted as Git locks", async (t) => {
  const { root, file } = await fixture(t);
  const target = path.join(root, "target");
  await fs.writeFile(target, "keep");
  await fs.symlink(target, file);
  await assert.rejects(
    removeConfirmedLock(file, async () => true),
    /regular file/,
  );
  assert.equal(await fs.readFile(target, "utf8"), "keep");
});

test("recovery checks the reported repository path; retry and log do not delete a lock", async (t) => {
  const { root, file } = await fixture(t);
  await fs.writeFile(file, "keep");
  const repo = { rootUri: { fsPath: root } };
  const error = (lock) => ({
    message: "Git failed",
    stderr: `fatal: Unable to create '${lock}': File exists.`,
  });
  prompt = async () => {
    throw new Error("Unexpected dialog");
  };
  assert.equal(
    await recoverIndexLock(repo, error(path.join(root, "other", "index.lock"))),
    false,
  );
  prompt = async () => "Retry";
  assert.equal(await recoverIndexLock(repo, error(file)), true);
  assert.equal(await fs.readFile(file, "utf8"), "keep");
  commands = [];
  prompt = async () => "Open Git Log";
  assert.equal(await recoverIndexLock(repo, error(file)), false);
  assert.deepEqual(commands, ["git.showOutput"]);
  let prompts = 0;
  prompt = async (_message, options) => {
    if (++prompts === 1) return "Remove index.lock…";
    assert.equal(options.modal, true);
    assert.ok(options.detail.includes(file));
    return "Git Is Stopped — Remove Lock";
  };
  assert.equal(await recoverIndexLock(repo, error(file)), true);
  assert.equal(prompts, 2);
  await assert.rejects(fs.stat(file), (error) => error.code === "ENOENT");
});
