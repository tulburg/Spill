import type { Board } from "./board";
import type { Card, SpillEvent } from "./store";

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

export function event(e: SpillEvent): string {
  return `${e.at.slice(0, 16).replace("T", " ")}  ${e.actor.padEnd(6)} ${e.action.padEnd(10)} ${e.card}${e.detail ? `  ${e.detail}` : ""}`;
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
    run: (b) => b.board().map(summary).join("\n") || "The board is empty.",
  },
  {
    name: "spill_get",
    description: "Read one card in full, with its links and comments.",
    inputSchema: { type: "object", properties: { id: str }, required: ["id"] },
    run: (b, a) => full(b.get(a.id)),
  },
  {
    name: "spill_ask",
    description: "Create a Q-n question for the user, optionally blocking specs. One question per card; put context and options in the body.",
    inputSchema: {
      type: "object",
      properties: { title: str, body: str, section: str, blocks: { ...strList, description: "Spec IDs this question blocks" } },
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
    description: "Move a card to a new status (for specs: draft, discussing, active, done). Cannot set approved or rejected; only the user can.",
    inputSchema: { type: "object", properties: { id: str, status: str, note: { ...str, description: "Optional comment added with the change" } }, required: ["id", "status"] },
    run: (b, a) => `Moved ${summary(b.setStatus(a))}`,
  },
  {
    name: "spill_comment",
    description: "Add a comment to a card's thread.",
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
    description: "Record a D-n decision. When it answers a question, pass that Q-n; the question is closed as answered.",
    inputSchema: { type: "object", properties: { title: str, body: str, question: str, section: str }, required: ["title"] },
    run: (b, a) => `Recorded ${summary(b.record(a))}`,
  },
  {
    name: "spill_inbox",
    description: "What the user changed since your last inbox call: approvals, rejections, answers, comments, new questions. Call at the start of every session.",
    inputSchema: { type: "object", properties: {} },
    run: (b) => {
      const events = b.inbox();
      return events.length ? events.map(event).join("\n") : "Nothing new from the user.";
    },
  },
];
