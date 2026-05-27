/**
 * Canonicalize a repo-relative path so two spellings of the same file compare
 * equal: forward slashes, no leading "./", no "." or duplicate-slash segments,
 * ".." resolved. Idempotent. Declared file ownership ("writes") is normalized
 * through this so a Windows "src\a.ts" and a "src/a.ts" claim the same lock.
 */
export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}
