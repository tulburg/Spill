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
    description: "Read one card in full, with its links and comments.",
    inputSchema: { type: "object", properties: { id: str }, required: ["id"] },
    run: (b, a) => full(b.get(a.id)),
  },
  {
    name: "spill_ask",
    description:
      'Create a Q-n question for the user, optionally blocking specs. One question per card. Body: context in the first paragraph, then options as "- A. text" lines (the app turns them into answer buttons). If the answer picks no option, it is a redirect: rewrite this same question and reopen it rather than asking a new one. For a design sign-off pass design: true with the board link in the body; it must block the spec and gets the options "A. Approve this design" / "B. Needs changes".',
    inputSchema: {
      type: "object",
      properties: {
        title: str,
        body: str,
        section: str,
        blocks: { ...strList, description: "Spec IDs this question blocks" },
        multi: { type: "boolean", description: "The user may pick several options (multi select). Default: pick one." },
        design: { type: "boolean", description: "A design approval question. Answer A approves the spec it blocks." },
      },
      required: ["title"],
    },
    run: (b, a) => `Created ${summary(b.ask(a))}`,
  },
  {
    name: "spill_draft_spec",
    description: "Create an S-n spec in draft. Body sections: Purpose, Requirements (numbered, testable), Out of scope, Acceptance checks.",
    inputSchema: {
      type: "object",
      properties: { title: str, body: str, section: str, depends_on: strList },
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
      "Move a card to a new status. Specs: draft, discussing, active (only a queued spec, one at a time, before you write code), done (after recording checks). Questions: open (to reopen a redirected question), answered, dropped. Cannot set approved, queued or rejected; only the user can. Check the card's current status first.",
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
    description: "Link two cards: blocks, answers, or depends_on. The inverse link is added for blocks and answers.",
    inputSchema: { type: "object", properties: { from: str, type: { type: "string", enum: ["blocks", "answers", "depends_on"] }, to: str }, required: ["from", "type", "to"] },
    run: (b, a) => {
      b.link(a);
      return `Linked ${a.from} ${a.type} ${a.to}`;
    },
  },
  {
    name: "spill_record",
    description:
      "Record a D-n decision. When it answers a question, pass that Q-n; the question is closed as answered. Only for real decisions: an answer that rejects every option is a redirect, so rewrite and reopen the question instead.",
    inputSchema: { type: "object", properties: { title: str, body: str, question: str, section: str }, required: ["title"] },
    run: (b, a) => `Recorded ${summary(b.record(a))}`,
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
      'What the user changed since your last inbox call: approvals (actor "auto" for automatic ones), Build presses ("approved -> queued": start that spec), rejections, reverts (status lines ending "(reverted)": stop work), answers, redirects (action "redirect": none of a question\'s options fit; rewrite that question with spill_update), comments (including "Fix failing check: <name>" requests), new questions, and board-level messages (answer those with spill_reply; files the user attached are listed as "[attached: path, ...]", read them). Call at the start of every session and between steps.',
    inputSchema: { type: "object", properties: {} },
    run: (b) => {
      const events = b.inbox();
      const body = events.length ? events.map(event).join("\n") : "Nothing new from the user.";
      const r = rejectionLine(b);
      return r ? `${r}\n\n${body}` : body;
    },
  },
];
