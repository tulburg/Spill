# Using Spill in this project

Spill is a visual control center for a project's specs. It shows every question, spec, and
decision as a card on a canvas, colored by status, so the user can see at a glance what is
open, what is approved, and what Claude is working on right now. Claude reads and writes the
board through the Spill MCP server.

## The most important rule: fetch and update spec state

The board shows a spec as "Claude building" for as long as it is `active`. A spec left active
after Claude stopped working on it looks like a hang to the user. So:

- **Fetch** before each step: `spill_inbox`, and `spill_get` on the spec. Act on what changed
  (answers, reverts, approvals) before going on.
- **Update** whenever you stop building an active spec, for any reason, in the same step:
  `done` (checks recorded), a blocking question (`spill_ask` with `blocks: [S-n]`) when you need
  the user, or `discussing` with a comment when the spec is wrong or you are switching away.
- **Before ending a turn**, call `spill_board` and check every active spec. If you are not
  building it right now, update it as above. Never end a turn with a spec active and nothing
  being built.
- **At the start of a session**, an active spec you are not continuing is stale: update it first.

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
- Update requested: on a `done` spec the user asks for an update instead of reverting. It shows as
  an `update_request` line in `spill_inbox`, and the card shows "Update requested" until you act:
  set the spec `active` when the update fits the spec as written (allowed without a new approval
  while the request is open), ask a question that blocks it when you need input, or update the
  spec text and set it to `draft` so it waits for approval again. Only an update too big for the
  same spec becomes a new or replacement spec. Comment which path you took.
- Branch or replace (too big for the same spec): branch a new spec with `spill_draft_spec`
  `follows: S-n` when the done spec stays; it is drawn next to it with a "Follows" link. When the
  done spec's code must go, `spill_propose_replace` asks the user, naming both specs and the files
  to remove. **Never remove code before the user picks A.** Then remove it, record the removed files
  with `spill_files`, and set the old spec `replaced`: it stays dimmed, linked to its replacement,
  with its questions and decisions. On B, keep it and link the new spec `follows` it.
- `rejected`: the user said no. **Only the user sets this.** Keep the card; do not delete it to undo the rejection.
- Deleting a card: a card that should not exist (a duplicate, or a change drafted as a new spec that
  belongs on an existing one) is deleted only through `spill_propose_delete`, which asks "Delete
  S-n?". **Nothing is deleted until the user picks A**; then the card, every link to it, and its open
  questions that block nothing else are removed, and the question stays as the record. Only specs in
  draft, discussing, approved or rejected, and open or dropped questions; a done spec goes through
  `spill_propose_replace`. On B, keep it and do not propose it again unless something changes.
- `active`: Claude is implementing it right now. Only a `queued` spec can be made active.
- `done`: shipped and verified.
- `replaced`: a done spec the user agreed to replace; its code is removed. Set it only after the
  user picks A on its replacement question.

Questions use `open -> answered` (or `dropped`) instead.

### Links

Cards link to each other: a question `blocks` a spec, a decision `answers` a question, a spec
`depends_on` another spec. Spill draws these as lines on the canvas.

- A question that stops work on a spec must `block` it, even when the spec is `active`. An
  unlinked question floats loose on the canvas and the spec keeps showing "Claude building".
- `depends_on` makes a spec a **child** of the target: it is drawn under that parent, and the
  parent auto-approves once every child spec is done. Use it only for specs that are parts of a
  bigger spec, never for order or prerequisites (a spike that must come first is not a child of
  the spec it unblocks). Keep those in the same section and state the order in the body and in
  `spill_focus`.

## 2. MCP tools

The `spill` MCP server exposes these tools (all take the project from the working directory):

| Tool                 | Use it to                                                              |
|----------------------|------------------------------------------------------------------------|
| `spill_board`        | Get a summary of every card: id, kind, title, status, section.         |
| `spill_get`          | Read one card in full, with its comments and links.                    |
| `spill_ask`          | Create a `Q-n` question, optionally blocking specs. Options are `- A. text` lines in the body; `multi: true` lets the user pick several. |
| `spill_draft_spec`   | Create an `S-n` spec in `draft`.                                       |
| `spill_update`       | Edit a card's title, body, or section.                                 |
| `spill_set_status`   | Move a card (`discussing`, `active`, `done`, `replaced`). Not `approved`/`rejected`.|
| `spill_comment`      | Add a comment to a card's thread.                                      |
| `spill_unlink`       | Remove a link (and its inverse), e.g. to move a question to the part that owns it after a split. |
| `spill_link`         | Link two cards (`blocks`, `answers`, `depends_on`, `follows`). `depends_on` makes the spec a child of the target; `follows` marks a branch from a done spec. |
| `spill_files`        | Record the files you touched building a spec (`new`, `changed`, `removed`); shown as its Files list. |
| `spill_propose_replace` | Ask to delete and replace a done spec; names the files to remove. Nothing is removed until the user picks A. |
| `spill_propose_delete` | Ask to delete a card that should not exist (not a done spec). Nothing is deleted until the user picks A. |
| `spill_record`       | Record a `D-n` decision and close the question it answers.             |
| `spill_rejections`   | The rejection queue: rejected specs still waiting on you, with reasons; `resolve` one to leave it rejected. |
| `spill_focus`        | Set the spotlight: cards being discussed now and cards up next.        |
| `spill_todos`        | Your todo list for the active build (the full list each call); fills the card's todo progress bar. |
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
   **An answer that picks no option is a redirect.** The app records it as a `redirect` inbox
   line and keeps the question open. Read what the user wrote and act on what it means:
   - an answer of their own (an alternative to the options): record it with `spill_record`;
   - the question should not exist (already settled, wrongly framed, not theirs to decide): set
     it `dropped`, comment why, and act on what they said;
   - "not what I meant" or unclear: rewrite the same question with `spill_update` (that clears
     the redirect note on the card) and comment what changed.
   Never open a new question for the same thing.
3. **Draft specs.** Each spec body has: Purpose, Requirements (numbered, each testable),
   Out of scope, Acceptance checks. Link open questions that block it.
4. **Wait for Build, then build.** Do not start code for a spec until the user presses Build and
   it is `queued`. Build means build: start it without being asked, one active spec at a time,
   in the order queued. An approval alone is not a go.
   Designs are drawn in Spill and owned by the spec (D-31): once spec designs exist (S-42), draw them
   with Spill's design tools instead of Paper or OpenDraw, and the review happens in the Designs
   section of the spec's Overview. Most specs have one design: leave out the variant. Use variants
   (A, B, C) only to offer several directions; the user compares them side by side on the board.
   In the design viewer the user only comments (S-46): pins on a spot (Shift+click) and comment
   threads. These reach your inbox (`design_pin`, `design_comment`); `spill_design_feedback` gives
   every open pin's position and note, open comments, and a count of resolved ones. Work through
   the open notes: change the design for each one, then reply with what changed and resolve it in
   the same `spill_design_reply` call (`resolve: true`, for pins and comments alike). Resolving
   clears the note from the user's view, so the spot is free for new pins; only you resolve. Leave
   a note open only when you need the user's answer, and reply with the question.
   **Design sign-off is one design question per spec**, never an approval in the viewer:
   `spill_ask` with `design: true`, blocking that one spec. Do not list options; the app builds
   them from the designs: one per variant ("Variant A: ...", "Variant B: ...") or "Approve this
   design", then "Needs changes". Answering with a variant (or "Approve this design") records it as
   the chosen one and approves the spec if nothing else is open. "Needs changes" leaves it waiting:
   rework the design from the notes and the answer, then reopen the same question. A spec with
   designs cannot be approved any other way.
   Approval keeps a read-only copy of the spec's designs (S-47, D-35): later edits never change
   what was approved, and comparing with that version lists the design changes since.
   A spec with open questions cannot be approved. Read a card's current status right before you
   edit or move it: the user may have just approved it in the app.
5. **Work visibly.** `spill_set_status S-n active` before writing code, `done` after verifying.
   Right after setting it active, record your todo list for this build with `spill_todos` (every
   item, each with `done`), and send the full list again as you finish items (S-48). It fills the
   left 75% of the card's progress bar; each new build, update builds included, starts it at 0.
   Todos show nowhere else. Comment on the card with what changed and where ("Req 2 done" or
   "Reqs 1-3 done" fills the right 25%, requirements met, which carries over between builds). Record each file you create or change with `spill_files`. Run the
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
   Fading rules (S-40): finished cards (done, answered, rejected, replaced, dropped, and decisions)
   always look muted, including an answered question's chosen answer (its green ring marks it).
   While a spotlight is set, finished cards and drafts outside it also fade; active, approved,
   queued, discussing specs and open questions never fade. Hovering or opening
   any card shows it at full strength.
8. **Rejections.** Revise the spec and move it to `discussing`, or, if it is superseded, draft the
   replacement and `spill_rejections resolve` it with a note saying why.
   A rejected draft whose reason says what the user wants usually means "redraft": rewrite the
   same spec from the reason and move it back to `discussing`; do not open a new spec.
9. **Stay in sync.** The user acts in the app while you work: call `spill_inbox` between steps and
   before asking anything.
10. **Behavior changed? Spec changed.** If building reveals something the spec does not say,
   stop, add a question or update the spec, and set it back to `discussing`.
11. **Too large? Recommend a split.** At any point before a spec is `done` (drafting,
   discussing, approved, queued, or mid-build), if it has grown too large to build and check as
   one piece, ask (`spill_ask`, blocking it), naming the parts you propose with the
   requirements, questions and decisions each would own, and recommend the split.
   **A split is a reorganization, not new branches bolted on.** If the user agrees:
   - draft each part with `depends_on` the original, written as a complete spec;
   - move every existing question to the part it belongs to (`spill_unlink` from the original,
     `spill_link` to the part); its decision moves with it;
   - open new questions on the part they concern;
   - rewrite the original (`spill_update`) as the overview: what the whole is for and how the
     parts fit, with no requirements left that a part owns;
   - comment on the original what moved where.
   Then build the parts one by one (an active original goes back to `discussing` while its parts
   are built). A done spec is never split.

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

`spill app` opens the board in a Spill window, where specs can also be approved, built or rejected. With Spill already open it adds a window to the running app; File > Open Recent and Open Project... open other boards, and the Window menu lists the open ones.

Every change, from either side, is appended to `.spill/events.jsonl`.
