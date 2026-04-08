import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, basename } from "path";

export class HFUploader {
  private repo: string;
  private workspace: string;

  constructor(repo: string, workspace: string) {
    this.repo = repo;
    this.workspace = workspace;
  }

  /**
   * Verify hf CLI is installed
   */
  checkDependencies(): boolean {
    try {
      execSync("hf auth whoami", { stdio: "pipe" });
      return true;
    } catch {
      console.error(
        "[ERROR] hf CLI not found. Install with: pip install huggingface_hub[cli]"
      );
      return false;
    }
  }

  /**
   * Create or update HF dataset repo
   */
  ensureRepo(): boolean {
    try {
      // Check if repo exists
      execSync(`hf repos info ${this.repo} --type dataset`, {
        stdio: "pipe",
      });
      console.log(`[OK] Dataset repo ${this.repo} exists`);
      return true;
    } catch {
      console.log(`Creating dataset repo ${this.repo}...`);
      try {
        execSync(
          `hf repos create ${this.repo} --type dataset --private`,
          { stdio: "pipe" }
        );
        console.log(`[OK] Created dataset repo ${this.repo}`);
        return true;
      } catch (error: any) {
        // Check if it's a 409 conflict (repo already exists)
        if (error.message && error.message.includes('409')) {
          console.log(`[OK] Dataset repo ${this.repo} already exists`);
          return true;
        }
        // Check if already exists (fallback)
        try {
          execSync(`hf repos info ${this.repo} --type dataset`, {
            stdio: "pipe",
          });
          console.log(`[OK] Dataset repo ${this.repo} exists`);
          return true;
        } catch {
          console.error(`[ERROR] Failed to create repo: ${error}`);
          return false;
        }
      }
    }
  }

  /**
   * Generate dataset card
   */
  generateDatasetCard(organizationOrUser?: string): string {
    const repoId = organizationOrUser ? `${organizationOrUser}/${this.repo}` : this.repo;
    return `---
viewer: false
dataset_info:
  format: agent-traces
  config_name: default
  splits:
  - name: train
    num_bytes: 0
    num_examples: 0
  download_size: 0
  dataset_size: 0
license: mit
task_categories:
- text-generation
tags:
- format:agent-traces
- agent-traces
- coding-agent
- vtcode-share-hf
- redacted
pretty_name: vtcode Session Traces
size_categories:
- n<1K
language:
- en
- code
modality:
- text
---

# Coding agent session traces for VTCode

This dataset contains redacted coding agent session traces collected while working on various projects. The traces were exported with vtcode-share-hf from a local VTCode workspace and filtered to keep only sessions that passed deterministic redaction and LLM review.

## Data description

Each \`*.json\` file is a redacted VTCode session. Sessions are stored as JSON files containing structured session data including conversation transcripts, tool calls, model responses, and metadata.

VTCode session files contain complete coding sessions with user interactions, assistant responses, tool executions, and session metadata. See the upstream session format documentation for the exact schema.

Source tool: [https://github.com/vinhnx/VTCode](https://github.com/vinhnx/VTCode)

## Session Format

VTCode sessions follow the [ATIF Protocol](https://harborframework.com/docs/agents/trajectory-format) for standardized agent trajectory interchange.

## Redaction and review

The data was processed with vtcode-share-hf using deterministic secret redaction plus an LLM review step. Deterministic redaction targets exact known secrets and curated credential patterns. The LLM review decides whether a session is fit to share publicly and whether any sensitive content appears to have been missed.

## Limitations

This dataset is best-effort redacted. Coding agent transcripts can still contain sensitive or off-topic content, especially if a session mixed work with unrelated private tasks. Use with appropriate caution.

## Agent Trace Viewer

This dataset contains complex nested trajectory data that is best explored using the dedicated ATIF viewer:

\`\`\`bash
# Install vtcode-share-hf and run the viewer
vtcode-share-hf viewer
\`\`\`

Then open http://localhost:3000 in your browser to load and explore trajectory files with full interactive features including step navigation, tool call visualization, and metrics tracking.

For programmatic access, use the datasets library:

\`\`\`python
from datasets import load_dataset
ds = load_dataset("vinhnx90/vtcode-sessions")
\`\`\`

## License

This dataset is released under the [MIT License](https://opensource.org/licenses/MIT).
`;
  }

  /**
   * Upload sessions to HF
   */
  upload(dryRun: boolean = false): {
    success: boolean;
    uploaded: number;
    skipped: number;
  } {
    if (!this.checkDependencies()) {
      return { success: false, uploaded: 0, skipped: 0 };
    }

    const redactedDir = join(this.workspace, "redacted");
    if (!existsSync(redactedDir)) {
      console.error(`[ERROR] No redacted sessions directory: ${redactedDir}`);
      return { success: false, uploaded: 0, skipped: 0 };
    }

    // Read manifest if exists
    const manifestPath = join(this.workspace, "manifest.jsonl");
    const uploadedSessions = new Set<string>();

    if (existsSync(manifestPath)) {
      try {
        const lines = readFileSync(manifestPath, "utf-8").split("\n");
        for (const line of lines) {
          if (line.trim()) {
            const entry = JSON.parse(line);
            uploadedSessions.add(entry.file);
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Collect sessions to upload
    let uploaded = 0;
    let skipped = 0;

    try {
      const files = this.getRedactedSessions();
      console.log(`Found ${files.length} redacted sessions`);

      if (dryRun) {
        console.log("\n[DRY-RUN] Would upload:");
        files.forEach((file) => {
          if (uploadedSessions.has(file)) {
            console.log(`  [SKIP] ${file} (already uploaded)`);
            skipped++;
          } else {
            console.log(`  [OK] ${file}`);
            uploaded++;
          }
        });
        return { success: true, uploaded, skipped };
      }

      // Real upload
      for (const file of files) {
        if (uploadedSessions.has(file)) {
          console.log(`[SKIP] ${file} already uploaded`);
          skipped++;
          continue;
        }

        const filePath = join(redactedDir, file);
        console.log(`[UPLOADING] ${file}...`);

        try {
          execSync(
            `hf upload ${this.repo} ${filePath} ${file} --repo-type dataset`,
            { stdio: "inherit" }
          );
          uploadedSessions.add(file);
          uploaded++;
        } catch (error) {
          console.error(`  [ERROR] Failed: ${error}`);
        }
      }

      // Update manifest
      this.updateManifest(uploadedSessions);

      console.log(`\n[DONE] Upload complete: ${uploaded} uploaded, ${skipped} skipped`);
      return { success: true, uploaded, skipped };
    } catch (error) {
      console.error(`[ERROR] Upload failed: ${error}`);
      return { success: false, uploaded, skipped };
    }
  }

  /**
   * Get list of redacted sessions
   */
  private getRedactedSessions(): string[] {
    const redactedDir = join(this.workspace, "redacted");
    if (!existsSync(redactedDir)) {
      return [];
    }

    try {
      const files = execSync(`find ${redactedDir} -name "*.json" -o -name "*.jsonl"`, {
        encoding: "utf-8",
      });
      return files
        .split("\n")
        .filter((f) => f.trim())
        .map((f) => basename(f));
    } catch {
      return [];
    }
  }

  /**
   * Upload dataset card (README.md)
   */
  uploadDatasetCard(organizationOrUser?: string): boolean {
    try {
      const cardContent = this.generateDatasetCard(organizationOrUser);
      const tempCardPath = join(this.workspace, "README.md");
      writeFileSync(tempCardPath, cardContent);

      console.log(`[UPLOADING] Dataset card...`);
      execSync(
        `hf upload ${this.repo} ${tempCardPath} README.md --repo-type dataset`,
        { stdio: "inherit" }
      );

      // Clean up temp file
      unlinkSync(tempCardPath);
      console.log(`[OK] Dataset card uploaded`);
      return true;
    } catch (error) {
      console.error(`[ERROR] Failed to upload dataset card: ${error}`);
      return false;
    }
  }

  /**
   * Update manifest
   */
  private updateManifest(files: Set<string>) {
    const manifestPath = join(this.workspace, "manifest.jsonl");
    const manifest: Array<{
      file: string;
      uploaded_at: string;
    }> = [];

    if (existsSync(manifestPath)) {
      try {
        const lines = readFileSync(manifestPath, "utf-8").split("\n");
        for (const line of lines) {
          if (line.trim()) {
            manifest.push(JSON.parse(line));
          }
        }
      } catch {
        // Ignore
      }
    }

    // Add new entries
    for (const file of files) {
      if (!manifest.find((m) => m.file === file)) {
        manifest.push({
          file,
          uploaded_at: new Date().toISOString(),
        });
      }
    }

    const content = manifest.map((m) => JSON.stringify(m)).join("\n");
    writeFileSync(manifestPath, content);
  }
}
