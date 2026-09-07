// Real extension host + Git filesystem. menu-ui.mjs can hold the actual tree
// context menu open while status and pixel results arrive through production APIs.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const vscode = require("vscode");
const { png } = require("./performance-host.cjs");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 30000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await pause(100);
  }
}

exports.run = async () => {
  const git = await vscode.extensions.getExtension("vscode.git").activate();
  const api = git.getAPI(1);
  await until(() => api.repositories.length, "repository");
  const repo = api.repositories[0];
  const root = repo.rootUri.fsPath;
  const before = png(123),
    after = png(456);
  const names = Array.from(
    { length: 32 },
    (_, i) => `performance/screen${i}.png`,
  );
  fs.mkdirSync(path.join(root, "performance"));
  for (const name of names) fs.writeFileSync(path.join(root, name), before);
  const command = (...args) => execFileSync("git", args, { cwd: root });
  command("add", "--", "performance");
  command(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--only",
    "-qm",
    "Model fixture",
    "--",
    "performance",
  );
  for (const name of names) fs.writeFileSync(path.join(root, name), after);
  await repo.status();

  let sidebar,
    tree,
    counting = false;
  const counts = {
    reads: 0,
    bytes: 0,
    snapshots: 0,
    statistics: 0,
    treeRefreshes: 0,
    decorations: 0,
  };
  const countedFs = {
    ...vscode.workspace.fs,
    readFile: async (uri) => {
      const data = await vscode.workspace.fs.readFile(uri);
      if (counting && uri.fsPath.includes("/performance/")) {
        counts.reads++;
        counts.bytes += data.length;
      }
      return data;
    },
  };
  const shimWindow = new Proxy(vscode.window, {
    get(target, key) {
      if (key === "createTreeView")
        return (id, options) => {
          sidebar = options.treeDataProvider;
          return (tree = target.createTreeView(id, options));
        };
      if (key === "createWebviewPanel")
        return (...args) => {
          const panel = target.createWebviewPanel(...args);
          const webview = new Proxy(panel.webview, {
            get(target, key) {
              if (key === "postMessage")
                return (message) => {
                  if (counting && message.type === "snapshot")
                    counts.snapshots++;
                  if (counting && message.type === "statistics")
                    counts.statistics++;
                  return target.postMessage(message);
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
            set(target, key, value) {
              return Reflect.set(target, key, value, target);
            },
          });
          return new Proxy(panel, {
            get(target, key) {
              const value =
                key === "webview" ? webview : Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
            set(target, key, value) {
              return Reflect.set(target, key, value, target);
            },
          });
        };
      return Reflect.get(target, key);
    },
  });
  const shim = new Proxy(vscode, {
    get(target, key) {
      if (key === "window") return shimWindow;
      if (key === "workspace")
        return new Proxy(target.workspace, {
          get(target, key) {
            return key === "fs" ? countedFs : Reflect.get(target, key);
          },
        });
      return Reflect.get(target, key);
    },
  });
  const load = Module._load;
  Module._load = function (name, ...args) {
    return name === "vscode" ? shim : load.call(this, name, ...args);
  };
  try {
    await vscode.extensions.getExtension("gornivv.ff-git-image").activate();
  } finally {
    Module._load = load;
  }
  assert.ok(sidebar, "Capture the production provider");
  const selectedUri = vscode.Uri.file(path.join(root, names[0]));
  await vscode.commands.executeCommand("workbench.view.extension.ff_git_image");
  await vscode.commands.executeCommand(
    "ff_git_image.openFile",
    selectedUri,
    "working",
    true,
  );
  await until(
    () =>
      sidebar
        .leaves()
        .every((node) => node.metrics.ready || node.metrics.errors),
    "background worker results",
    60000,
  );
  const node = sidebar.findFile(selectedUri, "working");
  assert.ok(node.change.revision, node.change.revisionError);
  assert.ok(
    node.metrics.ready,
    JSON.stringify(sidebar.statistics.get(node.change.revision)),
  );
  const roots = sidebar.getChildren();
  await tree.reveal(node, { select: true, focus: true });
  await pause(800);
  const events = [
    sidebar.onDidChangeTreeData(() => {
      if (counting) counts.treeRefreshes++;
    }),
    sidebar.onDidChangeFileDecorations(() => {
      if (counting) counts.decorations++;
    }),
  ];
  const control = process.env.FF_GIT_IMAGE_MENU_CONTROL;
  if (control) {
    fs.writeFileSync(path.join(control, "ready"), "screen0.png");
    await until(
      () => fs.existsSync(path.join(control, "opened")),
      "menu opened",
    );
  }
  counting = true;
  const start = performance.now();
  for (let tick = 0; tick < 4; tick++) {
    await repo.status();
    // Simulate delayed worker progress through the production result cache.
    sidebar.statistics.set(node.change.revision, {
      changed: tick + 1,
      total: 100,
    });
    await pause(450);
  }
  const warm = { ...counts, elapsedMs: performance.now() - start };
  assert.equal(sidebar.getChildren(), roots);
  assert.equal(sidebar.findFile(selectedUri, "working"), node);
  assert.equal(
    warm.reads,
    0,
    "Status and pixel updates must not reread unchanged PNGs",
  );
  assert.equal(
    warm.treeRefreshes,
    0,
    "Metrics must never refresh native tree handles",
  );
  assert.equal(warm.snapshots, 0);
  assert.equal(warm.statistics, 0, "Cached pixels must not be recalculated");
  assert.ok(
    warm.decorations > 0,
    JSON.stringify({
      warm,
      generation: sidebar.generation,
      nodeGeneration: node.generation,
      linked: sidebar.metricNodes.get(node.change.revision)?.size,
      dirty: sidebar.dirtyDecorations.size,
      metrics: node.metrics,
      decoration: sidebar.provideFileDecoration(node.resourceUri),
    }),
  );
  if (control) {
    fs.writeFileSync(path.join(control, "updated"), JSON.stringify(warm));
    await until(
      () => fs.existsSync(path.join(control, "checked")),
      "menu remained open",
    );
  }
  for (const key of Object.keys(counts)) counts[key] = 0;
  const revision = node.change.revision;
  fs.writeFileSync(selectedUri.fsPath, png(789));
  await until(
    () => node.change.revision !== revision,
    "one changed image discovered by watcher",
  );
  await until(() => node.metrics.ready, "one image pixel results");
  await pause(600);
  const edited = { ...counts };
  assert.equal(
    edited.reads,
    1,
    "Only the changed working image is read; index bytes are shared",
  );
  assert.equal(edited.treeRefreshes, 0);
  assert.equal(edited.statistics, 1);
  assert.equal(sidebar.findFile(selectedUri, "working"), node);
  if (control) {
    fs.writeFileSync(path.join(control, "edited"), JSON.stringify(edited));
    await until(
      () => fs.existsSync(path.join(control, "editChecked")),
      "folder menu remained open after image edit",
    );
  }
  const report = {
    vscode: vscode.version,
    files: names.length,
    bytesPerImage: after.length,
    warm,
    edited,
  };
  fs.writeFileSync(
    path.join(__dirname, "model-performance-0.1.13.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  events.forEach((event) => event.dispose());
  console.log("PASS: native model/cache/worker", JSON.stringify(report));
  fs.writeFileSync(process.env.FF_GIT_IMAGE_TEST_RESULT, "passed");
};
