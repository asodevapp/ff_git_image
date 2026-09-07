// Browser harness only. The installed extension does not start this server.
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svg = (color, subtitle) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480"><rect width="720" height="480" fill="#f6f8fb"/><rect width="720" height="68" fill="white"/><text x="32" y="43" font-family="Arial" font-weight="bold" font-size="22" fill="#192636">Canvas Studio</text><text x="564" y="41" font-family="Arial" font-size="13" fill="#758295">Your workspace</text><text x="32" y="125" font-family="Arial" font-size="27" font-weight="bold" fill="#192636">Good morning, Alex.</text><text x="32" y="153" font-family="Arial" font-size="14" fill="#758295">${subtitle}</text><rect x="32" y="185" width="310" height="150" rx="12" fill="${color}"/><text x="54" y="220" font-family="Arial" font-size="13" fill="white">PROJECTS THIS MONTH</text><text x="54" y="280" font-family="Arial" font-size="44" font-weight="bold" fill="white">24</text><rect x="362" y="185" width="326" height="150" rx="12" fill="white"/><text x="384" y="220" font-family="Arial" font-size="13" fill="#758295">TEAM MEMBERS</text><text x="384" y="280" font-family="Arial" font-size="44" font-weight="bold" fill="#192636">08</text><rect x="32" y="355" width="656" height="84" rx="12" fill="white"/><circle cx="72" cy="397" r="18" fill="#e4ecf5"/><text x="107" y="394" font-family="Arial" font-size="15" fill="#192636">Brand assets</text><text x="107" y="416" font-family="Arial" font-size="12" fill="#758295">Updated just now · 12 files</text></svg>`;
const payload = (value) => ({
  data: `data:image/svg+xml;base64,${Buffer.from(value).toString("base64")}`,
});
const old = payload(svg("#6d5efc", "A little progress, every day."));
const fresh = payload(
  svg("#13a887", "Everything you need to make something great."),
);
const sized = (color, width, height) =>
  payload(
    svg(color, "A different capture resolution.").replace(
      'width="720" height="480"',
      `width="${width}" height="${height}" viewBox="0 0 720 ${(height * 720) / width}"`,
    ),
  );
const smallCapture = sized("#6d5efc", 1440, 875);
const largeCapture = sized("#13a887", 3456, 2156);
const items = [
  {
    id: "resized",
    path: "assets/screens/resized.svg",
    scope: "working",
    status: "Modified",
  },
  {
    id: "resized-reverse",
    path: "assets/screens/resized-reverse.svg",
    scope: "working",
    status: "Modified",
  },
  {
    id: "main",
    path: "assets/screens/workspace.svg",
    scope: "working",
    status: "Modified",
  },
  {
    id: "staged",
    path: "assets/screens/workspace.svg",
    scope: "staged",
    status: "Modified",
  },
  {
    id: "new",
    path: "assets/icons/new.svg",
    scope: "working",
    status: "Added",
  },
  {
    id: "deleted",
    path: "assets/legacy/banner.svg",
    scope: "working",
    status: "Deleted",
  },
  {
    id: "error",
    path: "assets/broken.svg",
    scope: "working",
    status: "Modified",
  },
  {
    id: "unsafe",
    path: "assets/<img onerror=alert(1)>.svg",
    scope: "working",
    status: "Modified",
  },
].map((item) => ({
  repository: "design-system",
  root: "/workspace/design-system",
  beforeLabel:
    item.status === "Added"
      ? "Not present"
      : item.scope === "staged"
        ? "HEAD"
        : "Index",
  afterLabel:
    item.status === "Deleted"
      ? "Not present"
      : item.scope === "staged"
        ? "Index"
        : "Working tree",
  ...item,
}));
const images = {
  resized: [smallCapture, largeCapture],
  "resized-reverse": [largeCapture, smallCapture],
  main: [old, fresh],
  staged: [old, old],
  new: [null, fresh],
  deleted: [old, null],
  error: [{ error: "Index: unavailable" }, fresh],
  unsafe: [old, fresh],
};
const server = createServer(async (req, res) => {
  try {
    const name = req.url === "/" ? "viewer.html" : req.url.slice(1);
    if (
      !["viewer.html", "viewer.css", "viewer.mjs", "diff.mjs"].includes(name)
    ) {
      res.writeHead(404).end();
      return;
    }
    let body = await readFile(path.join(root, "media", name), "utf8");
    if (name.endsWith(".html"))
      body = body
        .replaceAll("__CSP__", "'self'")
        .replaceAll("__NONCE__", "test-nonce")
        .replaceAll("__STYLE__", "/viewer.css")
        .replaceAll("__SCRIPT__", "/viewer.mjs");
    res.setHeader(
      "Content-Type",
      name.endsWith(".html")
        ? "text/html"
        : name.endsWith(".css")
          ? "text/css"
          : "text/javascript",
    );
    res.end(body);
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(
    ({ items, images }) => {
      // Settings saved by 0.1.1 must not retain the removed webview filters.
      let state = JSON.parse(
        sessionStorage.getItem("viewer-state") ?? "null",
      ) ?? {
        activeId: "main",
        mode: "side",
        scope: "staged",
        search: "does-not-exist",
        repository: "/old-workspace",
      };
      window.__state = () => state;
      window.__messages = [];
      window.__activity = {
        decodes: 0,
        workers: 0,
        draws: 0,
        paneChanges: 0,
        paneHides: 0,
      };
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function () {
        window.__activity.decodes++;
        return decode.call(this);
      };
      const clearRect = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        if (this.canvas.id) window.__activity.draws++;
        return clearRect.apply(this, args);
      };
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          window.__activity.workers++;
        }
      };
      document.addEventListener("DOMContentLoaded", () => {
        new MutationObserver((records) => {
          window.__activity.paneChanges += records.length;
          window.__activity.paneHides += records.filter(
            (record) => record.oldValue === null,
          ).length;
        }).observe(document.querySelector("#panes"), {
          attributes: true,
          attributeFilter: ["hidden"],
          attributeOldValue: true,
        });
      });
      const revisions = Object.fromEntries(items.map((item) => [item.id, 1]));
      window.__updateImages = (id, pair) => {
        images[id] = pair;
        revisions[id]++;
      };
      window.__getImages = (id) => images[id];
      window.__pending = [];
      window.__holdResponses = false;
      window.__releaseResponses = () => {
        window.__holdResponses = false;
        window.__pending.splice(0).forEach(window.__emit);
      };
      window.__responses = 0;
      window.__emit = (data) => window.postMessage(data, "*");
      window.__snapshot = (selected, changes = items) =>
        window.__emit({ type: "snapshot", changes, selected });
      window.__selectImage = (id) => window.__snapshot(id);
      window.__revisionSnapshot = () =>
        new Promise((resolve) => {
          const listener = (event) => {
            if (!event.data.revisionProbe) return;
            window.removeEventListener("message", listener);
            resolve();
          };
          window.addEventListener("message", listener);
          window.__emit({
            type: "snapshot",
            revisionProbe: true,
            changes: items.map((item) => ({
              ...item,
              revision: `${item.id}:${revisions[item.id]}`,
            })),
          });
        });
      window.acquireVsCodeApi = () => ({
        getState: () => state,
        setState: (value) => {
          state = value;
          sessionStorage.setItem("viewer-state", JSON.stringify(value));
        },
        postMessage: (message) => {
          window.__messages.push(message);
          if (message.type === "ready" || message.type === "refresh")
            window.__snapshot();
          if (message.type === "load") {
            const [before, after] = images[message.id];
            const revision = `${message.id}:${revisions[message.id]}`;
            const response = {
              type: "images",
              id: message.id,
              request: message.request,
              revision,
              ...(message.revision === revision
                ? { unchanged: true }
                : { before, after }),
            };
            if (window.__holdResponses) window.__pending.push(response);
            else window.__emit(response);
          }
        },
      });
      window.addEventListener("message", (event) => {
        if (event.data.type === "images") window.__responses++;
      });
    },
    { items, images },
  );
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const compared = () =>
    page.waitForFunction(() =>
      document.querySelector("#metrics").textContent.includes("pixels changed"),
    );
  await compared();
  assert.equal(
    await page
      .locator("aside, #files, #search, #repository, [data-scope]")
      .count(),
    0,
  );
  assert.equal(
    await page
      .locator(".review")
      .evaluate((element) => element.getBoundingClientRect().width),
    1440,
  );
  assert.equal(await page.evaluate(() => window.__state().search), undefined);
  await page.click("#show-sidebar");
  assert.equal(
    await page.evaluate(() => window.__messages.at(-1).type),
    "showSidebar",
  );
  const selectFromSidebar = async (id, valid = true) => {
    await page.evaluate((id) => window.__selectImage(id), id);
    await page.waitForFunction(
      (id) =>
        window.__messages.filter((message) => message.type === "load").at(-1)
          ?.id === id,
      id,
    );
    if (valid) await compared();
  };
  const pixel = (selector) =>
    page
      .locator(selector)
      .evaluate((canvas) => [
        ...canvas.getContext("2d").getImageData(40, 200, 1, 1).data,
      ]);
  assert.deepEqual(await pixel("#left-canvas"), [109, 94, 252, 255]);
  assert.deepEqual(await pixel("#right-canvas"), [19, 168, 135, 255]);
  const pixelActivity = await page.evaluate(() => ({ ...window.__activity }));
  const pixelResponses = await page.evaluate(() => {
    const count = window.__responses;
    for (let i = 0; i < 3; i++) window.__snapshot();
    return count;
  });
  await page.waitForFunction(
    (count) => window.__responses === count + 3,
    pixelResponses,
  );
  assert.deepEqual(await page.evaluate(() => window.__activity), pixelActivity);
  const loadsBeforeMetadata = await page.evaluate(
    () => window.__messages.filter((message) => message.type === "load").length,
  );
  for (let i = 0; i < 3; i++)
    await page.evaluate(() => window.__revisionSnapshot());
  assert.equal(
    await page.evaluate(
      () =>
        window.__messages.filter((message) => message.type === "load").length,
    ),
    loadsBeforeMetadata,
    "Snapshots with the same image revision must not request another load",
  );
  assert.deepEqual(await page.evaluate(() => window.__activity), pixelActivity);

  // Slider updates its readout immediately, coalesces drag events, and never reloads images.
  const threshold = page.getByRole("slider", {
    name: "Color difference threshold",
    exact: true,
  });
  assert.equal(await threshold.inputValue(), "0");
  assert.match(await threshold.getAttribute("aria-valuetext"), /Exact/);
  const thresholdActivity = await page.evaluate(() => {
    const previous = {
      ...window.__activity,
      loads: window.__messages.filter((message) => message.type === "load")
        .length,
    };
    const input = document.querySelector("#tolerance");
    for (let value = 1; value <= 255; value++) {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return {
      previous,
      immediateWorkers: window.__activity.workers,
      readout: document.querySelector("#tolerance-value").value,
    };
  });
  assert.equal(thresholdActivity.readout, "255");
  assert.equal(
    thresholdActivity.immediateWorkers,
    thresholdActivity.previous.workers,
  );
  await compared();
  assert.match(
    await page.locator("#metrics").textContent(),
    /· 0 \/ .*pixels changed \(0.00%\).*color threshold 255/,
  );
  assert.equal(
    await page.evaluate(() => window.__activity.workers),
    thresholdActivity.previous.workers + 1,
  );
  assert.equal(
    await page.evaluate(() => window.__activity.decodes),
    thresholdActivity.previous.decodes,
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.__messages.filter((message) => message.type === "load").length,
    ),
    thresholdActivity.previous.loads,
  );
  await threshold.press("Home");
  await compared();
  assert.equal(await threshold.inputValue(), "0");
  await threshold.press("ArrowRight");
  await compared();
  assert.equal(await threshold.inputValue(), "1");
  const track = await threshold.boundingBox();
  await threshold.click({
    position: { x: track.width * 0.4, y: track.height / 2 },
  });
  await compared();
  const rememberedThreshold = await threshold.inputValue();
  assert.ok(
    Number(rememberedThreshold) > 1 && Number(rememberedThreshold) < 255,
  );
  assert.equal(
    await page.evaluate(() => window.__state().tolerance),
    rememberedThreshold,
  );
  await page.reload();
  await compared();
  assert.equal(await threshold.inputValue(), rememberedThreshold);
  assert.equal(
    await page.locator("#tolerance-value").textContent(),
    rememberedThreshold,
  );
  await threshold.press("Home");
  await compared();
  assert.equal(await threshold.inputValue(), "0");

  for (const mode of [
    "swipe",
    "overlay",
    "diff",
    "blink",
    "before",
    "after",
    "side",
  ]) {
    await page.selectOption("#mode", mode);
    assert.equal(
      await page.locator("#right-pane").isVisible(),
      mode === "side",
    );
    assert.equal(
      await page.locator("#logical-scaling-control").isVisible(),
      mode === "side",
    );
    if (mode === "diff")
      assert.deepEqual(await pixel("#left-canvas"), [255, 82, 158, 255]);
    if (mode === "before")
      assert.deepEqual(await pixel("#left-canvas"), [109, 94, 252, 255]);
    if (mode === "after")
      assert.deepEqual(await pixel("#left-canvas"), [19, 168, 135, 255]);
  }
  await page.selectOption("#mode", "swipe");
  await page.locator("#mix").fill("0");
  assert.deepEqual(await pixel("#left-canvas"), [19, 168, 135, 255]);
  await page.locator("#mix").fill("100");
  assert.deepEqual(await pixel("#left-canvas"), [109, 94, 252, 255]);
  await page.selectOption("#mode", "overlay");
  await page.locator("#mix").fill("0");
  assert.deepEqual(await pixel("#left-canvas"), [109, 94, 252, 255]);
  await page.locator("#mix").fill("100");
  assert.deepEqual(await pixel("#left-canvas"), [19, 168, 135, 255]);
  await page.selectOption("#mode", "side");
  await page.check("#highlight");
  assert.notDeepEqual(await pixel("#right-canvas"), [19, 168, 135, 255]);
  await page.click("#changes");
  assert.notEqual(
    (await page.locator("#zoom-percent").inputValue()) + "%",
    "100%",
  );
  await page.click("#actual");
  assert.equal(
    (await page.locator("#zoom-percent").inputValue()) + "%",
    "100%",
  );
  // Reproduce the user's 1440×875 → 3456×2156 captures.
  await selectFromSidebar("resized");
  assert.equal(
    await page.locator("#left-canvas").evaluate((canvas) => canvas.width),
    3456,
  );
  const scaling = page.getByRole("checkbox", {
    name: "Logical scaling",
    exact: true,
  });
  assert.equal(await scaling.isChecked(), false);
  const loadsBeforeScaling = await page.evaluate(
    () => window.__messages.filter((message) => message.type === "load").length,
  );
  await scaling.check();
  assert.equal(await page.locator("#mode").inputValue(), "side");
  assert.equal(
    await page.locator('#mode option[value="layout"], #layout-action').count(),
    0,
  );
  assert.equal(
    await page.evaluate(() => window.__state().logicalScaling),
    true,
  );
  const geometry = () =>
    page.locator("canvas").evaluateAll((canvases) =>
      canvases.map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        return {
          width: canvas.width,
          height: canvas.height,
          displayWidth: rect.width,
          displayHeight: rect.height,
          top: rect.top,
        };
      }),
    );
  let pair = await geometry();
  const checkboxRect = await page
    .locator("#logical-scaling-control")
    .boundingBox();
  assert.ok(checkboxRect.y + checkboxRect.height <= pair[0].top);
  assert.deepEqual(
    pair.map((image) => [image.width, image.height]),
    [
      [1440, 875],
      [3456, 2156],
    ],
  );
  assert.ok(Math.abs(pair[0].displayWidth - pair[1].displayWidth) < 1);
  assert.ok(Math.abs(pair[0].top - pair[1].top) < 1);
  for (const image of pair)
    assert.ok(
      Math.abs(
        image.displayHeight / image.displayWidth - image.height / image.width,
      ) < 0.001,
    );
  for (const id of ["#highlight-control", "#tolerance-control", "#changes"])
    assert.equal(await page.locator(id).isVisible(), false);
  assert.doesNotMatch(
    await page.locator("#metrics").textContent(),
    /pixels changed/,
  );
  // A previously enabled pixel highlight must not contaminate layout rendering.
  assert.deepEqual(await pixel("#right-canvas"), [255, 255, 255, 255]);
  // Unchecking returns to original pixel sizes without changing View or reloading.
  await scaling.uncheck();
  await compared();
  assert.equal(await page.locator("#mode").inputValue(), "side");
  assert.deepEqual(
    (await geometry()).map((image) => image.width),
    [3456, 3456],
  );
  assert.equal(await page.locator("#highlight-control").isVisible(), true);
  assert.equal(
    await page.evaluate(() => window.__state().logicalScaling),
    false,
  );
  await scaling.check();
  assert.equal(
    await page.evaluate(
      () =>
        window.__messages.filter((message) => message.type === "load").length,
    ),
    loadsBeforeScaling,
  );
  pair = await geometry();
  const fitWidth = pair[0].displayWidth;
  await page.click("#zoom-in");
  pair = await geometry();
  assert.ok(pair[0].displayWidth > fitWidth);
  assert.ok(Math.abs(pair[0].displayWidth - pair[1].displayWidth) < 1);
  await page.click("#actual");
  pair = await geometry();
  assert.equal(pair[0].displayWidth, 1440);
  assert.equal(pair[1].displayWidth, 1440);
  await page.locator("#left-viewport").evaluate((viewport) => {
    viewport.scrollLeft = 180;
    viewport.scrollTop = 85;
  });
  await page.waitForFunction(() => {
    const left = document.querySelector("#left-viewport"),
      right = document.querySelector("#right-viewport");
    return (
      left.scrollTop === 85 &&
      left.scrollLeft === 180 &&
      right.scrollTop === left.scrollTop &&
      right.scrollLeft === left.scrollLeft
    );
  });
  await page.locator("#right-viewport").evaluate((viewport) => {
    viewport.scrollLeft = 110;
    viewport.scrollTop = 40;
  });
  await page.waitForFunction(
    () =>
      document.querySelector("#left-viewport").scrollTop === 40 &&
      document.querySelector("#left-viewport").scrollLeft === 110,
  );
  // Unrelated Git/focus/watcher events must not decode, redraw, restart workers,
  // hide the panes, or disturb zoom/scroll, even while a refresh is in flight.
  const stableView = () =>
    page.evaluate(() => ({
      activity: { ...window.__activity },
      zoom: document.querySelector("#zoom-percent").value + "%",
      metrics: document.querySelector("#metrics").textContent,
      hidden: document.querySelector("#panes").hidden,
      scroll: ["left", "right"].map((side) => {
        const element = document.querySelector(`#${side}-viewport`);
        return [element.scrollLeft, element.scrollTop];
      }),
    }));
  const stable = await stableView();
  let responses = await page.evaluate(() => {
    const count = window.__responses;
    for (let i = 0; i < 10; i++) window.__snapshot();
    return count;
  });
  await page.waitForFunction(
    (count) => window.__responses === count + 10,
    responses,
  );
  assert.deepEqual(await stableView(), stable);
  responses = await page.evaluate(() => window.__responses);
  await page.click("#refresh");
  await page.waitForFunction((count) => window.__responses > count, responses);
  assert.deepEqual(await stableView(), stable);
  await page.evaluate(() => {
    window.__holdResponses = true;
    window.__snapshot();
  });
  await page.waitForFunction(() => window.__pending.length === 1);
  assert.deepEqual(await stableView(), stable);
  responses = await page.evaluate(() => window.__responses);
  await page.evaluate(() => window.__releaseResponses());
  await page.waitForFunction((count) => window.__responses > count, responses);
  assert.deepEqual(await stableView(), stable);
  await page.click("#fit");
  // Keep the checkbox selected across files without restarting the raw pixel diff.
  await selectFromSidebar("resized-reverse", false);
  await page.waitForFunction(
    () =>
      document.querySelector("#left-canvas").width === 3456 &&
      document.querySelector("#right-canvas").width === 1440,
  );
  pair = await geometry();
  assert.ok(Math.abs(pair[0].displayWidth - pair[1].displayWidth) < 1);
  assert.match(await page.locator("#metrics").textContent(), /Logical scaling/);
  await page.selectOption("#mode", "diff");
  await compared();
  assert.equal(
    await page.locator("#left-canvas").evaluate((canvas) => canvas.width),
    3456,
  );
  assert.equal(await page.locator("#tolerance-control").isVisible(), true);
  // Returning to Side by side restores the checkbox and normalized comparison.
  await page.selectOption("#mode", "side");
  assert.equal(await scaling.isChecked(), true);
  assert.equal(await page.evaluate(() => window.__state().mode), "side");
  assert.equal(
    await page.evaluate(() => window.__state().logicalScaling),
    true,
  );
  await selectFromSidebar("new", false);
  await page.waitForFunction(() =>
    document
      .querySelector("#metrics")
      .textContent.includes("Not present → 720 × 480"),
  );
  assert.equal(await page.locator("#open").isDisabled(), false);
  await selectFromSidebar("resized", false);
  await page.waitForFunction(
    () =>
      document.querySelector("#left-canvas").width === 1440 &&
      document.querySelector("#right-canvas").width === 3456,
  );
  await page.click("#fit");
  await mkdir(path.join(root, ".test-host"), { recursive: true });
  await page.screenshot({
    path: path.join(root, ".test-host", "logical-scaling.png"),
  });
  await page.setViewportSize({ width: 800, height: 600 });
  await page.waitForFunction(
    () =>
      document.querySelector("#left-canvas").getBoundingClientRect().width <
      400,
  );
  pair = await geometry();
  assert.ok(Math.abs(pair[0].displayWidth - pair[1].displayWidth) < 1);
  assert.ok(pair[0].displayWidth < 400);
  await page.setViewportSize({ width: 1440, height: 960 });
  // VS Code can recreate a hidden webview. Restore the chosen scaling then, too.
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector("#metrics").textContent.includes("Logical scaling"),
  );
  assert.equal(await scaling.isChecked(), true);
  assert.equal(await page.locator("#mode").inputValue(), "side");
  pair = await geometry();
  assert.deepEqual(
    pair.map((image) => image.width),
    [1440, 3456],
  );
  assert.ok(Math.abs(pair[0].displayWidth - pair[1].displayWidth) < 1);
  await scaling.uncheck();
  await selectFromSidebar("staged");
  assert.match(await page.locator("#metrics").textContent(), /\(0.00%\)/);
  assert.match(await page.locator("#context").textContent(), /HEAD → Index/);
  await selectFromSidebar("new");
  assert.match(await page.locator("#metrics").textContent(), /100.00%/);
  await selectFromSidebar("deleted");
  assert.equal(await page.locator("#open").isDisabled(), true);
  await selectFromSidebar("error", false);
  await page.waitForFunction(() =>
    document
      .querySelector("#metrics")
      .textContent.includes("Incomplete comparison"),
  );
  assert.match(
    await page.locator("#notice").textContent(),
    /Index: unavailable/,
  );
  await selectFromSidebar("unsafe");
  assert.equal(await page.locator("#filename img").count(), 0);
  assert.equal(
    await page.locator("#filename").textContent(),
    "assets/<img onerror=alert(1)>.svg",
  );
  const oldRequest = await page.evaluate(
    () => window.__messages.filter((m) => m.type === "load").at(-1).request,
  );
  await selectFromSidebar("main");
  await page.evaluate(
    (oldRequest) =>
      window.__emit({
        type: "images",
        id: "unsafe",
        request: oldRequest,
        before: null,
        after: null,
      }),
    oldRequest,
  );
  assert.equal(
    await page.locator("#filename").textContent(),
    "assets/screens/workspace.svg",
  );
  await page.uncheck("#highlight");
  // A real same-file edit is decoded off-screen while the previous view stays
  // visible, then replaces it. A late response for that same file is ignored.
  const originalPair = await page.evaluate(() => window.__getImages("main"));
  const beforeEdit = await stableView();
  await page.evaluate(() => {
    window.__holdResponses = true;
    const [before] = window.__getImages("main");
    window.__updateImages("main", [before, before]);
    window.__snapshot();
  });
  await page.waitForFunction(() => window.__pending.length === 1);
  assert.deepEqual(await stableView(), beforeEdit);
  assert.deepEqual(await pixel("#right-canvas"), [19, 168, 135, 255]);
  await page.evaluate(() => window.__releaseResponses());
  await page.waitForFunction(() =>
    document.querySelector("#metrics").textContent.includes("(0.00%)"),
  );
  assert.deepEqual(await pixel("#right-canvas"), [109, 94, 252, 255]);
  assert.equal(
    (await stableView()).activity.paneHides,
    beforeEdit.activity.paneHides,
  );
  await page.evaluate((pair) => {
    window.__holdResponses = true;
    window.__updateImages("main", [null, null]);
    window.__snapshot();
    // Queue the second snapshot after the first load has reached the mock host.
    window.__restorePair = pair;
  }, originalPair);
  await page.waitForFunction(() => window.__pending.length === 1);
  await page.evaluate(() => {
    window.__updateImages("main", window.__restorePair);
    window.__snapshot();
  });
  await page.waitForFunction(() => window.__pending.length === 2);
  await page.evaluate(() => {
    window.__pending.reverse();
    window.__releaseResponses();
  });
  await page.waitForFunction(() => {
    const pixel = document
      .querySelector("#right-canvas")
      .getContext("2d")
      .getImageData(40, 200, 1, 1).data;
    return pixel[0] === 19 && pixel[1] === 168;
  });
  await compared();
  assert.equal(await page.locator("#panes").isVisible(), true);
  // A status refresh preserves the active comparison without duplicating navigation.
  await selectFromSidebar("staged");
  await page.click("#refresh");
  await compared();
  assert.match(await page.locator("#context").textContent(), /HEAD → Index/);
  await page.evaluate(() => window.__snapshot(undefined, []));
  await page.waitForFunction(() => document.querySelector("#panes").hidden);
  assert.equal(
    await page.locator("#empty strong").textContent(),
    "No changed images",
  );
  await selectFromSidebar("main");
  await page.selectOption("#mode", "side");
  await page.click("#fit");
  await mkdir(path.join(root, ".test-host"), { recursive: true });
  await page.screenshot({ path: path.join(root, ".test-host", "viewer.png") });
  await page.setViewportSize({ width: 800, height: 600 });
  assert.equal(
    await page
      .locator(".review")
      .evaluate((element) => element.getBoundingClientRect().width),
    800,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const completeAction = (request) =>
    page.evaluate(
      (request) =>
        new Promise((resolve) => {
          const done = (event) => {
            if (
              event.data.type !== "actionComplete" ||
              event.data.request !== request
            )
              return;
            window.removeEventListener("message", done);
            resolve();
          };
          window.addEventListener("message", done);
          window.__emit({ type: "actionComplete", request });
        }),
      request,
    );
  // Review navigation/actions use the version actually decoded by the viewer.
  await selectFromSidebar("main");
  assert.ok(
    await page.evaluate(() =>
      window.__messages.some((m) => m.type === "viewed" && m.id === "main"),
    ),
  );
  await page.click("#next");
  await page.waitForFunction(
    () =>
      document.querySelector("#stage").textContent === "Unstage" &&
      !document.querySelector("#stage").disabled,
  );
  assert.equal(await page.locator("#discard").isDisabled(), true);
  await page.click("#stage");
  const action = await page.evaluate(() =>
    window.__messages.filter((m) => m.type === "action").at(-1),
  );
  assert.equal(action.id, "staged");
  assert.equal(action.action, "unstage");
  assert.match(action.revision, /^staged:/);
  assert.equal(await page.locator("#stage").isDisabled(), true);
  // Navigation and actions on the next image remain usable while this one waits.
  assert.equal(await page.locator("#previous").isDisabled(), false);
  await page.click("#previous");
  await compared();
  assert.equal(await page.locator("#stage").isDisabled(), false);
  await page.click("#stage");
  const secondAction = await page.evaluate(() =>
    window.__messages.filter((m) => m.type === "action").at(-1),
  );
  assert.equal(secondAction.id, "main");
  assert.notEqual(secondAction.request, action.request);
  await completeAction(action.request);
  assert.equal(
    await page.locator("#stage").isDisabled(),
    true,
    "Another image's completion must not release this pending action",
  );
  await completeAction(secondAction.request);
  assert.equal(await page.locator("#stage").isDisabled(), false);
  await page.locator("#zoom-percent").fill("150");
  await page.locator("#zoom-percent").press("Tab");
  assert.equal(await page.locator("#zoom-percent").inputValue(), "150");
  await page.click("#fit-width");
  assert.ok(Number(await page.locator("#zoom-percent").inputValue()) > 0);
  await page.locator("#left-viewport").focus();
  await page.keyboard.press("1");
  assert.equal(await page.locator("#zoom-percent").inputValue(), "100");
  await page.keyboard.press("0");
  assert.notEqual(await page.locator("#zoom-percent").inputValue(), "100");
  await page.locator("#left-canvas").dblclick({ position: { x: 20, y: 20 } });
  assert.equal(await page.locator("#zoom-percent").inputValue(), "100");
  await page.check("#highlight");
  await page.locator("#strength").fill("20");
  const faint = await pixel("#right-canvas");
  await page.locator("#strength").fill("90");
  assert.notDeepEqual(await pixel("#right-canvas"), faint);
  assert.equal(await page.evaluate(() => window.__state().strength), "90");
  const statsView = await page.evaluate(() => ({
    draws: window.__activity.draws,
    metrics: document.querySelector("#metrics").textContent,
  }));
  await page.evaluate(() => {
    const [before, after] = window.__getImages("main");
    window.__emit({
      type: "statistics",
      id: "main",
      request: 901,
      revision: "stats-probe",
      before,
      after,
    });
  });
  await page.waitForFunction(() =>
    window.__messages.some(
      (m) => m.type === "statisticsResult" && m.request === 901,
    ),
  );
  const stats = await page.evaluate(() =>
    window.__messages.find(
      (m) => m.type === "statisticsResult" && m.request === 901,
    ),
  );
  assert.equal(stats.error, undefined);
  assert.equal(stats.total, 720 * 480);
  assert.ok(stats.changed > 0);
  assert.deepEqual(
    await page.evaluate(() => ({
      draws: window.__activity.draws,
      metrics: document.querySelector("#metrics").textContent,
    })),
    statsView,
  );
  await page.click("#ignore");
  const ignoreAction = await page.evaluate(() =>
    window.__messages.filter((m) => m.type === "action").at(-1),
  );
  assert.equal(ignoreAction.action, "ignore");
  assert.equal(ignoreAction.id, "main");
  await completeAction(ignoreAction.request);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.click("#fit");
  await page.screenshot({
    path: path.join(root, ".test-host", "viewer-parity.png"),
  });
  // Older saved Layout settings migrate to the visible checkbox.
  await page.evaluate(() =>
    sessionStorage.setItem(
      "viewer-state",
      JSON.stringify({ activeId: "resized", mode: "layout" }),
    ),
  );
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector("#metrics").textContent.includes("Logical scaling"),
  );
  assert.equal(await page.locator("#mode").inputValue(), "side");
  assert.equal(await scaling.isChecked(), true);
  assert.equal(
    await page.evaluate(() => window.__state().logicalScaling),
    true,
  );
  await scaling.uncheck();
  await compared();
  await page.reload();
  await compared();
  assert.equal(await scaling.isChecked(), false);
  assert.equal(
    await page.locator("#left-canvas").evaluate((canvas) => canvas.width),
    3456,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: browser UI — queued actions with continued navigation and correlated completions, revision-bound actions, previous/next, numeric zoom, Fit Width, double-click, shortcuts, highlight intensity, background counts without redraw, logical scaling, stable refreshes, all modes and responsive layout.",
  );
  if (process.argv.includes("--screenshots")) {
    const { captureReadme } = await import("./readme-ui.mjs");
    await captureReadme(page, root);
    assert.deepEqual(errors, []);
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
