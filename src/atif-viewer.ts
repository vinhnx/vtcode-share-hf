#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, normalize, sep } from "path";
import { Command } from "commander";
import express from "express";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class ATIFViewer {
  private app: express.Application;
  private port: number;
  private workspaceDir?: string;

  constructor(port: number = 3000, workspaceDir?: string) {
    this.port = port;
    this.workspaceDir = workspaceDir;
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes() {
    // Serve static assets (HTML, CSS, JS) from viewer/ directory
    const viewerDir = join(__dirname, "..", "viewer");
    if (existsSync(viewerDir)) {
      this.app.use(express.static(viewerDir));
    }

    // Fallback: serve from assets/ for backward compat
    const assetsDir = join(__dirname, "..", "assets");
    if (existsSync(assetsDir)) {
      this.app.use(express.static(assetsDir));
    }

    // Main page
    this.app.get("/", (_req, res) => {
      // Try viewer/ first, then assets/
      const viewerPath = join(viewerDir, "atif-viewer.html");
      const assetsPath = join(assetsDir, "atif-viewer.html");
      if (existsSync(viewerPath)) {
        res.sendFile(viewerPath);
      } else if (existsSync(assetsPath)) {
        res.sendFile(assetsPath);
      } else {
        res.status(404).send("Viewer HTML not found");
      }
    });

    // API: List workspace sessions
    this.app.get("/api/sessions", (_req, res) => {
      if (!this.workspaceDir) {
        return res.json({ sessions: [], workspace: null });
      }

      const redactedDir = join(this.workspaceDir, "redacted");
      if (!existsSync(redactedDir)) {
        return res.json({ sessions: [], workspace: this.workspaceDir });
      }

      try {
        const sessions = readdirSync(redactedDir)
          .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"))
          .map((f) => {
            const filePath = join(redactedDir, f);
            const stats = statSync(filePath);
            return {
              filename: f,
              size: stats.size,
              modified: stats.mtime.toISOString(),
            };
          })
          .sort((a, b) => b.modified.localeCompare(a.modified));

        // Load reject list
        const rejectPath = join(this.workspaceDir, "reject.txt");
        let rejected: string[] = [];
        if (existsSync(rejectPath)) {
          rejected = readFileSync(rejectPath, "utf-8")
            .split("\n")
            .filter((l) => l.trim());
        }

        res.json({
          sessions,
          workspace: this.workspaceDir,
          rejected,
        });
      } catch (error) {
        res.status(500).json({ error: `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}` });
      }
    });

    // API: Load a specific trajectory file
    // SECURITY: Prevent path traversal by validating filename against workspace redacted dir
    this.app.get("/api/trajectory", (req, res) => {
      const filename = req.query.file as string;
      if (!filename) {
        return res.status(400).json({ error: "File path required" });
      }

      // Resolve the file path within the workspace redacted directory
      const targetDir = this.workspaceDir
        ? join(this.workspaceDir, "redacted")
        : join(__dirname, "..", "redacted");

      // SECURITY: Normalize and verify the path is within the allowed directory
      const resolvedPath = normalize(join(targetDir, filename));
      const resolvedDir = normalize(targetDir);

      // Path traversal check
      if (!resolvedPath.startsWith(resolvedDir + sep) && resolvedPath !== resolvedDir) {
        return res.status(403).json({ error: "Access denied: path traversal detected" });
      }

      // Only allow .json and .jsonl files
      if (!filename.endsWith(".json") && !filename.endsWith(".jsonl")) {
        return res.status(400).json({ error: "Only .json and .jsonl files are allowed" });
      }

      if (!existsSync(resolvedPath)) {
        return res.status(404).json({ error: `File not found: ${filename}` });
      }

      try {
        const data = readFileSync(resolvedPath, "utf-8");
        const trajectory = JSON.parse(data);
        res.json(trajectory);
      } catch (error) {
        res.status(500).json({ error: `Failed to load trajectory: ${error instanceof Error ? error.message : String(error)}` });
      }
    });

    // API: Load TruffleHog scan report for a file
    this.app.get("/api/scan-report", (req, res) => {
      if (!this.workspaceDir) {
        return res.status(400).json({ error: "Workspace not configured" });
      }

      const filename = req.query.file as string;
      if (!filename) {
        return res.status(400).json({ error: "File parameter required" });
      }

      // Check both report formats
      const reportPaths = [
        join(this.workspaceDir, "reports", `${filename}.trufflehog.json`),
        join(this.workspaceDir, "reports", `${filename}.report.json`),
      ];

      for (const reportPath of reportPaths) {
        const normalized = normalize(reportPath);
        const normalizedDir = normalize(join(this.workspaceDir, "reports"));
        if (normalized.startsWith(normalizedDir + sep) && existsSync(normalized)) {
          try {
            const data = readFileSync(normalized, "utf-8");
            return res.json(JSON.parse(data));
          } catch {
            // Continue to next
          }
        }
      }

      res.status(404).json({ error: "No scan report found" });
    });
  }

  start() {
    this.app.listen(this.port, () => {
      console.log(`ATIF Trajectory Viewer running at http://localhost:${this.port}`);
      if (this.workspaceDir) {
        console.log(`Workspace: ${this.workspaceDir}`);
        console.log(`Open http://localhost:${this.port} to browse sessions`);
      } else {
        console.log(`Open http://localhost:${this.port} and load an ATIF trajectory file`);
      }
    });
  }
}

// CLI command
const program = new Command();

program
  .name("atif-viewer")
  .description("Launch ATIF Trajectory Viewer web interface")
  .option("--port <port>", "Port to run the viewer on", "3000")
  .option("--workspace <dir>", "Workspace directory to browse sessions")
  .action((options) => {
    const port = parseInt(options.port, 10);
    const viewer = new ATIFViewer(port, options.workspace);
    viewer.start();
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse(process.argv);
}
