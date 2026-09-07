// Run with `node test/ui.mjs --screenshots` to capture the actual webview.
// Uses the browser harness's synthetic images; no workspace content is captured.
import { mkdir } from "node:fs/promises";
import path from "node:path";

export async function captureReadme(page, root) {
  const directory = path.join(root, "docs", "images");
  await mkdir(directory, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 850 });
  await page.evaluate(() =>
    sessionStorage.setItem(
      "viewer-state",
      JSON.stringify({ activeId: "main", mode: "side", tolerance: 0 }),
    ),
  );
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector("#metrics").textContent.includes("pixels changed"),
  );
  const capture = async (name) => {
    await page.click("#fit");
    await page.locator("#fit").blur();
    await page.mouse.move(0, 0);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.screenshot({ path: path.join(directory, `${name}.png`) });
  };
  await capture("side-by-side");
  await page.selectOption("#mode", "swipe");
  // Cut through the changed card, so both versions are visible at once.
  await page.locator("#mix").fill("28");
  await capture("swipe");
  await page.selectOption("#mode", "overlay");
  await page.locator("#mix").fill("50");
  await capture("overlay");
  await page.selectOption("#mode", "diff");
  await capture("pixel-diff");
  await page.selectOption("#mode", "side");
  await page.locator("#logical-scaling").check();
  await page.evaluate(() => window.__selectImage("resized"));
  await page.waitForFunction(
    () =>
      document.querySelector("#left-size").textContent.includes("1440") &&
      document.querySelector("#right-size").textContent.includes("3456") &&
      document
        .querySelector("#metrics")
        .textContent.includes("Logical scaling"),
  );
  await capture("logical-scaling");
  console.log(`README: saved five webview screenshots to ${directory}`);
}
