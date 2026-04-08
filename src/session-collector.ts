import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { createHash } from "crypto";
import { Redactor } from "./redactor.js";

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
  manifest: SessionMetadata[];
}

export class SessionCollector {
  private redactor: Redactor;
  private workspace: WorkspaceConfig;

  constructor(
    workspace_path: string,
    repo: string,
    organization?: string,
    secrets?: string | string[]
  ) {
    this.redactor = new Redactor(secrets);
    this.workspace = {
      workspace_path,
      sessions_path: join(workspace_path, "redacted"),
      repo,
      organization,
      no_images: false,
      manifest: [],
    };

    this.ensureWorkspace();
  }

  /**
   * Initialize workspace directories
   */
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
   * Collect and redact a session file
   */
  collectSession(sessionPath: string): {
    success: boolean;
    metadata?: SessionMetadata;
    error?: string;
  } {
    try {
      const content = readFileSync(sessionPath, "utf-8");
      const sourceHash = this.hashContent(content);

      // Parse JSON
      let sessionObj: any;
      try {
        sessionObj = JSON.parse(content);
      } catch {
        // Try JSONL format (one JSON per line)
        sessionObj = {
          lines: content
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line)),
        };
      }

      // Redact
      const { obj: redacted, redactions } = this.redactor.redactObject(sessionObj);
      const redactionKey = this.computeRedactionKey(sourceHash, redactions.length);
      const redactedContent = JSON.stringify(redacted, null, 2);
      const redactedHash = this.hashContent(redactedContent);

      // Write redacted session
      const filename = basename(sessionPath);
      const outputPath = join(this.workspace.sessions_path, filename);
      writeFileSync(outputPath, redactedContent);

      // Write report
      const report = {
        file: filename,
        source_hash: sourceHash,
        redacted_hash: redactedHash,
        redactions_count: redactions.length,
        redactions: redactions.slice(0, 10), // First 10 for preview
      };
      const reportPath = join(
        this.workspace.workspace_path,
        "reports",
        `${filename}.report.json`
      );
      writeFileSync(reportPath, JSON.stringify(report, null, 2));

      const metadata: SessionMetadata = {
        filename,
        source_hash: sourceHash,
        redacted_hash: redactedHash,
        redaction_key: redactionKey,
        size_bytes: Buffer.byteLength(redactedContent),
        created_at: new Date().toISOString(),
        redactions_count: redactions.length,
      };

      return { success: true, metadata };
    } catch (error) {
      return {
        success: false,
        error: `Failed to collect session: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Save workspace config
   */
  saveWorkspaceConfig() {
    const configPath = join(this.workspace.workspace_path, "workspace.json");
    writeFileSync(configPath, JSON.stringify(this.workspace, null, 2));
  }

  /**
   * Load workspace config
   */
  loadWorkspaceConfig(): WorkspaceConfig | null {
    const configPath = join(this.workspace.workspace_path, "workspace.json");
    if (existsSync(configPath)) {
      try {
        return JSON.parse(readFileSync(configPath, "utf-8"));
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Hash content
   */
  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * Compute redaction key for caching
   */
  private computeRedactionKey(sourceHash: string, redactionCount: number): string {
    const key = `v1:${sourceHash}:${redactionCount}`;
    return createHash("sha256").update(key).digest("hex");
  }

  getWorkspace(): WorkspaceConfig {
    return this.workspace;
  }
}
