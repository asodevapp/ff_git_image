import * as vscode from "vscode";
import ignore = require("../vendor/ignore");
import { collectChanges, ImageChange } from "./changes";
import { GitAPI, Repository } from "./git-api";
import { updateIgnorePatterns } from "./ignore-patterns";

interface Rules {
  uri: vscode.Uri;
  watcher: vscode.FileSystemWatcher;
  subscriptions: vscode.Disposable[];
  matcher: ignore.Ignore;
  content: string;
  version: number;
  error?: string;
}

/** One working-tree .image_ignore per repository, shared by every image view. */
export class ImageIgnore implements vscode.Disposable {
  // Git API can return a fresh Repository wrapper on every access.
  private readonly rules = new Map<string, Rules>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;
  showIgnored = false;

  constructor(api: GitAPI) {
    api.repositories.forEach((repo) => this.watch(repo));
    this.subscriptions = [
      api.onDidOpenRepository((repo) => {
        this.watch(repo);
        void this.reload(repo.rootUri.toString());
      }),
      api.onDidCloseRepository((repo) => {
        this.unwatch(repo.rootUri.toString());
        this.changed.fire();
      }),
    ];
  }

  changes(repo: Repository, includeIgnored = this.showIgnored): ImageChange[] {
    const matcher = this.rules.get(repo.rootUri.toString())?.matcher;
    // Match the destination path for renames and the last path for deletions.
    return collectChanges(repo)
      .map((change) => ({
        ...change,
        ignored: matcher?.ignores(change.path) ?? false,
      }))
      .filter((change) => includeIgnored || !change.ignored);
  }

  toggleShowIgnored() {
    this.showIgnored = !this.showIgnored;
    this.changed.fire();
  }

  async setIgnored(
    repo: Repository,
    paths: string[],
    ignored: boolean,
  ): Promise<void> {
    const uri = vscode.Uri.joinPath(repo.rootUri, ".image_ignore");
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File)
        throw new Error(".image_ignore must be a regular file.");
      if (stat.size > 1024 * 1024)
        throw new Error(".image_ignore exceeds 1 MiB.");
    } catch (error) {
      if (!(
        error instanceof vscode.FileSystemError && error.code === "FileNotFound"
      ))
        throw error;
      const creation = new vscode.WorkspaceEdit();
      creation.createFile(uri, { ignoreIfExists: true });
      if (!(await vscode.workspace.applyEdit(creation)))
        throw new Error("Could not create .image_ignore.");
    }
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty)
      throw new Error("Save your edits to .image_ignore and try again.");
    const content = document.getText();
    const disk = Buffer.from(await vscode.workspace.fs.readFile(uri))
      .toString("utf8")
      .replace(/^\uFEFF/, "");
    if (content !== disk)
      throw new Error(
        ".image_ignore changed on disk. Wait for the editor to reload it and try again.",
      );
    const replacement = updateIgnorePatterns(content, paths, ignored);
    if (replacement === content) return;
    if (Buffer.byteLength(replacement) > 1024 * 1024)
      throw new Error(".image_ignore exceeds 1 MiB.");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(
        document.positionAt(0),
        document.positionAt(content.length),
      ),
      replacement,
    );
    if (!(await vscode.workspace.applyEdit(edit)) || !(await document.save()))
      throw new Error(
        "Could not save .image_ignore. Review the file and try again.",
      );
    await this.refresh();
  }

  async refresh(repositories?: readonly Repository[]): Promise<void> {
    const keys = repositories
      ? repositories.map((repo) => repo.rootUri.toString())
      : [...this.rules.keys()];
    await Promise.all(keys.map((key) => this.reload(key)));
  }

  private watch(repo: Repository) {
    const key = repo.rootUri.toString();
    if (this.rules.has(key)) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repo.rootUri, ".image_ignore"),
    );
    const reload = () => {
      void this.reload(key);
    };
    this.rules.set(key, {
      uri: vscode.Uri.joinPath(repo.rootUri, ".image_ignore"),
      watcher,
      subscriptions: [
        watcher.onDidCreate(reload),
        watcher.onDidChange(reload),
        watcher.onDidDelete(reload),
      ],
      matcher: ignore({ ignorecase: false }),
      content: "",
      version: 0,
    });
  }

  private async reload(key: string): Promise<void> {
    const rules = this.rules.get(key);
    if (!rules || this.disposed) return;
    const version = ++rules.version;
    let content = "";
    try {
      content = Buffer.from(await vscode.workspace.fs.readFile(rules.uri))
        .toString("utf8")
        .replace(/^\uFEFF/, "");
    } catch (error) {
      if (
        this.disposed ||
        this.rules.get(key) !== rules ||
        version !== rules.version
      )
        return;
      if (!(
        error instanceof vscode.FileSystemError && error.code === "FileNotFound"
      )) {
        const message = `FF Git Image: Cannot read ${rules.uri.fsPath}. Keeping the previous image ignore rules. ${error instanceof Error ? error.message : String(error)}`;
        if (rules.error !== message)
          void vscode.window.showWarningMessage(message);
        rules.error = message;
        return;
      }
    }
    if (
      this.disposed ||
      this.rules.get(key) !== rules ||
      version !== rules.version
    )
      return;
    rules.error = undefined;
    if (content === rules.content) return;
    rules.matcher = ignore({ ignorecase: false }).add(content);
    rules.content = content;
    this.changed.fire();
  }

  private unwatch(key: string) {
    const rules = this.rules.get(key);
    rules?.subscriptions.forEach((subscription) => subscription.dispose());
    rules?.watcher.dispose();
    this.rules.delete(key);
  }

  dispose() {
    this.disposed = true;
    this.subscriptions.forEach((subscription) => subscription.dispose());
    [...this.rules.keys()].forEach((key) => this.unwatch(key));
    this.changed.dispose();
  }
}
