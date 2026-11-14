import { Board } from "./board";
import { Store } from "./store";
import { TOOLS } from "./tools";

const VERSION = "0.1.0";

// Sent on initialize, so any model using the server learns the rules without reading .spill/SPILL.md.
export const INSTRUCTIONS = `Spill is the project's spec board. The user watches it in the Spill app and acts there while you work, so the board must always match reality.

Most important: fetch and update spec state, always. The board shows a spec as "Claude building" for as long as it is active, so a spec you are no longer building must not stay active.
- Fetch: call spill_inbox and spill_get on the spec before each step, and act on what changed (answers, reverts, approvals) before going on.
- Update: whenever you stop building an active spec, for any reason, move it in the same step: done (checks recorded), or a blocking question (spill_ask blocks S-n) when you need the user, or discussing with a comment when the spec is wrong or you are switching away.
- Before you end your turn, call spill_board and check every active spec. If you are not building it right now, update it as above. Never end a turn with a spec active and nothing being built.

Start of every session: call spill_inbox, then spill_board. If either starts with "Rejections waiting", work through spill_rejections first. An active spec you are not continuing is stale: update it first.

Rules:
- Specs before code. Draft with spill_draft_spec (Purpose, numbered testable Requirements, Out of scope, Acceptance checks) and build only after the user presses Build on it.
- Right after you set a spec active, record your todo list for the build with spill_todos, before writing code, and send the full list again as you finish each item. It drives the card's progress bar (todos on the left, requirements met on the right). Each build starts with an empty list.
- Build means build. A spec moves approved -> queued when the user presses Build; start queued specs (one active spec at a time, in the order queued) without waiting to be asked. Approved alone is not a go, and only a queued spec can be set active.
- Approval can be automatic (inbox actor "auto"): with nothing else open, the last blocking question answered, every child spec done, or your "Reqs 1-n done" covering every requirement approves a spec.
- Only the user approves, builds, rejects or reverts. Never try to set approved, queued or rejected yourself.
- Design review notes (pins and comments, from spill_design_feedback): change the design for each open note, then reply with what changed and resolve it in the same spill_design_reply call (resolve: true). Resolving clears it from the user's view; only you resolve. Leave a note open only when you need the user's answer, and reply with the question.
- A spec with designs is signed off by one design question: spill_ask with design: true, blocking that one spec, with no options in the body (the app builds them: one per variant, or "Approve this design", then "Needs changes"). A variant (or "Approve this design") approves the spec and marks it chosen; "Needs changes" means rework the design from the notes and the answer, then reopen the same question. The design viewer is only for pins and comments; there is no approval there.
- Read a card's current status (spill_get) right before you edit or move it; the user may have just approved or changed it.
- A spec with open questions cannot be approved; get them answered first.
- A question that stops work on a spec must block it (spill_ask blocks, or spill_link Q-n blocks S-n), even when the spec is active. An unlinked question floats loose on the board and the active spec keeps showing "Claude building" while nothing is built.
- depends_on makes a spec a child of the target: it is drawn under that parent, and the parent auto-approves once every child spec is done. Use it only for specs that are parts of a bigger spec. Never use it for order or prerequisites (a spike that must come first is not a child of the spec it unblocks); keep those in the same section and say the order in the body and in spill_focus.
- Questions go on the board, never only in chat: one spill_ask per question, a short title, context in the first paragraph, options as "- A. text" lines. Pass multi: true when several options can be picked. Check the board for answers before asking again.
- An answer that picks no option arrives as an inbox line with action "redirect" and the question stays open. Read what the user wrote and act on what it means: (1) an answer of their own (an alternative to the options): record it with spill_record, passing the question; (2) the question should not exist (it is already settled, wrongly framed, or not theirs to decide): set the question to dropped, comment why, and act on what they said; (3) "not what I meant" or unclear: rewrite the same question with spill_update (that clears the redirect note) and comment what changed. Never open a new question for the same thing.
- A card that should not exist (a duplicate, or a change drafted as a new spec that belongs on an existing one) is deleted only through spill_propose_delete, which asks the user first; nothing is deleted until they pick A. Never use it to undo a rejection.
- An update the user asks for on a done spec arrives as an inbox line with action "update_request"; the card shows "Update requested" until you act on it. Decide how big it is: (1) it fits the spec as written: set the spec active (no new approval needed while the request is open), build it, record checks and set it done again; (2) you need the user's input first: ask a question that blocks the spec; (3) the spec text must change: update the spec with spill_update and set it to draft, where it waits for approval again; (4) it is too big for the same spec: branch a new spec (spill_draft_spec with follows) when the done spec stays as it is, or propose replacing it (spill_propose_replace) when its code must go. Comment which one you chose.
- Record the files you touch while building a spec with spill_files (new, changed or removed); they become its Files list. A replacement proposal is a question; never remove a spec's code until the user picks A on it. Then remove the code, record the removed files, and set the old spec replaced; it stays on the board dimmed, linked to its replacement.
- Working on a spec: spill_set_status active before writing code (one active spec at a time), comment "Req 2 done" as requirements land (this moves the card's progress bar), run the acceptance checks and record them with spill_checks (running: true, then results), then set it done and update or clear spill_focus.
- If building shows the spec is wrong or incomplete, stop, update the spec or ask a question, and set it back to discussing.
- Too large? Recommend splitting it. At any point before a spec is done (drafting, discussing, approved, queued or mid-build), if it has grown too large to build and check as one piece (many requirements, several platforms or surfaces, a progress bar that barely moves), ask with spill_ask, blocking it. Name the parts you propose, each with its requirements and the existing questions and decisions it would own, and recommend the split.
- A split is a reorganization, not new branches bolted on. If the user agrees: (1) draft each part with spill_draft_spec and depends_on the original, each written as a complete spec (Purpose, Requirements, Out of scope, Acceptance checks); (2) move every existing question to the part it belongs to: spill_unlink it from the original and spill_link it to the part (its decision moves with it, since a decision hangs off its question); (3) open new questions on the part they concern; (4) rewrite the original with spill_update as the overview: what the whole is for and how the parts fit, with no requirements left that a part owns; (5) comment on the original what moved where. Then build the parts one by one (an active original goes back to discussing while its parts are built, since only one spec can be active). A done spec is never split.
- A rejected spec: revise it and move it to discussing, or, if it is superseded, draft its replacement and spill_rejections resolve it with a note saying why.
- A rejected draft whose reason describes what the user wants usually means "redraft": rewrite the same spec from the reason and move it back to discussing. Do not open a new spec for it.
- An inbox status line ending "(reverted)" means the user took the spec back to discussing: stop work on it.
- A user comment "Fix failing check: <name>" (the app's Fix button): set the spec active, fix it, run the checks again, record them, set it done.
- Other user comments on a card are feedback on that card: act on them or reply with spill_comment.
- Inbox lines with action "message" are board-level messages: answer each with spill_reply. Each line says its thread ("new thread" or "in thread of <time>"); pass that time as thread when answering an older thread. Files the user attached are listed as "[attached: path, ...]"; read them before answering.
- Keep spill_focus current: what is being discussed now and what is next.
- While you work, call spill_inbox again between steps and before asking anything, so approvals and answers are not missed.`;

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: any };

// Handle one JSON-RPC message. Returns the response, or undefined for notifications.
export function handle(store: Store, msg: Msg): object | undefined {
  const reply = (result: object) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  if (msg.id === undefined) return undefined;

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "spill", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Unknown tool ${msg.params?.name}`);
      try {
        const out = tool.run(new Board(store, "claude"), msg.params?.arguments ?? {});
        return reply(typeof out === "string" ? { content: [{ type: "text", text: out }] } : out);
      } catch (e) {
        return reply({ content: [{ type: "text", text: (e as Error).message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

// Newline-delimited JSON-RPC over stdio.
export async function serve(store: Store): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let out: object | undefined;
      try {
        out = handle(store, JSON.parse(line));
      } catch {
        out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
      }
      if (out) process.stdout.write(JSON.stringify(out) + "\n");
    }
  }
}
