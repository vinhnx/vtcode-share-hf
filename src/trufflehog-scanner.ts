import { execSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, basename, resolve } from "path";
import { createHash } from "crypto";
import { atomicWrite } from "./atomic-write.js";
import { isSessionFile } from "./session-file-utils.js";

export interface TruffleHogFinding {
  detector: string;
  decoder?: string;
  status: "verified" | "unverified" | "unknown";
  line?: number;
  raw_sha256?: string;
  masked: string;
  file: string;
}

export interface TruffleHogSummary {
  findings: number;
  verified: number;
  unverified: number;
  unknown: number;
  top_detectors: string[];
}

export interface TruffleHogReport {
  file: string;
  redacted_hash: string;
  findings: TruffleHogFinding[];
  summary: TruffleHogSummary;
}

export interface TruffleHogScanResult {
  reports: Map<string, TruffleHogReport>;
  totalFindings: number;
  verifiedCount: number;
  unverifiedCount: number;
  unknownCount: number;
  scannedFiles: number;
  scanDurationMs: number;
}

export class TruffleHogScanner {
  private workspace: string;
  private binary: string;

  constructor(workspace: string, binary: string = "trufflehog") {
    this.workspace = workspace;
    this.binary = binary;
  }

  isAvailable(): boolean {
    try {
      execSync(`${this.binary} --version`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Scan individual files (like pi-share-hf) instead of directory scan.
   * This gives per-file reports with deduped findings.
   */
  scanFiles(filePaths: string[]): TruffleHogScanResult {
    if (filePaths.length === 0) {
      return {
        reports: new Map(),
        totalFindings: 0,
        verifiedCount: 0,
        unverifiedCount: 0,
        unknownCount: 0,
        scannedFiles: 0,
        scanDurationMs: 0,
      };
    }

    const start = Date.now();

    // Build path -> metadata map
    const pathToFile = new Map<string, { filename: string; content: string }>();
    for (const fp of filePaths) {
      try {
        const content = readFileSync(fp, "utf-8");
        pathToFile.set(resolve(fp), { filename: basename(fp), content });
      } catch {
        // Skip unreadable files
      }
    }

    // Run trufflehog on all files
    const args = [
      this.binary,
      "filesystem",
      ...filePaths.map((f) => resolve(f)),
      "-j",
      "--results=verified,unknown,unverified",
      "--no-color",
      "--no-update",
    ];

    let rawOutput = "";
    try {
      rawOutput = execSync(args.join(" "), {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 100 * 1024 * 1024,
        timeout: 300_000,
      });
    } catch (error) {
      // Exit code 183 means findings were found — still valid
      const errStatus = (error as { status?: number }).status;
      if (errStatus === 183) {
        rawOutput = (error as { stdout?: string }).stdout || "";
      } else if ((error as { stdout?: string }).stdout) {
        rawOutput = (error as { stdout: string }).stdout;
      } else {
        throw new Error(`TruffleHog scan failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Parse and deduplicate per-file
    const findingsByFile = new Map<string, Map<string, TruffleHogFinding>>();

    for (const line of rawOutput.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const finding = this.parseFinding(parsed);
      if (!finding) continue;

      // Resolve the file path from trufflehog output
      const findingFile = this.extractFileFromParsed(parsed);
      const source = findingFile ? pathToFile.get(resolve(findingFile)) : undefined;
      if (!source) continue;

      const dedupMap = findingsByFile.get(source.filename) ?? new Map<string, TruffleHogFinding>();
      // Dedup key: detector + decoder + status + line + raw_sha256
      const dedupKey = JSON.stringify([
        finding.detector,
        finding.decoder ?? "",
        finding.status,
        finding.line ?? -1,
        finding.raw_sha256 ?? "",
      ]);
      if (!dedupMap.has(dedupKey)) {
        dedupMap.set(dedupKey, finding);
      }
      findingsByFile.set(source.filename, dedupMap);
    }

    // Build per-file reports
    const reports = new Map<string, TruffleHogReport>();
    let totalFindings = 0;
    let verifiedCount = 0;
    let unverifiedCount = 0;
    let unknownCount = 0;

    for (const fp of filePaths) {
      const filename = basename(fp);
      const dedupMap = findingsByFile.get(filename) ?? new Map();
      const findings = [...dedupMap.values()].sort((a, b) => {
        const lineA = a.line ?? Number.MAX_SAFE_INTEGER;
        const lineB = b.line ?? Number.MAX_SAFE_INTEGER;
        if (lineA !== lineB) return lineA - lineB;
        return a.detector.localeCompare(b.detector);
      });

      const summary = this.summarizeFindings(findings);
      const content = pathToFile.get(resolve(fp))?.content ?? "";
      const redactedHash = createHash("sha256").update(content).digest("hex");

      reports.set(filename, { file: filename, redacted_hash: redactedHash, findings, summary });

      totalFindings += findings.length;
      verifiedCount += summary.verified;
      unverifiedCount += summary.unverified;
      unknownCount += summary.unknown;
    }

    return {
      reports,
      totalFindings,
      verifiedCount,
      unverifiedCount,
      unknownCount,
      scannedFiles: filePaths.length,
      scanDurationMs: Date.now() - start,
    };
  }

  /**
   * Legacy directory scan — scans all JSON/JSONL files in the redacted dir.
   */
  scan(redactedDir?: string): TruffleHogScanResult {
    const scanDir = redactedDir || join(this.workspace, "redacted");
    if (!existsSync(scanDir)) {
      return {
        reports: new Map(),
        totalFindings: 0,
        verifiedCount: 0,
        unverifiedCount: 0,
        unknownCount: 0,
        scannedFiles: 0,
        scanDurationMs: 0,
      };
    }

    const files = readdirSync(scanDir)
      .filter(isSessionFile)
      .map((f) => join(scanDir, f));

    return this.scanFiles(files);
  }

  /**
   * Check if a report has blocking findings (any verified or unknown).
   */
  static getBlockingReason(report: TruffleHogReport): { reason: string; evidence: string; missedSensitiveData: "yes" | "maybe" } | null {
    if (report.summary.findings === 0) return null;
    return {
      reason: "trufflehog-findings",
      evidence: this.formatSummaryEvidence(report),
      missedSensitiveData: report.summary.verified > 0 || report.summary.unknown > 0 ? "yes" : "maybe",
    };
  }

  private static formatSummaryEvidence(report: TruffleHogReport): string {
    const summary = report.summary;
    const detectors = summary.top_detectors.length > 0 ? summary.top_detectors.join(", ") : "none";
    const examples = report.findings
      .slice(0, 5)
      .map((f) => `${f.detector}:${f.masked}`)
      .join(", ");
    return `verified=${summary.verified}, unknown=${summary.unknown}, unverified=${summary.unverified}, detectors=${detectors}${examples ? `, examples=${examples}` : ""}`;
  }

  getFindingsByFile(findings: TruffleHogFinding[]): Map<string, TruffleHogFinding[]> {
    const map = new Map<string, TruffleHogFinding[]>();
    for (const f of findings) {
      const file = basename(f.file);
      if (!map.has(file)) map.set(file, []);
      map.get(file)!.push(f);
    }
    return map;
  }

  saveReport(result: TruffleHogScanResult): string[] {
    const reportDir = join(this.workspace, "reports");
    const paths: string[] = [];

    for (const [filename, report] of result.reports) {
      const reportPath = join(reportDir, `${filename}.trufflehog.json`);
      atomicWrite(reportPath, JSON.stringify(report, null, 2));
      paths.push(reportPath);
    }

    // Also save aggregate summary
    const summaryPath = join(reportDir, "trufflehog-scan.json");
    atomicWrite(summaryPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      totalFindings: result.totalFindings,
      verifiedCount: result.verifiedCount,
      unverifiedCount: result.unverifiedCount,
      unknownCount: result.unknownCount,
      scannedFiles: result.scannedFiles,
      scanDurationMs: result.scanDurationMs,
    }, null, 2));
    paths.push(summaryPath);

    return paths;
  }

  private parseFinding(parsed: unknown): TruffleHogFinding | null {
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;

    if (typeof obj.DetectorName !== "string") return null;

    const status = this.parseStatus(obj);
    const filesystem = this.extractFilesystemMetadata(obj);
    const raw = typeof obj.Raw === "string" && obj.Raw.length > 0 ? obj.Raw : undefined;

    return {
      detector: obj.DetectorName,
      decoder: typeof obj.DecoderName === "string" ? obj.DecoderName : undefined,
      status,
      line: filesystem?.line,
      raw_sha256: raw ? createHash("sha256").update(raw).digest("hex") : undefined,
      masked: raw ? this.maskSecret(raw) : "[REDACTED]",
      file: filesystem?.file ?? "",
    };
  }

  private parseStatus(obj: Record<string, unknown>): "verified" | "unverified" | "unknown" {
    if (obj.Verified === true) return "verified";

    const extraData = typeof obj.ExtraData === "object" && obj.ExtraData !== null
      ? obj.ExtraData as Record<string, unknown>
      : undefined;

    if (extraData) {
      const errorStr = (typeof extraData.verification_error === "string" ? extraData.verification_error : "")
        || (typeof extraData.verificationError === "string" ? extraData.verificationError : "")
        || (typeof extraData.error === "string" ? extraData.error : "");
      if (errorStr.trim() !== "") return "unknown";
    }

    return "unverified";
  }

  private extractFilesystemMetadata(obj: unknown): { file?: string; line?: number } | null {
    if (typeof obj !== "object" || obj === null) return null;
    const record = obj as Record<string, unknown>;

    const sourceMetadata = record.SourceMetadata as Record<string, unknown> | undefined;
    if (!sourceMetadata || typeof sourceMetadata !== "object") return null;

    const data = sourceMetadata.Data as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object") return null;

    const filesystem = data.Filesystem as Record<string, unknown> | undefined;
    if (!filesystem || typeof filesystem !== "object") return null;

    return {
      file: typeof filesystem.file === "string" ? filesystem.file : undefined,
      line: typeof filesystem.line === "number" ? filesystem.line : undefined,
    };
  }

  private extractFileFromParsed(parsed: unknown): string | null {
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;

    const sourceMetadata = obj.SourceMetadata as Record<string, unknown> | undefined;
    if (!sourceMetadata) return null;

    const data = sourceMetadata.Data as Record<string, unknown> | undefined;
    if (!data) return null;

    const filesystem = data.Filesystem as Record<string, unknown> | undefined;
    if (!filesystem) return null;

    return typeof filesystem.file === "string" ? filesystem.file : null;
  }

  private maskSecret(raw: string): string {
    if (raw.length <= 8) return "***";
    const prefixLength = raw.startsWith("npm_") ? Math.min(8, raw.length - 4) : Math.min(4, raw.length - 4);
    const suffixLength = Math.min(4, raw.length - prefixLength);
    return `${raw.slice(0, prefixLength)}***${raw.slice(raw.length - suffixLength)}`;
  }

  private summarizeFindings(findings: TruffleHogFinding[]): TruffleHogSummary {
    const detectorCounts = new Map<string, number>();
    const summary: TruffleHogSummary = {
      findings: findings.length,
      verified: 0,
      unverified: 0,
      unknown: 0,
      top_detectors: [],
    };

    for (const finding of findings) {
      summary[finding.status]++;
      detectorCounts.set(finding.detector, (detectorCounts.get(finding.detector) ?? 0) + 1);
    }

    summary.top_detectors = [...detectorCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([detector]) => detector);

    return summary;
  }
}
