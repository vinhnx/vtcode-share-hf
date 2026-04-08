import { createHash } from "crypto";

export interface RedactionResult {
  text: string;
  redactions: Array<{ original: string; redacted: string; reason: string }>;
}

/**
 * Redacts PII and secrets from text
 */
export class Redactor {
  private secrets: Set<string> = new Set();
  private patterns: RegExp[] = [];

  constructor(secretsInput?: string | string[]) {
    this.initializePatterns();
    this.addSecrets(secretsInput);
  }

  /**
   * Initialize common secret/API key patterns
   */
  private initializePatterns() {
    this.patterns = [
      // API Keys and tokens
      /sk-[A-Za-z0-9\-_]{20,}/g, // OpenAI keys
      /pk-[A-Za-z0-9\-_]{20,}/g,
      /[A-Za-z0-9\-_]{20,}:[A-Za-z0-9\-_]{20,}/g, // Generic key:secret pattern
      /\b(?:password|passwd|pwd|secret|token|auth|key)\s*=\s*[^\s;,]+/gi,
      /\b(?:AWS_SECRET|GITHUB_TOKEN|OPENAI_API_KEY)\s*=\s*[^\s;,]+/gi,
      // AWS patterns
      /AKIA[0-9A-Z]{16}/g,
      // GitHub tokens
      /gh[pousr]{1}_[A-Za-z0-9_]{36,255}/g,
      // Email addresses
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    ];
  }

  /**
   * Add secrets to redact
   */
  addSecrets(input?: string | string[]) {
    if (!input) return;

    const items = Array.isArray(input) ? input : [input];
    for (const item of items) {
      if (item.includes("\n")) {
        item.split("\n").forEach((line) => {
          const trimmed = line.trim();
          if (trimmed) this.secrets.add(trimmed);
        });
      } else {
        this.secrets.add(item);
      }
    }
  }

  /**
   * Redact secrets and PII from text
   */
  redact(text: string): RedactionResult {
    let result = text;
    const redactions: Array<{ original: string; redacted: string; reason: string }> = [];

    // Redact explicit secrets
    for (const secret of this.secrets) {
      if (secret && result.includes(secret)) {
        const redacted = `[REDACTED_SECRET_${this.hash(secret)}]`;
        redactions.push({
          original: secret,
          redacted,
          reason: "explicit_secret",
        });
        result = result.split(secret).join(redacted);
      }
    }

    // Redact pattern matches
    for (const pattern of this.patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const original = match[0];
        if (!this.secrets.has(original)) {
          const redacted = `[REDACTED_${this.classifySecret(original)}]`;
          redactions.push({
            original,
            redacted,
            reason: "pattern_match",
          });
          result = result.split(original).join(redacted);
        }
      }
    }

    return { text: result, redactions };
  }

  /**
   * Redact JSON object recursively
   */
  redactObject(obj: any): { obj: any; redactions: RedactionResult[] } {
    const redactions: RedactionResult[] = [];

    const recurse = (item: any): any => {
      if (typeof item === "string") {
        const result = this.redact(item);
        if (result.redactions.length > 0) {
          redactions.push(result);
        }
        return result.text;
      } else if (Array.isArray(item)) {
        return item.map(recurse);
      } else if (typeof item === "object" && item !== null) {
        const redacted: any = {};
        for (const key in item) {
          redacted[key] = recurse(item[key]);
        }
        return redacted;
      }
      return item;
    };

    return { obj: recurse(obj), redactions };
  }

  /**
   * Classify the type of secret
   */
  private classifySecret(text: string): string {
    if (/^sk-/.test(text)) return "OPENAI_KEY";
    if (/^AKIA/.test(text)) return "AWS_KEY";
    if (/^gh[pousr]_/.test(text)) return "GITHUB_TOKEN";
    if (/@/.test(text)) return "EMAIL";
    if (/\bpassword\b/i.test(text)) return "PASSWORD";
    return "SECRET";
  }

  /**
   * Hash a secret for reference
   */
  private hash(text: string): string {
    return createHash("sha256").update(text).digest("hex").substring(0, 8);
  }
}
