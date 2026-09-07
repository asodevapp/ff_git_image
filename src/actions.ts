import * as vscode from "vscode";
import * as path from "node:path";
import { ImageChange } from "./changes";
import { GitAPI, Repository, Status } from "./git-api";
import { ImageIgnore } from "./image-ignore";
import { ImageChangesTree, ImageTreeItem } from "./sidebar";
import { imageRevision, readImagePair } from "./images";
import { recoverIndexLock } from "./git-lock";
import { ImageActionQueue, ImageActionTask } from "./action-queue";

export type ImageAction =
  "stage" | "unstage" | "discard" | "ignore" | "unignore";
export type ConfirmDiscard = (
  changes: readonly ImageChange[],
) => Promise<boolean>;

export async function confirmDiscard(
  changes: readonly ImageChange[],
): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Discard changes to ${changes.length} image${changes.length === 1 ? "" : "s"}?`,
    {
      modal: true,
      detail:
        "Tracked images will be restored to their staged (index) version. New images will be moved to Trash. Staged changes are preserved.\n\n" +
        changes
          .map((change) => `${change.repository}: ${change.path}`)
          .join("\n"),
    },
    "Discard Changes",
  );
  return choice === "Discard Changes";
}

export function leaves(item: ImageTreeItem): ImageChange[] {
  return item.change ? [item.change] : (item.children ?? []).flatMap(leaves);
}

// The Git API turns absolute paths back into repository-relative pathspecs.
// Explicit literal magic prevents names such as FullHd[dark].png matching siblings.
function literalPath(repo: Repository, relative: string): string {
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.split("/").includes("..")
  )
    throw new Error(
      "Invalid image path. Refresh the image tree and try again.",
    );
  return path.join(repo.rootUri.fsPath, `:(literal)${relative}`);
}

function identity(change: ImageChange): string {
  return JSON.stringify([
    change.id,
    change.status,
    change.previousPath,
    change.before?.ref,
    change.ignored ?? false,
  ]);
}

export class ImageActions {
  readonly queue = new ImageActionQueue();
  constructor(
    private readonly api: GitAPI,
    private readonly ignores: ImageIgnore,
    private readonly tree: ImageChangesTree,
    private readonly confirm: ConfirmDiscard = confirmDiscard,
    private readonly reviewed: (id: string) => string | undefined = () =>
      undefined,
  ) {}

  async run(
    action: ImageAction,
    input: unknown,
    report: (message: string) => void = () => {},
  ): Promise<number> {
    const task = this.enqueue(action, input);
    const subscription = task.onProgress(report);
    try {
      return await task.result;
    } finally {
      subscription.dispose();
    }
  }

  enqueue(action: ImageAction, input: unknown): ImageActionTask {
    const nodes = Array.isArray(input) ? input : [input];
    if (!nodes.length || nodes.some((node) => !(node instanceof ImageTreeItem)))
      throw new Error(
        "Right-click an image or folder in the FF Git Image tree.",
      );
    const ignoreAction = action === "ignore" || action === "unignore";
    const scope = action === "unstage" ? "staged" : "working";
    const selectedNodes = new Map<string, ImageTreeItem>();
    const visit = (node: ImageTreeItem) => {
      if (node.change) selectedNodes.set(node.change.id, node);
      else node.children?.forEach(visit);
    };
    nodes.forEach(visit);
    const selected = [...selectedNodes.values()]
      .map((node) => node.change!)
      .filter((change) =>
        ignoreAction
          ? change.ignored === (action === "unignore")
          : change.scope === scope && !change.ignored,
      )
      .map((change) => ({
        ...change,
        revision: this.reviewed(change.id) ?? change.revision,
      }));
    if (!selected.length)
      throw new Error(
        `This action is only available in ${scope === "staged" ? "Staged Changes" : "Changes"} for matching images.`,
      );
    const key = () =>
      JSON.stringify([
        action,
        selected
          .map((change) => [
            identity(change),
            change.revision,
            change.revisionError,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ]);
    const duplicate = this.queue.find(key());
    if (duplicate) return duplicate;
    // Capture an initial revision now, not after earlier queued actions finish.
    // Existing revisions and the last viewed revision are already immutable copies.
    const ready = ignoreAction
      ? Promise.resolve()
      : Promise.all(
          selected.map(async (change) => {
            if (change.revision) return;
            const node = selectedNodes.get(change.id)!;
            await this.tree.prepare(node, true);
            change.revision = node.change?.revision;
            change.revisionError = node.change?.revisionError;
          }),
        ).then(() => {});
    const labels: Record<ImageAction, string> = {
      stage: "Stage",
      unstage: "Unstage",
      discard: "Discard",
      ignore: "Ignore",
      unignore: "Stop ignoring",
    };
    const task = this.queue.enqueue(
      key(),
      `${labels[action]} ${selected.length} image${selected.length === 1 ? "" : "s"}`,
      (report) => this.execute(action, selected, ready, report),
    );
    // A second click after the initial read joins the same outstanding task too.
    void ready.then(
      () => this.queue.alias(task, key()),
      () => {},
    );
    return task;
  }

  private async execute(
    action: ImageAction,
    selected: ImageChange[],
    ready: Promise<void>,
    report: (message: string) => void,
  ): Promise<number> {
    const ignoreAction = action === "ignore" || action === "unignore";
    const repositories = new Map(
      this.api.repositories.map((repo) => [repo.rootUri.fsPath, repo]),
    );
    if (selected.some((change) => !repositories.has(change.root)))
      throw new Error("A selected repository has been closed.");
    const validate = async (changes: ImageChange[]) => {
      for (const [i, change] of changes.entries()) {
        report(`Checking ${i + 1}/${changes.length}: ${change.path}`);
        await this.regularChange(change);
        if (!change.revision)
          throw new Error(
            change.revisionError ??
              "Image revisions are still loading or unavailable. Refresh the tree and try again.",
          );
        if ((await imageRevision(this.api, change)) !== change.revision)
          throw new Error(
            `Image changed since it was selected or viewed: ${change.path}. Review the refreshed image and try again.`,
          );
      }
    };
    const groups = new Map<string, ImageChange[]>();
    for (const change of selected) {
      let group = groups.get(change.root);
      if (!group) groups.set(change.root, (group = []));
      group.push(change);
    }
    const involved = [...groups.keys()].map((root) => repositories.get(root)!);
    const background = this.tree.pauseBackgroundChecks();
    let done = 0;
    try {
      if (selected.some((change) => !change.revision) && !ignoreAction)
        report("Reading selected image revisions…");
      await ready;
      await this.tree.refresh([], involved);
      for (const [root, changes] of groups)
        this.resolve(repositories.get(root)!, changes);
      // Cross-repository batches keep a full preflight before the first write.
      if (!ignoreAction && action !== "discard" && groups.size > 1)
        await validate(selected);
      if (action === "discard") {
        const revisions: string[] = [];
        for (const change of selected) {
          const snapshot = await this.snapshot(change);
          if (snapshot.revision !== change.revision)
            throw new Error(
              `Image changed since it was selected or viewed: ${change.path}. Review the refreshed image and try again.`,
            );
          revisions.push(snapshot.revision);
        }
        if (!(await this.confirm(selected))) return 0;
        await this.tree.refresh([], involved);
        for (const [root, changes] of groups)
          this.resolve(repositories.get(root)!, changes);
        let singleSnapshot:
          Awaited<ReturnType<ImageActions["snapshot"]>> | undefined;
        for (let i = 0; i < selected.length; i++) {
          const snapshot = await this.snapshot(selected[i]);
          if (selected.length === 1) singleSnapshot = snapshot;
          if (snapshot.revision !== revisions[i])
            throw new Error(
              "Images changed while confirming. Review them and try again; no changes were discarded.",
            );
        }
        for (let i = 0; i < selected.length; i++) {
          const change = selected[i];
          const snapshot = singleSnapshot ?? (await this.snapshot(change));
          if (snapshot.revision !== revisions[i])
            throw new Error(
              "An image changed during the operation. Remaining images were not discarded; refresh and review them.",
            );
          const uri = change.after?.uri ?? change.before!.uri;
          if (snapshot.index !== undefined) {
            await vscode.workspace.fs.createDirectory(
              vscode.Uri.joinPath(uri, ".."),
            );
            await vscode.workspace.fs.writeFile(uri, snapshot.index);
          } else if (snapshot.working !== undefined)
            await vscode.workspace.fs.delete(uri, { useTrash: true });
          this.tree.didMutate([change], "working");
          report(`Discarded ${++done}/${selected.length}: ${change.path}`);
        }
      } else {
        for (const [root, changes] of groups) {
          const repo = repositories.get(root)!;
          if (ignoreAction)
            await this.ignores.setIgnored(
              repo,
              changes.map((change) => change.path),
              action === "ignore",
            );
          else {
            const paths = new Set<string>();
            const rawChanges = new Map(
              (action === "unstage"
                ? repo.state.indexChanges
                : repo.state.workingTreeChanges
              ).map((entry) => [
                (entry.renameUri ?? entry.uri).toString(),
                entry,
              ]),
            );
            for (const change of changes) {
              const uri = change.after?.uri ?? change.before!.uri;
              paths.add(literalPath(repo, change.path));
              const raw = rawChanges.get(uri.toString());
              if (
                change.previousPath &&
                raw &&
                [Status.INDEX_RENAMED, Status.INTENT_TO_RENAME].includes(
                  raw.status,
                )
              )
                paths.add(literalPath(repo, change.previousPath));
            }
            if (!paths.size) throw new Error("No image changes selected.");
            const mutate = async (retry = false) => {
              if (retry) await this.tree.refresh([], [repo]);
              this.resolve(repo, changes);
              await validate(changes);
              report(
                `${action === "stage" ? "Staging" : "Unstaging"} ${changes.length} images…`,
              );
              if (action === "stage") await repo.add([...paths]);
              else await repo.revert([...paths]);
              this.tree.didMutate(changes, "index");
            };
            try {
              await mutate();
            } catch (error) {
              if (!(await recoverIndexLock(repo, error))) throw error;
              report("Retrying Git operation…");
              await mutate(true);
            }
          }
          done += changes.length;
          report(`Processed ${done}/${selected.length} images`);
        }
      }
      return done;
    } finally {
      try {
        // Refresh only affected repositories. Pixel/revision work resumes outside
        // the mutation queue, so the next action does not wait for a tree scan.
        await this.tree.refresh([], involved);
      } finally {
        background.dispose();
      }
    }
  }

  private resolve(repo: Repository, selected: ImageChange[]): ImageChange[] {
    const visible = new Map(
      this.ignores.changes(repo, true).map((change) => [change.id, change]),
    );
    return selected.map((previous) => {
      const current = visible.get(previous.id);
      if (!current || identity(current) !== identity(previous))
        throw new Error(
          "The selected image changes are no longer current. Refresh the tree and try again.",
        );
      return current;
    });
  }

  private async regularFile(uri: vscode.Uri): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File)
        throw new Error(
          `Cannot change a directory or symbolic link: ${uri.fsPath}`,
        );
      return true;
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      )
        return false;
      throw error;
    }
  }

  private async regularChange(change: ImageChange) {
    const exists = await this.regularFile(
      change.after?.uri ?? change.before!.uri,
    );
    if (change.scope === "working" && exists !== !!change.after)
      throw new Error(
        `Image changed since it was selected or viewed: ${change.path}. Review the refreshed image and try again.`,
      );
  }

  private async snapshot(change: ImageChange) {
    await this.regularChange(change);
    const pair = await readImagePair(this.api, change);
    if (pair.before?.error || pair.after?.error)
      throw new Error(pair.before?.error ?? pair.after!.error);
    return {
      working: pair.after?.data,
      index: pair.before?.data,
      revision: pair.revision,
    };
  }
}
