#!/usr/bin/env node

import { Command } from "commander";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { SessionCollector } from "./session-collector.js";
import { HFUploader } from "./hf-uploader.js";

const program = new Command();

program
  .name("vtcode-share-hf")
  .description("Collect, review, and upload redacted vtcode sessions to Hugging Face")
  .version("1.0.0");

/**
 * init command: Initialize workspace
 */
program
  .command("init")
  .description("Initialize a workspace for vtcode session sharing")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--repo <id>", "HF dataset repo (user/dataset)", true)
  .option("--organization <name>", "HF organization namespace")
  .option("--workspace <dir>", "workspace directory", ".vtcode-hf")
  .action(
    (options: {
      cwd: string;
      repo: string;
      organization?: string;
      workspace: string;
    }) => {
      const workspacePath = resolve(options.cwd, options.workspace);
      const collector = new SessionCollector(
        workspacePath,
        options.repo,
        options.organization
      );
      collector.saveWorkspaceConfig();

      console.log(`✓ Initialized workspace at ${workspacePath}`);
      console.log(`  Repo: ${options.repo}`);
      if (options.organization) {
        console.log(`  Organization: ${options.organization}`);
      }
      console.log(
        `\nNext: run 'vtcode-share-hf collect --workspace ${options.workspace}'`
      );
    }
  );

/**
 * collect command: Redact and collect sessions
 */
program
  .command("collect")
  .description("Collect and redact vtcode sessions")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--workspace <dir>", "workspace directory", ".vtcode-hf")
  .option("--secret <value>", "secret to redact (repeatable)")
  .option("--env-file <path>", "environment file with secrets")
  .option("--force", "reprocess all sessions")
  .action(
    (options: {
      cwd: string;
      workspace: string;
      secret?: string | string[];
      envFile?: string;
      force: boolean;
    }) => {
      const workspacePath = resolve(options.cwd, options.workspace);

      if (!existsSync(workspacePath)) {
        console.error(`❌ Workspace not initialized. Run 'vtcode-share-hf init' first.`);
        process.exit(1);
      }

      const config = new SessionCollector(workspacePath, "").loadWorkspaceConfig();
      if (!config) {
        console.error(`❌ Cannot read workspace config.`);
        process.exit(1);
      }

      // Collect secrets
      const secrets: string[] = [];

      // From env file
      if (options.envFile) {
        try {
          const envContent = readFileSync(options.envFile, "utf-8");
          secrets.push(...envContent.split("\n").filter((line) => line.trim()));
        } catch {
          console.warn(`⚠ Could not read env file: ${options.envFile}`);
        }
      }

      // From --secret flags
      if (options.secret) {
        const secretList = Array.isArray(options.secret) ? options.secret : [options.secret];
        secrets.push(...secretList);
      }

      // Collect from ~/.zshrc if exists
      const zshrc = join(process.env.HOME || "", ".zshrc");
      if (existsSync(zshrc)) {
        try {
          const content = readFileSync(zshrc, "utf-8");
          const envVars = content.match(/export\s+\w+=.*/g) || [];
          secrets.push(...envVars);
        } catch {
          // Ignore
        }
      }

      const collector = new SessionCollector(
        workspacePath,
        config.repo,
        config.organization,
        secrets
      );

      // Find vtcode sessions
      const sessionsPath = join(process.env.HOME || "", ".vtcode/sessions");
      if (!existsSync(sessionsPath)) {
        console.error(`❌ vtcode sessions not found at ${sessionsPath}`);
        process.exit(1);
      }

      const files = readdirSync(sessionsPath).filter((f) =>
        f.match(/session-vtcode.*\.(json|jsonl)$/)
      );

      console.log(`Found ${files.length} vtcode sessions`);

      let collected = 0;
      for (const file of files) {
        const filePath = join(sessionsPath, file);
        const result = collector.collectSession(filePath);

        if (result.success && result.metadata) {
          console.log(`✓ ${file} (${result.metadata.redactions_count} redactions)`);
          collected++;
        } else {
          console.error(`✗ ${file}: ${result.error}`);
        }
      }

      collector.saveWorkspaceConfig();
      console.log(`\n✅ Collected ${collected}/${files.length} sessions`);
    }
  );

/**
 * upload command: Upload sessions to HF
 */
program
  .command("upload")
  .description("Upload redacted sessions to Hugging Face dataset")
  .option("--workspace <dir>", "workspace directory", ".vtcode-hf")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--dry-run", "show what would be uploaded")
  .action(
    (options: { workspace: string; cwd: string; dryRun: boolean }) => {
      const workspacePath = resolve(options.cwd, options.workspace);

      if (!existsSync(workspacePath)) {
        console.error(`❌ Workspace not found at ${workspacePath}`);
        process.exit(1);
      }

      const config = new SessionCollector(workspacePath, "").loadWorkspaceConfig();
      if (!config) {
        console.error(`❌ Cannot read workspace config.`);
        process.exit(1);
      }

      const uploader = new HFUploader(config.repo, workspacePath);

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
    }
  );

/**
 * list command: List sessions
 */
program
  .command("list")
  .description("List sessions in workspace")
  .option("--workspace <dir>", "workspace directory", ".vtcode-hf")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--uploadable", "show only uploadable sessions")
  .action(
    (options: { workspace: string; cwd: string; uploadable: boolean }) => {
      const workspacePath = resolve(options.cwd, options.workspace);
      const redactedDir = join(workspacePath, "redacted");

      if (!existsSync(redactedDir)) {
        console.log("No sessions yet.");
        return;
      }

      const files = readdirSync(redactedDir).filter((f) =>
        f.match(/\.(json|jsonl)$/)
      );

      if (options.uploadable) {
        console.log("Uploadable sessions:");
      }

      files.forEach((file) => {
        console.log(`  ${file}`);
      });

      console.log(`\nTotal: ${files.length} sessions`);
    }
  );

program.parse(process.argv);
