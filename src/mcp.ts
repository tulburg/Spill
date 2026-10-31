import { Board } from "./board";
import { Store } from "./store";
import { TOOLS } from "./tools";

const VERSION = "0.1.0";

// Sent on initialize, so any model using the server learns the rules without reading .spill/SPILL.md.
export const INSTRUCTIONS = `Spill is the project's spec board. The user watches it in the Spill app and acts there while you work, so the board must always match reality.

Start of every session: call spill_inbox, then spill_board. If either starts with "Rejections waiting", work through spill_rejections first.

Rules:
- Specs before code. Draft with spill_draft_spec (Purpose, numbered testable Requirements, Out of scope, Acceptance checks) and build only after the user presses Build on it.
- Build means build. A spec moves approved -> queued when the user presses Build; start queued specs (one active spec at a time, in the order queued) without waiting to be asked. Approved alone is not a go, and only a queued spec can be set active.
- Approval can be automatic (inbox actor "auto"): with nothing else open, the last blocking question answered, every child spec done, or your "Reqs 1-n done" covering every requirement approves a spec.
- Only the user approves, builds, rejects or reverts. Never try to set approved, queued or rejected yourself.
- A spec whose design needs signing off gets a design question: spill_ask with design: true, the board link in the body, blocking the spec. Answer A approves the spec; B means rework the design and reopen the question.
- Read a card's current status (spill_get) right before you edit or move it; the user may have just approved or changed it.
- A spec with open questions cannot be approved; get them answered first.
- Questions go on the board, never only in chat: one spill_ask per question, a short title, context in the first paragraph, options as "- A. text" lines. Pass multi: true when several options can be picked. Check the board for answers before asking again.
- An answer that picks no option (free text, "none of these", "not what I meant") is a redirect, not a decision. The app reports it as an inbox line with action "redirect" and keeps the question open. Keep the same question: rewrite it with spill_update (that clears the redirect note), and comment what changed. If a free answer was recorded as a decision anyway, set the question back to open. Do not open a new question for the same thing.
- Working on a spec: spill_set_status active before writing code (one active spec at a time), comment "Req 2 done" as requirements land (this moves the card's progress bar), run the acceptance checks and record them with spill_checks (running: true, then results), then set it done and update or clear spill_focus.
- If building shows the spec is wrong or incomplete, stop, update the spec or ask a question, and set it back to discussing.
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
        const text = tool.run(new Board(store, "claude"), msg.params?.arguments ?? {});
        return reply({ content: [{ type: "text", text }] });
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
