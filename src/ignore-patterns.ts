import ignore = require("../vendor/ignore");

function exact(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.split("/").includes("..") ||
    /[\r\n]/.test(path)
  )
    throw new Error("This path cannot be stored in .image_ignore.");
  return "/" + path.replace(/[\\*?\[\] ]/g, "\\$&");
}

/** Append literal rules/exceptions; preserve comments and existing wildcard rules. */
export function updateIgnorePatterns(
  content: string,
  paths: string[],
  ignored: boolean,
): string {
  const matcher = ignore({ ignorecase: false }).add(content);
  const additions: string[] = [];
  const add = (rule: string) => {
    additions.push(rule);
    matcher.add(rule);
  };
  for (const path of new Set(paths)) {
    const pattern = exact(path);
    if (matcher.ignores(path) === ignored) continue;
    if (ignored) add(pattern);
    else {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const directory = parts.slice(0, i).join("/");
        if (matcher.ignores(directory + "/")) {
          add("!" + exact(directory) + "/");
          // Opening an excluded parent must not reveal its other descendants.
          add(exact(directory) + "/*");
        }
      }
      add("!" + pattern);
    }
  }
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  return additions.length
    ? content +
        (content && !content.endsWith("\n") ? newline : "") +
        additions.join(newline) +
        newline
    : content;
}
