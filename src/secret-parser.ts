import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Common non-secret environment variable names to skip
 * when auto-extracting from shell config files.
 */
const NON_SECRET_KEYS = new Set([
  "PATH", "HOME", "USER", "SHELL", "LANG", "TERM",
  "EDITOR", "PAGER", "SHLVL", "PWD", "OLDPWD",
  "LOGNAME", "HOSTNAME", "TMPDIR",
]);

/**
 * Extract secret-like values from a line of text.
 * Handles: export KEY=VALUE, KEY="VALUE", KEY=VALUE, or bare values.
 * Returns the extracted value or null.
 */
export function extractSecretValue(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // export KEY=VALUE or KEY=VALUE (with optional quotes)
  const match = trimmed.match(/(?:export\s+)?(\w+)=["']?(.+?)["']?\s*$/);
  if (match) {
    const [, key, value] = match;
    if (NON_SECRET_KEYS.has(key)) return null;
    if (value.length > 2) return value;
    return null;
  }

  // Bare value (no = sign)
  if (!trimmed.includes("=") && trimmed.length > 3) {
    return trimmed;
  }

  return null;
}

/**
 * Load secrets from multiple sources:
 * - env file (KEY=VALUE lines)
 * - secret file (one secret per line)
 * - literal secrets (array of strings)
 * - shell config file (~/.zshrc)
 *
 * Returns deduplicated array of secret values.
 */
export function loadSecrets(options: {
  envFile?: string;
  secretFile?: string;
  literals?: string[];
  shellConfig?: string;
}): string[] {
  const secrets = new Set<string>();

  // Environment file
  if (options.envFile) {
    try {
      const content = readFileSync(options.envFile, "utf-8");
      for (const line of content.split("\n")) {
        const value = extractSecretValue(line);
        if (value) secrets.add(value);
      }
    } catch {
      console.warn(`[WARN] Cannot read env file: ${options.envFile}`);
    }
  }

  // Secret file
  if (options.secretFile) {
    try {
      const content = readFileSync(options.secretFile, "utf-8");
      for (const line of content.split("\n")) {
        const value = extractSecretValue(line);
        if (value) secrets.add(value);
      }
    } catch {
      console.warn(`[WARN] Cannot read secret file: ${options.secretFile}`);
    }
  }

  // Literal secrets
  if (options.literals) {
    for (const literal of options.literals) {
      const value = extractSecretValue(literal);
      if (value) secrets.add(value);
    }
  }

  // Shell config
  const shellPath = options.shellConfig || join(process.env.HOME || "", ".zshrc");
  if (existsSync(shellPath)) {
    try {
      const content = readFileSync(shellPath, "utf-8");
      for (const line of content.split("\n")) {
        const value = extractSecretValue(line);
        if (value) secrets.add(value);
      }
    } catch {
      // Ignore read errors
    }
  }

  return [...secrets];
}

/**
 * Load deny patterns from inline strings and/or files.
 * Inline strings are treated as regex patterns.
 * Files contain one regex per line.
 */
export function loadDenyPatterns(options: {
  inline?: string[];
  files?: string[];
}): RegExp[] {
  const patterns: RegExp[] = [];

  if (options.files) {
    for (const filePath of options.files) {
      try {
        const content = readFileSync(filePath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) {
            try {
              patterns.push(new RegExp(trimmed));
            } catch {
              console.warn(`[WARN] Invalid regex pattern: ${trimmed}`);
            }
          }
        }
      } catch {
        console.warn(`[WARN] Cannot read deny file: ${filePath}`);
      }
    }
  }

  if (options.inline) {
    for (const pattern of options.inline) {
      try {
        patterns.push(new RegExp(pattern));
      } catch {
        console.warn(`[WARN] Invalid regex pattern: ${pattern}`);
      }
    }
  }

  return patterns;
}
