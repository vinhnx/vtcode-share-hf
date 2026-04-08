## VS Code Context

### Active Editor: README.md (lines 1-204)

```markdown
# vtcode-share-hf

Collect, redact, and upload VTCode session traces to a Hugging Face dataset.

> **Warning**: Sharing agent sessions risks leaking secrets and PII. Review redacted output before uploading.

**Dataset**: [vinhnx90/vtcode-sessions](https://huggingface.co/datasets/vinhnx90/vtcode-sessions)

## Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize workspace |
| `collect` | Redact sessions from `~/.vtcode/sessions/` |
| `scan` | Scan redacted sessions with [trufflehog](https://github.com/trufflesecurity/trufflehog) |
| `upload` | Upload approved sessions to HF |
| `list` | View sessions in workspace |
| `reject` | Mark sessions to skip on upload |
| `viewer` | Launch ATIF trajectory viewer |

## Install

```bash
bun install && bun link
```

Requires [hf CLI](https://huggingface.co/docs/huggingface_hub/guides/cli#standalone-installer-recommended):

```bash
curl -LsSf https://hf.co/cli/install.sh | bash
hf auth login
```

## Quick start

```bash
# 1. Initialize
vtcode-share-hf init --repo myuser/vtcode-sessions

# 2. Collect and redact
vtcode-share-hf collect --secret ~/.secrets.txt --secret "my-token"

# 3. Scan with trufflehog (optional but recommended)
vtcode-share-hf scan

# 4. Review
vtcode-share-hf list --uploadable

# 5. Upload
vtcode-share-hf upload --dry-run   # preview first
vtcode-share-hf upload             # upload for real
```

## Redaction

**Built-in** (deterministic):
- Literal secrets from `--secret`, `--env-file`, and `~/.zshrc`
- API key patterns: OpenAI, GitHub, AWS, generic `key=secret`
- Email addresses and auth patterns

**Trufflehog** (enhanced, via `scan` command):
- 800+ secret detectors with verification
- Entropy-based detection
- Auto re-redact discovered secrets with `--redact`
- Auto-reject sessions with verified secrets with `--reject`

```bash
# Scan for remaining secrets
vtcode-share-hf scan

# Scan and re-redact
vtcode-share-hf scan --redact

# Scan and auto-reject sessions with verified secrets
vtcode-share-hf scan --reject

# Combined: collect + scan in one step
vtcode-share-hf collect --scan --secret ~/.secrets.txt
```

Install trufflehog:

```bash
brew install trufflehog
```

### What is NOT redacted

- Non-standard secrets and custom tokens
- Context-specific PII (names, project names)
- Embedded files in transcripts

Always spot-check `.vtcode-hf/redacted/` before uploading.

## Workspace layout

```
.vtcode-hf/
├── workspace.json       # config
├── manifest.jsonl       # upload manifest
├── redacted/            # public, ready for upload
├── reports/             # redaction logs + trufflehog reports
└── reject.txt           # rejected session filenames
```

## Command reference

### `init`

```bash
vtcode-share-hf init --repo user/dataset [--organization name] [--workspace .vtcode-hf]
```

### `collect`

```bash
vtcode-share-hf collect \
  --secret secrets.txt \
  --secret "my-token" \
  --env-file ~/.zshrc \
  --session-dirs "~/.vtcode/sessions:~/other/sessions" \
  --scan \
  [--force]
```

Options:
- `--secret <file|text>` — literal secret or file (repeatable)
- `--env-file <path>` — extract secrets from env file
- `--session-dirs <paths>` — colon-separated session directories
- `--scan` — run trufflehog scan after collection
- `--force` — reprocess all sessions

### `scan`

```bash
vtcode-share-hf scan [--only-verified] [--redact] [--reject]
```

Options:
- `--only-verified` — only show verified secrets
- `--redact` — re-redact sessions with discovered secrets
- `--reject` — auto-reject sessions containing verified secrets

### `upload`

```bash
vtcode-share-hf upload [--dry-run]
```

### `list`

```bash
vtcode-share-hf list [--uploadable]
```

### `reject`

```bash
vtcode-share-hf reject <session.json>
```

### `viewer`

```bash
vtcode-share-hf viewer [--port 3000]
```

## Verifying results

```bash
vtcode-share-hf list --uploadable
grep -r "sensitive-keyword" .vtcode-hf/redacted/
vtcode-share-hf scan
```

## Safety checklist

Before uploading:

- [ ] Review `reports/` for redaction findings
- [ ] Spot-check `redacted/` for private content
- [ ] Run `vtcode-share-hf scan` for trufflehog findings
- [ ] Use `--dry-run` before real upload
- [ ] Verify rejected session list

## Development

```bash
bun run build      # compile TypeScript
bun run dev        # watch mode
bun run check      # type check + lint
```

## License

MIT

## See also

- [VTCode](https://github.com/vinhnx/VTCode) — the coding agent
- [trufflehog](https://github.com/trufflesecurity/trufflehog) — secret scanning
- [ATIF Protocol](https://harborframework.com/docs/agents/trajectory-format) — agent trajectory format
- [pi-share-hf](https://github.com/badlogic/pi-share-hf) — original tool for pi agent

```
