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
draft -> discussing -> approved -> queued -> active -> done
                    \-> rejected
```

- `draft`: written by Claude or the user, not yet looked at.
- `discussing`: under conversation right now. Comments go on the card.
- `approved`: the spec is agreed, but not yet a go to build. The user approves, or the board
  approves it by itself (actor `auto`, shown as "approved (auto: reason)" in `spill_inbox`) when,
  with nothing else open, the last blocking question is answered, every child spec is done, or your
  "Reqs 1-n done" covers every requirement. Never set it yourself.
- `queued`: the user pressed **Build** (`spill build`). **Build means build**: start queued specs
  without being asked, one at a time, in the order Build was pressed. Approved alone is not a go.
  **Only the user sets this.**
- Reverted: the user can take an `approved`, `queued`, `active` or `done` spec back to `discussing`
  (`spill revert`). It shows as a `status` line ending "(reverted)" in `spill_inbox`; stop work on it.
- `rejected`: the user said no. **Only the user sets this.** Keep the card; do not delete it.
- `active`: Claude is implementing it right now. Only a `queued` spec can be made active.
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
| `spill_ask`          | Create a `Q-n` question, optionally blocking specs. Options are `- A. text` lines in the body; `multi: true` lets the user pick several. |
| `spill_draft_spec`   | Create an `S-n` spec in `draft`.                                       |
| `spill_update`       | Edit a card's title, body, or section.                                 |
| `spill_set_status`   | Move a card (`discussing`, `active`, `done`). Not `approved`/`rejected`.|
| `spill_comment`      | Add a comment to a card's thread.                                      |
| `spill_link`         | Link two cards (`blocks`, `answers`, `depends_on`).                    |
| `spill_record`       | Record a `D-n` decision and close the question it answers.             |
| `spill_rejections`   | The rejection queue: rejected specs still waiting on you, with reasons; `resolve` one to leave it rejected. |
| `spill_focus`        | Set the spotlight: cards being discussed now and cards up next.        |
| `spill_checks`       | Record a spec's acceptance check results (`running: true` first, then `results`) so its card shows them. |
| `spill_reply`        | Answer a board-level message (inbox action `message`); `thread` picks an older thread. |
| `spill_inbox`        | List what changed since your last call: answers, new user questions, approvals, rejections, messages. |

## 3. Workflow, every session

1. **Sync.** Call `spill_inbox` first, then `spill_board`. Act on anything the user answered,
   approved, rejected, or added since last time. If either starts with "Rejections waiting", work
   through `spill_rejections` before anything else.
2. **Ask on the board.** When you need input, call `spill_ask` for each question (one question
   per card, short title, context in the first paragraph, options as `- A. text` lines; `multi: true`
   when several can be picked). Then tell the user the IDs in chat.
   **An answer that picks no option is a redirect, not a decision.** The app records it as a
   `redirect` inbox line and keeps the question open. Rewrite the same question with `spill_update`
   (that clears the redirect note on the card) and comment what changed. Do not open a new
   question for the same thing.
3. **Draft specs.** Each spec body has: Purpose, Requirements (numbered, each testable),
   Out of scope, Acceptance checks. Link open questions that block it.
4. **Wait for Build, then build.** Do not start code for a spec until the user presses Build and
   it is `queued`. Build means build: start it without being asked, one active spec at a time,
   in the order queued. An approval alone is not a go.
   A spec that needs a design signed off gets a design question: `spill_ask` with `design: true`,
   the board link in the body, blocking the spec. It offers "A. Approve this design" and
   "B. Needs changes"; A approves the spec ("design approved") if nothing else is open, B means
   rework the design and reopen the question.
   A spec with open questions cannot be approved. Read a card's current status right before you
   edit or move it: the user may have just approved it in the app.
5. **Work visibly.** `spill_set_status S-n active` before writing code, `done` after verifying.
   Comment on the card with what changed and where ("Req 2 done" or "Reqs 1-3 done" moves its
   progress bar). Run the
   spec's acceptance checks and record them with `spill_checks` before moving it to `done`.
   A user comment "Fix failing check: <name>" (the app's Fix button) means: set the spec `active`,
   fix it, run the checks again with `spill_checks`, and move it back to `done`.
6. **Answer messages.** The user can message Claude from the app's corner message button or
   `spill message text [--file path]`, not tied to any card. They show in `spill_inbox` as
   `message`, with any attached files listed as `[attached: path, ...]` (read them); answer each
   with `spill_reply`. Messages come in threads: each inbox line says "new thread" or "in thread of
   <time>"; a reply goes to the latest thread waiting on you unless you pass that time as `thread`.
   The button shows the message as received, then working once you have read it, until you reply or change the board.
7. **Keep the spotlight current.** Whenever the conversation moves to a card, call `spill_focus`
   with what is being discussed and what comes next, so the user sees it in the app.
8. **Rejections.** Revise the spec and move it to `discussing`, or, if it is superseded, draft the
   replacement and `spill_rejections resolve` it with a note saying why.
   A rejected draft whose reason says what the user wants usually means "redraft": rewrite the
   same spec from the reason and move it back to `discussing`; do not open a new spec.
9. **Stay in sync.** The user acts in the app while you work: call `spill_inbox` between steps and
   before asking anything.
10. **Behavior changed? Spec changed.** If building reveals something the spec does not say,
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

## 6. User commands

Until the canvas app exists, the user changes the board with the `spill` command. These are the
only way to set `approved`, `queued` or `rejected`, and each one shows up in Claude's next `spill_inbox`:

```
spill board                     spill approve S-n [note]
spill build S-n                 spill revert S-n [reason]
spill show ID                   spill reject S-n reason
spill answer Q-n text|A|A,C     spill comment ID text
spill ask "title" [body]        spill log [n]
spill focus                     spill app
spill message text [--file p]
spill serve [port]
```

`spill app` opens the board in the Spill window, where specs can also be approved, built or rejected.

Every change, from either side, is appended to `.spill/events.jsonl`.
