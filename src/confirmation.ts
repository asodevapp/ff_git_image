import * as vscode from "vscode";

/** Keep native modal buttons on screen; the complete list belongs in an editor. */
export async function confirmImageAction(
  title: string,
  detail: string,
  paths: readonly string[],
  accept: string,
): Promise<boolean> {
  const preview = paths.slice(0, 3).map((file) => {
    const line = JSON.stringify(file);
    return line.length > 80 ? `…${line.slice(-79)}` : line;
  });
  if (paths.length > preview.length)
    preview.push(`… and ${paths.length - preview.length} more files`);
  const choice = await vscode.window.showWarningMessage(
    title,
    { modal: true, detail: `${detail}\n\n${preview.join("\n")}` },
    accept,
    "View File List",
  );
  if (choice === "View File List") {
    const document = await vscode.workspace.openTextDocument({
      language: "plaintext",
      content: `${title}\n\n${detail}\n\nReview this list, then run the action again to confirm.\n\n${paths.map((file) => JSON.stringify(file)).join("\n")}\n`,
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }
  return choice === accept;
}
