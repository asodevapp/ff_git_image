const assert = require("node:assert/strict");
const vscode = require("vscode");
const { FailureArtifacts } = require("../out/failures");
const { ImageChangesTree, imageQuickPicks } = require("../out/sidebar");
const { ImageIgnore } = require("../out/image-ignore");
const { collectChanges } = require("../out/changes");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.run = async (api, repo) => {
  const uri = (name) => vscode.Uri.joinPath(repo.rootUri, name);
  const write = (name, bytes) =>
    vscode.workspace.fs.writeFile(uri(name), bytes);
  const prefix = "test/editor/failures/";
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrGQAAAAASUVORK5CYII=",
    "base64",
  );
  const exclude = uri(".git/info/exclude");
  const rules = await vscode.workspace.fs.readFile(exclude);
  await vscode.workspace.fs.writeFile(
    exclude,
    Buffer.concat([rules, Buffer.from("\n**/failures/\n")]),
  );
  await vscode.workspace.fs.createDirectory(uri(prefix));
  for (const kind of ["masterImage", "testImage", "isolatedDiff", "maskedDiff"])
    await write(`${prefix}iPhone5S[dark]_${kind}.png`, png);
  await write(`${prefix}notes.txt`, Buffer.from("Keep this diagnostic"));
  await repo.status();
  assert(
    !collectChanges(repo).some((change) => change.path.startsWith(prefix)),
    "Git ignores the generated fixtures",
  );
  const failures = new FailureArtifacts(api);
  const ignores = new ImageIgnore(api);
  await ignores.refresh();
  const sidebar = new ImageChangesTree(api, ignores, undefined, failures);
  const until = async (predicate) => {
    for (let i = 0; i < 100 && !predicate(); i++) await pause(100);
    assert(predicate(), "Native failure watcher/filter must update");
  };
  try {
    await failures.refresh();
    assert.equal(failures.count, 4);
    sidebar.setFilter("failures");
    assert.equal(sidebar.count, 4);
    await sidebar.prepare(sidebar.getChildren()[0]);
    assert(
      sidebar.leaves().every((node) => !node.change.revision),
      "Listing artifacts must not read their image bytes",
    );
    const item = sidebar
      .leaves()
      .find((node) => node.change.path.endsWith("_testImage.png"));
    assert.equal(
      sidebar.provideFileDecoration(item.resourceUri).color.id,
      "list.errorForeground",
    );
    await sidebar.prepare(item, true);
    assert(item.change.revision);
    const preview = await sidebar.images.comparison(item.change);
    assert.equal(preview.before, null);
    assert(preview.after.data.startsWith("data:image/png;base64,"));
    await vscode.commands.executeCommand(
      "ff_git_image.openFile",
      item.change.after.uri,
      "failure",
    );
    const events = [];
    sidebar.onDidChangeTreeData((event) => events.push(event));
    await failures.refresh();
    assert.deepEqual(events, [], "Unchanged scans preserve tree handles");
    assert.equal(sidebar.findFile(item.change.after.uri, "failure"), item);
    await write(`${prefix}new.PNG`, png);
    await until(() => failures.count === 5);
    await write(".image_ignore", Buffer.from("**/*_maskedDiff.png\n"));
    await until(() => sidebar.count === 4);
    assert.equal(
      failures.count,
      5,
      "Cleanup still knows about ignored artifacts",
    );
    assert.equal(
      imageQuickPicks(
        api,
        ignores,
        sidebar.leaves().map((node) => node.change),
      ).length,
      4,
    );
    sidebar.setFilter("changes");
    assert(sidebar.leaves().every((node) => node.change.scope !== "failure"));
    const index = await vscode.workspace.fs.readFile(uri(".git/index"));
    assert.equal(
      await failures.clean(
        failures.snapshot,
        () => {},
        async () => false,
      ),
      0,
    );
    assert.deepEqual(
      await vscode.workspace.fs.readFile(uri(".git/index")),
      index,
    );
    assert.equal(failures.count, 5);
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "ff_git_image.filterImages",
      "ff_git_image.deleteFailures",
    ])
      assert(commands.includes(command));
    console.log(
      "PASS: real VS Code — ignored failure discovery, native watcher, separate artifact previews, status decorations, filters/search, .image_ignore and cancelled cleanup preserve files/index.",
    );
  } finally {
    sidebar.dispose();
    ignores.dispose();
    failures.dispose();
    await vscode.workspace.fs.writeFile(exclude, rules);
    await vscode.workspace.fs.delete(uri(".image_ignore"));
  }
};
