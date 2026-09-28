import * as vscode from "vscode";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ImageChange, mimeType } from "./changes";
import { GitAPI, Repository } from "./git-api";
import { comparisonRevision, maxImageBytes } from "./images";
import { confirmImageAction } from "./confirmation";

export type ImageFilter = "all" | "changes" | "failures";
export const imageFilters: Record<ImageFilter, string> = {
  all: "All images",
  changes: "Without failures",
  failures: "Failures only",
};
export const isFailurePath = (relative: string) =>
  relative.split("/").slice(0, -1).includes("failures");

export function artifactLabel(relative: string): string {
  const kind = /_(masterImage|testImage|isolatedDiff|maskedDiff)\.png$/i
    .exec(relative)?.[1]
    .toLowerCase();
  return (
    (
      {
        masterimage: "Expected · masterImage",
        testimage: "Actual · testImage",
        isolateddiff: "Isolated diff",
        maskeddiff: "Masked diff",
      } as Record<string, string>
    )[kind ?? ""] ?? "Failure image"
  );
}

export interface FailureFile {
  uri: vscode.Uri;
  root: vscode.Uri;
  path: string;
  size: number;
  mtime: number;
  ctime: number;
  revision?: string;
}

function relative(root: vscode.Uri, uri: vscode.Uri): string | undefined {
  if (root.scheme !== uri.scheme || root.authority !== uri.authority)
    return undefined;
  const result = path
    .relative(root.fsPath, uri.fsPath)
    .split(path.sep)
    .join("/");
  return result !== ".." &&
    !result.startsWith("../") &&
    !path.isAbsolute(result)
    ? result
    : undefined;
}

/** Filesystem-only artifact inventory. No Git processes or pixel work in scans. */
export class FailureArtifacts implements vscode.Disposable {
  private readonly files = new Map<string, FailureFile>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly pending = new Map<string, vscode.Uri>();
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly errors = new Map<string, string>();
  private lastState = "";
  private lastPaths = "";
  private readonly views = new Map<string, ImageChange[]>();
  private readonly skipped = new Set([
    ".git",
    ".dart_tool",
    ".fvm",
    "node_modules",
  ]);

  constructor(private readonly api: GitAPI) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/failures/**");
    const update = (uri: vscode.Uri) => {
      const repo = this.owner(uri);
      if (!repo) return;
      const parts = relative(repo.rootUri, uri)!.split("/");
      const index = parts.indexOf("failures");
      if (index < 0) return;
      this.queue(
        vscode.Uri.joinPath(repo.rootUri, ...parts.slice(0, index + 1)),
      );
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.flush();
      }, 200);
    };
    this.subscriptions.push(
      watcher,
      watcher.onDidCreate(update),
      watcher.onDidChange(update),
      watcher.onDidDelete(update),
      api.onDidOpenRepository(() => {
        void this.refresh();
      }),
      api.onDidCloseRepository(() => {
        for (const [key, file] of this.files)
          if (!this.owner(file.uri)) this.files.delete(key);
        void this.refresh();
      }),
    );
  }

  get snapshot(): FailureFile[] {
    return [...this.files.values()]
      .filter((file) => this.owner(file.uri))
      .sort((a, b) => a.uri.toString().localeCompare(b.uri.toString()))
      .map((file) => ({ ...file }));
  }
  get count() {
    return this.files.size;
  }

  select(changes: readonly ImageChange[]): FailureFile[] {
    const selected = new Map<string, FailureFile>();
    for (const change of changes) {
      if (change.scope !== "failure") continue;
      const key = change.after?.uri.toString();
      const file = key && this.files.get(key);
      if (
        !file ||
        file.path !== change.path ||
        file.root.fsPath !== change.root ||
        this.owner(file.uri)?.rootUri.toString() !== file.root.toString()
      )
        throw new Error(
          "Selected failure images changed. Refresh and try again.",
        );
      selected.set(key!, { ...file, revision: change.revision });
    }
    return [...selected.values()].sort((a, b) =>
      a.uri.toString().localeCompare(b.uri.toString()),
    );
  }
  get scanning() {
    return !!this.running || this.pending.size > 0;
  }
  get warnings() {
    return [...this.errors.values()];
  }

  private owner(uri: vscode.Uri): Repository | undefined {
    return this.api.repositories
      .filter((repo) => relative(repo.rootUri, uri) !== undefined)
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
  }

  changes(repo: Repository): ImageChange[] {
    const key = repo.rootUri.toString();
    const cached = this.views.get(key);
    if (cached) return cached;
    const changes: ImageChange[] = [...this.files.values()].flatMap((file) => {
      if (file.root.toString() !== key) return [];
      const name = relative(repo.rootUri, file.uri)!;
      return [
        {
          id: JSON.stringify([repo.rootUri.toString(), "failure", name]),
          root: repo.rootUri.fsPath,
          repository: path.basename(repo.rootUri.fsPath),
          path: name,
          scope: "failure" as const,
          status: "Failure",
          after: { uri: file.uri, label: artifactLabel(name) },
        },
      ];
    });
    changes.sort((a, b) => a.path.localeCompare(b.path));
    this.views.set(key, changes);
    return changes;
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    clearTimeout(this.timer);
    for (const repo of this.api.repositories) this.queue(repo.rootUri);
    await this.flush();
  }

  private queue(uri: vscode.Uri) {
    if (this.disposed) return;
    for (const value of this.pending.values())
      if (
        this.owner(value)?.rootUri.toString() ===
          this.owner(uri)?.rootUri.toString() &&
        relative(value, uri) !== undefined
      )
        return;
    for (const [key, value] of this.pending)
      if (
        this.owner(value)?.rootUri.toString() ===
          this.owner(uri)?.rootUri.toString() &&
        relative(uri, value) !== undefined
      )
        this.pending.delete(key);
    this.pending.set(uri.toString(), uri);
  }

  private notify() {
    // Byte/stat changes alone never rebuild the tree. The shared image watcher
    // invalidates exact previews and revision caches independently.
    const paths = JSON.stringify(
      [...this.files.values()]
        .map((file) => [file.uri.toString(), file.root.toString()])
        .sort(),
    );
    if (paths !== this.lastPaths) {
      this.views.clear();
      this.lastPaths = paths;
    }
    const state = JSON.stringify([paths, this.warnings, this.scanning]);
    if (state === this.lastState) return;
    this.lastState = state;
    this.changed.fire();
  }

  private flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      while (this.pending.size && !this.disposed) {
        const [key, uri] = this.pending.entries().next().value!;
        this.pending.delete(key);
        const repo = this.owner(uri);
        if (!repo) continue;
        try {
          const found = await this.scan(repo, uri);
          if (this.disposed || !this.owner(uri)) continue;
          for (const [fileKey, file] of this.files)
            if (
              file.root.toString() === repo.rootUri.toString() &&
              relative(uri, file.uri) !== undefined
            )
              this.files.delete(fileKey);
          for (const file of found) this.files.set(file.uri.toString(), file);
          for (const [errorKey] of this.errors)
            if (relative(uri, vscode.Uri.parse(errorKey)) !== undefined)
              this.errors.delete(errorKey);
        } catch (error) {
          this.errors.set(key, `Cannot scan ${uri.fsPath}: ${String(error)}`);
        }
        this.notify();
      }
    })().finally(() => {
      this.running = undefined;
      this.notify();
    });
    this.notify();
    return this.running;
  }

  private async regularParents(root: vscode.Uri, uri: vscode.Uri) {
    const name = relative(root, uri);
    if (name === undefined || !this.owner(uri))
      throw new Error("Artifact is outside an open repository.");
    const parts = name ? name.split("/") : [];
    for (let i = 0; i <= parts.length; i++) {
      const current = vscode.Uri.joinPath(root, ...parts.slice(0, i));
      if (
        (await vscode.workspace.fs.stat(current)).type !==
        vscode.FileType.Directory
      )
        throw new Error(`Not a regular directory: ${current.fsPath}`);
    }
  }

  private async scan(
    repo: Repository,
    start: vscode.Uri,
  ): Promise<FailureFile[]> {
    const result: FailureFile[] = [];
    try {
      await this.regularParents(repo.rootUri, start);
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      )
        return [];
      throw error;
    }
    const pending = [start];
    while (pending.length && !this.disposed) {
      const directory = pending.pop()!;
      for (const [name, type] of await vscode.workspace.fs.readDirectory(
        directory,
      )) {
        const uri = vscode.Uri.joinPath(directory, name);
        if (this.owner(uri)?.rootUri.toString() !== repo.rootUri.toString())
          continue;
        if (type === vscode.FileType.Directory) {
          if (!this.skipped.has(name)) pending.push(uri);
        } else if (type === vscode.FileType.File) {
          const name = relative(repo.rootUri, uri)!;
          if (!isFailurePath(name) || !mimeType(name)) continue;
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type === vscode.FileType.File)
              result.push({
                uri,
                root: repo.rootUri,
                path: name,
                size: stat.size,
                mtime: stat.mtime,
                ctime: stat.ctime,
              });
          } catch (error) {
            if (!(
              error instanceof vscode.FileSystemError &&
              error.code === "FileNotFound"
            ))
              throw error;
          }
        }
      }
    }
    return result;
  }

  private async validate(file: FailureFile) {
    if (
      relative(file.root, file.uri) !== file.path ||
      !isFailurePath(file.path) ||
      !mimeType(file.path)
    )
      throw new Error("Invalid failure image path.");
    if (this.owner(file.uri)?.rootUri.toString() !== file.root.toString())
      throw new Error(
        "A selected repository changed or closed. Refresh and try again.",
      );
    await this.regularParents(file.root, vscode.Uri.joinPath(file.uri, ".."));
    const stat = await vscode.workspace.fs.stat(file.uri);
    if (
      stat.type !== vscode.FileType.File ||
      stat.size !== file.size ||
      stat.mtime !== file.mtime ||
      stat.ctime !== file.ctime
    )
      throw new Error(
        `Failure image changed: ${file.path}. Refresh and try again.`,
      );
  }

  private async fingerprint(file: FailureFile) {
    await this.validate(file);
    if (file.size > maxImageBytes)
      throw new Error(
        `Cannot verify ${file.path}: image exceeds the 32 MiB limit. Remove it through Explorer.`,
      );
    const bytes = await vscode.workspace.fs.readFile(file.uri);
    await this.validate(file);
    if (bytes.length !== file.size)
      throw new Error(`Failure image changed: ${file.path}`);
    if (
      file.revision &&
      comparisonRevision(null, { data: bytes, mime: mimeType(file.path) }) !==
        file.revision
    )
      throw new Error(
        `Failure image changed since it was viewed: ${file.path}. Refresh and try again.`,
      );
    return createHash("sha256").update(bytes).digest("hex");
  }

  /** Frozen paths, all-file preflight, and Trash; never remove a directory/index. */
  async clean(
    files: readonly FailureFile[],
    report: (message: string) => void,
    confirm = confirmFailureCleanup,
  ): Promise<number> {
    if (!files.length) return 0;
    const fingerprints: string[] = [];
    for (const [i, file] of files.entries()) {
      report(`Checking ${i + 1}/${files.length}: ${file.path}`);
      fingerprints.push(await this.fingerprint(file));
    }
    if (!(await confirm(files))) return 0;
    for (const [i, file] of files.entries()) {
      report(`Verifying ${i + 1}/${files.length}: ${file.path}`);
      if ((await this.fingerprint(file)) !== fingerprints[i])
        throw new Error(
          `Failure image changed while confirming: ${file.path}. Refresh and try again.`,
        );
    }
    let removed = 0;
    try {
      for (const file of files) {
        await this.validate(file);
        report(`Moving ${removed + 1}/${files.length} to Trash: ${file.path}`);
        await vscode.workspace.fs.delete(file.uri, {
          useTrash: true,
          recursive: false,
        });
        this.files.delete(file.uri.toString());
        removed++;
      }
      return removed;
    } catch (error) {
      throw new Error(
        `Moved ${removed}/${files.length} failure images to Trash. ${String(error)}`,
      );
    } finally {
      this.notify();
      await this.refresh();
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.pending.clear();
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.changed.dispose();
  }
}

export async function confirmFailureCleanup(
  files: readonly FailureFile[],
): Promise<boolean> {
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  return confirmImageAction(
    `Move ${files.length} failure images to Trash?`,
    `${(bytes / (1024 * 1024)).toFixed(2)} MiB. Only the captured failure images will be moved, including any hidden/ignored files in this selection. Stop tests before cleaning.`,
    files.map((file) => file.uri.fsPath),
    "Move to Trash",
  );
}
