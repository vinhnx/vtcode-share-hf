#!/usr/bin/env node

import { Command } from "commander";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve, basename } from "path";
import { SessionCollector } from "./session-collector.js";
import { HFUploader } from "./hf-uploader.js";
import { ATIFViewer } from "./atif-viewer.js";
import { TruffleHogScanner } from "./trufflehog-scanner.js";

const program = new Command();

program
  .name("vtcode-share-hf")
  .description("Collect, review, reject, and upload redacted VTCode sessions to Hugging Face")
  .version("1.0.0");

program
  .command("init")
  .description("Initialize workspace for VTCode session sharing")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--repo <id>", "HF dataset repo (user/dataset)", true)
  .option("--organization <name>", "HF organization namespace")
  .option("--workspace <dir>", "workspace directory", ".vtcode-hf")
  .option("--no-images", "strip embedded images from redacted output")
  .action((options) => {
    const repoPattern = /^[^/]+\/[^/]+$/;
    if (!repoPattern.test(options.repo)) {
      console.error(`[ERROR] Invalid repo format: ${options.repo}`);
      console.error('  Use "user/dataset" or "organization/dataset"');
      process.exit(1);
    }

    const workspacePath = resolve(options.cwd, options.workspace);
    const collector = new SessionCollector(workspacePath, options.repo, options.organization);
    collector.saveWorkspaceConfig();

    console.log(`[OK] Workspace initialized at ${workspacePath}`);
    console.log(`  Repo: ${options.repo}`);
    if (options.organization) {
      console.log(`  Organization: ${options.organization}`);
    }
    console.log(`\nNext: run 'vtcode-share-hf collect'`);
  });

program
  .command("collect")
  .description("Collect and redact VTCode sessions")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--workspace <dir>", "workspace directory", ".vtcode-hf")
  .option("--session-dirs <paths>", "colon-separated session dirs")
  .option("--secret <value>", "secret to redact (repeatable)", (val: string, arr: string[]) => { arr.push(val); return arr; }, [] as string[])
  .option("--secret-file <path>", "file with secrets (one per line)")
  .option("--env-file <path>", "environment file with secrets")
  .option("--deny <pattern>", "reject sessions matching pattern (repeatable)", (val: string, arr: string[]) => { arr.push(val); return arr; }, [] as string[])
  .option("--deny-file <path>", "file with deny patterns (one regex per line)")
  .option("--force", "reprocess all sessions")
  .option("--scan", "run trufflehog scan after collection")
  .action((options) => {
    const workspacePath = resolve(options.cwd, options.workspace);

    if (!existsSync(workspacePath)) {
      console.error(`[ERROR] Workspace not initialized. Run 'vtcode-share-hf init' first.`);
      process.exit(1);
    }

    const config = new SessionCollector(workspacePath, "").loadWorkspaceConfig();
    if (!config) {
      console.error("[ERROR] Cannot read workspace config.");
      process.exit(1);
    }

    const secrets: string[] = [];

    if (options.envFile) {
      try {
        const content = readFileSync(options.envFile, "utf-8");
        secrets.push(...content.split("\n").filter((l) => l.trim()));
      } catch {
        console.warn(`[WARN] Cannot read env file: ${options.envFile}`);
      }
    }

    if (options.secretFile) {
      try {
        const content = readFileSync(options.secretFile, "utf-8");
        secrets.push(...content.split("\n").filter((l) => l.trim()));
      } catch {
        console.warn(`[WARN] Cannot read secret file: ${options.secretFile}`);
      }
    }

    secrets.push(...(options.secret || []));

    const zshrc = join(process.env.HOME || "", ".zshrc");
    if (existsSync(zshrc)) {
      try {
        const content = readFileSync(zshrc, "utf-8");
        const envVars = content.match(/export\s+\w+=.*/g) || [];
        // Filter out common non-secret environment variables
        const skipKeys = new Set(["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "EDITOR", "PAGER", "SHLVL", "PWD", "OLDPWD", "LOGNAME"]);
        for (const line of envVars) {
          const keyMatch = line.match(/export\s+(\w+)=/);
          if (keyMatch && !skipKeys.has(keyMatch[1])) {
            secrets.push(line);
          }
        }
      } catch { /* ignore */ }
    }

    const collector = new SessionCollector(workspacePath, config.repo, config.organization, secrets);
    collector.setForce(options.force || false);

    const denyPatterns: string[] = [];
    if (options.denyFile) {
      try {
        const content = readFileSync(options.denyFile, "utf-8");
        denyPatterns.push(...content.split("\n").filter((l) => l.trim()));
      } catch {
        console.warn(`[WARN] Cannot read deny file: ${options.denyFile}`);
      }
    }
    denyPatterns.push(...(options.deny || []));
    if (denyPatterns.length > 0) {
      collector.setDenyPatterns(denyPatterns);
    }

    let sessionDirs: string[];
    if (options.sessionDirs) {
      sessionDirs = options.sessionDirs.split(":").map((p: string) => {
        let path = p.trim();
        if (path.startsWith("~")) {
          path = join(process.env.HOME || "", path.slice(1));
        }
        return path;
      }).filter((p: string) => p);
    } else {
      sessionDirs = [join(process.env.HOME || "", ".vtcode/sessions")];
    }

    let totalFiles = 0;
    let collected = 0;
    let skipped = 0;
    let rejected = 0;

    for (const sessionsPath of sessionDirs) {
      if (!existsSync(sessionsPath)) {
        console.warn(`[SKIP] Sessions dir not found: ${sessionsPath}`);
        continue;
      }

      const files = readdirSync(sessionsPath).filter((f) =>
        f.match(/\.(json|jsonl)$/) && !f.startsWith(".")
      );

      console.log(`Found ${files.length} sessions in ${sessionsPath}`);

      for (const file of files) {
        const filePath = join(sessionsPath, file);
        const result = collector.collectSession(filePath);

        if (result.success) {
          if (result.skipped) {
            skipped++;
          } else if (result.rejected) {
            rejected++;
            console.log(`[REJECT] ${file} (deny pattern match)`);
          } else {
            collected++;
          }
        } else {
          console.error(`[FAIL] ${file}: ${result.error}`);
        }
        totalFiles++;
      }
    }

    collector.saveWorkspaceConfig();
    console.log(`\n[DONE] ${collected} collected, ${skipped} unchanged, ${rejected} rejected (of ${totalFiles} total)`);

    if (options.scan) {
      const scanner = new TruffleHogScanner(workspacePath);
      if (!scanner.isAvailable()) {
        console.warn("\n[WARN] trufflehog not found. Install: brew install trufflehog");
        return;
      }
      console.log("\n[SCAN] Running trufflehog...");
      const result = scanner.scan();
      console.log(`  Findings: ${result.verifiedCount} verified, ${result.unverifiedCount} unverified, ${result.unknownCount} unknown`);
      scanner.saveReport(result);
    }
  });

program
  .command("upload")
  .description("Upload redacted sessions to Hugging Face")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--workspace <dir>", "workspace directory", ".vtcode-hf")
  .option("--dry-run", "show what would be uploaded")
  .action((options) => {
    const workspacePath = resolve(options.cwd, options.workspace);

    if (!existsSync(workspacePath)) {
      console.error(`[ERROR] Workspace not found at ${workspacePath}`);
      process.exit(1);
    }

    const config = new SessionCollector(workspacePath, "").loadWorkspaceConfig();
    if (!config) {
      console.error("[ERROR] Cannot read workspace config.");
      process.exit(1);
    }

    const uploader = new HFUploader(config.repo, workspacePath, config.organization);

    if (!uploader.checkDependencies()) {
      process.exit(1);
    }

    if (!uploader.ensureRepo()) {
      process.exit(1);
    }

    const result = uploader.upload(options.dryRun);
    if (!result.success) {
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List sessions in workspace")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--workspace <dir>", "workspace directory", ".vtcode-hf")
  .option("--uploadable", "show only uploadable sessions")
  .action((options) => {
    const workspacePath = resolve(options.cwd, options.workspace);
    const collector = new SessionCollector(workspacePath, "");
    const redactedDir = join(workspacePath, "redacted");

    if (!existsSync(redactedDir)) {
      console.log("No sessions yet.");
      return;
    }

    const files = readdirSync(redactedDir).filter((f) => f.match(/\.(json|jsonl)$/));

    if (options.uploadable) {
      const uploadable = collector.getUploadableSessions();
      console.log(`Uploadable (${uploadable.length}):`);
      uploadable.forEach((f) => console.log(`  ${f}`));
    } else {
      console.log(`All sessions (${files.length}):`);
      files.forEach((f) => console.log(`  ${f}`));
    }
  });

program
  .command("grep")
  .description("Search uploadable sessions")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--workspace <dir>", "workspace directory", ".vtcode-hf")
  .option("-i, --ignore-case", "case-insensitive search")
  .argument("<pattern>", "search pattern")
  .action((pattern, options) => {
    const workspacePath = resolve(options.cwd, options.workspace);
    const collector = new SessionCollector(workspacePath, "");
    const redactedDir = join(workspacePath, "redacted");

    if (!existsSync(redactedDir)) {
      console.log("No sessions.");
      return;
    }

    const uploadable = collector.getUploadableSessions();
    const regex = new RegExp(pattern, options.ignoreCase ? "i" : "");

    console.log(`Searching ${uploadable.length} uploadable sessions for: ${pattern}`);

    let matches = 0;
    for (const file of uploadable) {
      const filePath = join(redactedDir, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        if (regex.test(content)) {
          console.log(`  ${file}`);
          matches++;
        }
      } catch { /* ignore */ }
    }

    console.log(`\n${matches} sessions matched.`);
  });

program
  .command("reject")
  .description("Mark sessions as never uploadable")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--workspace <dir>", "workspace directory", ".vtcode-hf")
  .argument("<files...>", "session files to reject")
  .action((files, options) => {
    const workspacePath = resolve(options.cwd, options.workspace);
    const collector = new SessionCollector(workspacePath, "");

    for (const file of files) {
      collector.addRejected(basename(file));
      console.log(`[REJECTED] ${basename(file)}`);
    }
  });

program
  .command("allow")
  .description("Remove session from reject list")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--workspace <dir>", "workspace directory", ".vtcode-hf")
  .argument("<files...>", "session files to allow")
  .action((files, options) => {
    const workspacePath = resolve(options.cwd, options.workspace);
    const collector = new SessionCollector(workspacePath, "");

    for (const file of files) {
      collector.removeRejected(basename(file));
      console.log(`[ALLOWED] ${basename(file)}`);
    }
  });

program
  .command("card")
  .description("Upload dataset card (README.md)")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--workspace <dir>", "workspace directory", ".vtcode-hf")
  .action((options) => {
    const workspacePath = resolve(options.cwd, options.workspace);

    if (!existsSync(workspacePath)) {
      console.error("[ERROR] Workspace not found.");
      process.exit(1);
    }

    const config = new SessionCollector(workspacePath, "").loadWorkspaceConfig();
    if (!config) {
      console.error("[ERROR] Cannot read workspace config.");
      process.exit(1);
    }

    const uploader = new HFUploader(config.repo, workspacePath, config.organization);
    if (!uploader.checkDependencies()) {
      process.exit(1);
    }

    if (!uploader.uploadDatasetCard()) {
      process.exit(1);
    }
  });

program
  .command("viewer")
  .description("Launch ATIF Trajectory Viewer")
  .option("--port <port>", "port", "3000")
  .option("--workspace <dir>", "workspace directory to browse sessions")
  .action((options) => {
    const port = parseInt(options.port, 10);
    const workspacePath = options.workspace
      ? resolve(options.workspace)
      : undefined;
    const viewer = new ATIFViewer(port, workspacePath);
    viewer.start();
  });

program
  .command("scan")
  .description("Scan redacted sessions for secrets")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--workspace <dir>", "workspace directory", ".vtcode-hf")
  .option("--reject", "auto-reject sessions with verified secrets")
  .action((options) => {
    const workspacePath = resolve(options.cwd, options.workspace);
    const scanner = new TruffleHogScanner(workspacePath);

    if (!scanner.isAvailable()) {
      console.error("[ERROR] trufflehog not found. Install: brew install trufflehog");
      process.exit(1);
    }

    const redactedDir = join(workspacePath, "redacted");
    if (!existsSync(redactedDir)) {
      console.error("[ERROR] No redacted sessions. Run 'collect' first.");
      process.exit(1);
    }

    const files = readdirSync(redactedDir)
      .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"))
      .map((f) => join(redactedDir, f));

    if (files.length === 0) {
      console.log("No session files to scan.");
      return;
    }

    console.log(`[SCANNING] Running trufflehog on ${files.length} files...`);

    const result = scanner.scanFiles(files);

    console.log(
      `\n[RESULTS] ${result.totalFindings} findings (${result.verifiedCount} verified, ${result.unverifiedCount} unverified, ${result.unknownCount} unknown)`
    );
    console.log(`  Scanned ${result.scannedFiles} files in ${Math.round(result.scanDurationMs / 1000)}s`);

    if (result.totalFindings > 0) {
      console.log("\n[DETAILS]");
      for (const [filename, report] of result.reports) {
        if (report.findings.length === 0) continue;
        console.log(`\n  ${filename} (${report.findings.length} findings):`);
        for (const f of report.findings) {
          const status = f.status.toUpperCase();
          const lineInfo = f.line !== undefined ? ` L${f.line}` : "";
          console.log(`    [${status}] ${f.detector}${lineInfo}: ${f.masked}`);
        }
      }

      if (options.reject) {
        const collector = new SessionCollector(workspacePath, "");
        for (const [filename, report] of result.reports) {
          if (report.summary.verified > 0) {
            collector.addRejected(filename);
            console.log(`  [REJECTED] ${filename} (verified secret)`);
          }
        }
      }
    }

    const reportPaths = scanner.saveReport(result);
    console.log(`\n  Reports: ${reportPaths.length} files saved`);

    if (result.verifiedCount > 0 && !options.reject) {
      console.log("\n  Tip: Use --reject to auto-reject sessions with verified secrets");
    }
  });

program
  .command("stats")
  .description("Show workspace upload statistics")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--workspace <dir>", "workspace directory", ".vtcode-hf")
  .action((options) => {
    const workspacePath = resolve(options.cwd, options.workspace);

    if (!existsSync(workspacePath)) {
      console.error("[ERROR] Workspace not found.");
      process.exit(1);
    }

    const config = new SessionCollector(workspacePath, "").loadWorkspaceConfig();
    if (!config) {
      console.error("[ERROR] Cannot read workspace config.");
      process.exit(1);
    }

    const uploader = new HFUploader(config.repo, workspacePath, config.organization);
    const stats = uploader.stats();

    console.log("\nUpload Statistics");
    console.log(`  Total sessions:    ${stats.total}`);
    console.log(`  Uploaded:          ${stats.uploaded}`);
    console.log(`  Pending:           ${stats.pending}`);
    console.log(`  Rejected:          ${stats.rejected}`);
    console.log(`  Pending size:      ${(stats.totalSize / 1024).toFixed(1)} KB`);
  });

program.parse(process.argv);
