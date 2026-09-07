import * as path from "node:path";
import type { Uri } from "vscode";
import { Change, Repository, Status } from "./git-api";

export const imageTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};
export const mimeType = (file: string): string | undefined =>
  imageTypes[path.extname(file).toLowerCase()];
export type Scope = "staged" | "working" | "conflict";
export interface ImageSource {
  uri: Uri;
  ref?: string;
  label: string;
}
export interface ImageChange {
  revision?: string;
  revisionError?: string;
  ignored?: boolean;
  id: string;
  path: string;
  previousPath?: string;
  repository: string;
  root: string;
  scope: Scope;
  status: string;
  before?: ImageSource;
  after?: ImageSource;
}

export function collectChanges(repository: Repository): ImageChange[] {
  const root = repository.rootUri.fsPath;
  const relative = (uri: Uri) =>
    path.relative(root, uri.fsPath).split(path.sep).join("/");
  const result = new Map<string, ImageChange>();
  const groups: [Scope, readonly Change[]][] = [
    ["staged", repository.state.indexChanges],
    [
      "working",
      [
        ...repository.state.workingTreeChanges,
        ...(repository.state.untrackedChanges ?? []),
      ],
    ],
    ["conflict", repository.state.mergeChanges],
  ];
  for (const [scope, changes] of groups) {
    for (const change of changes) {
      if (change.status === Status.IGNORED) continue;
      const renamed = [
        Status.INDEX_RENAMED,
        Status.INDEX_COPIED,
        Status.INTENT_TO_RENAME,
      ].includes(change.status);
      const uri = change.renameUri ?? change.uri;
      const original = renamed ? change.originalUri : uri;
      if (!mimeType(uri.fsPath) && !mimeType(original.fsPath)) continue;
      const added = [
        Status.INDEX_ADDED,
        Status.UNTRACKED,
        Status.INTENT_TO_ADD,
        Status.BOTH_ADDED,
      ].includes(change.status);
      const deleted = [
        Status.INDEX_DELETED,
        Status.DELETED,
        Status.BOTH_DELETED,
      ].includes(change.status);
      const id = JSON.stringify([
        repository.rootUri.toString(),
        scope,
        relative(uri),
      ]);
      result.set(id, {
        id,
        path: relative(uri),
        previousPath: renamed ? relative(original) : undefined,
        repository: path.basename(root),
        root,
        scope,
        status:
          scope === "conflict"
            ? "Conflict"
            : added
              ? "Added"
              : deleted
                ? "Deleted"
                : renamed
                  ? "Renamed"
                  : "Modified",
        before: added
          ? undefined
          : {
              uri: original,
              ref:
                scope === "working"
                  ? ""
                  : (repository.state.HEAD?.commit ?? "HEAD"),
              label: scope === "working" ? "Index" : "HEAD",
            },
        after: deleted
          ? undefined
          : {
              uri,
              ...(scope === "staged" ? { ref: "" } : {}),
              label: scope === "staged" ? "Index" : "Working tree",
            },
      });
    }
  }
  return [...result.values()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.scope.localeCompare(b.scope),
  );
}

export function publicChange(change: ImageChange) {
  const { before, after, ...entry } = change;
  return {
    ...entry,
    beforeLabel: before?.label ?? "Not present",
    afterLabel: after?.label ?? "Not present",
  };
}
