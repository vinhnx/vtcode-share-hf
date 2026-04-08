import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";

export class HFUploader {
  private repo: string;
  private workspace: string;

  constructor(repo: string, workspace: string) {
    this.repo = repo;
    this.workspace = workspace;
  }

  /**
   * Verify huggingface-cli is installed
   */
  checkDependencies(): boolean {
    try {
      execSync("huggingface-cli --version", { stdio: "pipe" });
      return true;
    } catch {
      console.error(
        "[ERROR] huggingface-cli not found. Install with: pip install huggingface_hub[cli]"
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
      execSync(`huggingface-cli repo-info ${this.repo} --repo-type dataset`, {
        stdio: "pipe",
      });
      console.log(`[OK] Dataset repo ${this.repo} exists`);
      return true;
    } catch {
      console.log(`Creating dataset repo ${this.repo}...`);
      try {
        execSync(
          `huggingface-cli repo create ${this.repo} --repo-type dataset --private`,
          { stdio: "inherit" }
        );
        console.log(`[OK] Created dataset repo ${this.repo}`);
        return true;
      } catch (error) {
        console.error(`[ERROR] Failed to create repo: ${error}`);
        return false;
      }
    }
  }

  /**
   * Generate dataset card
   */
  generateDatasetCard(organizationOrUser?: string): string {
    const repoId = organizationOrUser ? `${organizationOrUser}/${this.repo}` : this.repo;
    return `---
dataset_info:
  features:
  - name: session_file
    dtype: string
  - name: source_hash
    dtype: string
  - name: redacted_hash
    dtype: string
  - name: redactions_count
    dtype: int32
  splits:
  - name: train
    num_bytes: 0
    num_examples: 0
  download_size: 0
  dataset_size: 0
license: mit
tags:
- agent-traces
- coding-agent
- vtcode-share-hf
task_ids:
- other
pretty_name: vtcode Session Traces
size_categories:
- n<1K
---

# vtcode Session Traces

Redacted coding agent session traces from [vtcode](https://github.com/badlogic/vtcode).

**⚠️ These sessions have been redacted for PII and secrets** using:
- Deterministic pattern matching (API keys, tokens, emails)
- Explicit secret filtering from user-provided lists
- LLM review (if enabled)

See [vtcode-share-hf](https://github.com/badlogic/vtcode-share-hf) for redaction methodology.

## Dataset Structure

Each session is a JSON file containing:
- \`metadata\`: workspace label, model, provider, skills used
- \`started_at\`, \`ended_at\`: timestamps
- \`total_messages\`, \`distinct_tools\`: session stats
- \`transcript\`: conversation transcript with tool calls and outputs

## Usage

\`\`\`python
from datasets import load_dataset
ds = load_dataset("${repoId}")
\`\`\`

## Citation

\`\`\`bibtex
@dataset{vtcode_share_hf,
  title={vtcode Session Traces},
  author={vtcode contributors},
  year={2026},
  url={https://huggingface.co/datasets/${repoId}}
}
\`\`\`
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
            `huggingface-cli upload ${this.repo} ${filePath} ${file} --repo-type dataset`,
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
