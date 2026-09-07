const assert = require("node:assert/strict");
const vscode = require("vscode");
const { collectChanges } = require("../out/changes");
const { readImage, readComparison } = require("../out/images");
const { ImageChangesTree, imageQuickPicks } = require("../out/sidebar");
const { ImageIgnore } = require("../out/image-ignore");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.run = async () => {
  const git = await vscode.extensions.getExtension("vscode.git").activate();
  const api = git.getAPI(1);
  for (let i = 0; i < 100 && !api.repositories.length; i++) await pause(100);
  assert.equal(
    api.repositories.length,
    1,
    "fixture repository must be discovered",
  );
  const repo = api.repositories[0];
  await repo.status();
  const changes = collectChanges(repo);
  const staged = changes.find(
    (c) => c.path === "partial.svg" && c.scope === "staged",
  );
  const working = changes.find(
    (c) => c.path === "partial.svg" && c.scope === "working",
  );
  assert.ok(staged);
  assert.ok(working);
  const decode = async (source) => {
    const payload = await readImage(api, source);
    assert.ok(!payload?.error, payload?.error);
    return payload
      ? Buffer.from(payload.data.split(",")[1], "base64").toString()
      : null;
  };
  assert.match(await decode(staged.before), /red/);
  assert.match(await decode(staged.after), /blue/);
  assert.match(await decode(working.before), /blue/);
  assert.match(await decode(working.after), /green/);
  const renamed = changes.find((c) => c.path === "renamed # ü.svg");
  assert.ok(renamed);
  assert.equal(renamed.previousPath, "old # ü.svg");
  assert.match(await decode(renamed.before), /red/);
  assert.match(await decode(renamed.after), /red/);
  const deleted = changes.find((c) => c.path === "deleted.svg");
  assert.equal(deleted.after, undefined);
  assert.match(await decode(deleted.before), /red/);
  const added = changes.find((c) => c.path === "untracked.svg");
  assert.equal(added.before, undefined);
  assert.match(await decode(added.after), /orange/);
  // Reproduce the user entry point: open the Activity Bar container, not a palette command.
  const extension = vscode.extensions.getExtension("gornivv.ff-git-image");
  const manifest = extension.packageJSON;
  const container = manifest.contributes.viewsContainers.activitybar.find(
    (item) => item.id === "ff_git_image",
  );
  assert.ok(
    container,
    "FF Git Image must contribute an Activity Bar container",
  );
  assert.ok(
    manifest.contributes.views[container.id].some(
      (view) => view.id === "ff_git_image.changes",
    ),
  );
  assert.ok(
    (
      await vscode.workspace.fs.stat(
        vscode.Uri.joinPath(extension.extensionUri, container.icon),
      )
    ).size > 0,
  );
  await vscode.commands.executeCommand("workbench.view.extension.ff_git_image");
  await vscode.commands.executeCommand("ff_git_image.changes.focus");
  for (let i = 0; i < 50 && !extension.isActive; i++) await pause(100);
  assert.ok(
    extension.isActive,
    "Opening the sidebar must activate the extension",
  );
  assert.ok(
    manifest.contributes.menus["view/title"].some(
      (item) => item.command === "ff_git_image.findImage",
    ),
  );

  const sidebar = new ImageChangesTree(api);
  try {
    const groups = sidebar.getChildren();
    const stagedGroup = groups.find((item) => item.label === "Staged Changes");
    const workingGroup = groups.find((item) => item.label === "Changes");
    assert.ok(stagedGroup);
    assert.ok(workingGroup);
    const stagedItem = sidebar
      .getChildren(stagedGroup)
      .find((item) => item.label === "partial.svg");
    const workingItem = sidebar
      .getChildren(workingGroup)
      .find((item) => item.label === "partial.svg");
    assert.equal(stagedItem.command.arguments[1], "staged");
    assert.equal(workingItem.command.arguments[1], "working");
    assert.notEqual(stagedItem.id, workingItem.id);
    assert.equal(workingItem.command.arguments[2], true);
    const folder = sidebar
      .getChildren(workingGroup)
      .find((item) => item.label === "src/assets/images/feature");
    assert.ok(folder, "Common directory chains must be compacted");
    assert.deepEqual(
      sidebar.getChildren(folder).map((item) => item.label),
      ["dark", "light"],
    );
    const dark = sidebar.getChildren(folder)[0];
    assert.deepEqual(
      sidebar.getChildren(dark).map((item) => item.label),
      ["en", "ru"],
    );
    const nestedFile = sidebar.getChildren(sidebar.getChildren(dark)[0])[0];
    assert.equal(nestedFile.label, "measurements-a_b.svg");
    assert.equal(sidebar.getParent(sidebar.getParent(nestedFile)), dark);
    const picks = imageQuickPicks(api).filter(
      (item) => item.label === "measurements-a_b.svg",
    );
    assert.equal(picks.length, 4);
    assert.equal(new Set(picks.map((item) => item.description)).size, 4);
    assert.equal(sidebar.count, changes.length);
    const deletedItem = sidebar
      .getChildren(workingGroup)
      .find((item) => item.label === "deleted.svg");
    assert.ok(
      deletedItem.command.arguments[0],
      "Deleted images must remain openable from the sidebar",
    );
    let refreshed = false;
    const subscription = sidebar.onDidChangeTreeData(() => {
      refreshed = true;
    });
    await sidebar.refresh();
    assert.equal(
      refreshed,
      false,
      "Unchanged Git status must not reset the tree",
    );
    assert.equal(sidebar.getChildren(), groups);
    // Real Git reads/status events, including an unrelated edit, keep prepared nodes stable.
    for (const group of groups) sidebar.getTreeItem(group);
    await Promise.all(groups.map((group) => sidebar.prepare(group)));
    const revision = workingItem.change.revision;
    await pause(350);
    refreshed = false;
    for (let i = 0; i < 3; i++) {
      await repo.status();
      await pause(200);
      assert.equal(sidebar.getChildren(), groups);
      assert.equal(sidebar.findFile(working.after.uri, "working"), workingItem);
      assert.equal(
        sidebar.getTreeItem(workingItem).contextValue,
        "ff_git_image.image.working",
      );
      assert.equal(
        sidebar.getTreeItem(workingGroup).contextValue,
        "ff_git_image.group.working",
      );
      assert.equal(workingItem.change.revision, revision);
    }
    assert.equal(
      refreshed,
      false,
      "Prepared nodes must settle even during repeated Git status updates",
    );
    subscription.dispose();
    await vscode.commands.executeCommand(
      stagedItem.command.command,
      ...stagedItem.command.arguments,
    );
    await vscode.commands.executeCommand(
      workingItem.command.command,
      ...workingItem.command.arguments,
    );
    await vscode.commands.executeCommand(
      nestedFile.command.command,
      ...nestedFile.command.arguments,
    );
  } finally {
    sidebar.dispose();
  }
  await pause(1500);
  assert.ok(
    vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .some((tab) => tab.label === "FF Git Image"),
  );
  // Exercise native .image_ignore filesystem events without a manual Git refresh.
  const ignores = new ImageIgnore(api);
  await ignores.refresh();
  const filteredTree = new ImageChangesTree(api, ignores);
  const ignoreUri = vscode.Uri.joinPath(repo.rootUri, ".image_ignore");
  const originalIds = collectChanges(repo).map((change) => change.id);
  const until = async (predicate) => {
    for (let i = 0; i < 100 && !predicate(); i++) await pause(100);
    assert.ok(
      predicate(),
      ".image_ignore watcher must update the shared image filter",
    );
  };
  try {
    assert.equal(filteredTree.count, originalIds.length);
    filteredTree.getChildren();
    await vscode.workspace.fs.writeFile(
      ignoreUri,
      Buffer.from(
        "# Keep only primary captures\n*.svg\n!**/measurements-a_b.svg\n",
      ),
    );
    await until(() => filteredTree.count === 4);
    assert.equal(imageQuickPicks(api, ignores).length, 4);
    assert.ok(
      ignores
        .changes(repo)
        .every((change) => change.path.endsWith("measurements-a_b.svg")),
    );
    assert.equal(
      filteredTree.findFile(working.after.uri, "working"),
      undefined,
    );
    assert.deepEqual(
      collectChanges(repo).map((change) => change.id),
      originalIds,
      "Image ignore rules must not alter Git changes",
    );
    await vscode.workspace.fs.writeFile(
      ignoreUri,
      Buffer.from("**/*@2x.svg\npartial.svg\n"),
    );
    await until(() => filteredTree.count === originalIds.length - 6);
    assert.ok(
      !ignores.changes(repo).some((change) => change.path === "partial.svg"),
      "Both staged and working entries must disappear",
    );
    await vscode.workspace.fs.writeFile(ignoreUri, Buffer.from("*\n"));
    await until(() => filteredTree.count === 0);
    assert.deepEqual(filteredTree.getChildren(), []);
    await vscode.workspace.fs.delete(ignoreUri);
    await until(() => filteredTree.count === originalIds.length);
  } finally {
    filteredTree.dispose();
    ignores.dispose();
  }
  // Real Git provider refreshes must not invent a new image revision.
  const first = await readComparison(api, working);
  const stagedFirst = await readComparison(api, staged);
  const findWorking = () =>
    collectChanges(repo).find((change) => change.id === working.id);
  const findStaged = () =>
    collectChanges(repo).find((change) => change.id === staged.id);
  await repo.status();
  assert.deepEqual(await readComparison(api, findWorking(), first.revision), {
    revision: first.revision,
    unchanged: true,
  });
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(repo.rootUri, "unrelated.txt"),
    Buffer.from("Unrelated edit"),
  );
  await repo.status();
  assert.equal(
    (await readComparison(api, findWorking(), first.revision)).unchanged,
    true,
  );
  const original = await vscode.workspace.fs.readFile(working.after.uri);
  await vscode.workspace.fs.writeFile(
    working.after.uri,
    Buffer.from(Buffer.from(original).toString().replace("green", "black")),
  );
  await repo.status();
  assert.equal(findWorking().status, working.status);
  const changed = await readComparison(api, findWorking(), first.revision);
  assert.notEqual(
    changed.revision,
    first.revision,
    "Same-length working bytes must invalidate the revision",
  );
  assert.equal(
    (await readComparison(api, findStaged(), stagedFirst.revision)).unchanged,
    true,
  );
  const gitFixture = (...args) =>
    require("node:child_process").execFileSync("git", args, {
      cwd: repo.rootUri.fsPath,
    });
  gitFixture("add", "partial.svg");
  await repo.status();
  const stagedChanged = await readComparison(
    api,
    findStaged(),
    stagedFirst.revision,
  );
  assert.notEqual(
    stagedChanged.revision,
    stagedFirst.revision,
    "Index bytes must invalidate the staged comparison",
  );
  gitFixture(
    "-c",
    "user.name=FF Git Image Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Change HEAD fixture",
  );
  await vscode.workspace.fs.writeFile(
    working.after.uri,
    Buffer.from(Buffer.from(original).toString().replace("green", "white")),
  );
  gitFixture("add", "partial.svg");
  await repo.status();
  const headChanged = await readComparison(
    api,
    findStaged(),
    stagedChanged.revision,
  );
  assert.notEqual(headChanged.revision, stagedChanged.revision);
  assert.match(
    Buffer.from(headChanged.before.data.split(",")[1], "base64").toString(),
    /black/,
  );
  console.log(
    "PASS: real VS Code — .image_ignore create/edit/delete watchers, exclusions and exceptions across tree/search/scopes, unchanged Git status, compact tree, stable image revisions, stable tree/menu during repeated native Git status events.",
  );
  await require("./actions-host.cjs").run(api, repo);
  require("node:fs").writeFileSync(
    process.env.FF_GIT_IMAGE_TEST_RESULT,
    "passed",
  );
};
