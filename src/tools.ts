import type { Board } from "./board";
import type { Card, Focus, SpillEvent } from "./store";

export function summary(c: Card): string {
  return `${c.id.padEnd(6)} ${c.status.padEnd(10)} ${c.title}${c.section ? `  [${c.section}]` : ""}`;
}

export function full(c: Card): string {
  const links = c.links.length ? c.links.map((l) => `${l.type} ${l.target}`).join(", ") : "none";
  return [
    `${c.id} (${c.kind}, ${c.status}) ${c.title}`,
    `Section: ${c.section ?? "none"}`,
    `Links: ${links}`,
    "",
    c.body.trim(),
    "",
    "## Comments",
    c.comments.trim() || "(none)",
  ].join("\n");
}

function minute(at: string): string {
  return at.slice(0, 16).replace("T", " ");
}

export function event(e: SpillEvent): string {
  // S-30: message lines name their thread by its first message's time.
  const thread = e.action === "message" ? (e.thread && e.thread !== e.at ? `  (in thread of ${minute(e.thread)})` : "  (new thread)") : "";
  return `${minute(e.at)}  ${e.actor.padEnd(6)} ${e.action.padEnd(10)} ${e.card}${e.detail ? `  ${e.detail}` : ""}${thread}`;
}

export function rejectionLine(b: Board): string | null {
  const r = b.rejections();
  return r.length ? `Rejections waiting: ${r.map((x) => x.card.id).join(", ")} (see spill_rejections)` : null;
}

export function focusLine(f: Focus | null): string {
  if (!f) return "Spotlight: none";
  const parts = [f.discussing.length ? `discussing ${f.discussing.join(", ")}` : "", f.next.length ? `next ${f.next.join(", ")}` : ""];
  return `Spotlight: ${parts.filter(Boolean).join("; ")}${f.note ? ` (${f.note})` : ""}`;
}

const str = { type: "string" };
const strList = { type: "array", items: { type: "string" } };

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run: (b: Board, a: any) => string;
}

export const TOOLS: Tool[] = [
  {
    name: "spill_board",
    description: "Summary of every card on the board: id, status, title, section.",
    inputSchema: { type: "object", properties: {} },
    run: (b) => [rejectionLine(b), focusLine(b.focus()), "", b.board().map(summary).join("\n") || "The board is empty."].filter((l) => l !== null).join("\n"),
  },
  {
    name: "spill_get",
    description: "Read one card in full, with its links, comments and the files recorded for it. For a spec whose text changed since it was approved, it ends with those changes, so you can explain them.",
    inputSchema: { type: "object", properties: { id: str }, required: ["id"] },
    run: (b, a) => {
      const c = b.get(a.id);
      // S-35: the files Claude recorded building the spec.
      const files = b.files(c.id);
      const base = files.length ? `${full(c)}\n\n## Files\n${files.map((f) => `${f.change.padEnd(8)} ${f.path}`).join("\n")}` : full(c);
      // S-34: what changed since the approved version, so Claude can explain the update.
      const ch = b.changesSinceApproved(c);
      if (!ch) return base;
      const add = ch.lines.filter((l) => l.op === "add").length;
      const del = ch.lines.length - add;
      const shown = ch.lines.filter((l) => l.text.trim()).slice(0, 20).map((l) => `${l.op === "add" ? "+" : "-"} ${l.text}`);
      return `${base}\n\n## Changes since the approved version (${minute(ch.at)}): +${add} -${del} lines\n${shown.join("\n")}`;
    },
  },
  {
    name: "spill_ask",
    description:
      'Create a Q-n question for the user, optionally blocking specs. One question per card. Body: context in the first paragraph, then options as "- A. text" lines (the app turns them into answer buttons). If the answer picks no option, it is a redirect: record it if it is an answer of its own, drop the question if the user says it should not exist, or rewrite this same question if it was unclear. Never ask a new one for the same thing. For a design sign-off pass design: true with the board link in the body; it must block the spec and gets the options "A. Approve this design" / "B. Needs changes".',
    inputSchema: {
      type: "object",
      properties: {
        title: str,
        body: str,
        section: str,
        blocks: { ...strList, description: "Spec IDs this question blocks. Always set it when the question stops work on a spec, including an active one." },
        multi: { type: "boolean", description: "The user may pick several options (multi select). Default: pick one." },
        design: { type: "boolean", description: "A design approval question. Answer A approves the spec it blocks." },
      },
      required: ["title"],
    },
    run: (b, a) => `Created ${summary(b.ask(a))}`,
  },
  {
    name: "spill_draft_spec",
    description: "Create an S-n spec in draft. Body sections: Purpose, Requirements (numbered, testable), Out of scope, Acceptance checks. Keep each spec small enough to build and check as one piece; when one grows too large (at any point before done), ask to split it and draft the parts with depends_on the original. To branch from a done spec (an update too big for it that does not replace it), pass follows: the new spec is linked to it and drawn next to it.",
    inputSchema: {
      type: "object",
      properties: { title: str, body: str, section: str, depends_on: { ...strList, description: "Parent spec IDs: this spec is a part of them and is drawn under them. Not for order or prerequisites." }, follows: { ...str, description: "A done spec this one branches from" } },
      required: ["title"],
    },
    run: (b, a) => `Created ${summary(b.draftSpec(a))}`,
  },
  {
    name: "spill_update",
    description: "Edit a card's title, body, or section. Body replaces the whole card text above the comments.",
    inputSchema: { type: "object", properties: { id: str, title: str, body: str, section: str }, required: ["id"] },
    run: (b, a) => `Updated ${summary(b.update(a))}`,
  },
  {
    name: "spill_set_status",
    description:
      "Move a card to a new status. Specs: draft, discussing, active (only a queued spec, or a done spec with an open update request; one at a time, before you write code), done (after recording checks), replaced (a done spec whose replacement the user confirmed with A on spill_propose_replace's question, after you removed its code and recorded the removed files). Questions: open (to reopen a question), answered, dropped (also when a redirect says the question should not exist). Cannot set approved, queued or rejected; only the user can. Check the card's current status first. Never leave a spec active when you stop building it: set done, block it with a question, or set discussing in the same step.",
    inputSchema: { type: "object", properties: { id: str, status: str, note: { ...str, description: "Optional comment added with the change" } }, required: ["id", "status"] },
    run: (b, a) => `Moved ${summary(b.setStatus(a))}`,
  },
  {
    name: "spill_comment",
    description: 'Add a comment to a card\'s thread. On an active spec, "Req 2 done" or "Reqs 1-3 done" moves its progress bar.',
    inputSchema: { type: "object", properties: { id: str, text: str }, required: ["id", "text"] },
    run: (b, a) => `Commented on ${b.comment(a).id}`,
  },
  {
    name: "spill_link",
    description: "Link two cards: blocks, answers, depends_on, or follows. The inverse link is added for blocks, answers and follows. A question that stops work on a spec must block it, even an active one. depends_on makes the spec a child of the target (drawn under it; the parent auto-approves when every child spec is done): use it only for parts of a bigger spec, never for order or prerequisites. follows marks a spec as branched from a done spec (drawn next to it).",
    inputSchema: { type: "object", properties: { from: str, type: { type: "string", enum: ["blocks", "answers", "depends_on", "follows"] }, to: str }, required: ["from", "type", "to"] },
    run: (b, a) => {
      b.link(a);
      return `Linked ${a.from} ${a.type} ${a.to}`;
    },
  },
  {
    name: "spill_unlink",
    description: "Remove a link between two cards (and its inverse). Use it when reorganizing, e.g. moving a question or child spec from a spec being split to the part that now owns it: spill_unlink the old link, then spill_link the new one.",
    inputSchema: { type: "object", properties: { from: str, type: { type: "string", enum: ["blocks", "answers", "depends_on", "follows"] }, to: str }, required: ["from", "type", "to"] },
    run: (b, a) => {
      b.unlink(a);
      return `Unlinked ${a.from} ${a.type} ${a.to}`;
    },
  },
  {
    name: "spill_record",
    description:
      "Record a D-n decision. When it answers a question, pass that Q-n; the question is closed as answered. A free answer to a question (a redirect) that gives an answer of its own is recorded here too; one that says the question is wrong or unclear is not a decision.",
    inputSchema: { type: "object", properties: { title: str, body: str, question: str, section: str }, required: ["title"] },
    run: (b, a) => `Recorded ${summary(b.record(a))}`,
  },
  {
    name: "spill_files",
    description:
      "Record the files you touched building a spec: path (relative to the project root) and change (new, changed, or removed). Record them as you build, before setting the spec done; the spec shows them as its Files list, and a replacement proposal names them. Recording a path again updates it; after removing a replaced spec's code, record those paths as removed.",
    inputSchema: {
      type: "object",
      properties: {
        id: str,
        files: { type: "array", items: { type: "object", properties: { path: str, change: { type: "string", enum: ["new", "changed", "removed"] } }, required: ["path", "change"] } },
      },
      required: ["id", "files"],
    },
    run: (b, a) => `${a.id} files: ${b.recordFiles(a).map((f) => `${f.change} ${f.path}`).join(", ")}`,
  },
  {
    name: "spill_propose_replace",
    description:
      "Propose deleting and replacing a done spec (id) with another spec (by), when an update is too big for it and it should not stay. Creates a question naming both specs and the files from id's Files list, blocking by. Nothing is deleted until the user picks A. On A: remove id's implementation, record the removed files with spill_files, then spill_set_status id replaced with a note on what was removed. On B: keep id and spill_link by follows id instead.",
    inputSchema: { type: "object", properties: { id: str, by: str, reason: { ...str, description: "One or two sentences on why the update needs a replacement" } }, required: ["id", "by"] },
    run: (b, a) => `Created ${summary(b.proposeReplace(a))}`,
  },
  {
    name: "spill_rejections",
    description:
      "The rejection queue: specs the user rejected that are still waiting on you, oldest first, with the full reason. A card leaves the queue when you revise it and move it to discussing, or when you pass resolve (its ID) and a note to leave it rejected for good.",
    inputSchema: { type: "object", properties: { resolve: { ...str, description: "Card ID to take off the queue, leaving it rejected" }, note: str } },
    run: (b, a) => {
      if (a.resolve) return `Resolved ${b.resolveRejection({ id: a.resolve, note: a.note }).id}; it stays rejected`;
      const r = b.rejections();
      return r.length ? r.map((x) => `${x.card.id} ${x.card.title}\n  rejected ${x.at.slice(0, 16).replace("T", " ")}: ${x.reason || "(no reason)"}`).join("\n") : "No rejections waiting.";
    },
  },
  {
    name: "spill_focus",
    description:
      "Set the spotlight the user sees: the cards being discussed right now and the cards up next, in order. Update it whenever the conversation moves to another card. Pass clear: true to remove it.",
    inputSchema: {
      type: "object",
      properties: {
        discussing: { ...strList, description: "Card IDs being discussed now" },
        next: { ...strList, description: "Card IDs up next, in order" },
        note: { ...str, description: "One line on what is being discussed" },
        clear: { type: "boolean" },
      },
    },
    run: (b, a) => focusLine(b.setFocus(a)).replace("Spotlight: none", "Spotlight cleared"),
  },
  {
    name: "spill_checks",
    description:
      "Record a spec's acceptance check results so its card shows them. Call with running: true when you start running the checks, then with results (one per check: name, pass, optional detail) when they finish.",
    inputSchema: {
      type: "object",
      properties: {
        id: str,
        running: { type: "boolean" },
        results: {
          type: "array",
          items: { type: "object", properties: { name: str, pass: { type: "boolean" }, detail: str }, required: ["name", "pass"] },
        },
      },
      required: ["id"],
    },
    run: (b, a) => {
      const r = b.checks(a);
      if (r.running) return `Checks running on ${a.id}`;
      const failed = r.results.filter((x) => !x.pass);
      return `${a.id}: ${r.results.length - failed.length} of ${r.results.length} checks pass${failed.length ? `; failing: ${failed.map((x) => x.name).join(", ")}` : ""}`;
    },
  },
  {
    name: "spill_reply",
    description:
      "Answer a board-level message from the user (inbox lines with action \"message\"). Goes to the latest thread still waiting on you, or to thread (the time an inbox line gives, \"in thread of YYYY-MM-DD HH:MM\"). The reply shows in that thread's card by the app's message button; missed replies leave a badge there.",
    inputSchema: { type: "object", properties: { text: str, thread: { ...str, description: "Thread to answer, by its first message's time; default the latest open thread" } }, required: ["text"] },
    run: (b, a) => (b.message(a.text, [], a.thread), "Replied"),
  },
  {
    name: "spill_inbox",
    description:
      'What the user changed since your last inbox call: approvals (actor "auto" for automatic ones), Build presses ("approved -> queued": start that spec), rejections, reverts (status lines ending "(reverted)": stop work), answers, redirects (action "redirect": the user answered in their own words; record it, drop the question, or rewrite it, depending on what they said), comments (including "Fix failing check: <name>" requests), update requests on done specs (action "update_request": decide whether it fits the spec as written, needs a question, needs the spec updated and re-approved, or is too big), new questions, and board-level messages (answer those with spill_reply; files the user attached are listed as "[attached: path, ...]", read them). Call at the start of every session and between steps.',
    inputSchema: { type: "object", properties: {} },
    run: (b) => {
      const events = b.inbox();
      const body = events.length ? events.map(event).join("\n") : "Nothing new from the user.";
      const r = rejectionLine(b);
      return r ? `${r}\n\n${body}` : body;
    },
  },
];
