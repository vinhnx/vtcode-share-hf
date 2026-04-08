import { writeFileSync, renameSync } from "fs";

/**
 * Atomic file write: writes to a temp file then renames.
 * Prevents corruption from partial writes or crashes.
 */
export function atomicWrite(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * Atomic JSON write with optional pretty-printing.
 */
export function atomicWriteJSON(filePath: string, data: unknown, pretty = true): void {
  const content = JSON.stringify(data, null, pretty ? 2 : undefined);
  atomicWrite(filePath, content);
}
