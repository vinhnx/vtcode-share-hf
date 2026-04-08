# vtcode-share-hf Usage Examples

## One-time setup

```bash
# Install dependencies
bun install
bun link

# Install HuggingFace CLI
pip install "huggingface_hub[cli]"
huggingface-cli login
```

## Scenario 1: Share all vtcode sessions

**Goal**: Collect and upload all vtcode sessions to a new HF dataset.

```bash
# Create workspace (one per HF dataset)
vtcode-share-hf init --repo myuser/vtcode-sessions

# Collect sessions (redacts PII/secrets automatically)
vtcode-share-hf collect

# Review what would be uploaded
vtcode-share-hf list --uploadable

# Dry run first
vtcode-share-hf upload --dry-run

# Upload for real
vtcode-share-hf upload
```

## Scenario 2: Share sessions with custom secrets filtering

**Goal**: Ensure custom API keys and tokens are redacted.

Create a secrets file:
```bash
cat > ~/.vtcode-secrets.txt << 'EOF'
sk-myopenaikey123456789
my-internal-api-token-abc
special-github-token-xyz
EOF
```

Collect with secrets:
```bash
vtcode-share-hf collect \
  --secret ~/.vtcode-secrets.txt \
  --force  # reprocess all sessions
```

Verify redaction in reports:
```bash
cat .vtcode-hf/reports/session-*.json | head -20
```

## Scenario 3: Exclude sensitive sessions

**Goal**: Reject sessions that contain private/sensitive work.

Manually inspect and reject:
```bash
vtcode-share-hf list --uploadable

# Open .vtcode-hf/redacted/session-xxx.json
# Review it for private content

# If it contains private data, reject it:
vtcode-share-hf reject session-vtcode-20260403T130038Z_864948-43241.json
```

Check rejected list:
```bash
cat .vtcode-hf/reject.txt
```

Upload only approved sessions:
```bash
vtcode-share-hf upload
```

## Scenario 4: Incremental collection

**Goal**: Collect new sessions daily without reprocessing old ones.

Create a script:
```bash
#!/bin/bash
# daily-collect.sh

WORKSPACE="${HOME}/.vtcode-hf-dataset"

# Initialize if needed
if [ ! -d "$WORKSPACE" ]; then
  vtcode-share-hf init --repo myuser/vtcode-sessions --workspace "$WORKSPACE"
fi

# Collect new sessions
vtcode-share-hf collect \
  --workspace "$WORKSPACE" \
  --secret ~/.vtcode-secrets.txt

# Spot-check for private content
echo "Redacted sessions:"
vtcode-share-hf list --uploadable --workspace "$WORKSPACE" | tail -5

# Upload new sessions
vtcode-share-hf upload --workspace "$WORKSPACE"

echo "✅ Done"
```

Run daily:
```bash
chmod +x daily-collect.sh
# Add to crontab:
# 0 0 * * * /path/to/daily-collect.sh
```

## Scenario 5: Organize by project

**Goal**: Separate sessions by project into different HF datasets.

```bash
# vtcode project dataset
vtcode-share-hf init \
  --cwd ~/Projects/vtcode \
  --repo vtcode-sessions \
  --organization myorg \
  --workspace .vtcode-hf

# my-lib project dataset
vtcode-share-hf init \
  --cwd ~/Projects/my-lib \
  --repo my-lib-sessions \
  --organization myorg \
  --workspace .vtcode-hf
```

Each workspace tracks its own manifest, so they don't interfere.

## Scenario 6: Verify redaction coverage

**Goal**: Ensure no secrets leaked through.

```bash
# Search redacted output for sensitive patterns
vtcode-share-hf grep -i 'password|token|secret|apikey|authorization'

# Search for known secrets
vtcode-share-hf grep 'sk-'  # OpenAI keys
vtcode-share-hf grep 'AKIA'  # AWS keys
vtcode-share-hf grep 'gh_'   # GitHub tokens
```

If any are found, add to secrets list and rerun:
```bash
echo "found-secret-xyz" >> ~/.vtcode-secrets.txt
vtcode-share-hf collect --force
```

## Scenario 7: Dataset card with organization

**Goal**: Create a dataset in an organization with proper metadata.

```bash
vtcode-share-hf init \
  --repo vtcode-agent-traces \
  --organization my-research-org

# Collect and upload
vtcode-share-hf collect
vtcode-share-hf upload

# Dataset appears at:
# https://huggingface.co/datasets/my-research-org/vtcode-agent-traces
```

## Scenario 8: Resume after interruption

**Goal**: Complete interrupted upload.

If upload is interrupted, session metadata is saved in manifest.

```bash
# Resume upload (skips already-uploaded sessions)
vtcode-share-hf upload

# Or check what would be uploaded
vtcode-share-hf upload --dry-run
```

## Scenario 9: Change secrets and reprocess

**Goal**: Update secrets list and redact all sessions again.

```bash
# Update secrets file
echo "new-secret-token" >> ~/.vtcode-secrets.txt

# Force reprocessing of all sessions
vtcode-share-hf collect \
  --secret ~/.vtcode-secrets.txt \
  --force

# Verify new redactions
vtcode-share-hf list --uploadable | wc -l

# Upload
vtcode-share-hf upload
```

## Scenario 10: Multi-machine sharing

**Goal**: Collect sessions from multiple machines to same dataset.

Machine A:
```bash
vtcode-share-hf init --repo shared/vtcode-sessions

vtcode-share-hf collect --secret ~/.secrets.txt
vtcode-share-hf upload
```

Machine B (different machine, same repo):
```bash
# Points to same dataset
vtcode-share-hf init --repo shared/vtcode-sessions

# Collect local sessions
vtcode-share-hf collect --secret ~/.secrets.txt

# Upload (skips already-uploaded from Machine A)
vtcode-share-hf upload
```

**Note**: Use git credentials for HF so both machines can push.

## Tips & Tricks

### Dry-run everything first
```bash
vtcode-share-hf upload --dry-run
```

### Keep a clean secrets file
```bash
# ~/.vtcode-secrets.txt
# One secret per line, no comments
sk-abc123secret
my-api-key-internal
production-db-password
```

### Export and inspect
```bash
# Export uploaded manifest
cat .vtcode-hf/manifest.jsonl | jq .

# Count sessions
vtcode-share-hf list | wc -l

# Find largest session
ls -lhS .vtcode-hf/redacted/ | head -5
```

### Cleanup
```bash
# Remove rejected sessions from redacted/ if needed
# (they won't be uploaded anyway)

# View rejected list
cat .vtcode-hf/reject.txt

# Clear workspace to restart
rm -rf .vtcode-hf/
vtcode-share-hf init --repo myuser/dataset
```

### Debugging redaction
```bash
# Check what got redacted
cat .vtcode-hf/reports/*.report.json | jq .redactions | head

# View a specific session before/after
# Original: ~/.vtcode/sessions/session-xxx.json
# Redacted: .vtcode-hf/redacted/session-xxx.json
```

## Safety checklist

Before uploading for real:

- [ ] Created separate workspace with `init`
- [ ] Listed secrets comprehensively in secret file
- [ ] Ran `collect` at least once
- [ ] Reviewed `.vtcode-hf/reports/` redaction logs
- [ ] Spot-checked `.vtcode-hf/redacted/` for private keywords
- [ ] Ran `upload --dry-run` and reviewed
- [ ] Rejected any sessions with private content
- [ ] Ran `upload` for real only when confident

## Troubleshooting

### "vtcode-share-hf: command not found"
```bash
bun link  # in the vtcode-share-hf directory
```

### "huggingface-cli not found"
```bash
pip install "huggingface_hub[cli]"
huggingface-cli login
```

### "Workspace not initialized"
```bash
vtcode-share-hf init --repo your-repo-name
```

### "No sessions collected"
Check that `~/.vtcode/sessions/` exists and contains `session-*.json` files.

### "Sessions not uploading"
- Verify workspace.json exists: `.vtcode-hf/workspace.json`
- Check git credentials: `git credential-osxkeychain` (macOS)
- Verify HF token is configured: `huggingface-cli whoami`
