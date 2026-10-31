import { Board } from "./board";
import { Store } from "./store";
import { TOOLS } from "./tools";

const VERSION = "0.1.0";

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
        instructions: "Spill is the spec board. Call spill_inbox, then spill_board, at the start of every session. Only the user approves or rejects.",
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
