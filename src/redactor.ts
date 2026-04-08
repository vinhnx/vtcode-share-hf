import { createHash } from "crypto";

export interface RedactionFinding {
  detector: string;
  severity: "critical" | "high" | "medium";
  jsonPath?: string;
  replacement: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  redactions: RedactionFinding[];
}

export interface SecretEntry {
  name: string;
  value: string;
  replacement: string;
}

// Pre-compiled pattern definitions — fresh RegExp instances created per redact() call
// to avoid lastIndex mutation bugs with /g flags.
const PATTERN_DEFINITIONS: Array<{ regex: string; type: string; severity: "critical" | "high" | "medium" }> = [
  { regex: "sk-proj-[A-Za-z0-9_\\-]{20,}", type: "OPENAI_PROJECT_KEY", severity: "critical" },
  { regex: "sk-[A-Za-z0-9_\\-]{20,}", type: "OPENAI_KEY", severity: "critical" },
  { regex: "pk-[A-Za-z0-9_\\-]{20,}", type: "PUBLIC_KEY", severity: "high" },
  { regex: "ant-[A-Za-z0-9]{20,}", type: "ANTHROPIC_KEY", severity: "critical" },
  { regex: "AKIA[0-9A-Z]{16}", type: "AWS_ACCESS_KEY", severity: "critical" },
  { regex: "gh[pousr]_[A-Za-z0-9_]{36,}", type: "GITHUB_TOKEN", severity: "critical" },
  { regex: "xox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*", type: "SLACK_TOKEN", severity: "critical" },
  { regex: "AIza[0-9A-Za-z_-]{35}", type: "GOOGLE_API_KEY", severity: "critical" },
  { regex: "ya29\\.[0-9A-Za-z_-]+", type: "GOOGLE_OAUTH", severity: "critical" },
  { regex: "eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+", type: "JWT_TOKEN", severity: "high" },
  { regex: "npm_[A-Za-z0-9]{36}", type: "NPM_TOKEN", severity: "critical" },
  { regex: "glpat-[A-Za-z0-9_\\-]{20,}", type: "GITLAB_TOKEN", severity: "critical" },
  { regex: "dckr_pat_[A-Za-z0-9_\\-]{20,}", type: "DOCKER_TOKEN", severity: "critical" },
  { regex: "gho_[A-Za-z0-9]{36}", type: "GITHUB_OAUTH", severity: "critical" },
  { regex: "[A-Za-z0-9]{32}\\.[A-Za-z0-9]{16}\\.[A-Za-z0-9]{20,}", type: "GENERIC_API_KEY", severity: "high" },
  { regex: "postgres(ql)?://[^\\s\"']{10,}", type: "DATABASE_URL", severity: "critical" },
  { regex: "mongodb(\\+srv)?://[^\\s\"']{10,}", type: "DATABASE_URL", severity: "critical" },
  { regex: "https?://[^\\s\"']*:[^\\s\"'@]+@[^\\s\"']+", type: "URL_WITH_CREDENTIALS", severity: "high" },
];

export class Redactor {
  private literalSecrets: SecretEntry[] = [];

  constructor(secretsInput?: string | string[]) {
    this.addSecrets(secretsInput);
  }

  addSecrets(input?: string | string[]) {
    if (!input) return;

    const items = Array.isArray(input) ? input : [input];
    for (const item of items) {
      if (!item.trim()) continue;

      // Handle key=value pairs from env files (e.g., "export API_KEY=sk-abc123")
      const lines = item.includes("\n") ? item.split("\n") : [item];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Extract value from export KEY=VALUE or KEY=VALUE patterns
        const secretValue = this.extractSecretValue(trimmed);
        if (secretValue && secretValue.length > 2) {
          const replacement = `[REDACTED:${this.hash(secretValue)}]`;
          // Avoid duplicates
          if (!this.literalSecrets.some((s) => s.value === secretValue)) {
            this.literalSecrets.push({ name: trimmed.substring(0, 50), value: secretValue, replacement });
          }
        }
      }
    }
  }

  /**
   * Extract the secret value from lines like:
   *   export API_KEY=sk-abc123
   *   API_KEY="sk-abc123"
   *   sk-abc123
   */
  private extractSecretValue(line: string): string | null {
    // export KEY=VALUE or KEY=VALUE (with optional quotes)
    const match = line.match(/(?:export\s+)?\w+=["']?(.+?)["']?\s*$/);
    if (match && match[1].length > 2) {
      return match[1];
    }
    // Plain value (no = sign)
    if (!line.includes("=") && line.length > 3) {
      return line;
    }
    return null;
  }

  redact(text: string): RedactionResult {
    let result = text;
    const redactions: RedactionFinding[] = [];

    // 1. First pass: literal secret redaction (exact match, highest priority)
    for (const secret of this.literalSecrets) {
      const count = this.countOccurrences(result, secret.value);
      if (count > 0) {
        result = result.split(secret.value).join(secret.replacement);
        redactions.push({
          detector: "literal-secret",
          severity: "critical",
          replacement: secret.replacement,
          count,
        });
      }
    }

    // 2. Second pass: pattern-based redaction
    // Create FRESH RegExp instances to avoid lastIndex bugs
    for (const { regex: pattern, type, severity } of PATTERN_DEFINITIONS) {
      const regex = new RegExp(pattern, "g");
      const matches = result.match(regex);
      if (matches) {
        const uniqueMatches = [...new Set(matches)];
        for (const match of uniqueMatches) {
          // Skip if already redacted by literal secrets
          if (this.literalSecrets.some((s) => s.value === match)) continue;

          const replacement = `[REDACTED:${type}]`;
          const count = this.countOccurrences(result, match);
          result = result.split(match).join(replacement);
          redactions.push({
            detector: type,
            severity,
            replacement,
            count,
          });
        }
      }
    }

    return { text: result, redactions };
  }

  redactObject(obj: unknown, path: string = "$"): { obj: unknown; redactions: RedactionResult[] } {
    const redactions: RedactionResult[] = [];
    const seen = new Set<unknown>();

    const recurse = (item: unknown, currentPath: string): unknown => {
      if (typeof item === "string") {
        const result = this.redact(item);
        if (result.redactions.length > 0) {
          redactions.push(result);
        }
        return result.text;
      }

      if (item === null || typeof item !== "object") {
        return item;
      }

      if (seen.has(item)) {
        return item;
      }
      seen.add(item);

      if (Array.isArray(item)) {
        return item.map((val, i) => recurse(val, `${currentPath}[${i}]`));
      }

      const redacted: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(item as Record<string, unknown>)) {
        const childPath = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
          ? `${currentPath}.${key}`
          : `${currentPath}[${JSON.stringify(key)}]`;
        redacted[key] = recurse(val, childPath);
      }
      return redacted;
    };

    return { obj: recurse(obj, path), redactions };
  }

  /** Count non-overlapping occurrences of needle in haystack */
  countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
      count++;
      pos += needle.length;
    }
    return count;
  }

  getSecretsCount(): number {
    return this.literalSecrets.length;
  }

  private hash(text: string): string {
    return createHash("sha256").update(text).digest("hex").substring(0, 8);
  }
}
