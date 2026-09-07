import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Repository } from "./git-api";

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";
export async function indexLockPath(root: string): Promise<string> {
  const dotGit = path.join(root, ".git");
  const stat = await fs.lstat(dotGit);
  if (stat.isSymbolicLink())
    throw new Error("Cannot recover a symbolic .git path.");
  if (stat.isDirectory()) return path.join(dotGit, "index.lock");
  if (!stat.isFile() || stat.size > 8192)
    throw new Error("Unrecognized .git file.");
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(
    await fs.readFile(dotGit, "utf8"),
  );
  if (!match) throw new Error("Unrecognized .git file.");
  const directory = path.resolve(root, match[1]);
  const target = await fs.lstat(directory);
  if (!target.isDirectory() || target.isSymbolicLink())
    throw new Error("Git directory must be a regular directory.");
  return path.join(directory, "index.lock");
}

async function lockStamp(file: string) {
  try {
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("index.lock must be a regular file.");
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(
      ":",
    );
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

export async function removeConfirmedLock(
  file: string,
  confirm: () => Promise<boolean>,
): Promise<boolean> {
  const before = await lockStamp(file);
  if (!before) return true;
  if (!(await confirm())) return false;
  const after = await lockStamp(file);
  if (!after) return true;
  if (after !== before)
    throw new Error(
      "index.lock changed while confirming. It was not removed; wait for Git to finish.",
    );
  await fs.unlink(file);
  return true;
}

/** Recovery is explicit: an old lock or closed descriptor does not prove Git is idle. */
export async function recoverIndexLock(
  repo: Repository,
  error: unknown,
): Promise<boolean> {
  const details = error as { message?: string; stderr?: string };
  const message = `${details?.message ?? error}\n${details?.stderr ?? ""}`;
  const reported =
    /Unable to create '([^'\r\n]+index\.lock)': File exists/.exec(message)?.[1];
  if (!reported) return false;
  const lock = await indexLockPath(repo.rootUri.fsPath);
  const normalize = (value: string) =>
    process.platform === "win32"
      ? path.normalize(value).toLowerCase()
      : path.normalize(value);
  if (normalize(reported) !== normalize(lock)) return false;
  const choice = await vscode.window.showWarningMessage(
    "Git could not update the index because index.lock exists.",
    "Retry",
    "Open Git Log",
    "Remove index.lock…",
  );
  if (choice === "Open Git Log") {
    await vscode.commands.executeCommand("git.showOutput");
    return false;
  }
  if (choice === "Retry") return true;
  if (choice !== "Remove index.lock…") return false;
  return removeConfirmedLock(
    lock,
    async () =>
      (await vscode.window.showWarningMessage(
        "Remove this Git index lock and retry?",
        {
          modal: true,
          detail: `${lock}\n\nStop Git operations in terminals and other Git clients before continuing. The extension cannot verify that another process has finished using this lock.`,
        },
        "Git Is Stopped — Remove Lock",
      )) === "Git Is Stopped — Remove Lock",
  );
}
