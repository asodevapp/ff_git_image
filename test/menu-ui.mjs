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
let browser;
try {
  await wait("ready");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().includes("workbench"));
  assert.ok(page, "VS Code workbench page");
  const row = page
    .getByRole("treeitem")
    .filter({ hasText: "screen0.png" })
    .first();
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
  await writeFile(path.join(control, "editChecked"), "yes");
  assert.equal(await exited, 0);
  console.log(
    "PASS: actual VS Code image/folder context menus stay open during Git status updates, pixel results and a real image edit.",
  );
  console.log(await readFile(path.join(control, "updated"), "utf8"));
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill();
  await rm(control, { recursive: true, force: true });
}
