import { comparePixels } from "./diff.mjs";

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const saved = vscode.getState() ?? {};
const modes = ["side", "swipe", "overlay", "diff", "blink", "before", "after"];
let items = [],
  activeId = saved.activeId;
let request = 0,
  revision,
  before = null,
  after = null,
  loaded = false,
  newImage = false,
  diff = null,
  mask = null,
  bounds = null;
let width = 1,
  height = 1,
  scale = 1,
  zoomMode = "fit",
  worker,
  workerUrl,
  toleranceTimer,
  blinkTimer,
  blinkAfter = false;
let syncing = false,
  drag = null,
  comparisonValid = true;
let rawMetrics = "";
const pendingActions = new Map();
let actionRequest = 0;
let statisticsWorker;
let statisticsTasks = Promise.resolve();
const canvases = [$("left-canvas"), $("right-canvas")];
const viewports = [$("left-viewport"), $("right-viewport")];
const surfaces = viewports.map((viewport) =>
  viewport.querySelector(".surface"),
);
const isLogicalScaling = () =>
  !newImage && $("mode").value === "side" && $("logical-scaling").checked;
const primaryIndex = () => (newImage ? 1 : 0);
const current = () => items.find((item) => item.id === activeId);
const dimensions = (image) =>
  image ? `${image.width} × ${image.height}` : "Not present";
const save = () =>
  vscode.setState({
    activeId,
    mode: $("mode").value,
    logicalScaling: $("logical-scaling").checked,
    mix: $("mix").value,
    highlight: $("highlight").checked,
    strength: $("strength").value,
    background: $("background").value,
    tolerance: $("tolerance").value,
  });

$("mode").value = modes.includes(saved.mode) ? saved.mode : "side";
// Restore the former Layout view as Side by side with logical scaling enabled.
$("logical-scaling").checked =
  saved.logicalScaling === true || saved.mode === "layout";
let previousScaling = isLogicalScaling();
$("mix").value = saved.mix ?? "50";
$("highlight").checked = saved.highlight === true;
$("strength").value = saved.strength ?? "60";
$("background").value = ["checker", "dark", "light"].includes(saved.background)
  ? saved.background
  : "checker";
$("tolerance").value = String(
  Math.max(0, Math.min(255, Math.floor(Number(saved.tolerance) || 0))),
);
updateTolerance();
document.body.dataset.background = $("background").value;

function updateTolerance() {
  const value = Number($("tolerance").value);
  $("tolerance-value").value = String(value);
  $("tolerance").setAttribute(
    "aria-valuetext",
    value === 0
      ? "Exact: detect every difference"
      : `${value} of 255: ignore color and transparency differences up to this threshold`,
  );
}

function notice(text = "") {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}
function cancelDiff() {
  clearTimeout(toleranceTimer);
  toleranceTimer = undefined;
  worker?.terminate();
  worker = undefined;
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = undefined;
}
function clear(resetCanvases = true) {
  cancelDiff();
  clearInterval(blinkTimer);
  blinkTimer = undefined;
  before = after = diff = mask = bounds = null;
  rawMetrics = "";
  loaded = false;
  newImage = false;
  revision = undefined;
  $("changes").disabled = true;
  for (const canvas of resetCanvases ? canvases : []) {
    canvas.width = 1;
    canvas.height = 1;
  }
}
function empty(title, description) {
  $("panes").hidden = true;
  $("empty").hidden = false;
  $("empty").querySelector("strong").textContent = title;
  $("empty").querySelector("p").textContent = description;
}
function select(id, reload = true) {
  if (activeId !== id) {
    clear();
    notice();
  }
  activeId = id;
  save();
  const item = current();
  updateActions();
  $("open").disabled = !item || item.afterLabel === "Not present";
  if (!item) {
    $("filename").textContent = "Image changes, in focus.";
    $("context").textContent = "Choose an image in the FF Git Image sidebar.";
    $("metrics").textContent = "";
    empty(
      items.length ? "Choose an image" : "No changed images",
      items.length
        ? "Choose an image in the FF Git Image sidebar. Use Images above to open it."
        : "Open a Git repository and change an image. Check .image_ignore for excluded images, or use Refresh to update Git status.",
    );
    return;
  }
  $("filename").textContent = item.path;
  $("context").textContent =
    `${item.repository} · ${item.status} · ${item.beforeLabel} → ${item.afterLabel}${item.previousPath ? ` · from ${item.previousPath}` : ""}`;
  // Keep the current comparison visible while checking for new image bytes.
  if (revision === undefined) {
    $("metrics").textContent = "Loading image versions…";
    empty("Loading comparison…", item.path);
  }
  if (reload) {
    request++;
    vscode.postMessage({ type: "load", id, request, revision });
  }
}

async function decode(payload) {
  if (!payload?.data) return null;
  const image = new Image();
  image.src = payload.data;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight)
    throw new Error("Image has no intrinsic dimensions.");
  if (
    image.naturalWidth * image.naturalHeight > 16_000_000 ||
    image.naturalWidth > 16384 ||
    image.naturalHeight > 16384
  ) {
    throw new Error(
      "Preview supports up to 16 million pixels and 16,384 pixels per dimension.",
    );
  }
  // Freeze a decoded frame so animated formats do not change during comparison.
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas;
}

window.addEventListener("message", async (event) => {
  const data = event.data;
  if (data.type === "statistics") {
    statisticsTasks = statisticsTasks.then(() => calculateStatistics(data));
    return;
  } else if (data.type === "actionComplete") {
    pendingActions.delete(data.request);
    updateActions();
    return;
  } else if (data.type === "snapshot") {
    const previousIndex = Math.max(
      0,
      items.findIndex((item) => item.id === activeId),
    );
    items = data.changes;
    $("summary").textContent = `${items.length} image changes`;
    const next =
      data.selected ??
      (items.some((item) => item.id === activeId)
        ? activeId
        : items[Math.min(previousIndex, items.length - 1)]?.id);
    select(
      next,
      next !== activeId || !revision || current()?.revision !== revision,
    );
    if (data.notice) notice(data.notice);
  } else if (data.type === "images") {
    if (data.request !== request || data.id !== activeId) return;
    if (data.unchanged) {
      vscode.postMessage({ type: "viewed", id: activeId, revision });
      updateActions();
      return;
    }
    const myRequest = request;
    const results = await Promise.allSettled([
      decode(data.before),
      decode(data.after),
    ]);
    if (myRequest !== request) return;
    // Commit the decoded pair together; do not collapse the visible canvases.
    clear(false);
    revision = data.revision;
    const errors = [
      data.before?.error,
      data.after?.error,
      ...results.map((result, i) =>
        result.status === "rejected"
          ? `${i ? "After" : "Before"}: ${result.reason.message ?? result.reason}`
          : "",
      ),
    ].filter(Boolean);
    comparisonValid = errors.length === 0;
    [before, after] = results.map((result) =>
      result.status === "fulfilled" ? result.value : null,
    );
    notice(
      errors.join("\n") ||
        (current()?.scope === "conflict"
          ? "Merge conflict: showing HEAD and the working image. Resolve the conflict in Source Control."
          : ""),
    );
    width = Math.max(before?.width ?? 0, after?.width ?? 0);
    height = Math.max(before?.height ?? 0, after?.height ?? 0);
    if (!width || !height || width * height > 16_000_000) {
      empty(
        "Preview unavailable",
        errors.join("\n") ||
          "The combined image area exceeds 16 million pixels.",
      );
      $("metrics").textContent = "Comparison unavailable";
      return;
    }
    loaded = true;
    // Only an explicitly added, readable image has no before pane. A failed
    // before decode or a merge conflict must keep the comparison and its notice.
    newImage =
      comparisonValid &&
      current()?.status === "Added" &&
      current()?.beforeLabel === "Not present" &&
      !before && !!after;
    $("empty").hidden = true;
    $("panes").hidden = false;
    rawMetrics = comparisonValid
      ? "Comparing pixels…"
      : "Incomplete comparison — one version could not be read.";
    render();
    startBlink();
    vscode.postMessage({ type: "viewed", id: activeId, revision });
    updateActions();
    if (comparisonValid && !isLogicalScaling() && !newImage) calculate();
  } else if (data.type === "error") notice(data.message);
});

function raster(image) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (image) ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, width, height).data;
}
function calculate() {
  cancelDiff();
  diff = mask = bounds = null;
  $("changes").disabled = true;
  if (!loaded || !comparisonValid || isLogicalScaling() || newImage) return;
  rawMetrics = "Comparing pixels…";
  $("metrics").textContent = rawMetrics;
  const tolerance = Math.max(
    0,
    Math.min(255, Number($("tolerance").value) || 0),
  );
  $("tolerance").value = String(tolerance);
  const beforePixels = raster(before),
    afterPixels = raster(after);
  workerUrl = URL.createObjectURL(
    new Blob(
      [
        `const compare = ${comparePixels.toString()}; self.onmessage = event => { const result = compare(event.data); self.postMessage(result, [result.diff.buffer, result.mask.buffer]); };`,
      ],
      { type: "text/javascript" },
    ),
  );
  const diffWorker = (worker = new Worker(workerUrl));
  worker.onmessage = (event) => {
    if (worker !== diffWorker) return;
    const result = event.data;
    const toCanvas = (pixels) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas
        .getContext("2d")
        .putImageData(new ImageData(pixels, width, height), 0, 0);
      return canvas;
    };
    diff = toCanvas(result.diff);
    mask = toCanvas(result.mask);
    bounds = result.bounds;
    $("changes").disabled = !bounds;
    rawMetrics = `${dimensions(before)} → ${dimensions(after)} · ${result.changed.toLocaleString()} / ${result.total.toLocaleString()} pixels changed (${(result.total ? (result.changed / result.total) * 100 : 0).toFixed(2)}%)${tolerance ? ` · color threshold ${tolerance}` : ""}`;
    cancelDiff();
    render();
  };
  worker.onerror = () => {
    if (worker !== diffWorker) return;
    cancelDiff();
    rawMetrics = "Pixel comparison failed. Other view modes remain available.";
    render();
  };
  worker.postMessage(
    {
      before: beforePixels,
      after: afterPixels,
      beforeSize: { width: before?.width ?? 0, height: before?.height ?? 0 },
      afterSize: { width: after?.width ?? 0, height: after?.height ?? 0 },
      width,
      height,
      tolerance,
    },
    [beforePixels.buffer, afterPixels.buffer],
  );
}

// Layout coordinates share a width; source pixels and their aspect ratios stay intact.
function geometry() {
  if (!isLogicalScaling()) return { width, height, factors: [1, 1] };
  const images = [before, after];
  const commonWidth = Math.min(
    ...images.filter(Boolean).map((image) => image.width),
  );
  const factors = images.map((image) =>
    image ? commonWidth / image.width : 1,
  );
  return {
    width: commonWidth,
    height: Math.max(
      ...images.map((image, index) => (image?.height ?? 0) * factors[index]),
    ),
    factors,
  };
}

function render() {
  const mode = $("mode").value,
    layout = isLogicalScaling(),
    side = mode === "side" && !newImage,
    mix = Number($("mix").value) / 100;
  $("comparison-toolbar").hidden = newImage;
  $("new-badge").hidden = !newImage;
  $("mix-control").hidden = !["swipe", "overlay"].includes(mode);
  $("mix-label").textContent = mode === "swipe" ? "Position" : "Opacity";
  $("mix-value").textContent = `${Math.round(mix * 100)}%`;
  $("logical-scaling-control").hidden = !side;
  $("highlight-control").hidden = layout || !["side", "after"].includes(mode);
  $("strength-control").hidden =
    $("highlight-control").hidden || !$("highlight").checked;
  $("tolerance-control").hidden = layout;
  $("changes").hidden = layout || newImage;
  $("actual").textContent = layout ? "100%" : "1:1";
  $("actual").title = layout
    ? "Use the smaller image's width for both versions"
    : "Show actual pixels";
  $("zoom").title = layout
    ? "Zoom relative to the smaller image's width"
    : "Image zoom";
  $("panes").classList.toggle("single", !side);
  $("panes").classList.toggle("layout", layout);
  $("left-pane").hidden = newImage;
  $("right-pane").hidden = !side && !newImage;
  if (!loaded) return;
  const view = geometry();
  const item = current();
  const viewport = viewports[primaryIndex()];
  const label =
    side || mode === "before"
      ? item.beforeLabel
      : mode === "after"
        ? item.afterLabel
        : mode === "diff"
          ? "Changed pixels in pink"
          : mode === "swipe"
            ? `${item.beforeLabel} ← | → ${item.afterLabel}`
            : mode === "blink"
              ? blinkAfter
                ? item.afterLabel
                : item.beforeLabel
              : `${item.afterLabel} over ${item.beforeLabel}`;
  $("left-label").textContent = label;
  $("right-label").textContent = item.afterLabel;
  $("left-size").textContent =
    side || mode === "before"
      ? dimensions(before)
      : mode === "after"
        ? dimensions(after)
        : `${width} × ${height}`;
  $("right-size").textContent = dimensions(after);
  if (zoomMode === "fit" || zoomMode === "width")
    scale = Math.min(
      1,
      Math.max(
        0.01,
        Math.min(
          ((layout
            ? Math.min(...viewports.map((viewport) => viewport.clientWidth))
            : viewport.clientWidth) -
            48) /
            view.width,
          zoomMode === "width"
            ? 16
            : (viewport.clientHeight - 48) / view.height,
        ),
      ),
    );
  $("zoom-percent").value = String(Math.round(scale * 100));
  const sourceZoom = (index) =>
    `${Math.round(scale * view.factors[index] * 100)}%`;
  if (layout) {
    $("left-size").textContent =
      `${dimensions(before)}${before ? ` · ${sourceZoom(0)}` : ""}`;
    $("right-size").textContent =
      `${dimensions(after)}${after ? ` · ${sourceZoom(1)}` : ""}`;
    $("metrics").textContent =
      `Logical scaling · Equal width, original proportions · ${dimensions(before)} → ${dimensions(after)}${comparisonValid ? "" : " · One version unavailable"}`;
  } else if (newImage) {
    $("metrics").textContent = `${dimensions(after)} · New image`;
  } else {
    $("metrics").textContent = rawMetrics;
  }
  for (const [index, surface] of surfaces.entries()) {
    // Matching scroll extents keep logical positions in sync when aspect ratios differ.
    surface.style.minHeight = layout
      ? `${Math.max(viewports[index].clientHeight, Math.ceil(view.height * scale) + 48)}px`
      : "";
  }
  const draw = (ctx, image) => {
    if (image) ctx.drawImage(image, 0, 0);
  };
  const highlight = (ctx) => {
    if (mask && $("highlight").checked) {
      ctx.globalAlpha = Number($("strength").value) / 100;
      draw(ctx, mask);
      ctx.globalAlpha = 1;
    }
  };
  for (const [index, canvas] of canvases.entries()) {
    if (newImage ? index === 0 : index === 1 && !side) continue;
    const image = index ? after : before;
    const canvasWidth = layout ? (image?.width ?? view.width) : width;
    const canvasHeight = layout
      ? (image?.height ?? Math.ceil(view.height))
      : height;
    if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
    if (canvas.height !== canvasHeight) canvas.height = canvasHeight;
    const sourceScale = scale * view.factors[index];
    canvas.style.width = `${canvasWidth * sourceScale}px`;
    canvas.style.height = `${canvasHeight * sourceScale}px`;
    canvas.classList.toggle("pixelated", !layout && scale >= 2);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    if (newImage) {
      draw(ctx, after);
    } else if (side) {
      draw(ctx, index ? after : before);
      if (index && !layout) highlight(ctx);
    } else if (mode === "before" || mode === "after" || mode === "blink") {
      const newVersion = mode === "after" || (mode === "blink" && blinkAfter);
      draw(ctx, newVersion ? after : before);
      if (mode === "after") highlight(ctx);
    } else if (mode === "diff") draw(ctx, diff);
    else if (mode === "overlay") {
      draw(ctx, before);
      ctx.globalAlpha = mix;
      draw(ctx, after);
      ctx.globalAlpha = 1;
    } else if (mode === "swipe") {
      draw(ctx, before);
      ctx.save();
      ctx.beginPath();
      ctx.rect(width * mix, 0, width * (1 - mix), height);
      ctx.clip();
      ctx.clearRect(0, 0, width, height);
      draw(ctx, after);
      ctx.restore();
      ctx.strokeStyle = "#60c9b6";
      ctx.lineWidth = 1 / scale;
      ctx.beginPath();
      ctx.moveTo(width * mix, 0);
      ctx.lineTo(width * mix, height);
      ctx.stroke();
    }
  }
}

function zoom(next, clientX, clientY) {
  if (!loaded) return;
  const index = primaryIndex();
  const viewport = viewports[index],
    rect = canvases[index].getBoundingClientRect(),
    viewportRect = viewport.getBoundingClientRect();
  const x = clientX ?? viewportRect.left + viewport.clientWidth / 2,
    y = clientY ?? viewportRect.top + viewport.clientHeight / 2;
  const imageX = (x - rect.left) / scale,
    imageY = (y - rect.top) / scale;
  scale = Math.max(0.01, Math.min(16, next));
  zoomMode = "manual";
  render();
  const updated = canvases[index].getBoundingClientRect();
  viewport.scrollLeft += updated.left + imageX * scale - x;
  viewport.scrollTop += updated.top + imageY * scale - y;
  synchronize(viewport);
}
function synchronize(source) {
  if (syncing || source.closest(".pane").hidden) return;
  syncing = true;
  for (const viewport of viewports)
    if (viewport !== source && !viewport.closest(".pane").hidden) {
      viewport.scrollLeft = source.scrollLeft;
      viewport.scrollTop = source.scrollTop;
    }
  syncing = false;
}
function startBlink() {
  clearInterval(blinkTimer);
  blinkTimer = undefined;
  if (loaded && !newImage && $("mode").value === "blink" && !document.hidden)
    blinkTimer = setInterval(() => {
      blinkAfter = !blinkAfter;
      render();
    }, 650);
}
for (const viewport of viewports) {
  viewport.tabIndex = 0;
  viewport.addEventListener("scroll", () => synchronize(viewport));
  viewport.addEventListener("dblclick", (event) => {
    if (!loaded) return;
    const imageRect = viewport.querySelector("canvas").getBoundingClientRect();
    if (
      event.clientX < imageRect.left ||
      event.clientX > imageRect.right ||
      event.clientY < imageRect.top ||
      event.clientY > imageRect.bottom
    )
      return;
    if (Math.abs(scale - 1) < 0.01) {
      zoomMode = "fit";
      render();
    } else {
      const rect = viewport.getBoundingClientRect(),
        left = viewports[primaryIndex()].getBoundingClientRect();
      zoom(1, left.left + event.clientX - rect.left, event.clientY);
    }
  });
  viewport.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect(),
        left = viewports[primaryIndex()].getBoundingClientRect();
      zoom(
        scale * Math.exp(-event.deltaY * 0.008),
        left.left + event.clientX - rect.left,
        event.clientY,
      );
    },
    { passive: false },
  );
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !loaded) return;
    const rect = canvases[0].getBoundingClientRect();
    const swipe =
      !newImage &&
      $("mode").value === "swipe" &&
      Math.abs(
        event.clientX -
          rect.left -
          (width * scale * Number($("mix").value)) / 100,
      ) < 14;
    drag = {
      viewport,
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      swipe,
    };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("dragging");
    event.preventDefault();
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!loaded) return;
    const canvas = viewport.querySelector("canvas"),
      rect = canvas.getBoundingClientRect();
    const x = Math.floor(
        ((event.clientX - rect.left) * canvas.width) / rect.width,
      ),
      y = Math.floor(
        ((event.clientY - rect.top) * canvas.height) / rect.height,
      );
    $("position").textContent =
      x >= 0 && y >= 0 && x < canvas.width && y < canvas.height
        ? `${x}, ${y} px`
        : "";
    if (!drag || drag.viewport !== viewport) return;
    if (drag.swipe) {
      $("mix").value = String(
        Math.max(
          0,
          Math.min(100, ((event.clientX - rect.left) / (width * scale)) * 100),
        ),
      );
      render();
      save();
    } else {
      viewport.scrollLeft = drag.left + drag.x - event.clientX;
      viewport.scrollTop = drag.top + drag.y - event.clientY;
    }
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    viewport.addEventListener(type, () => {
      drag = null;
      viewport.classList.remove("dragging");
    });
}
function changeMode() {
  if (previousScaling !== isLogicalScaling()) zoomMode = "fit";
  previousScaling = isLogicalScaling();
  if (isLogicalScaling()) cancelDiff();
  render();
  startBlink();
  if (
    loaded && comparisonValid && !isLogicalScaling() &&
    !newImage && !diff && !worker
  )
    calculate();
  save();
}
$("mode").addEventListener("change", changeMode);
$("logical-scaling").addEventListener("change", changeMode);
for (const id of ["mix", "highlight", "strength"])
  $(id).addEventListener("input", () => {
    render();
    save();
  });
$("tolerance").addEventListener("input", () => {
  updateTolerance();
  cancelDiff();
  diff = mask = bounds = null;
  $("changes").disabled = true;
  if (loaded && comparisonValid && !isLogicalScaling()) {
    rawMetrics = "Comparing pixels…";
    $("metrics").textContent = rawMetrics;
  }
  // Coalesce drag events instead of allocating pixel buffers/starting a worker
  // for every pointer movement. Switching images or modes cancels this work.
  toleranceTimer = setTimeout(() => {
    calculate();
    render();
  }, 120);
  save();
});
$("background").addEventListener("change", () => {
  document.body.dataset.background = $("background").value;
  save();
});
$("fit").addEventListener("click", () => {
  zoomMode = "fit";
  render();
});
$("actual").addEventListener("click", () => zoom(1));
$("zoom-in").addEventListener("click", () => zoom(scale * 1.25));
$("zoom-out").addEventListener("click", () => zoom(scale / 1.25));
$("changes").addEventListener("click", () => {
  if (!bounds) return;
  zoom(
    Math.min(
      16,
      (viewports[0].clientWidth - 80) / bounds.width,
      (viewports[0].clientHeight - 80) / bounds.height,
    ),
  );
  const rect = canvases[0].getBoundingClientRect(),
    viewport = viewports[0],
    frame = viewport.getBoundingClientRect();
  viewport.scrollLeft +=
    rect.left -
    frame.left +
    (bounds.x + bounds.width / 2) * scale -
    viewport.clientWidth / 2;
  viewport.scrollTop +=
    rect.top -
    frame.top +
    (bounds.y + bounds.height / 2) * scale -
    viewport.clientHeight / 2;
  synchronize(viewport);
});
$("show-sidebar").addEventListener("click", () =>
  vscode.postMessage({ type: "showSidebar" }),
);
$("refresh").addEventListener("click", () =>
  vscode.postMessage({ type: "refresh" }),
);
$("open").addEventListener("click", () =>
  vscode.postMessage({ type: "open", id: activeId }),
);
function updateActions() {
  const item = current(),
    index = items.findIndex((item) => item.id === activeId);
  const actionBusy = [...pendingActions.values()].includes(activeId);
  const ready = loaded && comparisonValid && !!revision && !actionBusy;
  $("previous").disabled = index <= 0;
  $("next").disabled = index < 0 || index >= items.length - 1;
  $("stage").textContent = item?.scope === "staged" ? "Unstage" : "Stage";
  $("stage").disabled =
    !ready || !item || item.ignored || item.scope === "conflict";
  $("discard").disabled =
    !ready || !item || item.ignored || item.scope !== "working";
  $("ignore").textContent = item?.ignored ? "Stop ignoring" : "Ignore";
  $("ignore").disabled = !revision || !item || actionBusy;
}
function step(direction) {
  const index = items.findIndex((item) => item.id === activeId);
  const item = items[index + direction];
  if (!item) return;
  select(item.id);
  vscode.postMessage({ type: "reveal", id: item.id });
}
function act(action) {
  if (
    !revision ||
    !current() ||
    [...pendingActions.values()].includes(activeId)
  )
    return;
  const request = ++actionRequest;
  pendingActions.set(request, activeId);
  updateActions();
  vscode.postMessage({
    type: "action",
    action,
    id: activeId,
    revision,
    request,
  });
}
$("previous").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
$("stage").addEventListener("click", () =>
  act(current()?.scope === "staged" ? "unstage" : "stage"),
);
$("discard").addEventListener("click", () => act("discard"));
$("ignore").addEventListener("click", () =>
  act(current()?.ignored ? "unignore" : "ignore"),
);
$("zoom-percent").addEventListener("change", () =>
  zoom(Math.max(1, Number($("zoom-percent").value) || 100) / 100),
);
$("fit-width").addEventListener("click", () => {
  zoomMode = "width";
  render();
});
document.addEventListener("keydown", (event) => {
  if (
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(event.target.tagName)
  )
    return;
  if (["ArrowLeft", "ArrowRight", "+", "=", "-", "0", "1"].includes(event.key))
    event.preventDefault();
  if (event.key === "ArrowLeft") step(-1);
  if (event.key === "ArrowRight") step(1);
  if (event.key === "+" || event.key === "=") zoom(scale * 1.25);
  if (event.key === "-") zoom(scale / 1.25);
  if (event.key === "0") {
    zoomMode = "fit";
    render();
  }
  if (event.key === "1") zoom(1);
});

async function calculateStatistics(data) {
  let url;
  try {
    if (data.before?.error || data.after?.error)
      throw new Error(data.before?.error ?? data.after.error);
    const first = await decode(data.before),
      second = await decode(data.after);
    const width = Math.max(first?.width ?? 0, second?.width ?? 0);
    const height = Math.max(first?.height ?? 0, second?.height ?? 0);
    if (!width || !height || width * height > 16_000_000)
      throw new Error("Comparison unavailable or too large");
    const pixels = (image) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (image) context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, width, height).data;
    };
    const before = pixels(first),
      after = pixels(second);
    url = URL.createObjectURL(
      new Blob(
        [
          `const compare = ${comparePixels.toString()}; self.onmessage = event => { const {changed,total} = compare(event.data); self.postMessage({changed,total}); };`,
        ],
        { type: "text/javascript" },
      ),
    );
    const result = await new Promise((resolve, reject) => {
      statisticsWorker = new Worker(url);
      const timer = setTimeout(
        () => reject(new Error("Pixel comparison timed out")),
        15000,
      );
      statisticsWorker.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      statisticsWorker.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Pixel comparison failed"));
      };
      statisticsWorker.postMessage(
        {
          before,
          after,
          width,
          height,
          countsOnly: true,
          beforeSize: { width: first?.width ?? 0, height: first?.height ?? 0 },
          afterSize: { width: second?.width ?? 0, height: second?.height ?? 0 },
        },
        [before.buffer, after.buffer],
      );
    });
    vscode.postMessage({
      type: "statisticsResult",
      id: data.id,
      request: data.request,
      revision: data.revision,
      ...result,
    });
  } catch (error) {
    vscode.postMessage({
      type: "statisticsResult",
      id: data.id,
      request: data.request,
      revision: data.revision,
      error: String(error),
    });
  } finally {
    statisticsWorker?.terminate();
    statisticsWorker = undefined;
    if (url) URL.revokeObjectURL(url);
  }
}
new ResizeObserver(() => {
  if (zoomMode === "fit" || zoomMode === "width" || isLogicalScaling())
    render();
}).observe($("viewer"));
document.addEventListener("visibilitychange", startBlink);
window.addEventListener("pagehide", () => {
  cancelDiff();
  statisticsWorker?.terminate();
  clearInterval(blinkTimer);
});
render();
vscode.postMessage({ type: "ready" });
