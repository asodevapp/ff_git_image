import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { ImageChange, mimeType, publicChange, Scope } from "./changes";
import { GitAPI, GitExtension } from "./git-api";
import {
  ImageChangesTree,
  ImageTreeItem,
  imageQuickPicks,
  sidebarViewId,
} from "./sidebar";
import { ImageIgnore } from "./image-ignore";
import { ImageAction, ImageActions } from "./actions";
import { ImageStatistics } from "./statistics";
import { ImageActionTask } from "./action-queue";

const viewType = "ff_git_image.review";

class Review implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private changes = new Map<string, ImageChange>();
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private lastSnapshot = "";
  private ready = false;
  private disposed = false;
  readonly viewed = new Map<string, string>();
  private sent = new Map<string, string>();
  private statisticsRunning = false;
  private statisticsAgain = false;
  private statisticsReply?: (data: Record<string, unknown>) => void;
  private statisticsSequence = 0;
  private preferred?: { path: string; scope?: Scope };

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly api: GitAPI,
    private readonly ignores: ImageIgnore,
    private readonly sidebar: ImageChangesTree,
    private readonly statistics: ImageStatistics,
    private readonly runAction: (
      action: ImageAction,
      nodes: ImageTreeItem[],
    ) => Promise<void>,
    private readonly reveal: (change: ImageChange) => Promise<void>,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    };
    this.disposables.push(
      ignores.onDidChange(() => this.snapshot()),
      sidebar.onDidChangeRevisions(() => this.schedule()),
      sidebar.onDidChangeTreeData(() => this.schedule()),
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((message) => {
        void this.receive(message).catch((error) => this.report(error));
      }),
      panel.onDidChangeViewState(() => {
        if (panel.visible) this.schedule();
      }),
    );
    void this.html().catch((error) => this.report(error));
  }

  select(path: string, scope?: Scope, preserveFocus = false) {
    this.preferred = { path, scope };
    this.panel.reveal(undefined, preserveFocus);
    this.snapshot();
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.snapshot(), 250);
  }

  private snapshot() {
    if (!this.ready || this.disposed) return;
    const changes = this.sidebar.leaves().map((node) => node.change!);
    this.changes = new Map(changes.map((change) => [change.id, change]));
    const preferred = this.preferred;
    const matching =
      preferred &&
      changes.filter((change) =>
        [change.before?.uri.fsPath, change.after?.uri.fsPath].includes(
          preferred.path,
        ),
      );
    const selected =
      matching &&
      (matching.find((change) => change.scope === preferred?.scope) ??
        matching[0]);
    this.preferred = undefined;
    void this.updateStatistics();
    const snapshot = {
      type: "snapshot",
      changes: changes.map(publicChange),
      showIgnored: this.ignores.showIgnored,
      selected: selected?.id,
      repositories: this.api.repositories.map((repo) => ({
        root: repo.rootUri.fsPath,
        name: repo.rootUri.path.split("/").pop(),
      })),
      notice:
        preferred && !selected
          ? "No visible image changes found for the selected file. Check .image_ignore for excluded images."
          : "",
    };
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint !== this.lastSnapshot || preferred) {
      this.lastSnapshot = fingerprint;
      void this.panel.webview.postMessage(snapshot);
    }
  }

  private async updateStatistics() {
    if (this.statisticsRunning) {
      this.statisticsAgain = true;
      return;
    }
    if (
      this.statisticsRunning ||
      !this.ready ||
      this.disposed ||
      this.sidebar.backgroundChecksPaused ||
      !this.panel.visible
    )
      return;
    this.statisticsRunning = true;
    try {
      for (const node of this.sidebar.leaves()) {
        if (
          this.disposed ||
          !this.panel.visible ||
          this.sidebar.backgroundChecksPaused
        )
          break;
        await this.sidebar.prepare(node);
        if (this.sidebar.backgroundChecksPaused) break;
        const change = node.change!;
        if (
          !change.revision ||
          node.metrics.ready ||
          this.statistics.get(change.revision)
        )
          continue;
        const comparison = await this.sidebar.images.comparison(change);
        if (comparison.revision !== change.revision) continue;
        const request = ++this.statisticsSequence;
        const result = await new Promise<Record<string, unknown>>((resolve) => {
          const timer = setTimeout(() => {
            this.statisticsReply = undefined;
            resolve({ error: "Timed out" });
          }, 30000);
          this.statisticsReply = (data) => {
            clearTimeout(timer);
            this.statisticsReply = undefined;
            resolve(data);
          };
          void this.panel.webview.postMessage({
            type: "statistics",
            id: change.id,
            request,
            ...comparison,
          });
        });
        if (this.disposed) break;
        this.statistics.set(change.revision, {
          changed: typeof result.changed === "number" ? result.changed : 0,
          total: typeof result.total === "number" ? result.total : 0,
          ...(result.error ? { error: String(result.error) } : {}),
        });
      }
    } catch (error) {
      this.report(error);
    } finally {
      this.statisticsRunning = false;
      if (this.statisticsAgain) {
        this.statisticsAgain = false;
        void this.updateStatistics();
      }
    }
  }

  private async receive(message: unknown) {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    const data = message as Record<string, unknown>;
    switch (data.type) {
      case "ready":
        this.lastSnapshot = "";
        this.ready = true;
        this.snapshot();
        break;
      case "statisticsResult":
        if (data.request === this.statisticsSequence)
          this.statisticsReply?.(data);
        break;
      case "viewed":
        if (
          typeof data.id === "string" &&
          typeof data.revision === "string" &&
          this.sent.get(data.id) === data.revision
        )
          this.viewed.set(data.id, data.revision);
        break;
      case "reveal": {
        const change =
          typeof data.id === "string" ? this.changes.get(data.id) : undefined;
        if (change) await this.reveal(change);
        break;
      }
      case "action": {
        if (
          typeof data.id !== "string" ||
          !Number.isSafeInteger(data.request) ||
          !["stage", "unstage", "discard", "ignore", "unignore"].includes(
            String(data.action),
          )
        )
          return;
        try {
          const change = this.changes.get(data.id);
          if (!change) return;
          if (
            typeof data.revision !== "string" ||
            this.viewed.get(change.id) !== data.revision
          ) {
            this.report(
              new Error("Wait for the current image to load, then try again."),
            );
            return;
          }
          const item = new ImageTreeItem(change.path);
          item.change = { ...change, revision: data.revision };
          await this.runAction(data.action as ImageAction, [item]);
        } finally {
          this.snapshot();
          void this.panel.webview.postMessage({
            type: "actionComplete",
            request: data.request,
          });
        }
        break;
      }
      case "showSidebar":
        await vscode.commands.executeCommand(`${sidebarViewId}.focus`);
        break;
      case "refresh": {
        this.statistics.retryUnavailable();
        await this.sidebar.refresh();
        this.snapshot();
        break;
      }
      case "load": {
        if (typeof data.id !== "string" || !Number.isSafeInteger(data.request))
          return;
        const sequence = ++this.sequence;
        const change = this.changes.get(data.id);
        if (!change) return;
        const comparison = await this.sidebar.images.comparison(
          change,
          typeof data.revision === "string" ? data.revision : undefined,
        );
        if (sequence === this.sequence && !this.disposed) {
          this.sent.set(change.id, comparison.revision);
          await this.panel.webview.postMessage({
            type: "images",
            id: change.id,
            request: data.request,
            ...comparison,
          });
        }
        break;
      }
      case "open": {
        if (typeof data.id !== "string") return;
        const source = this.changes.get(data.id)?.after;
        if (source)
          await vscode.commands.executeCommand(
            "vscode.open",
            source.ref === undefined
              ? source.uri
              : this.api.toGitUri(source.uri, source.ref),
          );
        break;
      }
    }
  }

  private report(error: unknown) {
    if (!this.disposed)
      void this.panel.webview.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
  }

  private async html() {
    const webview = this.panel.webview;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    let html = Buffer.from(
      await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(media, "viewer.html"),
      ),
    ).toString("utf8");
    const escape = (value: string) =>
      value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;");
    const nonce = randomBytes(18).toString("base64");
    html = html
      .replaceAll("__CSP__", escape(webview.cspSource))
      .replaceAll("__NONCE__", nonce)
      .replaceAll(
        "__STYLE__",
        escape(
          webview
            .asWebviewUri(vscode.Uri.joinPath(media, "viewer.css"))
            .toString(),
        ),
      )
      .replaceAll(
        "__SCRIPT__",
        escape(
          webview
            .asWebviewUri(vscode.Uri.joinPath(media, "viewer.mjs"))
            .toString(),
        ),
      );
    if (!this.disposed) webview.html = html;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.sequence++;
    this.statisticsReply?.({ error: "Closed" });
    clearTimeout(this.timer);
    this.disposables.forEach((value) => value.dispose());
    this.panel.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  const git = await extension?.activate();
  if (!git?.enabled) {
    const unavailable = () =>
      vscode.window.showErrorMessage(
        "Enable the built-in Git extension to use FF Git Image.",
      );
    context.subscriptions.push(
      vscode.commands.registerCommand("ff_git_image.open", unavailable),
      vscode.commands.registerCommand("ff_git_image.openFile", unavailable),
      vscode.commands.registerCommand("ff_git_image.refresh", unavailable),
      vscode.commands.registerCommand("ff_git_image.findImage", unavailable),
      ...[
        "stage",
        "unstage",
        "discard",
        "ignore",
        "unignore",
        "showIgnored",
      ].map((action) =>
        vscode.commands.registerCommand(`ff_git_image.${action}`, unavailable),
      ),
      vscode.window.registerTreeDataProvider(sidebarViewId, {
        getTreeItem: (item: vscode.TreeItem) => item,
        getChildren: () => [
          new vscode.TreeItem(
            "Enable the built-in Git extension to load image changes.",
          ),
        ],
      }),
    );
    return;
  }
  const api = git.getAPI(1);
  const ignores = new ImageIgnore(api);
  context.subscriptions.push(ignores);
  await ignores.refresh();
  const statistics = new ImageStatistics();
  context.subscriptions.push(statistics);
  ignores.showIgnored = context.workspaceState.get("showIgnored", false);
  const sidebar = new ImageChangesTree(api, ignores, statistics);
  let review: Review | undefined;
  const actions = new ImageActions(api, ignores, sidebar, undefined, (id) =>
    review?.viewed.get(id),
  );
  const tree = vscode.window.createTreeView(sidebarViewId, {
    treeDataProvider: sidebar,
    showCollapseAll: true,
    canSelectMany: true,
  });
  let lastCount = -1;
  let lastIgnored: boolean | undefined;
  const updateBadge = () => {
    const count = sidebar.count;
    if (lastIgnored !== ignores.showIgnored) {
      lastIgnored = ignores.showIgnored;
      tree.message = ignores.showIgnored
        ? "Ignored images are visible"
        : undefined;
      void vscode.commands.executeCommand(
        "setContext",
        "ff_git_image.showIgnored",
        ignores.showIgnored,
      );
    }
    if (lastCount !== count) {
      lastCount = count;
      tree.badge = count
        ? { value: count, tooltip: `${count} image changes` }
        : undefined;
    }
  };
  updateBadge();
  context.subscriptions.push(
    sidebar,
    tree,
    vscode.window.registerFileDecorationProvider(sidebar),
    ignores.onDidChange(updateBadge),
    sidebar.onDidChangeTreeData(updateBadge),
  );
  let queueProgress: Promise<void> | undefined;
  const showQueueProgress = () => {
    if (queueProgress || actions.queue.idle) return;
    queueProgress = Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "FF Git Image",
          cancellable: false,
        },
        async (progress) => {
          const update = () =>
            progress.report({ message: actions.queue.message });
          const subscription = actions.queue.onDidChange(update);
          update();
          try {
            await actions.queue.whenIdle();
          } finally {
            subscription.dispose();
          }
        },
      ),
    ).finally(() => {
      queueProgress = undefined;
      // A new task can arrive as the previous progress notification closes.
      showQueueProgress();
    });
  };
  context.subscriptions.push(actions.queue.onDidChange(showQueueProgress));
  const commands = new Map<ImageActionTask, Promise<void>>();
  const runAction = async (action: ImageAction, nodes: ImageTreeItem[]) => {
    try {
      const task = actions.enqueue(action, nodes);
      const existing = commands.get(task);
      if (existing) return await existing;
      const completion = task.result
        .then((count) => {
          if (count)
            void vscode.window.setStatusBarMessage(
              `FF Git Image: ${action} — ${count} image changes`,
              5000,
            );
        })
        .catch((error) => {
          void vscode.window.showErrorMessage(
            `FF Git Image: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => commands.delete(task));
      commands.set(task, completion);
      await completion;
    } catch (error) {
      void vscode.window.showErrorMessage(
        `FF Git Image: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const reveal = async (change: ImageChange) => {
    const uri = change.after?.uri ?? change.before?.uri;
    const item = uri && sidebar.findFile(uri, change.scope);
    if (item) await tree.reveal(item, { select: true, focus: false });
  };
  const attach = (panel: vscode.WebviewPanel) => {
    review = new Review(
      panel,
      context,
      api,
      ignores,
      sidebar,
      statistics,
      runAction,
      reveal,
    );
    const current = review;
    context.subscriptions.push(
      current,
      panel.onDidDispose(() => {
        if (review === current) review = undefined;
      }),
    );
    return current;
  };
  const open = (
    input?: unknown,
    requestedScope?: Scope,
    preserveFocus = false,
  ) => {
    const current =
      review ??
      attach(
        vscode.window.createWebviewPanel(
          viewType,
          "FF Git Image",
          { viewColumn: vscode.ViewColumn.Active, preserveFocus },
          { enableScripts: true, retainContextWhenHidden: true },
        ),
      );
    const uri =
      input instanceof vscode.Uri
        ? input
        : input && typeof input === "object" && "resourceUri" in input
          ? (input as { resourceUri: vscode.Uri }).resourceUri
          : undefined;
    const scope: Scope | undefined =
      requestedScope ??
      (input &&
      typeof input === "object" &&
      "resourceGroup" in input &&
      (input as { resourceGroup?: { id?: string } }).resourceGroup?.id ===
        "index"
        ? "staged"
        : undefined);
    if (uri && mimeType(uri.fsPath))
      current.select(uri.fsPath, scope, preserveFocus);
    else current.panel.reveal(undefined, preserveFocus);
  };
  context.subscriptions.push(
    ...(
      ["stage", "unstage", "discard", "ignore", "unignore"] as ImageAction[]
    ).map((action) =>
      vscode.commands.registerCommand(
        `ff_git_image.${action}`,
        async (input: unknown, selection?: ImageTreeItem[]) => {
          if (!(input instanceof ImageTreeItem)) return;
          const selected = selection ?? [...tree.selection];
          const nodes = selected.some((node) => node.id === input.id)
            ? selected
            : [input];
          await runAction(action, nodes);
        },
      ),
    ),
    vscode.commands.registerCommand("ff_git_image.showIgnored", async () => {
      ignores.toggleShowIgnored();
      await context.workspaceState.update("showIgnored", ignores.showIgnored);
    }),
    vscode.commands.registerCommand("ff_git_image.open", open),
    vscode.commands.registerCommand(
      "ff_git_image.openFile",
      (input?: unknown, scope?: Scope, preserveFocus?: boolean) =>
        open(
          input ?? vscode.window.activeTextEditor?.document.uri,
          scope,
          preserveFocus,
        ),
    ),
    vscode.commands.registerCommand("ff_git_image.findImage", async () => {
      const picks = imageQuickPicks(api, ignores);
      if (!picks.length) {
        void vscode.window.showInformationMessage(
          "No visible image changes found. Check .image_ignore for excluded images.",
        );
        return;
      }
      const selected = await vscode.window.showQuickPick(picks, {
        title: "Find changed image",
        placeHolder:
          "Search by filename, folder, repository, or staged/unstaged state",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!selected) return;
      const { change } = selected;
      const uri = change.after?.uri ?? change.before?.uri;
      if (!uri) return;
      open(uri, change.scope);
      const item = sidebar.findFile(uri, change.scope);
      if (item) await tree.reveal(item, { select: true, focus: false });
    }),
    vscode.commands.registerCommand("ff_git_image.refresh", async () => {
      try {
        statistics.retryUnavailable();
        await sidebar.refresh();
      } catch (error) {
        await vscode.window.showErrorMessage(
          `FF Git Image: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
    vscode.window.registerWebviewPanelSerializer(viewType, {
      async deserializeWebviewPanel(panel) {
        attach(panel);
      },
    }),
  );
}
