# Spill

Spill is a visual control center for a project's specs. It shows every question, spec, and decision as a card on a canvas, colored by status, so the user can see what is open, approved, being discussed, and being worked on. Claude reads and writes the board through the Spill MCP server, which this repo also builds. Spill dogfoods its own protocol: section 4 applies here too, using the file fallback until the app exists.

---

## 1. Communication & output style

Prose (chat replies, commit messages, PR text, markdown, comments):
- **No em dashes.** Rewrite the sentence with a comma, semicolon, colon, period, or parentheses instead of an `—`. This targets em dashes and their look-alikes (`--`, spaced `-`, stray en dashes), not real hyphens: leave compound adjectives (`well-known`), ranges (`10-20`, `2019-2024`), and anything in code, paths, or URLs alone.
- Prefer plain ASCII punctuation and straight quotes over smart quotes and other Unicode decoration.
- No emojis unless the user asks for them.
- Skip filler openers ("Sure!", "Great question") and hollow closings ("Hope this helps!", "Let me know if..."). Answer directly and do not restate the request back.
- Be concise: short, direct statements over verbose explanation. Say "I don't know" rather than guess; do not invent APIs, files, or flags.

## 2. Code & scope

- Stay within the requested scope. No unsolicited refactors, renames, or "while I'm here" changes to code outside the task.
- Do not add or upgrade dependencies without listing them and asking first.
- Do not delete existing comments or code unrelated to the change.
- Prefer the simplest working solution; do not over-engineer or add abstraction that wasn't asked for.
- Treat user corrections as authoritative for the rest of the session.

## 3. Repo etiquette

- Work directly on `main`: no feature branches, worktrees, or pull requests. Commit only when asked.
- Match the style of the code you're editing.
- Verify a change by running it (tests, the app, the browser), not by reading it.
- UI design changes are drawn in Paper first (file "Spill", page "Work board v2"), then built.
- Test Approve and Reject on a copy of the board (`.spill/` copied to a scratch folder, served on
  another port), never on the real board.

## 4. Specs live in Spill

Every question, spec, and decision for this project is tracked in **Spill**, the visual spec board.
The user watches the board to see what is being asked, approved, and worked on, so the board must
always reflect reality. Full instructions: [`.spill/SPILL.md`](.spill/SPILL.md). Read it at the
start of every session that touches product behavior.

The short version:
- **Specs before code.** No feature code without an `approved` spec. Draft it on the board first.
- **Build means build.** Approved is not a go. When the user presses Build (the spec is `queued`),
  start building it without waiting to be asked (one active spec at a time, in the order queued).
- **Questions go on the board, not only in chat.** Every question you need answered becomes a
  `Q-n` card. Check the board for answers (and for questions the user added) before asking again.
- **Move cards as you work.** Set a spec `active` when you start it and `done` when it ships.
  Only one spec is `active` per session unless the user says otherwise.
- **An answer that picks none of the options is a redirect.** Rewrite and reopen the same question;
  do not record it as a decision or open a new question.
- **Never approve or reject your own cards.** Only the user moves a card to `approved`, `queued` or `rejected`
  (the board can also auto-approve; that is not you).
- If the Spill MCP server is not connected, use the file fallback in `.spill/` described in
  `SPILL.md`, and say so once.
