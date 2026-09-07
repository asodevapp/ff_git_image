import * as vscode from "vscode";
import * as path from "node:path";
import { collectChanges, ImageChange, Scope } from "./changes";
import { GitAPI, Repository } from "./git-api";
import type { ImageIgnore } from "./image-ignore";
import { ImageCache } from "./image-cache";
import { ImageStatistics } from "./statistics";

export const sidebarViewId = "ff_git_image.changes";

export function imageQuickPicks(
  api: GitAPI,
  ignores?: ImageIgnore,
): (vscode.QuickPickItem & { change: ImageChange })[] {
  const scopes: Record<Scope, string> = {
    staged: "Staged",
    working: "Unstaged",
    conflict: "Merge conflict",
  };
  return api.repositories
    .flatMap((repo) => (ignores ? ignores.changes(repo) : collectChanges(repo)))
    .map((change) => ({
      label: path.posix.basename(change.path),
      description: change.path,
      detail: `${change.repository} · ${scopes[change.scope]} · ${change.status}${change.previousPath ? ` · from ${change.previousPath}` : ""}`,
      change,
    }));
}

export class ImageTreeItem extends vscode.TreeItem {
  parent?: ImageTreeItem;
  change?: ImageChange;
  preparing?: Promise<void>;
  revisionError?: string;
  generation = -1;
  revisionEpoch = 0;
  metrics = { count: 0, ready: 0, changed: 0, total: 0, errors: 0 };
  decoration?: vscode.FileDecoration;
  constructor(
    label: string,
    public children?: ImageTreeItem[],
  ) {
    super(
      label,
      children
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    children?.forEach((child) => {
      child.parent = this;
    });
  }
}

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: ImageChange[];
  count: number;
}

export class ImageChangesTree
  implements vscode.TreeDataProvider<ImageTreeItem>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<
    ImageTreeItem | ImageTreeItem[] | undefined
  >();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly repositories = new Map<string, vscode.Disposable>();
  private timer?: ReturnType<typeof setTimeout>;
  private roots?: ImageTreeItem[];
  private readonly pendingReads: {
    item: ImageTreeItem;
    input: string;
    urgent: boolean;
    run: () => Promise<void>;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  private activeRead?: {
    item: ImageTreeItem;
    input: string;
    promise: Promise<void>;
  };
  private reading = false;
  readonly images: ImageCache;
  private readonly decorated = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.decorated.event;
  private readonly metricNodes = new Map<string, Set<ImageTreeItem>>();
  private readonly decorationNodes = new Map<string, ImageTreeItem>();
  private readonly dirtyDecorations = new Set<ImageTreeItem>();
  private backgroundPaused = 0;
  private generation = 0;
  private listing = "";
  private disposed = false;
  private decorationTimer?: ReturnType<typeof setTimeout>;
  private revisionSweep?: Promise<void>;
  private sweepAgain = false;
  private readonly revisionsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeRevisions = this.revisionsChanged.event;

  constructor(
    private readonly api: GitAPI,
    private readonly ignores?: ImageIgnore,
    private readonly statistics?: ImageStatistics,
  ) {
    this.images = new ImageCache(api);
    // One image watcher for the model, viewer and statistics. Events invalidate
    // exact working files even when a writer preserves size/timestamps.
    const watcher = vscode.workspace?.createFileSystemWatcher?.(
      "**/*.{png,PNG,jpg,JPG,jpeg,JPEG,webp,WEBP,gif,GIF,bmp,BMP,svg,SVG,ico,ICO,avif,AVIF}",
    );
    if (watcher) {
      const update = (uri: vscode.Uri) => {
        this.images.invalidate(uri);
        this.schedule();
      };
      this.subscriptions.push(
        watcher,
        watcher.onDidChange(update),
        watcher.onDidCreate(update),
        watcher.onDidDelete(update),
      );
    }
    if (ignores)
      this.subscriptions.push(ignores.onDidChange(() => this.invalidate()));
    if (statistics)
      this.subscriptions.push(
        statistics.onDidChange((revision) => {
          for (const node of revision
            ? (this.metricNodes.get(revision) ?? [])
            : this.leaves())
            this.updateMetric(node);
        }),
      );
    api.repositories.forEach((repo) => this.watch(repo));
    this.subscriptions.push(
      api.onDidOpenRepository((repo) => {
        this.watch(repo);
        this.schedule();
      }),
      api.onDidCloseRepository((repo) => {
        this.repositories.get(repo.rootUri.toString())?.dispose();
        this.repositories.delete(repo.rootUri.toString());
        this.schedule();
      }),
    );
  }

  get count(): number {
    return this.api.repositories.reduce(
      (total, repo) => total + this.changes(repo).length,
      0,
    );
  }

  getTreeItem(item: ImageTreeItem): vscode.TreeItem {
    if (!item.preparing) void this.prepare(item);
    return item;
  }

  async prepare(item: ImageTreeItem, urgent = false): Promise<void> {
    if (urgent) {
      for (const job of this.pendingReads)
        if (job.item === item) job.urgent = true;
      this.runReads();
    }
    if (item.preparing) return item.preparing;
    const run = async () => {
      if (item.change && !item.change.revision)
        await this.readRevision(item, urgent);
      for (const child of item.children ?? []) {
        if (this.disposed || (!urgent && item.generation !== this.generation))
          break;
        await this.prepare(child, urgent);
      }
      this.scheduleDecorations();
    };
    return (item.preparing = run());
  }

  private readRevision(item: ImageTreeItem, urgent = false): Promise<void> {
    const input = this.readInput(item);
    if (this.activeRead?.item === item && this.activeRead.input === input)
      return this.activeRead.promise;
    const pending = this.pendingReads.find(
      (job) => job.item === item && job.input === input,
    );
    if (pending) {
      pending.urgent ||= urgent;
      this.runReads();
      return pending.promise;
    }
    const change = item.change!;
    const run = async () => {
      if (this.disposed) return;
      let revision: string | undefined;
      let revisionError: string | undefined;
      try {
        revision = await this.images.revision(change);
      } catch (error) {
        revisionError = String(error);
      }
      if (this.disposed || this.readInput(item) !== input) return;
      if (
        revision === item.change!.revision &&
        revisionError === item.change!.revisionError
      )
        return;
      // Keep the previous revision usable while reading. Only actual byte changes
      // replace it; Git status notifications must not reset the tree to loading.
      this.unlinkMetric(item);
      item.change = { ...item.change!, revision, revisionError };
      item.revisionError = revisionError;
      if (revision) {
        let nodes = this.metricNodes.get(revision);
        if (!nodes) this.metricNodes.set(revision, (nodes = new Set()));
        nodes.add(item);
      }
      this.updateMetric(item);
      this.revisionsChanged.fire();
    };
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.pendingReads.push({
      item,
      input,
      urgent,
      run,
      promise,
      resolve,
      reject,
    });
    this.runReads();
    return promise;
  }

  private runReads() {
    if (this.reading) return;
    // Drop obsolete background work after a tree structure change.
    for (let i = this.pendingReads.length - 1; i >= 0; i--) {
      const job = this.pendingReads[i];
      if (
        this.disposed ||
        (!job.urgent &&
          (job.item.generation !== this.generation ||
            job.input !== this.readInput(job.item)))
      ) {
        this.pendingReads.splice(i, 1);
        job.resolve();
      }
    }
    let index = this.pendingReads.findIndex((job) => job.urgent);
    if (index < 0) {
      if (this.backgroundPaused) return;
      index = 0;
    }
    const job = this.pendingReads.splice(index, 1)[0];
    if (!job) return;
    this.reading = true;
    this.activeRead = {
      item: job.item,
      input: job.input,
      promise: job.promise,
    };
    void job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        this.reading = false;
        this.activeRead = undefined;
        this.runReads();
      });
  }

  get backgroundChecksPaused(): boolean {
    return this.backgroundPaused > 0;
  }

  pauseBackgroundChecks(): vscode.Disposable {
    this.backgroundPaused++;
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (--this.backgroundPaused === 0 && !this.disposed) {
          this.runReads();
          this.schedule();
          this.revisionsChanged.fire();
        }
      },
    };
  }

  private checkRevisions(): Promise<void> {
    if (this.backgroundPaused || this.disposed) return Promise.resolve();
    if (this.revisionSweep) {
      this.sweepAgain = true;
      return this.revisionSweep;
    }
    const run = async () => {
      do {
        this.sweepAgain = false;
        const walk = (nodes: ImageTreeItem[]): ImageTreeItem[] =>
          nodes.flatMap((node) =>
            node.change ? [node] : walk(node.children ?? []),
          );
        for (const node of walk(this.roots ?? [])) {
          if (this.disposed || this.backgroundPaused) return;
          // Initial reads already in progress do not need another queued read.
          if (node.change?.revision || node.change?.revisionError)
            await this.readRevision(node);
          else await this.prepare(node);
        }
      } while (this.sweepAgain && !this.disposed);
    };
    this.revisionSweep = run().finally(() => {
      this.revisionSweep = undefined;
    });
    return this.revisionSweep;
  }

  private unlinkMetric(item: ImageTreeItem) {
    const revision = item.change?.revision;
    if (!revision) return;
    const nodes = this.metricNodes.get(revision);
    nodes?.delete(item);
    if (!nodes?.size) this.metricNodes.delete(revision);
  }

  private updateMetric(item: ImageTreeItem) {
    if (!item.change || item.generation !== this.generation) return;
    const result = this.statistics?.get(item.change.revision);
    const next = {
      count: 1,
      ready: result && !result.error ? 1 : 0,
      changed: result && !result.error ? result.changed : 0,
      total: result && !result.error ? result.total : 0,
      errors: result?.error || item.revisionError ? 1 : 0,
    };
    const previous = item.metrics;
    item.metrics = next;
    this.dirtyDecorations.add(item);
    for (let parent = item.parent; parent; parent = parent.parent) {
      for (const key of Object.keys(next) as (keyof typeof next)[])
        parent.metrics[key] += next[key] - previous[key];
      this.dirtyDecorations.add(parent);
    }
    this.scheduleDecorations();
  }

  private scheduleDecorations() {
    if (this.decorationTimer || this.disposed || !this.dirtyDecorations.size)
      return;
    this.decorationTimer = setTimeout(() => {
      this.decorationTimer = undefined;
      const changed: vscode.Uri[] = [];
      for (const node of this.dirtyDecorations) {
        if (node.generation !== this.generation || !node.resourceUri) continue;
        const next = this.metricDecoration(node);
        if (JSON.stringify(next) !== JSON.stringify(node.decoration)) {
          node.decoration = next;
          changed.push(node.resourceUri);
        }
      }
      this.dirtyDecorations.clear();
      // Decoration changes repaint labels; they never rebuild tree nodes/handles.
      if (changed.length) this.decorated.fire(changed);
    }, 250);
  }

  private metricDecoration(
    item: ImageTreeItem,
  ): vscode.FileDecoration | undefined {
    if (!this.statistics) return undefined;
    const { count, ready, changed, total, errors } = item.metrics;
    const percent = total ? (changed * 100) / total : 0;
    const exact = `${percent.toFixed(2)}% changed pixels`;
    const tooltip =
      ready === count
        ? exact
        : ready
          ? `${exact} · ${ready}/${count} images calculated${errors ? ` · ${errors} unavailable` : ""}`
          : errors
            ? "Image statistics unavailable. Refresh to retry."
            : "Calculating image statistics…";
    // VS Code permits at most two graphemes in a decoration badge.
    const badge =
      ready !== count
        ? errors
          ? "!"
          : "…"
        : changed === 0
          ? "0"
          : percent < 1
            ? "<1"
            : percent === 100
              ? "Δ"
              : String(Math.floor(percent));
    return { badge, tooltip, propagate: false };
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const item = this.decorationNodes.get(uri.toString());
    return item ? this.metricDecoration(item) : undefined;
  }

  leaves(): ImageTreeItem[] {
    const walk = (nodes: ImageTreeItem[]): ImageTreeItem[] =>
      nodes.flatMap((node) =>
        node.change ? [node] : walk(node.children ?? []),
      );
    return walk(this.getChildren());
  }

  getParent(item: ImageTreeItem): ImageTreeItem | undefined {
    return item.parent;
  }

  findFile(uri: vscode.Uri, scope?: Scope): ImageTreeItem | undefined {
    const find = (nodes: ImageTreeItem[]): ImageTreeItem | undefined => {
      for (const node of nodes) {
        if (
          node.change &&
          (node.resourceUri?.toString() === uri.toString() ||
            (node.change.after?.uri ?? node.change.before?.uri)?.toString() ===
              uri.toString()) &&
          (!scope || node.command?.arguments?.[1] === scope)
        )
          return node;
        const child = node.children && find(node.children);
        if (child) return child;
      }
      return undefined;
    };
    return find(this.getChildren());
  }

  getChildren(item?: ImageTreeItem): ImageTreeItem[] {
    if (item) return item.children ?? [];
    if (this.roots) return this.roots;
    this.roots = this.build();
    this.initializeMetrics();
    return this.roots;
  }

  private build(): ImageTreeItem[] {
    this.listing = this.currentListing();
    const multiple = this.api.repositories.length > 1;
    const roots = this.api.repositories.flatMap((repo) => {
      const changes = this.changes(repo);
      const groups = this.groups(repo, changes);
      if (!multiple || !groups.length) return groups;
      const node = new ImageTreeItem(
        path.basename(repo.rootUri.fsPath),
        groups,
      );
      node.id = repo.rootUri.toString();
      node.description = String(changes.length);
      node.tooltip = repo.rootUri.fsPath;
      node.iconPath = new vscode.ThemeIcon("repo");
      return [node];
    });
    const mark = (nodes: ImageTreeItem[]) =>
      nodes.forEach((node) => {
        node.generation = this.generation;
        mark(node.children ?? []);
      });
    mark(roots);
    return roots;
  }

  async refresh(
    recheck?: readonly ImageTreeItem[],
    repositories: readonly Repository[] = this.api.repositories,
  ): Promise<void> {
    await this.ignores?.refresh(repositories);
    const results = await Promise.allSettled(
      repositories.map((repo) => repo.status()),
    );
    this.invalidate();
    if (recheck) {
      for (const node of recheck)
        if (node.change?.revision || node.change?.revisionError)
          await this.readRevision(node, true);
    } else {
      this.images.invalidate();
      await this.checkRevisions();
      this.revisionsChanged.fire();
    }
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  private changes(repo: Repository): ImageChange[] {
    return this.ignores ? this.ignores.changes(repo) : collectChanges(repo);
  }

  private groups(repo: Repository, changes: ImageChange[]): ImageTreeItem[] {
    const scopes: [Scope, string, string][] = [
      ["conflict", "Merge Changes", "warning"],
      ["staged", "Staged Changes", "check"],
      ["working", "Changes", "diff"],
    ];
    return scopes.flatMap(([scope, label, icon]) => {
      const matching = changes.filter((change) => change.scope === scope);
      if (!matching.length) return [];
      const node = new ImageTreeItem(
        label,
        this.folders(repo, scope, matching),
      );
      node.id = JSON.stringify([repo.rootUri.toString(), scope]);
      node.description = String(matching.length);
      node.iconPath = new vscode.ThemeIcon(icon);
      node.contextValue = `ff_git_image.group.${scope}`;
      return [node];
    });
  }

  private folders(
    repo: Repository,
    scope: Scope,
    changes: ImageChange[],
  ): ImageTreeItem[] {
    const root: Folder = {
      name: "",
      path: "",
      folders: new Map(),
      files: [],
      count: 0,
    };
    for (const change of changes) {
      const parts = change.path.split("/").slice(0, -1);
      let folder = root;
      folder.count++;
      for (const name of parts) {
        let child = folder.folders.get(name);
        if (!child) {
          child = {
            name,
            path: folder.path ? `${folder.path}/${name}` : name,
            folders: new Map(),
            files: [],
            count: 0,
          };
          folder.folders.set(name, child);
        }
        folder = child;
        folder.count++;
      }
      folder.files.push(change);
    }
    const children = (folder: Folder): ImageTreeItem[] => [
      ...[...folder.folders.values()]
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        )
        .map((entry) => {
          let compact = entry;
          let label = entry.name;
          while (!compact.files.length && compact.folders.size === 1) {
            compact = compact.folders.values().next().value!;
            label += `/${compact.name}`;
          }
          const node = new ImageTreeItem(label, children(compact));
          node.id = JSON.stringify([
            repo.rootUri.toString(),
            scope,
            "folder",
            compact.path,
          ]);
          node.description = String(compact.count);
          node.tooltip = compact.path;
          node.iconPath = new vscode.ThemeIcon("folder");
          node.contextValue = `ff_git_image.folder.${scope}`;
          return node;
        }),
      ...[...folder.files]
        .sort((a, b) =>
          a.path.localeCompare(b.path, undefined, { numeric: true }),
        )
        .map((change) => this.file(change)),
    ];
    return children(root);
  }

  private file(change: ImageChange): ImageTreeItem {
    const node = new ImageTreeItem(path.posix.basename(change.path));
    node.id = change.id;
    node.tooltip = `${change.path}${change.previousPath ? `\nRenamed from ${change.previousPath}` : ""}\n${change.status} · ${change.before?.label ?? "Not present"} → ${change.after?.label ?? "Not present"}`;
    node.accessibilityInformation = {
      label: `${change.path}, ${change.scope}, ${change.status}`,
    };
    node.resourceUri = change.after?.uri ?? change.before?.uri;
    node.iconPath = new vscode.ThemeIcon("file-media");
    node.change = change;
    node.contextValue = `ff_git_image.image.${change.scope}${change.ignored ? ".ignored" : ""}`;
    node.description = change.ignored ? "Ignored" : "";
    node.command = {
      command: "ff_git_image.openFile",
      title: "Compare Image Changes",
      arguments: [node.resourceUri, change.scope, true],
    };
    return node;
  }

  private watch(repo: Repository) {
    if (!this.repositories.has(repo.rootUri.toString()))
      this.repositories.set(
        repo.rootUri.toString(),
        repo.state.onDidChange(() => this.schedule()),
      );
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.invalidate();
      void this.checkRevisions();
    }, 150);
  }

  private currentListing(): string {
    return JSON.stringify(
      this.api.repositories.map((repo) => [
        repo.rootUri.toString(),
        this.changes(repo).map((change) => [
          change.id,
          change.status,
          change.previousPath,
          change.ignored ?? false,
          change.before?.uri.toString(),
          change.before?.ref,
          change.after?.uri.toString(),
          change.after?.ref,
        ]),
      ]),
    );
  }

  /** A completed write invalidates data for its exact paths, never the tree UI.
   * Already queued actions retain their immutable captured revisions. */
  didMutate(changes: readonly ImageChange[], source: "index" | "working") {
    const paths = new Set(
      changes.flatMap((change) =>
        [change.before?.uri.toString(), change.after?.uri.toString()].filter(
          (value): value is string => !!value,
        ),
      ),
    );
    if (source === "working")
      for (const change of changes) {
        const uri = change.after?.uri ?? change.before?.uri;
        if (uri) this.images.invalidate(uri);
      }
    for (const node of this.leaves()) {
      if (
        ![node.change!.before, node.change!.after].some(
          (image) =>
            image &&
            (source === "index" ? image.ref === "" : image.ref === undefined) &&
            paths.has(image.uri.toString()),
        )
      )
        continue;
      this.unlinkMetric(node);
      node.change = {
        ...node.change!,
        revision: undefined,
        revisionError: undefined,
      };
      node.revisionError = undefined;
      node.revisionEpoch++;
      for (let item: ImageTreeItem | undefined = node; item; item = item.parent)
        item.preparing = undefined;
      this.updateMetric(node);
    }
  }

  private readInput(item: ImageTreeItem) {
    return `${item.revisionEpoch}:${this.imageInput(item.change!)}`;
  }

  private imageInput(change: ImageChange) {
    return JSON.stringify([
      change.root,
      change.before?.uri.toString(),
      change.before?.ref,
      change.after?.uri.toString(),
      change.after?.ref,
    ]);
  }

  private initializeMetrics() {
    this.metricNodes.clear();
    this.decorationNodes.clear();
    this.dirtyDecorations.clear();
    const visit = (node: ImageTreeItem) => {
      node.metrics = { count: 0, ready: 0, changed: 0, total: 0, errors: 0 };
      if (this.statistics) {
        // Dedicated resources keep staged/working metrics separate and do not
        // decorate files in Explorer or the user's normal Source Control view.
        node.resourceUri = vscode.Uri.parse(
          `ff-git-image-metric:/${encodeURIComponent(node.id!)}`,
        );
        this.decorationNodes.set(node.resourceUri.toString(), node);
      }
      if (node.change?.revision) {
        let nodes = this.metricNodes.get(node.change.revision);
        if (!nodes)
          this.metricNodes.set(node.change.revision, (nodes = new Set()));
        nodes.add(node);
      }
      node.children?.forEach(visit);
    };
    this.roots?.forEach(visit);
    this.leaves().forEach((node) => this.updateMetric(node));
  }

  private invalidate() {
    if (this.disposed || (this.roots && this.listing === this.currentListing()))
      return;
    if (!this.roots) {
      this.changed.fire(undefined);
      return;
    }
    const previousRoots = this.roots;
    const previous = new Map<string, ImageTreeItem>();
    const visit = (nodes: ImageTreeItem[]) =>
      nodes.forEach((node) => {
        previous.set(node.id!, node);
        visit(node.children ?? []);
      });
    visit(previousRoots);
    this.generation++;
    const affected = new Set<ImageTreeItem>();
    const ids = (nodes?: ImageTreeItem[]) =>
      JSON.stringify(nodes?.map((node) => node.id));
    const reconcile = (fresh: ImageTreeItem): ImageTreeItem => {
      const old = previous.get(fresh.id!);
      const children = fresh.children?.map(reconcile);
      const item = old ?? fresh;
      if (old) {
        if (
          ids(old.children) !== ids(children) ||
          old.contextValue !== fresh.contextValue ||
          old.label !== fresh.label ||
          old.tooltip !== fresh.tooltip ||
          old.description !== fresh.description
        )
          affected.add(old);
        if (
          old.change &&
          fresh.change &&
          this.imageInput(old.change) === this.imageInput(fresh.change)
        ) {
          if (
            old.change.status !== fresh.change.status ||
            old.change.ignored !== fresh.change.ignored
          ) {
            old.change = {
              ...fresh.change,
              revision: old.change.revision,
              revisionError: old.change.revisionError,
            };
          }
        } else {
          old.change = fresh.change;
          old.revisionError = undefined;
          old.preparing = undefined;
        }
        for (const key of [
          "label",
          "description",
          "tooltip",
          "iconPath",
          "resourceUri",
          "contextValue",
          "command",
          "accessibilityInformation",
        ] as const)
          (old as any)[key] = fresh[key];
      }
      item.children = children;
      item.generation = this.generation;
      children?.forEach((child) => {
        child.parent = item;
      });
      return item;
    };
    this.roots = this.build().map(reconcile);
    this.roots.forEach((root) => {
      root.parent = undefined;
    });
    this.initializeMetrics();
    this.runReads();
    if (ids(previousRoots) !== ids(this.roots)) this.changed.fire(undefined);
    else {
      const minimal = [...affected].filter((node) => {
        for (let parent = node.parent; parent; parent = parent.parent)
          if (affected.has(parent)) return false;
        return true;
      });
      if (minimal.length) this.changed.fire(minimal);
    }
    this.revisionsChanged.fire();
  }

  dispose() {
    this.disposed = true;
    this.runReads();
    clearTimeout(this.timer);
    clearTimeout(this.decorationTimer);
    this.revisionsChanged.dispose();
    this.images.dispose();
    this.decorated.dispose();
    this.repositories.forEach((subscription) => subscription.dispose());
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.changed.dispose();
  }
}
