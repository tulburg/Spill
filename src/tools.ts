import type { Board } from "./board";
import { Designs, type Artboard } from "./designs";
import { screenshot } from "./render";
import type { Card, Focus, SpillEvent } from "./store";

// S-49: ver is a spec's version label ("v3", "v3 new"), shown after its status.
export function summary(c: Card, ver?: string): string {
  return `${c.id.padEnd(6)} ${c.status.padEnd(10)} ${ver ? `${ver.padEnd(7)}` : ""}${c.title}${c.section ? `  [${c.section}]` : ""}`;
}

export function full(c: Card, ver?: string): string {
  const links = c.links.length ? c.links.map((l) => `${l.type} ${l.target}`).join(", ") : "none";
  return [
    `${c.id}${ver ? ` ${ver}` : ""} (${c.kind}, ${c.status}) ${c.title}`,
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
  // A string is sent as text; content is sent as is (S-44: screenshots are images).
  run: (b: Board, a: any) => string | { content: object[] };
}

export const TOOLS: Tool[] = [
  {
    name: "spill_board",
    description: "Summary of every card on the board: id, status, version (specs: v2, or \"v3 new\" when a newer version waits for approval), title, section.",
    inputSchema: { type: "object", properties: {} },
    run: (b) => [rejectionLine(b), focusLine(b.focus()), "", b.board().map((c) => summary(c, c.kind === "spec" ? b.versionLabel(c) : undefined)).join("\n") || "The board is empty."].filter((l) => l !== null).join("\n"),
  },
  {
    name: "spill_get",
    description: "Read one card in full, with its links, comments and the files recorded for it. For a spec whose text changed since it was approved, it ends with those changes, so you can explain them.",
    inputSchema: { type: "object", properties: { id: str }, required: ["id"] },
    run: (b, a) => {
      const c = b.get(a.id);
      // S-35: the files Claude recorded building the spec.
      const files = b.files(c.id);
      const ver = c.kind === "spec" ? b.versionLabel(c) : undefined;
      const base = files.length ? `${full(c, ver)}\n\n## Files\n${files.map((f) => `${f.change.padEnd(8)} ${f.path}`).join("\n")}` : full(c, ver);
      // S-34: what changed since the approved version, so Claude can explain the update.
      const ch = b.changesSinceApproved(c);
      if (!ch) return base;
      const n = (op: string) => ch.lines.filter((l) => l.op === op).length;
      const shown = ch.lines.filter((l) => l.text.trim()).slice(0, 20).map((l) => `${l.op === "add" ? "+" : l.op === "mod" ? "~" : "-"} ${l.text}`);
      return `${base}\n\n## Changes since the approved version (${minute(ch.at)}): +${n("add")} -${n("del")} ~${n("mod")} lines\n${shown.join("\n")}`;
    },
  },
  {
    name: "spill_ask",
    description:
      'Create a Q-n question for the user, optionally blocking specs. One question per card. Body: context in the first paragraph, then options as "- A. text" lines (the app turns them into answer buttons). If the answer picks no option, it is a redirect: record it if it is an answer of its own, drop the question if the user says it should not exist, or rewrite this same question if it was unclear. Never ask a new one for the same thing. For the design sign-off of a spec (the only way a spec with designs is approved) pass design: true, blocking exactly that spec, and list no options: the app builds them from the designs, one per variant ("Variant A: ...") or "Approve this design", then "Needs changes". A variant or "Approve this design" approves the spec and marks it chosen.',
    inputSchema: {
      type: "object",
      properties: {
        title: str,
        body: str,
        section: str,
        blocks: { ...strList, description: "Spec IDs this question blocks. Always set it when the question stops work on a spec, including an active one." },
        multi: { type: "boolean", description: "The user may pick several options (multi select). Default: pick one." },
        design: { type: "boolean", description: "The spec's design sign-off. Options are built from its designs; a variant (or Approve this design) approves the spec." },
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
    run: (b, a) => {
      const c = b.setStatus(a);
      // S-48: the moment a build starts is when the todo list is due.
      const todo = c.kind === "spec" && c.status === "active" ? `\nNext: record your todo list for this build with spill_todos (every item, each with done), before writing code, and send the full list again as you finish items. It drives the card's progress bar.` : "";
      return `Moved ${summary(c)}${todo}`;
    },
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
    name: "spill_propose_delete",
    description:
      "Propose deleting a card that should not exist: a duplicate, or a change drafted as a new spec that belongs on an existing one. Creates a question \"Delete <id>?\" (A. Delete it / B. Keep it) with your reason. Nothing is deleted until the user picks A; then the card, every link to it, and its open questions that block nothing else are removed. Only specs in draft, discussing, approved or rejected, and open or dropped questions; a done spec goes through spill_propose_replace. Never delete any other way, and never use it to undo the user's rejection. On B, keep the card and do not propose it again unless something changes.",
    inputSchema: { type: "object", properties: { id: str, reason: { ...str, description: "One or two sentences on why the card should not exist" } }, required: ["id", "reason"] },
    run: (b, a) => `Created ${summary(b.proposeDelete(a))}`,
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
    name: "spill_todos",
    description:
      "Your todo list for the spec you are building (active). Record it right after setting the spec active, before writing code, then call again with the full list each time you finish an item (done: true), add one or reword one. It fills the left part of the card's progress bar; requirements met (\"Reqs 1-n done\") fill the right part. Each new build starts with an empty list. Todos are not shown anywhere else.",
    inputSchema: {
      type: "object",
      properties: { id: str, items: { type: "array", items: { type: "object", properties: { text: str, done: { type: "boolean" } }, required: ["text"] } } },
      required: ["id", "items"],
    },
    run: (b, a) => {
      const l = b.todos(a);
      return `${a.id}: ${l.items.filter((x) => x.done).length} of ${l.items.length} todos done`;
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
  // S-44: design tools, named and shaped after OpenDraw's MCP tools.
  ...designTools(),
];

function boardLine(x: Artboard): string {
  return `${x.id.padEnd(6)} ${x.variant ? `${x.variant}  ` : ""}${x.width} x ${x.height}  ${x.status.padEnd(8)} ${x.title}`;
}

function designTools(): Tool[] {
  const spec = { type: "string", description: "The spec (S-n) the designs belong to" };
  const styleMap = { type: "object", additionalProperties: { type: ["string", "number", "null"] }, description: "CSS properties, camelCase or kebab-case. Bare numbers are px; null removes a property." };
  const d = (b: Board) => new Designs(b.store);
  return [
    {
      name: "spill_design_list",
      description: "A spec's artboards (or every spec's, without spec): id, size, status and title, grouped by variant when the spec has variants.",
      inputSchema: { type: "object", properties: { spec } },
      run: (b, a) => {
        const all = d(b).list(a.spec);
        const lines = all.flatMap((s) => {
          const head = `${s.spec}: ${s.artboards.length} artboard${s.artboards.length === 1 ? "" : "s"}`;
          const variants = [...new Set(s.artboards.map((x) => x.variant))].sort();
          if (variants.length === 1 && !variants[0]) return [head, ...s.artboards.map((x) => `  ${boardLine(x)}`)];
          return [head, ...variants.flatMap((v) => [`  ${v ? `Variant ${v}` : "No variant"}`, ...s.artboards.filter((x) => x.variant === v).map((x) => `    ${boardLine(x)}`)])];
        });
        return lines.join("\n") || (a.spec ? `${a.spec} has no designs yet.` : "No designs yet.");
      },
    },
    {
      name: "spill_design_create_artboard",
      description:
        "Creates an artboard (a top-level frame) for a spec's design and returns its id. styles must include width and height (e.g. 1440px, 390px); add a background and layout (display flex, flexDirection, padding, gap). Most specs have one design and need no variant: leave variant out. Pass variant (A, B, C) only when you offer the user several directions to choose from; the app then shows them side by side on the board.",
      inputSchema: { type: "object", properties: { spec, title: str, variant: str, styles: styleMap }, required: ["spec", "title", "styles"] },
      run: (b, a) => `Created ${boardLine(d(b).createArtboard(a))}`,
    },
    {
      name: "spill_design_write_html",
      description:
        'Turns HTML with inline styles into design nodes. "insert-children" appends them inside target (an artboard or node id); "replace" removes target and puts them in its place. Every element gets a data-node id (ids in the HTML are replaced). Write one visual group per call (a header, a card, a row). Layout is flexbox with padding and gap. Returns the new top-level node ids.',
      inputSchema: {
        type: "object",
        properties: { spec, html: str, target: { ...str, description: "In insert-children mode the parent; in replace mode the node to replace" }, mode: { type: "string", enum: ["insert-children", "replace"] } },
        required: ["spec", "html", "target", "mode"],
      },
      run: (b, a) => `Wrote ${d(b).writeHtml(a).join(", ")}`,
    },
    {
      name: "spill_design_read",
      description: "The HTML of an artboard or node, with its data-node ids, so you can edit part of it.",
      inputSchema: { type: "object", properties: { spec, node: { ...str, description: "Artboard or node id" } }, required: ["spec", "node"] },
      run: (b, a) => d(b).read(a),
    },
    {
      name: "spill_design_update_styles",
      description: "Changes inline styles on nodes without touching their children. Each update sets styles on every node in nodeIds; null removes a property. On an artboard, width and height also update the artboard's size.",
      inputSchema: {
        type: "object",
        properties: { spec, updates: { type: "array", items: { type: "object", properties: { nodeIds: strList, styles: styleMap }, required: ["nodeIds", "styles"] } } },
        required: ["spec", "updates"],
      },
      run: (b, a) => `Styled ${d(b).updateStyles(a).join(", ")}`,
    },
    {
      name: "spill_design_duplicate",
      description:
        "Copies nodes with fresh ids. A node copy goes right after the original, or at the end of parentId. An artboard copy is a new artboard in the same variant; pass variant to start another direction from it (only when offering several directions), and title to name it. Returns the new ids in order.",
      inputSchema: {
        type: "object",
        properties: { spec, nodes: { type: "array", items: { type: "object", properties: { id: str, parentId: str, variant: str, title: str }, required: ["id"] } } },
        required: ["spec", "nodes"],
      },
      run: (b, a) => `Duplicated as ${d(b).duplicate(a).join(", ")}`,
    },
    {
      name: "spill_design_delete",
      description: "Deletes nodes and everything inside them. An artboard id deletes the whole artboard.",
      inputSchema: { type: "object", properties: { spec, nodeIds: strList }, required: ["spec", "nodeIds"] },
      run: (b, a) => `Deleted ${d(b).delete(a).join(", ")}`,
    },
    {
      name: "spill_design_screenshot",
      description: "Renders an artboard or node to PNG with WebKit, so you can check your work after meaningful changes. scale 1 or 2 (default 1).",
      inputSchema: { type: "object", properties: { spec, node: str, scale: { type: "number" } }, required: ["spec", "node"] },
      run: (b, a) => ({ content: [{ type: "image", data: Buffer.from(screenshot(d(b), a)).toString("base64"), mimeType: "image/png" }] }),
    },
    // S-46: the user's review of a spec's designs.
    {
      name: "spill_design_feedback",
      description:
        "The user's review of a spec's designs: which variant (or the whole design) the design question chose, if answered; every open pin with its number, artboard, position (x, y in artboard px from the top left) and note; open comments; the replies on each; and a count of resolved notes (resolved ones are cleared from the user's view and not listed). Pins and comments also reach spill_inbox. Work through the open notes: change the design for each, then reply with what changed and resolve it in the same spill_design_reply call. Leave a note open only when you need the user's answer; reply with the question.",
      inputSchema: { type: "object", properties: { spec }, required: ["spec"] },
      run: (b, a) => {
        const f = d(b).feedback(a.spec);
        if (!f.artboards.length) return `${a.spec} has no designs yet.`;
        const keys = f.keys.length ? f.keys : [""];
        const replies = (rs: { by: string; text: string }[], pad: string) => rs.map((r) => `${pad}${r.by === "claude" ? "You" : "User"}: ${r.text}`);
        const out: string[] = [];
        for (const k of keys) {
          out.push(`${k ? `Variant ${k}` : "Design"}: ${f.chosen && f.chosen.variant === k ? "chosen" : "waiting"}`);
          for (const p of f.pins.filter((x) => !x.resolved && (f.pinKey[x.n] ?? "") === k)) {
            const ab = f.artboards.find((x) => x.id === p.artboard);
            out.push(`  Pin ${p.n} on ${p.artboard}${ab ? ` "${ab.title}"` : ""} at (${p.x}, ${p.y}): ${p.text}`, ...replies(p.replies, "    "));
          }
          for (const n of f.notes.filter((x) => !x.resolved && x.variant === k)) out.push(`  Comment ${n.id}: ${n.text}`, ...replies(n.replies, "    "));
        }
        const done = f.pins.filter((x) => x.resolved).length + f.notes.filter((x) => x.resolved).length;
        const open = f.pins.length + f.notes.length - done;
        out.push(`${open} open note${open === 1 ? "" : "s"}, ${done} resolved.`);
        return out.join("\n");
      },
    },
    {
      name: "spill_design_reply",
      description: "Reply to a pin (pin: its number) or a comment (comment: c-n) on a spec's design. resolve: true marks it resolved once you changed the design for it, which clears it from the user's view; pass text with what changed in the same call. Only you resolve; the user cannot.",
      inputSchema: { type: "object", properties: { spec, pin: { type: "number" }, comment: str, text: str, resolve: { type: "boolean" } }, required: ["spec"] },
      run: (b, a) => d(b).reply(a),
    },
  ];
}
