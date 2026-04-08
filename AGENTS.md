# AGENTS.md

Development and deployment guide for vtcode-share-hf.

## Quick commands

```bash
bun run build      # TypeScript compilation
bun run dev        # watch mode
bun run check      # type check + lint
bun link           # Install CLI globally
bun run viewer     # Launch ATIF trajectory viewer
```

## Architecture

- **src/redactor.ts** — PII/secret detection and redaction (18 pattern types, literal secrets)
- **src/trufflehog-scanner.ts** — TruffleHog integration for enhanced secret scanning (per-file reports, dedup)
- **src/session-collector.ts** — Workspace management, session collection, image handling
- **src/hf-uploader.ts** — HuggingFace dataset operations (upload, manifest, image sync)
- **src/atif-viewer.ts** — ATIF trajectory viewer (workspace browser, path traversal protection)
- **src/cli.ts** — CLI entry point (Commander.js)

## Development workflow

1. Make changes in `src/`
2. Build: `bun run build`
3. Test: `vtcode-share-hf <command>`
4. Check: `bun run check`

## TruffleHog integration

The `TruffleHogScanner` class in `src/trufflehog-scanner.ts` wraps the [trufflehog](https://github.com/trufflesecurity/trufflehog) CLI:

- `isAvailable()` — check if `trufflehog` binary is on PATH
- `scanFiles(paths)` — run `trufflehog filesystem` on specific files, parse JSON output
- `scan()` — convenience method: scans all files in redacted directory
- `getFindingsByFile()` — group findings by session file (legacy compatibility)
- `saveReport()` — write per-file scan reports to `reports/`

### CLI integration

- `vtcode-share-hf scan` — standalone scan command with `--reject` flag
- `vtcode-share-hf collect --scan` — run trufflehog after collection
- `vtcode-share-hf stats` — show upload statistics

### TruffleHog exit codes

- `0` — no findings
- `183` — findings detected (used with `--fail`)
- Scanner handles both 0 and 183 gracefully

### Per-file report format

```typescript
interface TruffleHogFinding {
  detector: string;
  decoder?: string;
  status: "verified" | "unverified" | "unknown";
  line?: number;
  raw_sha256?: string;
  masked: string;
  file: string;
}

interface TruffleHogReport {
  file: string;
  redacted_hash: string;
  findings: TruffleHogFinding[];
  summary: { findings: number; verified: number; unverified: number; unknown: number; top_detectors: string[] };
}
```

## Workspace structure

```
.vtcode-hf/
├── workspace.json          # config, repo, organization, no_images
├── manifest.local.jsonl    # local upload manifest
├── redacted/               # public, ready for upload
├── reports/                # redaction logs + trufflehog scan reports (*.trufflehog.json)
├── review/                 # (future) LLM review sidecars
├── review-chunks/          # (future) review chunk data
├── images/                 # extracted preserved images
└── reject.txt              # rejected session filenames
```

## Testing redaction

Create a test file with secrets:
```json
{
  "key": "sk-abc123secret",
  "email": "user@example.com",
  "secret": "my-api-key"
}
```

Run collector with `--force` to reprocess.

## CI/CD

```yaml
# .github/workflows/vtcode-share.yml
name: Collect vtcode sessions
on:
  schedule:
    - cron: '0 0 * * *'

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run build
      - run: bun vtcode-share-hf init --repo ${{ secrets.HF_REPO }}
      - run: bun vtcode-share-hf collect --scan --secret "${{ secrets.API_KEY }}"
      - run: bun vtcode-share-hf upload
        env:
          HF_TOKEN: ${{ secrets.HF_TOKEN }}
```

## Safety checklist

Before uploading:

- [ ] Review `reports/` for redaction findings
- [ ] Spot-check `redacted/` for private keywords
- [ ] Run `vtcode-share-hf scan` for trufflehog findings (use `--reject` to auto-reject)
- [ ] Use `vtcode-share-hf stats` to review upload status
- [ ] Use `--dry-run` before real upload
- [ ] Check rejected session list

## References

- [pi-share-hf](https://github.com/badlogic/pi-share-hf) — Original tool
- [VTCode](https://github.com/vinhnx/VTCode) — The coding agent
- [trufflehog](https://github.com/trufflesecurity/trufflehog) — Secret scanning
- [ATIF Protocol](https://harborframework.com/docs/agents/trajectory-format) — Agent trajectory format
- [Commander.js](https://github.com/tj/commander.js) — CLI framework
- [HuggingFace Hub](https://github.com/huggingface/huggingface_hub) — Python client
