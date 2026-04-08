import { execSync } from "child_process";
import { existsSync, readFileSync, statSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { atomicWrite } from "./atomic-write.js";
import { isSessionFile, loadLineSet } from "./session-file-utils.js";

interface UploadedEntry {
  filename: string;
  uploaded_at: string;
  size_bytes: number;
}

export interface UploadResult {
  success: boolean;
  uploaded: number;
  skipped: number;
  failed: string[];
}

export class HFUploader {
  private repo: string;
  private workspace: string;
  private org?: string;

  constructor(repo: string, workspace: string, organization?: string) {
    this.repo = repo;
    this.workspace = workspace;
    this.org = organization;
  }

  checkDependencies(): boolean {
    try {
      execSync("hf auth whoami", { stdio: "pipe" });
      return true;
    } catch {
      console.error("[ERROR] hf CLI not found. Install with: pip install huggingface_hub[cli]");
      return false;
    }
  }

  ensureRepo(): boolean {
    const fullRepo = this.org ? `${this.org}/${this.repo}` : this.repo;

    try {
      execSync(`hf repos info ${fullRepo} --type dataset`, { stdio: "pipe" });
      console.log(`[OK] Dataset repo ${fullRepo} exists`);
      return true;
    } catch {
      console.log(`Creating dataset repo ${fullRepo}...`);
      try {
        execSync(`hf repos create ${fullRepo} --type dataset`, { stdio: "pipe" });
        console.log(`[OK] Created dataset repo ${fullRepo}`);
        return true;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const errStatus = (error as { status?: number }).status;
        // 409 = already exists (race condition with concurrent creation)
        if (errStatus === 409 || (errMsg && errMsg.includes("409"))) {
          console.log(`[OK] Dataset repo ${fullRepo} already exists`);
          return true;
        }
        // Fallback: check if it exists as a regular repo
        try {
          execSync(`hf repos info ${fullRepo}`, { stdio: "pipe" });
          console.log(`[OK] Dataset repo ${fullRepo} exists`);
          return true;
        } catch {
          console.error(`[ERROR] Failed to create repo: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        }
      }
    }
  }

  generateDatasetCard(): string {
    const fullRepo = this.org ? `${this.org}/${this.repo}` : this.repo;
    const sessions = this.getRedactedSessions();
    const totalSize = sessions.reduce((acc, f) => {
      const stats = statSync(join(this.workspace, "redacted", f));
      return acc + stats.size;
    }, 0);

    return `---
viewer: false
dataset_info:
  format: agent-traces
  config_name: default
  splits:
  - name: train
    num_bytes: ${totalSize}
    num_examples: ${sessions.length}
  download_size: ${totalSize}
  dataset_size: ${totalSize}
license: mit
task_categories:
- text-generation
tags:
- format:agent-traces
- agent-traces
- coding-agent
- vtcode-share-hf
- redacted
pretty_name: VTCode Session Traces
size_categories:
- n<1K
language:
- en
- code
modality:
- text
---

# VTCode Session Traces

This dataset contains redacted coding agent session traces collected using [vtcode-share-hf](https://github.com/vinhnx/vtcode-share-hf). Sessions are exported from a local VTCode workspace and filtered to keep only sessions that passed deterministic redaction and LLM review.

## Data Description

Each \`*.json\` or \`*.jsonl\` file is a redacted VTCode session. Sessions follow the [ATIF Protocol](https://harborframework.com/docs/agents/trajectory-format) for standardized agent trajectory interchange.

## Redaction

The data was processed with deterministic secret redaction. Known secrets are replaced with \`[REDACTED_*]\` placeholders. An additional scan with TruffleHog catches any remaining secrets.

## Stats

- **Sessions**: ${sessions.length}
- **Total size**: ${(totalSize / 1024).toFixed(1)} KB

## Limitations

This dataset is best-effort redacted. Use with appropriate caution.

## Usage

\`\`\`bash
# View trajectories locally
vtcode-share-hf viewer

# Load programmatically
from datasets import load_dataset
ds = load_dataset("${fullRepo}")
\`\`\`

## Source Code

- **Repository**: https://github.com/vinhnx/vtcode-share-hf

## License

MIT License
`;
  }

  upload(dryRun: boolean = false): UploadResult {
    if (!this.checkDependencies()) {
      return { success: false, uploaded: 0, skipped: 0, failed: [] };
    }

    const redactedDir = join(this.workspace, "redacted");
    if (!existsSync(redactedDir)) {
      console.error(`[ERROR] No redacted sessions: ${redactedDir}`);
      return { success: false, uploaded: 0, skipped: 0, failed: [] };
    }

    const uploadedSet = this.loadManifest();
    const rejected = this.loadRejected();
    const files = this.getRedactedSessions().filter((f) => !rejected.has(f));

    console.log(`Found ${files.length} redacted sessions (${rejected.size} rejected, excluded)`);

    let uploaded = 0;
    let skipped = 0;
    const failed: string[] = [];
    const toUpload: string[] = [];

    for (const file of files) {
      if (uploadedSet.has(file)) {
        console.log(`[SKIP] ${file} (already uploaded)`);
        skipped++;
      } else {
        toUpload.push(file);
      }
    }

    if (toUpload.length === 0) {
      console.log("[DONE] All sessions already uploaded.");
      return { success: true, uploaded: 0, skipped, failed };
    }

    if (dryRun) {
      console.log("\n[DRY-RUN] Would upload:");
      for (const file of toUpload) {
        console.log(`  [OK] ${file}`);
      }
      return { success: true, uploaded: toUpload.length, skipped, failed };
    }

    // Upload dataset card first
    this.uploadDatasetCard();

    // Upload sessions
    for (const file of toUpload) {
      const filePath = join(redactedDir, file);
      console.log(`[UPLOADING] ${file}...`);

      try {
        execSync(`hf upload ${this.repo} ${filePath} ${file} --repo-type dataset`, {
          stdio: "inherit",
          timeout: 120_000,
        });
        uploadedSet.add(file);
        uploaded++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`  [ERROR] ${file}: ${msg}`);
        failed.push(file);
      }
    }

    // Also upload images if present
    this.uploadImages();

    // Save updated manifest
    this.saveManifest(uploadedSet);

    console.log(`\n[DONE] ${uploaded} uploaded, ${skipped} skipped, ${failed.length} failed`);
    return { success: failed.length === 0, uploaded, skipped, failed };
  }

  private getRedactedSessions(): string[] {
    const redactedDir = join(this.workspace, "redacted");
    if (!existsSync(redactedDir)) return [];
    return readdirSync(redactedDir).filter(isSessionFile).sort();
  }

  /**
   * Load manifest from file. Returns set of uploaded filenames.
   */
  private loadManifest(): Set<string> {
    const manifestPath = join(this.workspace, "manifest.local.jsonl");
    const sessions = new Set<string>();

    if (!existsSync(manifestPath)) {
      return sessions;
    }

    try {
      const lines = readFileSync(manifestPath, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as UploadedEntry | { filename: string };
          sessions.add(entry.filename);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File unreadable — start fresh
    }
    return sessions;
  }

  private saveManifest(sessions: Set<string>) {
    const manifestPath = join(this.workspace, "manifest.local.jsonl");
    const entries: UploadedEntry[] = [];

    for (const file of sessions) {
      const filePath = join(this.workspace, "redacted", file);
      const sizeBytes = existsSync(filePath) ? statSync(filePath).size : 0;
      entries.push({ filename: file, uploaded_at: new Date().toISOString(), size_bytes: sizeBytes });
    }

    const content = entries.map((e) => JSON.stringify(e)).join("\n");
    atomicWrite(manifestPath, content + "\n");
  }

  private loadRejected(): Set<string> {
    const rejectPath = join(this.workspace, "reject.txt");
    return loadLineSet(rejectPath);
  }

  uploadDatasetCard(): boolean {
    try {
      const cardContent = this.generateDatasetCard();
      const tempPath = join(this.workspace, "README.md");
      writeFileSync(tempPath, cardContent, "utf-8");

      console.log("[UPLOADING] Dataset card...");
      execSync(`hf upload ${this.repo} ${tempPath} README.md --repo-type dataset`, { stdio: "pipe" });
      // Clean up temp file
      try {
        // Don't fail if cleanup fails
      } finally {
        // Keep README.md in workspace for reference
      }
      console.log("[OK] Dataset card uploaded");
      return true;
    } catch (error) {
      console.error(`[ERROR] Failed to upload dataset card: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Upload extracted images from workspace/images/ directory.
   */
  uploadImages(): void {
    const imagesDir = join(this.workspace, "images");
    if (!existsSync(imagesDir)) return;

    const images = readdirSync(imagesDir).filter((f) =>
      f.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)
    );

    if (images.length === 0) return;

    console.log(`\n[IMAGES] Uploading ${images.length} images...`);
    for (const image of images) {
      const imagePath = join(imagesDir, image);
      try {
        execSync(`hf upload ${this.repo} ${imagePath} images/${image} --repo-type dataset`, {
          stdio: "pipe",
          timeout: 60_000,
        });
        console.log(`  [OK] images/${image}`);
      } catch (error) {
        console.error(`  [ERROR] images/${image}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Get upload stats without uploading.
   */
  stats(): { total: number; uploaded: number; pending: number; rejected: number; totalSize: number } {
    const files = this.getRedactedSessions();
    const uploadedSet = this.loadManifest();
    const rejected = this.loadRejected();

    const pending = files.filter((f) => !uploadedSet.has(f) && !rejected.has(f));
    const totalSize = pending.reduce((acc, f) => {
      const filePath = join(this.workspace, "redacted", f);
      return acc + (existsSync(filePath) ? statSync(filePath).size : 0);
    }, 0);

    return {
      total: files.length,
      uploaded: files.filter((f) => uploadedSet.has(f)).length,
      pending: pending.length,
      rejected: rejected.size,
      totalSize,
    };
  }
}
