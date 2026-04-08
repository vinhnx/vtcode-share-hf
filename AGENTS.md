# vtcode-share-hf AGENTS.md

Development and deployment guide for vtcode-share-hf.

## Quick commands

```bash
bun run build      # TypeScript compilation
bun run dev        # Watch mode
bun run check      # Type check + lint
bun link           # Install CLI globally
```

## Architecture

- **[src/redactor.ts](file:///src/redactor.ts)** - PII/secret detection and redaction
- **[src/session-collector.ts](file:///src/session-collector.ts)** - Workspace management and session collection
- **[src/hf-uploader.ts](file:///src/hf-uploader.ts)** - HuggingFace dataset operations
- **[src/cli.ts](file:///src/cli.ts)** - CLI entry point (Commander.js)

## Development workflow

1. **Make changes** in src/
2. **Build**: `bun run build`
3. **Test**: `vtcode-share-hf <command>`
4. **Check**: `bun run check`

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

## Workspace structure

```
.vtcode-hf/
├── workspace.json          # config, repo, organization
├── manifest.jsonl          # upload manifest (remote-backed)
├── manifest.local.jsonl    # local manifest
├── redacted/               # public, ready for upload
├── reports/                # deterministic redaction logs
├── review/                 # (future) LLM review sidecars
├── review-chunks/          # (future) transcript chunks
├── images/                 # (future) extracted images
└── reject.txt              # rejected session filenames
```

## Integration with trufflehog

The tool can be enhanced with `trufflehog` for advanced secret detection:

```bash
pip install trufflehog
```

Future integration points:
- Run `trufflehog filesystem` on session transcripts
- Parse findings and apply additional redaction
- Generate security report in workspace

## Future enhancements

1. **LLM Review**: Integrate with Claude/GPT for semantic review (like pi-share-hf)
2. **Image extraction**: Extract and handle embedded images
3. **Trufflehog integration**: Advanced secret scanning
4. **Parallel processing**: Speed up collection with worker threads
5. **Dataset card generation**: Auto-create README.md with proper citations
6. **S3 backend**: Upload to S3 instead of HF Git
7. **Delta sync**: Only upload new/changed sessions
8. **Manifest caching**: Cache remote manifest locally

## CI/CD

To set up continuous collection:

```yaml
# .github/workflows/vtcode-share.yml
name: Collect vtcode sessions
on:
  schedule:
    - cron: '0 0 * * *'  # Daily

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run build
      - run: bun vtcode-share-hf init --repo ${{ secrets.HF_REPO }}
      - run: bun vtcode-share-hf collect --secret "${{ secrets.API_KEY }}"
      - run: bun vtcode-share-hf upload
        env:
          HF_TOKEN: ${{ secrets.HF_TOKEN }}
```

## Safety checklist

Before uploading:

- [ ] Review `.vtcode-hf/reports/` for redaction findings
- [ ] Spot-check `.vtcode-hf/redacted/` for private keywords
- [ ] Verify all API keys are in secrets list
- [ ] Run `grep` to search for known patterns
- [ ] Use `--dry-run` before real upload
- [ ] Check rejected session list makes sense

## References

- [pi-share-hf](https://github.com/badlogic/pi-share-hf) - Original tool
- [Commander.js](https://github.com/tj/commander.js) - CLI framework
- [trufflehog](https://github.com/trufflesecurity/trufflehog) - Secret scanning
- [HuggingFace Hub](https://github.com/huggingface/huggingface_hub) - Python client
