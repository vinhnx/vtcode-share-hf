import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { WorkspaceConfig, SessionMetadata } from "./session-collector.js";

/**
 * Load workspace config from a workspace directory.
 * Returns null if the workspace is not initialized or config is unreadable.
 */
export function loadWorkspaceConfig(workspacePath: string): WorkspaceConfig | null {
  const configPath = join(workspacePath, "workspace.json");
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Validate that a workspace is initialized and readable.
 * Returns the workspace config or exits with an error message.
 */
export function requireWorkspaceConfig(workspacePath: string): WorkspaceConfig | null {
  if (!existsSync(workspacePath)) {
    console.error(`[ERROR] Workspace not found at ${workspacePath}`);
    return null;
  }
  const config = loadWorkspaceConfig(workspacePath);
  if (!config) {
    console.error("[ERROR] Cannot read workspace config. Run 'vtcode-share-hf init' first.");
    return null;
  }
  return config;
}

/**
 * Build a temporary SessionCollector just to load config.
 * Uses empty repo string since we only need file I/O, not collection.
 */
export async function loadWorkspaceFromCollector(workspacePath: string): Promise<WorkspaceConfig | null> {
  if (!existsSync(workspacePath)) {
    console.error(`[ERROR] Workspace not found at ${workspacePath}`);
    return null;
  }
  const { SessionCollector } = await import("./session-collector.js");
  const config = new SessionCollector(workspacePath, "").loadWorkspaceConfig();
  if (!config) {
    console.error("[ERROR] Cannot read workspace config.");
    return null;
  }
  return config;
}

/**
 * Resolve a workspace directory from cwd and optional override.
 */
export function resolveWorkspace(cwd: string, workspaceDir?: string): string {
  return resolve(cwd, workspaceDir || ".vtcode-hf");
}

/**
 * Parse manifest.local.jsonl from a workspace directory.
 * Returns array of session metadata entries.
 */
export function loadManifest(workspacePath: string): SessionMetadata[] {
  const manifestPath = join(workspacePath, "manifest.local.jsonl");
  if (!existsSync(manifestPath)) return [];
  try {
    return readFileSync(manifestPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l.trim()) as SessionMetadata);
  } catch {
    return [];
  }
}

/**
 * Get the full repo ID (with optional org namespace).
 */
export function fullRepoId(repo: string, organization?: string): string {
  return organization ? `${organization}/${repo}` : repo;
}
