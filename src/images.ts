import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { GitAPI } from "./git-api";
import { ImageChange, ImageSource, mimeType } from "./changes";

export const maxImageBytes = 32 * 1024 * 1024;
export interface ImagePayload {
  data?: string;
  bytes?: number;
  error?: string;
}

export interface ImageBytes {
  data?: Uint8Array;
  mime?: string;
  error?: string;
}

export function comparisonRevision(
  before: ImageBytes | null,
  after: ImageBytes | null,
): string {
  const hash = createHash("sha256");
  for (const image of [before, after]) {
    if (!image) hash.update("absent:");
    else if (image.error)
      hash.update(`error:${image.error.length}:`).update(image.error);
    else
      hash
        .update(`image:${image.mime}:${image.data!.length}:`)
        .update(image.data!);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function readImagePair(api: GitAPI, change: ImageChange) {
  const [before, after] = await Promise.all([
    readImageBytes(api, change.before),
    readImageBytes(api, change.after),
  ]);
  return { before, after, revision: comparisonRevision(before, after) };
}

export function payload(image: ImageBytes | null): ImagePayload | null {
  if (!image) return null;
  if (image.error) return { error: image.error };
  return {
    data: `data:${image.mime};base64,${Buffer.from(image.data!).toString("base64")}`,
    bytes: image.data!.length,
  };
}

export async function readComparison(
  api: GitAPI,
  change: ImageChange,
  knownRevision?: string,
) {
  const result = await readImagePair(api, change);
  return result.revision === knownRevision
    ? { revision: result.revision, unchanged: true as const }
    : {
        revision: result.revision,
        before: payload(result.before),
        after: payload(result.after),
      };
}

export async function imageRevision(
  api: GitAPI,
  change: ImageChange,
): Promise<string> {
  const result = await readImagePair(api, change);
  if (result.before?.error || result.after?.error)
    throw new Error(result.before?.error ?? result.after!.error);
  return result.revision;
}

export async function readImage(
  api: GitAPI,
  source?: ImageSource,
): Promise<ImagePayload | null> {
  return payload(await readImageBytes(api, source));
}

export async function readImageBytes(
  api: GitAPI,
  source?: ImageSource,
): Promise<ImageBytes | null> {
  if (!source) return null;
  try {
    const mime = mimeType(source.uri.fsPath);
    if (!mime)
      throw new Error(
        "This version does not have a supported image extension.",
      );
    const uri =
      source.ref === undefined
        ? source.uri
        : api.toGitUri(source.uri, source.ref);
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.SymbolicLink)
      throw new Error(
        "Symbolic links are not previewed. Open the target image instead.",
      );
    if (stat.size > maxImageBytes)
      throw new Error("Image exceeds the 32 MiB preview limit.");
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > maxImageBytes)
      throw new Error("Image exceeds the 32 MiB preview limit.");
    if (
      Buffer.from(bytes.subarray(0, 128))
        .toString("utf8")
        .startsWith("version https://git-lfs.github.com/spec/v1")
    ) {
      throw new Error(
        "This version is a Git LFS pointer. Its image bytes are not stored in Git; no LFS download is run.",
      );
    }
    return {
      data: bytes,
      mime,
    };
  } catch (error) {
    return {
      error: `${source.label}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
