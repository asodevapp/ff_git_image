import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageChange, ImageSource } from "./changes";
import type { GitAPI, Repository } from "./git-api";
import {
  comparisonRevision,
  ImageBytes,
  payload,
  readImageBytes,
} from "./images";
import { indexLockPath } from "./git-lock";

class ChangedDuringRead extends Error {}

type Pair = {
  before: ImageBytes | null;
  after: ImageBytes | null;
  revision: string;
};

/** Preview cache only. Mutations deliberately use the uncached readers in images.ts. */
export class ImageCache implements vscode.Disposable {
  private readonly bytes = new Map<string, ImageBytes>();
  private readonly revisions = new Map<string, { revision: string }>();
  private readonly metadata = new Map<
    string,
    { epoch: string; object: string }
  >();
  private readonly metadataReads = new Map<string, Promise<string>>();
  private readonly reads = new Map<string, Promise<ImageBytes | null>>();
  private readonly pairs = new Map<string, Promise<Pair>>();
  private readonly indexPaths = new Map<string, Promise<string>>();
  private readonly epochs = new Map<string, number>();
  private readonly indexChecks = new Map<string, Promise<string | undefined>>();
  private byteSize = 0;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly api: GitAPI,
    private readonly byteLimit = 64 * 1024 * 1024,
  ) {}

  invalidate(uri?: vscode.Uri) {
    if (!uri) {
      this.generation++;
      this.metadata.clear();
      this.revisions.clear();
      this.bytes.clear();
      this.byteSize = 0;
      this.epochs.clear();
    } else {
      if (this.epochs.size >= 2000 && !this.epochs.has(uri.toString()))
        this.invalidate();
      this.epochs.set(uri.toString(), ++this.eventSequence);
    }
  }

  private trim<T>(map: Map<string, T>, limit = 2000) {
    while (map.size > limit) map.delete(map.keys().next().value!);
  }

  private touch<T>(map: Map<string, T>, key: string): T | undefined {
    const value = map.get(key);
    if (value !== undefined) {
      map.delete(key);
      map.set(key, value);
    }
    return value;
  }

  private indexEpoch(repo: Repository): Promise<string | undefined> {
    const root = repo.rootUri.fsPath;
    const pending = this.indexChecks.get(root);
    if (pending) return pending;
    const check = (async () => {
      try {
        let file = this.indexPaths.get(root);
        if (!file) {
          file = indexLockPath(root).then((lock) => lock.slice(0, -5));
          this.indexPaths.set(root, file);
          this.trim(this.indexPaths);
        }
        const stat = await fs.lstat(await file, { bigint: true });
        return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(
          ":",
        );
      } catch {
        // Unborn/missing index or unsupported filesystem: validate through Git.
        this.indexPaths.delete(root);
        return undefined;
      }
    })().finally(() => this.indexChecks.delete(root));
    this.indexChecks.set(root, check);
    return check;
  }

  private async identity(
    change: ImageChange,
    source?: ImageSource,
  ): Promise<string> {
    if (!source) return "absent";
    const key = JSON.stringify([
      change.root,
      source.uri.toString(),
      source.ref,
    ]);
    const prefix = `${this.generation}:${key}:`;
    if (source.ref && /^[a-f0-9]{40,64}$/.test(source.ref))
      return prefix + source.ref;
    const repo = this.api.repositories.find(
      (repo) => repo.rootUri.fsPath === change.root,
    );
    if (source.ref !== undefined && repo?.getObjectDetails) {
      const epoch = source.ref === "" ? await this.indexEpoch(repo) : undefined;
      const old = this.touch(this.metadata, key);
      if (epoch && old?.epoch === epoch) return prefix + old.object;
      const requestKey = `${prefix}:${epoch ?? "unknown"}`;
      let request = this.metadataReads.get(requestKey);
      if (!request) {
        const literalPath = `:(literal)${path.relative(change.root, source.uri.fsPath).split(path.sep).join("/")}`;
        request = repo
          .getObjectDetails(source.ref, literalPath)
          .then((details) => {
            const object = `${details.mode}:${details.object}:${details.size}`;
            if (epoch) {
              this.metadata.set(key, { epoch, object });
              this.trim(this.metadata);
            }
            return prefix + object;
          })
          .finally(() => this.metadataReads.delete(requestKey));
        this.metadataReads.set(requestKey, request);
      }
      return request;
    }
    const uri =
      source.ref === undefined
        ? source.uri
        : this.api.toGitUri(source.uri, source.ref);
    const stat = await vscode.workspace.fs.stat(uri);
    // Git's virtual file mtime is synthetic. Older API providers without object
    // identities, or filesystems without timestamps, must fall back to fresh reads.
    if (
      source.ref !== undefined ||
      !Number.isFinite(stat.mtime) ||
      !Number.isFinite(stat.ctime)
    )
      return prefix + `uncached:${++this.uncached}`;
    return (
      prefix +
      [
        stat.type,
        stat.size,
        stat.mtime,
        stat.ctime,
        this.epochs.get(source.uri.toString()) ?? 0,
      ].join(":")
    );
  }
  private uncached = 0;
  private eventSequence = 0;

  private async keys(change: ImageChange) {
    return Promise.all([
      this.identity(change, change.before),
      this.identity(change, change.after),
    ]);
  }

  private read(key: string, source?: ImageSource) {
    if (!source) return Promise.resolve(null);
    const cached = this.touch(this.bytes, key);
    if (cached) return Promise.resolve(cached);
    const pending = this.reads.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const read = readImageBytes(this.api, source)
      .then((image) => {
        if (
          image &&
          !image.error &&
          !this.disposed &&
          generation === this.generation
        ) {
          this.bytes.set(key, image);
          this.byteSize += image.data?.byteLength ?? 0;
          while (this.byteSize > this.byteLimit || this.bytes.size > 2000) {
            const oldest = this.bytes.keys().next().value!;
            this.byteSize -= this.bytes.get(oldest)?.data?.byteLength ?? 0;
            this.bytes.delete(oldest);
          }
        }
        return image;
      })
      .finally(() => this.reads.delete(key));
    this.reads.set(key, read);
    return read;
  }

  private async pair(change: ImageChange, keys: string[]): Promise<Pair> {
    const key = JSON.stringify(keys);
    const pending = this.pairs.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const read = (async () => {
      const [before, after] = await Promise.all([
        this.read(keys[0], change.before),
        this.read(keys[1], change.after),
      ]);
      try {
        const afterKeys = await this.keys(change);
        if (
          keys.some(
            (value, i) =>
              !value.includes(":uncached:") && value !== afterKeys[i],
          )
        )
          throw new ChangedDuringRead(
            "Image changed while being read. Try again after the writer finishes.",
          );
      } catch (error) {
        for (const sourceKey of keys) {
          this.byteSize -= this.bytes.get(sourceKey)?.data?.byteLength ?? 0;
          this.bytes.delete(sourceKey);
        }
        throw error;
      }
      const previous = this.touch(this.revisions, key);
      const revision = previous?.revision ?? comparisonRevision(before, after);
      if (
        !this.disposed &&
        generation === this.generation &&
        !before?.error &&
        !after?.error
      ) {
        this.revisions.set(key, { revision });
        this.trim(this.revisions);
      }
      return { before, after, revision };
    })().finally(() => this.pairs.delete(key));
    this.pairs.set(key, read);
    return read;
  }

  private async stable<T>(read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await read();
      } catch (error) {
        if (!(error instanceof ChangedDuringRead) || attempt >= 2) throw error;
      }
    }
  }

  async revision(change: ImageChange): Promise<string> {
    return this.stable(async () => {
      const keys = await this.keys(change);
      const cached = this.touch(this.revisions, JSON.stringify(keys));
      if (cached) return cached.revision;
      const result = await this.pair(change, keys);
      if (result.before?.error || result.after?.error)
        throw new Error(result.before?.error ?? result.after!.error);
      return result.revision;
    });
  }

  async comparison(change: ImageChange, knownRevision?: string) {
    const response = (result: Pair) =>
      result.revision === knownRevision
        ? { revision: result.revision, unchanged: true as const }
        : {
            revision: result.revision,
            before: payload(result.before),
            after: payload(result.after),
          };
    try {
      return await this.stable(async () => {
        const keys = await this.keys(change);
        const revision = this.touch(
          this.revisions,
          JSON.stringify(keys),
        )?.revision;
        if (knownRevision && revision === knownRevision)
          return { revision, unchanged: true as const };
        return response(await this.pair(change, keys));
      });
    } catch {
      // Return the same useful per-side errors as the uncached viewer.
      const { readImagePair } = await import("./images");
      return response(await readImagePair(this.api, change));
    }
  }

  dispose() {
    this.disposed = true;
    this.invalidate();
    this.indexPaths.clear();
  }
}
