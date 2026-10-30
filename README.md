# claude-template

Starting point for new projects worked on with Claude Code.

- `CLAUDE.md`: default rules (no em dashes, scope discipline, repo etiquette) plus the Spill protocol.
- `.spill/`: Spill board config, the file fallback store, and `SPILL.md`, which teaches Claude
  how to use the Spill MCP and how to write questions and specs on the board.

## Use it

```bash
gh repo create my-project --private --template tulburg/claude-template --clone
```

Then replace the heading in `CLAUDE.md`, set `project` in `.spill/config.json`, and replace this README.
