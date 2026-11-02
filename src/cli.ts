#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Board } from "./board";
import { serve } from "./mcp";
import { startServer } from "./server";
import { Store, findSpillDir } from "./store";
import { event, focusLine, full, summary } from "./tools";

const USAGE = `spill: the spec board, from the terminal

  spill board                     list every card
  spill show ID                   one card in full
  spill approve S-n [note]        approve a spec
  spill build S-n                 queue an approved spec for Claude to build
  spill reject S-n reason         reject a spec
  spill revert S-n [reason]       take an approved, queued, active or done spec back to discussing
  spill answer Q-n text           answer a question (records a D-n)
  spill comment ID text           comment on a card
  spill ask "title" [body]        add a question for Claude
  spill log [n]                   last n events (default 20)
  spill focus                     what Claude is discussing now and next
  spill message text [--file p]   message Claude, not about any card, optionally with files
  spill app [port]                open the board in a Spill window (adds a window if Spill is open)
  spill serve [port]              serve the board for a browser (default 4747)
  spill mcp                       run the MCP server on stdio (for Claude)`;

const TAURI_DIR = join(import.meta.dir, "..", "src-tauri");

// Serve the board for a browser.
async function serveBoard(store: Store, port: number): Promise<void> {
  const server = await startServer(store, port);
  console.log(`Spill board for ${store.config().project || store.dir} at http://localhost:${server.port}`);
}

// S-36 (D-22): one Spill app holds every project window and serves each board itself. Hand this
// project to the running app, or start the app with it; the app picks a free port unless one is given.
async function openApp(store: Store, port?: number): Promise<void> {
  const root = dirname(store.dir);
  const name = store.config().project || root;
  const handed = await new Promise<boolean>((done) => {
    const s = createConnection(join(homedir(), ".spill", "app.sock"));
    s.on("connect", () => s.write(`open\t${root}\t${port ?? ""}\n`));
    s.on("data", () => (s.end(), done(true)));
    s.on("error", () => done(false));
  });
  if (handed) return console.log(`Opened ${name} in the running Spill app`);
  const built = join(TAURI_DIR, "target", "debug", "Spill");
  const cmd = existsSync(built) ? [built] : ["cargo", "run", "--quiet", "--manifest-path", join(TAURI_DIR, "Cargo.toml")];
  const env = { ...process.env, SPILL_OPEN: root, SPILL_BUN: process.execPath, SPILL_CLI: join(import.meta.dir, "cli.ts"), ...(port ? { SPILL_PORT: String(port) } : {}) };
  console.log(`Opening ${name} in Spill`);
  const child = Bun.spawn(cmd, { env, stdout: "inherit", stderr: "inherit" });
  process.exit(await child.exited);
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }
  const store = new Store(findSpillDir(process.cwd()));
  if (cmd === "mcp") {
    serve(store);
    return;
  }
  if (cmd === "serve" || cmd === "app") {
    const run = cmd === "app" ? openApp(store, rest[0] ? Number(rest[0]) : undefined) : serveBoard(store, Number(rest[0] ?? process.env.SPILL_PORT ?? 4747));
    run.catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
    return;
  }

  const b = new Board(store, "user");
  const need = (n: number, what: string) => {
    if (rest.length < n) throw new Error(`Usage: spill ${cmd} ${what}`);
  };
  const text = (from: number) => rest.slice(from).join(" ");

  switch (cmd) {
    case "board":
      console.log(b.board().map(summary).join("\n") || "The board is empty.");
      break;
    case "show":
      need(1, "ID");
      console.log(full(b.get(rest[0])));
      break;
    case "approve":
      need(1, "S-n [note]");
      console.log(`Approved ${summary(b.setStatus({ id: rest[0], status: "approved", note: text(1) || undefined }))}`);
      break;
    case "build":
      need(1, "S-n");
      console.log(`Queued ${summary(b.build({ id: rest[0] }))}`);
      break;
    case "reject":
      need(2, "S-n reason");
      console.log(`Rejected ${summary(b.setStatus({ id: rest[0], status: "rejected", note: text(1) }))}`);
      break;
    case "revert":
      need(1, "S-n [reason]");
      console.log(`Reverted ${summary(b.revert({ id: rest[0], reason: text(1) }))}`);
      break;
    case "answer": {
      need(2, "Q-n text");
      const q = b.get(rest[0]);
      // "A" or "A,C" picks options; anything else is a free answer.
      let letters: string[] | undefined = /^[A-Z](\s*,\s*[A-Z])*$/.test(text(1)) ? text(1).split(/\s*,\s*/) : undefined;
      if (letters && !letters.every((l) => new RegExp(`^\\s*-\\s*${l}\\.\\s`, "m").test(q.body))) letters = undefined;
      const d = letters ? b.answer({ id: q.id, picks: letters }) : b.answer({ id: q.id, text: text(1) });
      console.log(d.kind === "question" ? `Sent your answer to ${q.id}; Claude will act on it` : `Answered ${q.id} as ${summary(d)}`);
      break;
    }
    case "comment":
      need(2, "ID text");
      console.log(`Commented on ${b.comment({ id: rest[0], text: text(1) }).id}`);
      break;
    case "ask":
      need(1, '"title" [body]');
      console.log(`Created ${summary(b.ask({ title: rest[0], body: text(1) }))}`);
      break;
    case "message": {
      // S-8: `--file path` (repeatable) attaches files.
      const files: string[] = [];
      const words: string[] = [];
      for (let i = 0; i < rest.length; i++) rest[i] === "--file" && rest[i + 1] ? files.push(rest[++i]) : words.push(rest[i]);
      if (!words.length && !files.length) need(1, "text [--file path]");
      for (const f of files) if (!existsSync(f)) throw new Error(`No such file: ${f}`);
      b.message(words.join(" "), files.map((f) => store.saveAttachment(f, new Uint8Array(readFileSync(f)))));
      console.log("Sent to Claude");
      break;
    }
    case "focus":
      console.log(focusLine(b.focus()));
      break;
    case "log": {
      const n = Number(rest[0] ?? 20);
      console.log(store.events().slice(-n).map(event).join("\n") || "No events yet.");
      break;
    }
    default:
      throw new Error(`Unknown command ${cmd}\n\n${USAGE}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
