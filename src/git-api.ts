// Minimal structural subset of VS Code's built-in Git API v1.
// Contract: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
import type { Event, Uri } from "vscode";

export enum Status {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,
  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
  INTENT_TO_RENAME,
  TYPE_CHANGED,
  ADDED_BY_US,
  ADDED_BY_THEM,
  DELETED_BY_US,
  DELETED_BY_THEM,
  BOTH_ADDED,
  BOTH_DELETED,
  BOTH_MODIFIED,
}
export interface Change {
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly renameUri?: Uri;
  readonly status: Status;
}
export interface Repository {
  readonly rootUri: Uri;
  readonly state: {
    readonly HEAD?: { readonly commit?: string; readonly name?: string };
    readonly indexChanges: Change[];
    readonly workingTreeChanges: Change[];
    readonly untrackedChanges?: Change[];
    readonly mergeChanges: Change[];
    readonly onDidChange: Event<void>;
  };
  getObjectDetails?(
    ref: string,
    path: string,
  ): Promise<{ mode: string; object: string; size: number }>;
  status(): Promise<void>;
  add(paths: string[]): Promise<void>;
  revert(paths: string[]): Promise<void>;
}
export interface GitAPI {
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  toGitUri(uri: Uri, ref: string): Uri;
}
export interface GitExtension {
  enabled: boolean;
  getAPI(version: 1): GitAPI;
}
