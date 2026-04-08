# vtcode-share-hf

Collect, review, reject, and upload redacted [vtcode](https://github.com/badlogic/vtcode) session traces to a Hugging Face dataset.

**⚠️ Sharing coding agent sessions risks leaking secrets and PII.** Read this README fully before use.

## What it does

- `init`: create a workspace for vtcode session collection
- `collect`: redact sessions from `~/.vtcode/sessions/` 
- `upload`: upload approved sessions to a Hugging Face dataset
- `list`: view sessions in workspace

## What gets redacted

Every string field in every JSON object is scanned:

- **literal secrets** from `~/.zshrc`, `--env-file`, and `--secret`
- **common API key and token patterns**: OpenAI, GitHub, AWS, generic `key=secret`
- **email addresses** and standard auth patterns

For maximum safety, pass known secrets explicitly with `--secret`.

## What does NOT get redacted deterministically

- **Non-standard secrets**: custom tokens, internal service credentials
- **Context-specific PII**: names, references, sensitive project names
- **Embedded files**: included in session transcripts

## Limitations

Redacting coding agent sessions with 100% precision is not solved. This tool:

1. **Targets OSS project sessions** which typically contain little private data
2. **Uses deterministic redaction** for known patterns (handles most cases)
3. **Requires manual review** for sensitive projects (check redacted output)

If your vtcode sessions do not involve many custom secrets, the dataset is likely safe after redaction.

## Install

```bash
bun install
bun link
```

### External dependencies

`collect` and `upload` need `huggingface-cli`:

```bash
pip install "huggingface_hub[cli]"
huggingface-cli login
```

When logging in:
- Create a token at https://huggingface.co/settings/tokens with write scope
- Say Y when asked to add the token as git credential
- Do not set `HF_TOKEN` as an environment variable

## Quick start

### 1. Initialize workspace

```bash
vtcode-share-hf init --repo myuser/vtcode-sessions
```

### 2. Collect and redact sessions

```bash
vtcode-share-hf collect \
  --secret ~/.secrets.txt \
  --secret "my-custom-token-xyz"
```

Secrets file format: one secret per line.

### 3. Review redacted output

```bash
vtcode-share-hf list --uploadable
```

Inspect redacted sessions in `.vtcode-hf/redacted/` directory.

### 4. Reject sessions if needed

```bash
vtcode-share-hf reject session-vtcode-*.json
```

### 5. Upload to Hugging Face

```bash
# Dry run first
vtcode-share-hf upload --dry-run

# Upload for real
vtcode-share-hf upload
```

## Workspace layout

```
.vtcode-hf/
  workspace.json          # config
  manifest.jsonl          # uploaded sessions manifest
  redacted/               # public, redacted sessions
  reports/                # deterministic redaction findings
  review/                 # (future) LLM review results
  images/                 # (future) extracted images
  reject.txt              # rejected session filenames
```

## Commands

### `init`

```bash
vtcode-share-hf init [--cwd /path] --repo user/dataset [--workspace .vtcode-hf]
```

Options:
- `--cwd <dir>`: project directory (default: current directory)
- `--repo <id>`: HF dataset repo (format: `user/dataset`)
- `--organization <name>`: HF organization namespace
- `--workspace <dir>`: workspace location (default: `.vtcode-hf`)

### `collect`

```bash
vtcode-share-hf collect \
  --secret secrets.txt \
  --secret "my-token" \
  --env-file ~/.zshrc \
  [--force] [--workspace .vtcode-hf]
```

Options:
- `--secret <file>|<text>`: literal secret or secret file (repeatable)
- `--env-file <path>`: environment file to extract secrets from (default: `~/.zshrc`)
- `--force`: reprocess all sessions
- `--workspace <dir>`: workspace location

Automatically:
- Reads `~/.vtcode/sessions/*` (vtcode session files)
- Extracts secrets from `~/.zshrc` export statements
- Applies deterministic redaction patterns
- Saves redacted sessions to workspace

### `upload`

```bash
vtcode-share-hf upload [--dry-run] [--workspace .vtcode-hf]
```

Options:
- `--dry-run`: show what would be uploaded without doing it
- `--workspace <dir>`: workspace location

Only uploads sessions that pass redaction checks.

### `list`

```bash
vtcode-share-hf list [--uploadable] [--workspace .vtcode-hf]
```

Options:
- `--uploadable`: show only uploadable sessions
- `--workspace <dir>`: workspace location

### `reject`

```bash
vtcode-share-hf reject [--workspace .vtcode-hf] <session.json | image.png>
```

Adds session to `reject.txt`. Upload will skip rejected sessions.

## Verifying results

After `collect`, spot-check the redacted output:

```bash
# List uploadable sessions
vtcode-share-hf list --uploadable

# Search redacted sessions for sensitive keywords
grep -r "my-private-project" .vtcode-hf/redacted/
grep -ri "password|token|secret" .vtcode-hf/redacted/ | head -20
```

If you find private content still present, add the keyword/secret to your secrets list and rerun `collect --force`.

## Dataset card

Generated Hugging Face dataset cards include tags:
- `agent-traces`
- `coding-agent`
- `vtcode-share-hf`

This allows discovery via [Hugging Face dataset search](https://huggingface.co/datasets?other=agent-traces).

## Safety considerations

1. **Deterministic redaction catches most cases** but is not 100% reliable
2. **Manual review recommended** for projects involving:
   - Financial data
   - Personal credentials
   - Proprietary code or protocols
   - Customer or partner information
3. **Keep your secrets file secure** – it contains sensitive values
4. **Use the `reject` command** for any sessions you're unsure about
5. **Check `reports/` directory** for detailed redaction findings

## Development

```bash
bun run build      # TypeScript to JavaScript
bun run dev        # watch mode
bun run check      # type check + lint
bun run test       # run tests
```

## License

MIT

## See also

- [pi-share-hf](https://github.com/badlogic/pi-share-hf) - similar tool for pi coding agent
- [vtcode](https://github.com/badlogic/vtcode) - the coding agent this tool works with
- [trufflehog](https://github.com/trufflesecurity/trufflehog) - advanced secret detection (future integration)
