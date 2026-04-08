import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";

/** File extension patterns used throughout the codebase */
const SESSION_EXTENSIONS = new Set([".json", ".jsonl"]);

/**
 * Check if a filename looks like a session file.
 */
export function isSessionFile(filename: string): boolean {
  for (const ext of SESSION_EXTENSIONS) {
    if (filename.endsWith(ext)) return true;
  }
  return false;
}

/**
 * List session files in a directory.
 * Returns sorted array of filenames.
 */
export function listSessionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.startsWith(".") && isSessionFile(f))
    .sort();
}

/**
 * Load a line-based file (reject.txt, deny patterns, etc).
 * Returns Set of trimmed non-empty lines.
 */
export function loadLineSet(filePath: string): Set<string> {
  if (!existsSync(filePath)) return new Set();
  return new Set(
    readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
  );
}

/**
 * Load regex patterns from a file (one per line).
 * Invalid patterns are silently skipped.
 */
export function loadRegexPatterns(filePath: string): RegExp[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return new RegExp(l);
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
}

/**
 * Save a Set of strings to a file, one per line, sorted.
 */
export function saveLineSet(filePath: string, values: Set<string>): void {
  const content = [...values].sort().join("\n") + "\n";
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * Resolve a tilde-prefixed path to the user's home directory.
 */
export function resolveTildePath(path: string): string {
  if (!path.startsWith("~")) return path;
  return join(process.env.HOME || "", path.slice(1));
}

/**
 * Parse colon-separated paths, resolving tildes.
 */
export function parseColonPaths(input: string): string[] {
  return input
    .split(":")
    .map((p) => resolveTildePath(p.trim()))
    .filter((p) => p.length > 0);
}
