import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { createHash } from "crypto";
import { Redactor } from "./redactor.js";
import { atomicWrite } from "./atomic-write.js";
import { loadLineSet, isSessionFile, saveLineSet } from "./session-file-utils.js";

export interface SessionMetadata {
  filename: string;
  source_hash: string;
  redacted_hash: string;
  redaction_key: string;
  size_bytes: number;
  created_at: string;
  redactions_count: number;
}

export interface WorkspaceConfig {
  workspace_path: string;
  sessions_path: string;
  repo: string;
  organization?: string;
  no_images: boolean;
  cwd?: string;
  manifest: SessionMetadata[];
}

export interface CollectResult {
  success: boolean;
  metadata?: SessionMetadata;
  skipped?: boolean;
  rejected?: boolean;
  error?: string;
}

export class SessionCollector {
  private redactor: Redactor;
  private workspace: WorkspaceConfig;
  private force: boolean = false;
  private denyPatterns: RegExp[] = [];
  private noImages: boolean = false;

  constructor(
    workspace_path: string,
    repo: string,
    organization?: string,
    secrets?: string | string[],
    options?: { noImages?: boolean; cwd?: string }
  ) {
    this.redactor = new Redactor(secrets);
    this.noImages = options?.noImages ?? false;
    this.workspace = {
      workspace_path,
      sessions_path: join(workspace_path, "redacted"),
      repo,
      organization,
      no_images: this.noImages,
      cwd: options?.cwd || process.cwd(),
      manifest: [],
    };

    this.ensureWorkspace();
  }

  setForce(force: boolean) {
    this.force = force;
  }

  setDenyPatterns(patterns: string | string[]) {
    const items = Array.isArray(patterns) ? patterns : [patterns];
    this.denyPatterns = items
      .map((p) => {
        try {
          return new RegExp(p);
        } catch {
          return null;
        }
      })
      .filter((r): r is RegExp => r !== null);
  }

  setNoImages(value: boolean) {
    this.noImages = value;
    this.workspace.no_images = value;
  }

  private ensureWorkspace() {
    const dirs = [
      this.workspace.workspace_path,
      this.workspace.sessions_path,
      join(this.workspace.workspace_path, "reports"),
      join(this.workspace.workspace_path, "review"),
      join(this.workspace.workspace_path, "review-chunks"),
      join(this.workspace.workspace_path, "images"),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Collect and redact a single session file.
   * Uses atomic write (write to .tmp then rename) to avoid corruption.
   */
  collectSession(sessionPath: string): CollectResult {
    const filename = basename(sessionPath);

    if (!this.shouldProcess(filename)) {
      return { success: true, skipped: true };
    }

    if (this.isDenied(filename)) {
      return { success: true, rejected: true };
    }

    try {
      const content = readFileSync(sessionPath, "utf-8");
      const sourceHash = this.hashContent(content);

      if (!this.force && this.isUnchanged(filename, sourceHash)) {
        return { success: true, skipped: true };
      }

      let sessionObj: unknown;
      try {
        sessionObj = JSON.parse(content);
      } catch {
        // Try JSONL format
        const lines = content
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
        sessionObj = { lines };
      }

      // Deny check on parsed content
      if (this.isSessionDenied(sessionObj)) {
        return { success: true, rejected: true };
      }

      // Redact
      const { obj: redacted, redactions } = this.redactor.redactObject(sessionObj);

      // Strip images if noImages is set
      const imageCount = this.stripImages(redacted);

      const redactionKey = this.computeRedactionKey(sourceHash, redactions.length);
      const redactedContent = JSON.stringify(redacted, null, 2);
      const redactedHash = this.hashContent(redactedContent);

      // Atomic write: write to temp file then rename
      const outputPath = join(this.workspace.sessions_path, filename);
      atomicWrite(outputPath, redactedContent);

      // Write report
      const report = {
        file: filename,
        source_hash: sourceHash,
        redacted_hash: redactedHash,
        redaction_key: redactionKey,
        redactions_count: redactions.length,
        images_stripped: imageCount,
        redactions: redactions.slice(0, 20),
        redaction_details: redactions,
      };
      const reportPath = join(this.workspace.workspace_path, "reports", `${filename}.report.json`);
      atomicWrite(reportPath, JSON.stringify(report, null, 2));

      const metadata: SessionMetadata = {
        filename,
        source_hash: sourceHash,
        redacted_hash: redactedHash,
        redaction_key: redactionKey,
        size_bytes: Buffer.byteLength(redactedContent),
        created_at: new Date().toISOString(),
        redactions_count: redactions.length,
      };

      this.updateManifest(metadata);

      return { success: true, metadata };
    } catch (error) {
      return {
        success: false,
        error: `Failed to collect session: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  extractImages(sessionFiles?: string[]): Map<string, string[]> {
    const files = sessionFiles || this.getRedactedSessions();
    const imageDir = join(this.workspace.workspace_path, "images");
    mkdirSync(imageDir, { recursive: true });
    const result = new Map<string, string[]>();

    for (const filename of files) {
      const filePath = join(this.workspace.sessions_path, filename);
      const content = readFileSync(filePath, "utf-8");
      const extracted = this.extractImagesFromFile(content, filename, imageDir);
      if (extracted.length > 0) {
        result.set(filename, extracted);
      }
    }

    return result;
  }

  private extractImagesFromFile(content: string, sessionName: string, imageDir: string): string[] {
    const extracted: string[] = [];
    // Match base64 data URIs for images
    const dataUriRegex = /data:image\/(\w+);base64,([A-Za-z0-9+/=]{100,})/g;
    let match;
    let index = 0;

    while ((match = dataUriRegex.exec(content)) !== null) {
      const ext = match[1];
      const base64 = match[2];
      const safeName = sessionName.replace(/\.(json|jsonl)$/, "")
        .replace(/[^a-zA-Z0-9_-]/g, "_");
      const imageName = `${safeName}_img${index}.${ext}`;
      const imagePath = join(imageDir, imageName);

      try {
        const buffer = Buffer.from(base64, "base64");
        writeFileSync(imagePath, buffer);
        extracted.push(imageName);
        index++;
      } catch {
        // Skip invalid base64
      }
    }

    return extracted;
  }

  /**
   * Strip image data from redacted object in-place, replacing with placeholder.
   * Returns count of stripped images.
   */
  stripImages(obj: unknown): number {
    if (!this.noImages) return 0;
    let count = 0;

    const recurse = (item: unknown): unknown => {
      if (typeof item === "string") {
        if (item.startsWith("data:image/") && item.length > 256) {
          count++;
          return "[IMAGE_REMOVED]";
        }
        return item;
      }
      if (item === null || typeof item !== "object") return item;
      if (Array.isArray(item)) return item.map(recurse);

      const rec = item as Record<string, unknown>;
      // Check for mimeType + data pattern at this level
      if (typeof rec.mimeType === "string" && rec.mimeType.startsWith("image/") && typeof rec.data === "string" && rec.data.length > 256) {
        count++;
        rec.data = "[IMAGE_REMOVED]";
      }
      // Recurse into children
      for (const key of Object.keys(rec)) {
        rec[key] = recurse(rec[key]);
      }
      return item;
    };

    recurse(obj);
    return count;
  }

  private shouldProcess(filename: string): boolean {
    const rejected = this.loadRejected();
    return !rejected.has(filename);
  }

  private isDenied(filename: string): boolean {
    for (const pattern of this.denyPatterns) {
      if (pattern.test(filename)) {
        return true;
      }
    }
    return false;
  }

  private isSessionDenied(obj: unknown): boolean {
    const content = JSON.stringify(obj);
    for (const pattern of this.denyPatterns) {
      if (pattern.test(content)) {
        return true;
      }
    }
    return false;
  }

  private isUnchanged(filename: string, sourceHash: string): boolean {
    const reportPath = join(this.workspace.workspace_path, "reports", `${filename}.report.json`);
    if (!existsSync(reportPath)) {
      return false;
    }

    try {
      const report = JSON.parse(readFileSync(reportPath, "utf-8"));
      return report.source_hash === sourceHash;
    } catch {
      return false;
    }
  }

  /**
   * Update manifest with atomic write.
   * Reads existing entries, updates or adds the new entry, writes atomically.
   */
  private updateManifest(metadata: SessionMetadata) {
    const manifestPath = join(this.workspace.workspace_path, "manifest.local.jsonl");
    const entries: SessionMetadata[] = [];

    if (existsSync(manifestPath)) {
      try {
        const lines = readFileSync(manifestPath, "utf-8").split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            entries.push(JSON.parse(trimmed));
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Start fresh if file is unreadable
      }
    }

    const index = entries.findIndex((e) => e.filename === metadata.filename);
    if (index >= 0) {
      entries[index] = metadata;
    } else {
      entries.push(metadata);
    }

    // Atomic write
    const content = entries.map((e) => JSON.stringify(e)).join("\n");
    atomicWrite(manifestPath, content + "\n");
  }

  saveWorkspaceConfig() {
    const configPath = join(this.workspace.workspace_path, "workspace.json");
    atomicWrite(configPath, JSON.stringify(this.workspace, null, 2));
  }

  loadWorkspaceConfig(): WorkspaceConfig | null {
    const configPath = join(this.workspace.workspace_path, "workspace.json");
    if (!existsSync(configPath)) return null;
    try {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return null;
    }
  }

  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  private computeRedactionKey(sourceHash: string, redactionCount: number): string {
    const key = `v1:${sourceHash}:${redactionCount}`;
    return createHash("sha256").update(key).digest("hex");
  }

  getWorkspace(): WorkspaceConfig {
    return this.workspace;
  }

  getRedactedSessions(): string[] {
    const dir = this.workspace.sessions_path;
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(isSessionFile).sort();
  }

  getUploadableSessions(): string[] {
    const rejected = this.loadRejected();
    return this.getRedactedSessions().filter((f) => !rejected.has(f));
  }

  loadRejected(): Set<string> {
    const rejectPath = join(this.workspace.workspace_path, "reject.txt");
    return loadLineSet(rejectPath);
  }

  addRejected(filename: string) {
    const rejectPath = join(this.workspace.workspace_path, "reject.txt");
    const rejected = this.loadRejected();
    rejected.add(filename);
    saveLineSet(rejectPath, rejected);
  }

  removeRejected(filename: string) {
    const rejectPath = join(this.workspace.workspace_path, "reject.txt");
    const rejected = this.loadRejected();
    rejected.delete(filename);
    saveLineSet(rejectPath, rejected);
  }

  /**
   * Load session file content (for grep, review, etc.)
   */
  loadSession(filename: string): string | null {
    const filePath = join(this.workspace.sessions_path, filename);
    if (!existsSync(filePath)) return null;
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Get session metadata from manifest
   */
  getSessionMetadata(filename: string): SessionMetadata | undefined {
    const manifestPath = join(this.workspace.workspace_path, "manifest.local.jsonl");
    if (!existsSync(manifestPath)) return undefined;

    try {
      const lines = readFileSync(manifestPath, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as SessionMetadata;
          if (entry.filename === filename) return entry;
        } catch {
          // Skip malformed
        }
      }
    } catch {
      // File unreadable
    }
    return undefined;
  }
}
