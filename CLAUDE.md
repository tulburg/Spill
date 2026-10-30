# Project name

One paragraph on what this project is. Replace this heading and paragraph when the project starts.

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

- Branch off `main`; land changes via pull request (do not push to `main`).
- Match the style of the code you're editing.
- Verify a change by running it (tests, the app, the browser), not by reading it.

## 4. Specs live in Spill

Every question, spec, and decision for this project is tracked in **Spill**, the visual spec board.
The user watches the board to see what is being asked, approved, and worked on, so the board must
always reflect reality. Full instructions: [`.spill/SPILL.md`](.spill/SPILL.md). Read it at the
start of every session that touches product behavior.

The short version:
- **Specs before code.** No feature code without an `approved` spec. Draft it on the board first.
- **Questions go on the board, not only in chat.** Every question you need answered becomes a
  `Q-n` card. Check the board for answers (and for questions the user added) before asking again.
- **Move cards as you work.** Set a spec `active` when you start it and `done` when it ships.
  Only one spec is `active` per session unless the user says otherwise.
- **Never approve or reject your own cards.** Only the user moves a card to `approved` or `rejected`.
- If the Spill MCP server is not connected, use the file fallback in `.spill/` described in
  `SPILL.md`, and say so once.
