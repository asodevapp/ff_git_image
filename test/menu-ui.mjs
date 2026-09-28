// Test-only CDP connection to a disposable VS Code profile. No user window is used.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  rm,
  mkdir,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const control = await mkdtemp(path.join(tmpdir(), "ff-menu-"));
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const child = spawn(process.execPath, ["test/run-host.cjs"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    FF_GIT_IMAGE_CDP_PORT: String(port),
    FF_GIT_IMAGE_MENU_CONTROL: control,
    FF_GIT_IMAGE_HOST_TEST: path.join(root, "test/model-host.cjs"),
  },
});
const exited = new Promise((resolve) => child.on("exit", resolve));
const wait = async (name) => {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    if (
      await stat(path.join(control, name)).then(
        () => true,
        () => false,
      )
    )
      return;
    if (child.exitCode !== null)
      throw new Error(`VS Code exited before ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${name}`);
};
let browser, page;
try {
  await wait("ready");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().includes("workbench"));
  assert.ok(page, "VS Code workbench page");
  const row = page
    .getByRole("treeitem")
    .filter({ hasText: "screen0.png" })
    .first();
  const action = (node, icon) =>
    node.locator(`.monaco-action-bar .action-label.codicon-${icon}`);
  const checkActions = async (node, staged = false) => {
    await node.hover();
    await action(node, staged ? "remove" : "add").waitFor({ state: "visible" });
    assert.equal(await action(node, staged ? "add" : "remove").count(), 0);
    assert.equal(await action(node, "discard").count(), staged ? 0 : 1);
    if (!staged) assert.ok(await action(node, "discard").isVisible());
  };
  await checkActions(row);
  await row.click({ button: "right" });
  const menu = page.locator(".monaco-menu-container");
  await menu.waitFor({ state: "visible" });
  const initial = await menu.innerText();
  assert.match(initial, /Accept Image Changes/);
  assert.match(initial, /Discard Image Changes/);
  await writeFile(path.join(control, "opened"), "yes");
  await wait("updated");
  assert.ok(
    await menu.isVisible(),
    "Context menu remains visible through Git and metric updates",
  );
  assert.equal(
    await menu.innerText(),
    initial,
    "Same commands remain available",
  );
  await mkdir(path.join(root, ".test-host"), { recursive: true });
  await page.screenshot({
    path: path.join(root, ".test-host/menu-stable.png"),
  });
  await page.keyboard.press("Escape");
  await row.hover();
  const hover = page
    .locator(".monaco-hover")
    .filter({ hasText: "changed pixels" })
    .first();
  await hover.waitFor({ state: "visible", timeout: 5000 });
  assert.match(await hover.innerText(), /4.00% changed pixels/);
  const folder = page
    .getByRole("treeitem")
    .filter({ hasText: "performance" })
    .first();
  await checkActions(folder);
  await folder.click({ button: "right" });
  await menu.waitFor({ state: "visible" });
  const folderCommands = await menu.innerText();
  assert.match(folderCommands, /Accept Image Changes/);
  assert.match(folderCommands, /Discard Image Changes/);
  await writeFile(path.join(control, "checked"), "yes");
  await wait("edited");
  assert.ok(
    await menu.isVisible(),
    "Folder menu remains open after a real image edit and pixel calculation",
  );
  assert.equal(await menu.innerText(), folderCommands);
  await page.screenshot({
    path: path.join(root, ".test-host/menu-folder-stable.png"),
  });
  await page.keyboard.press("Escape");
  const group = (label) =>
    page.getByRole("treeitem").filter({
      has: page
        .locator(".label-name")
        .filter({ hasText: new RegExp(`^${label}$`) }),
    });
  await checkActions(group("Changes"));
  await checkActions(group("Staged Changes"), true);

  // Exercise real inline commands, including their row arguments, against the
  // disposable Git fixture. All staged fixture changes are restored afterward.
  await row.hover();
  await action(row, "add").click();
  const stagedFile = page
    .getByRole("treeitem")
    .filter({ hasText: "screen0.png" })
    .filter({ has: page.locator(".action-label.codicon-remove") });
  const revealStaged = async (count) => {
    await group("Staged Changes")
      .filter({ hasText: String(count) })
      .waitFor({ state: "visible" });
    // Native tree rows outside the viewport are virtualized. Staging moves this
    // image above the current scroll position; navigate there before locating it.
    await page.getByRole("tree").first().focus();
    await page.keyboard.press("Home");
  };
  await revealStaged(11);
  await stagedFile.waitFor({ state: "visible", timeout: 15000 });
  await checkActions(stagedFile, true);
  await action(stagedFile, "remove").click();
  await stagedFile.waitFor({ state: "hidden", timeout: 15000 });
  await checkActions(folder);
  await action(folder, "add").click();
  await revealStaged(42);
  await stagedFile.waitFor({ state: "visible", timeout: 15000 });
  await checkActions(folder, true);
  await action(folder, "remove").click();
  await stagedFile.waitFor({ state: "hidden", timeout: 15000 });
  await checkActions(folder);
  await action(folder, "discard").click();
  await wait("discardCancelled");
  const confirmation = JSON.parse(
    await readFile(path.join(control, "discardCancelled"), "utf8"),
  );
  assert.equal(confirmation.message, "Discard changes to 32 images?");
  assert.equal(confirmation.options.modal, true);
  assert.match(confirmation.options.detail, /performance\/screen0\.png/);
  assert.match(confirmation.options.detail, /performance\/screen31\.png/);
  assert.deepEqual(confirmation.buttons, ["Discard Changes"]);
  await checkActions(row);
  await page.screenshot({
    path: path.join(root, ".test-host/inline-actions.png"),
  });
  await writeFile(path.join(control, "editChecked"), "yes");
  assert.equal(await exited, 0);
  console.log(
    "PASS: actual VS Code inline actions on files/folders/groups, file and folder stage/unstage, cancelled folder discard, and stable context menus during Git/pixel updates.",
  );
  console.log(await readFile(path.join(control, "updated"), "utf8"));
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(
      "Tree at failure:",
      await page.getByRole("treeitem").allTextContents(),
    );
    console.error(
      "Notifications:",
      await page.locator(".notifications-toasts").allInnerTexts(),
    );
    console.error("Dialogs:", await page.getByRole("dialog").allTextContents());
    await mkdir(path.join(root, ".test-host"), { recursive: true });
    await page.screenshot({
      path: path.join(root, ".test-host/menu-failure.png"),
    });
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill();
  await rm(control, { recursive: true, force: true });
}
