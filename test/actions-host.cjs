const assert = require("node:assert/strict");
const vscode = require("vscode");
const { execFileSync } = require("node:child_process");
const { ImageActions } = require("../out/actions");
const { ImageChangesTree } = require("../out/sidebar");
const { ImageIgnore } = require("../out/image-ignore");

exports.run = async (api, repo) => {
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo.rootUri.fsPath }).toString();
  const uri = (name) => vscode.Uri.joinPath(repo.rootUri, name);
  const write = (name, text) =>
    vscode.workspace.fs.writeFile(uri(name), Buffer.from(text));
  const read = async (name) =>
    Buffer.from(await vscode.workspace.fs.readFile(uri(name))).toString();
  const folder = "actions/golden/init";
  const primary = `${folder}/FullHd[dark].svg`;
  const hidden = `${folder}/FullHdd.svg`;
  const other = `${folder}/other.svg`;
  const deleted = `${folder}/deleted.svg`;
  const added = `${folder}/new # ü.svg`;
  const text = `${folder}/notes.txt`;
  const sibling = "actions/golden/neighbor/screen.svg";
  const oldName = "actions/rename/old # ü.svg";
  const newName = "actions/renamed/new [dark] # ü.svg";
  for (const name of [
    folder,
    "actions/golden/neighbor",
    "actions/rename",
    "actions/renamed",
  ])
    await vscode.workspace.fs.createDirectory(uri(name));
  for (const name of [primary, hidden, other, deleted, text, sibling, oldName])
    await write(name, `before:${name}`);
  git("add", "--", "actions");
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
    "Actions fixture",
    "--",
    "actions",
  );
  await write(primary, "staged-primary");
  git("--literal-pathspecs", "add", "--", primary);
  for (const name of [primary, hidden, other, text, sibling, added])
    await write(name, `working:${name}`);
  await vscode.workspace.fs.delete(uri(deleted));
  await write(".image_ignore", `/${hidden}\n`);
  const ignores = new ImageIgnore(api);
  await ignores.refresh();
  const tree = new ImageChangesTree(api, ignores);
  const walk = (nodes) =>
    nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
  const node = async (scope, relative = folder) => {
    const result = walk(tree.getChildren()).find(
      (item) =>
        item.contextValue === `ff_git_image.folder.${scope}` &&
        item.tooltip === relative,
    );
    assert.ok(result, `Missing ${scope} folder ${relative}`);
    await tree.prepare(result);
    return result;
  };
  const cached = () =>
    git("diff", "--cached", "--name-only", "-z", "--", "actions")
      .split("\0")
      .filter(Boolean);
  let confirm = async () => true;
  const actions = new ImageActions(api, ignores, tree, (changes) =>
    confirm(changes),
  );
  let actionNumber = 0;
  const run = actions.run.bind(actions);
  actions.run = async (action, ...args) => {
    const number = ++actionNumber;
    try {
      return await run(action, ...args);
    } catch (error) {
      error.message = `Action ${number} (${action}): ${error.message}`;
      throw error;
    }
  };
  try {
    await tree.refresh();
    await actions.run("stage", await node("working"));
    assert.deepEqual(cached().sort(), [primary, other, deleted, added].sort());
    assert.equal(await read(hidden), `working:${hidden}`);
    await actions.run("unstage", await node("staged"));
    assert.deepEqual(cached(), []);
    assert.equal(await read(primary), `working:${primary}`);
    assert.equal(await read(added), `working:${added}`);

    // Registered command follows the same exact-file path, including brackets.
    const file = tree.findFile(uri(primary), "working");
    await tree.prepare(file);
    assert.equal(file.contextValue, "ff_git_image.image.working");
    await vscode.commands.executeCommand("ff_git_image.stage", file);
    assert.deepEqual(cached(), [primary]);
    await write(primary, "new-working-primary");
    await tree.refresh();
    confirm = async (changes) => {
      assert.equal(changes.length, 4);
      assert.ok(
        changes.every(
          (change) =>
            change.path.startsWith(folder + "/") && change.path !== hidden,
        ),
      );
      return false;
    };
    await actions.run("discard", await node("working"));
    assert.equal(await read(primary), "new-working-primary");
    assert.equal(await read(added), `working:${added}`);

    confirm = async () => {
      await write(primary, "edited-during-confirmation");
      return true;
    };
    await assert.rejects(
      actions.run("discard", await node("working")),
      /Images changed while confirming/,
    );
    assert.equal(await read(primary), "edited-during-confirmation");
    assert.equal(await read(other), `working:${other}`);
    assert.equal(await read(added), `working:${added}`);

    // The failed action releases the mutation queue before background fingerprints.
    // Wait for the same automatic refresh the user sees before reviewing/retrying.
    const refreshedChange = tree.findFile(uri(primary), "working");
    const expectedRevision = await require("../out/images").imageRevision(
      api,
      refreshedChange.change,
    );
    for (
      let i = 0;
      i < 100 &&
      tree.findFile(uri(primary), "working")?.change.revision !==
        expectedRevision;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      tree.findFile(uri(primary), "working").change.revision,
      expectedRevision,
      "Background fingerprint refresh must resume after the action",
    );
    confirm = async () => true;
    await actions.run("discard", await node("working"));
    assert.equal(
      await read(primary),
      `working:${primary}`,
      "Discard restores the index, not HEAD",
    );
    assert.deepEqual(cached(), [primary], "Discard preserves staged contents");
    for (const name of [other, deleted])
      assert.equal(await read(name), `before:${name}`);
    await assert.rejects(read(added), (error) => error.code === "FileNotFound");
    for (const name of [hidden, text, sibling])
      assert.equal(await read(name), `working:${name}`);

    await vscode.workspace.fs.rename(uri(oldName), uri(newName));
    git("--literal-pathspecs", "add", "-A", "--", oldName, newName);
    await tree.refresh();
    const rename = tree.findFile(uri(newName), "staged");
    await tree.prepare(rename);
    assert.equal(rename.change.previousPath, oldName);
    await actions.run("unstage", rename);
    assert.deepEqual(cached(), [primary]);
    assert.equal(await read(newName), `before:${oldName}`);
    await assert.rejects(
      read(oldName),
      (error) => error.code === "FileNotFound",
    );

    // A stale folder may not expand its scope or fall back to a repository-wide action.
    await assert.rejects(actions.run("stage", file), /no longer current/);
    await assert.rejects(
      actions.run("discard", tree.findFile(uri(primary), "staged")),
      /only available in Changes/,
    );
    assert.deepEqual(cached(), [primary]);
    // Recreate a removed directory, restoring only its visible image files.
    const removedFolder = "actions/golden/neighbor";
    await vscode.workspace.fs.delete(uri(removedFolder), { recursive: true });
    await tree.refresh();
    await actions.run("discard", await node("working", removedFolder));
    assert.equal(await read(sibling), `before:${sibling}`);
    // Ignore menu writes real editor documents and keeps wildcard siblings hidden.
    await write(hidden, "ignored-sibling");
    await write(other, "ignore-me");
    await tree.refresh();
    let ignoreNode = tree.findFile(uri(other), "working");
    assert.equal(await actions.run("ignore", ignoreNode), 1);
    assert.ok(
      (await read(".image_ignore")).includes("/actions/golden/init/other.svg"),
    );
    assert.equal(tree.findFile(uri(other), "working"), undefined);
    ignores.toggleShowIgnored();
    ignoreNode = tree.findFile(uri(other), "working");
    assert.equal(ignoreNode.change.ignored, true);
    assert.equal(await actions.run("unignore", ignoreNode), 1);
    assert.equal(tree.findFile(uri(other), "working").change.ignored, false);
    assert.equal(tree.findFile(uri(hidden), "working").change.ignored, true);
    ignores.toggleShowIgnored();
    await tree.refresh();
    const stale = tree.findFile(uri(other), "working");
    await tree.prepare(stale);
    await write(other, "changed-after-review");
    await assert.rejects(
      actions.run("stage", stale),
      /changed since it was selected or viewed/,
    );
    assert.deepEqual(cached(), [primary]);
    // The real API error carries the lock path; removal is explicit and fixture-only.
    const lock = uri(".git/index.lock");
    await vscode.workspace.fs.writeFile(lock, Buffer.from("fixture lock"));
    let lockError;
    try {
      await repo.add([
        require("node:path").join(repo.rootUri.fsPath, ":(literal)" + other),
      ]);
    } catch (error) {
      lockError = error;
    }
    assert.ok(lockError);
    assert.match(`${lockError.message}\n${lockError.stderr}`, /index\.lock/);
    const { indexLockPath, removeConfirmedLock } = require("../out/git-lock");
    const resolvedLock = await indexLockPath(repo.rootUri.fsPath);
    assert.equal(resolvedLock, lock.fsPath);
    assert.equal(
      await removeConfirmedLock(resolvedLock, async () => false),
      false,
    );
    assert.equal(
      await removeConfirmedLock(resolvedLock, async () => true),
      true,
    );
    await write(`${folder}/extra.svg`, "second selected image");
    await tree.refresh();
    const fresh = tree.findFile(uri(other), "working");
    await tree.prepare(fresh);
    await tree.prepare(tree.getParent(fresh));
    const messages = [];
    assert.equal(
      await actions.run("stage", [fresh, tree.getParent(fresh)], (message) =>
        messages.push(message),
      ),
      2,
    );
    assert.ok(messages.some((message) => message === "Processed 2/2 images"));
    assert.equal(await read(hidden), "ignored-sibling");
    const createRoot = uri("ignore-create");
    await vscode.workspace.fs.createDirectory(createRoot);
    await ignores.setIgnored({ rootUri: createRoot }, ["literal?.png"], true);
    assert.equal(
      await read("ignore-create/.image_ignore"),
      "/literal\\?.png\n",
    );
    assert.ok(
      !git("diff", "--cached", "--name-only", "-z")
        .split("\0")
        .some((name) => name.endsWith(".image_ignore")),
    );
    // Rapid registered commands share the extension queue, including a duplicate click.
    const queuedNames = ["queue/first [dark].svg", "queue/second.svg"];
    await vscode.workspace.fs.createDirectory(uri("queue"));
    for (const name of queuedNames)
      await write(
        name,
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      );
    await tree.refresh();
    const queuedNodes = queuedNames.map((name) =>
      tree.findFile(uri(name), "working"),
    );
    await Promise.all(queuedNodes.map((node) => tree.prepare(node)));
    await Promise.all([
      vscode.commands.executeCommand("ff_git_image.stage", queuedNodes[0]),
      vscode.commands.executeCommand("ff_git_image.stage", queuedNodes[1]),
      vscode.commands.executeCommand("ff_git_image.stage", queuedNodes[0]),
    ]);
    assert.deepEqual(
      git("diff", "--cached", "--name-only", "-z", "--", "queue")
        .split("\0")
        .filter(Boolean)
        .sort(),
      queuedNames.sort(),
    );
    await tree.refresh();
    const stagedQueue = queuedNames.map((name) =>
      tree.findFile(uri(name), "staged"),
    );
    await Promise.all(stagedQueue.map((node) => tree.prepare(node)));
    await Promise.all(
      stagedQueue.map((node) =>
        vscode.commands.executeCommand("ff_git_image.unstage", node),
      ),
    );
    assert.equal(git("diff", "--cached", "--name-only", "--", "queue"), "");
    console.log(
      "PASS: real VS Code actions — rapid queued stage/unstage commands and duplicate clicks, revision-bound stage, multi-selection/progress, Ignore/Stop ignoring editor saves, Git lock error/recovery, literal paths, folder stage/unstage, cancelled/stale discard, index restoration, new-image Trash, rename unstage.",
    );
  } finally {
    tree.dispose();
    ignores.dispose();
    await vscode.workspace.fs.delete(uri(".image_ignore"));
  }
};
