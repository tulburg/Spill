# Using Spill in this project

Spill is a visual control center for a project's specs. It shows every question, spec, and
decision as a card on a canvas, colored by status, so the user can see at a glance what is
open, what is approved, and what Claude is working on right now. Claude reads and writes the
board through the Spill MCP server.

## 1. The model

### Card kinds

| Kind     | ID     | What it is                                                                 |
|----------|--------|----------------------------------------------------------------------------|
| Section  | `SEC-n`| A group on the canvas (a feature or area, like "Auth" or "Billing").       |
| Question | `Q-n`  | Something that must be answered before a spec can be written or approved.  |
| Spec     | `S-n`  | A testable requirement or feature definition. Code implements specs.       |
| Decision | `D-n`  | A recorded answer or trade-off, linked to the question it closes.          |

IDs are assigned by Spill, are never reused, and are how everyone refers to a card in chat
("answered Q15", "S4 is approved").

### Statuses

```
draft -> discussing -> approved -> active -> done
                    \-> rejected
```

- `draft`: written by Claude or the user, not yet looked at.
- `discussing`: under conversation right now. Comments go on the card.
- `approved`: the user agreed. **Only the user sets this.**
- `rejected`: the user said no. **Only the user sets this.** Keep the card; do not delete it.
- `active`: Claude is implementing it right now.
- `done`: shipped and verified.

Questions use `open -> answered` (or `dropped`) instead.

### Links

Cards link to each other: a question `blocks` a spec, a decision `answers` a question, a spec
`depends_on` another spec. Spill draws these as lines on the canvas.

## 2. MCP tools

The `spill` MCP server exposes these tools (all take the project from the working directory):

| Tool                 | Use it to                                                              |
|----------------------|------------------------------------------------------------------------|
| `spill_board`        | Get a summary of every card: id, kind, title, status, section.         |
| `spill_get`          | Read one card in full, with its comments and links.                    |
| `spill_ask`          | Create a `Q-n` question, optionally blocking specs.                    |
| `spill_draft_spec`   | Create an `S-n` spec in `draft`.                                       |
| `spill_update`       | Edit a card's title, body, or section.                                 |
| `spill_set_status`   | Move a card (`discussing`, `active`, `done`). Not `approved`/`rejected`.|
| `spill_comment`      | Add a comment to a card's thread.                                      |
| `spill_link`         | Link two cards (`blocks`, `answers`, `depends_on`).                    |
| `spill_record`       | Record a `D-n` decision and close the question it answers.             |
| `spill_inbox`        | List what changed since your last call: answers, new user questions, approvals, rejections. |

## 3. Workflow, every session

1. **Sync.** Call `spill_inbox` first, then `spill_board`. Act on anything the user answered,
   approved, rejected, or added since last time.
2. **Ask on the board.** When you need input, call `spill_ask` for each question (one question
   per card, short title, context in the body). Then tell the user the IDs in chat.
3. **Draft specs.** Each spec body has: Purpose, Requirements (numbered, each testable),
   Out of scope, Acceptance checks. Link open questions that block it.
4. **Wait for approval.** Do not start code for a spec until the user has set it `approved`.
5. **Work visibly.** `spill_set_status S-n active` before writing code, `done` after verifying.
   Comment on the card with what changed and where.
6. **Behavior changed? Spec changed.** If building reveals something the spec does not say,
   stop, add a question or update the spec, and set it back to `discussing`.

## 4. File fallback (no MCP connected)

Spill stores the board in this folder, so the board also works without the app:

- `.spill/cards/<ID>.md`: one file per card. Front matter holds `id`, `kind`, `title`,
  `status`, `section`, and `links`; the body is the card text, then a `## Comments` section.
- `.spill/config.json`: project settings (see below).

Rules for the fallback: take the next free number for the kind, never reuse an ID, and follow the
same status rules (never write `approved` or `rejected` yourself). The Spill app picks the files
up when it next opens the project.

## 5. Connecting the MCP server

Once Spill is installed, copy `.spill/mcp.example.json` into the project's `.mcp.json` (or merge
its `spill` entry) and restart Claude Code. `spill_board` should then return the board.
