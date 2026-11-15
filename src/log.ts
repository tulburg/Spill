// S-54: a diagnostic log per project, for flows that break. It lives under ~/.spill/logs (never in
// .spill/, so it is never committed): one JSON line per failure, from the board server, the board
// page, the MCP server or the desktop app. The app computes the same file name (src-tauri main.rs).
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Store } from "./store";

export type LogEntry = { at: string; source: "server" | "ui" | "mcp" | "app"; level: "error" | "warn" | "info"; what: string; card?: string; message: string };

export const LOG_MAX = 2 * 1024 * 1024;
const CUT = 200;

export function logDir(): string {
  return process.env.SPILL_LOG_DIR ?? join(homedir(), ".spill", "logs");
}

// FNV-1a, 32 bits, as 8 hex digits: short, and the same in the app.
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s, "utf8")) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// <project>-<hash of the project folder>.log; the hash tells apart two projects with one name.
export function logFile(store: Store): string {
  const root = dirname(store.dir);
  const name = (store.config().project || root.split("/").pop() || "spill").replace(/[^A-Za-z0-9._-]+/g, "-");
  return join(logDir(), `${name}-${fnv(root)}.log`);
}

// Long text is cut, so file contents and design HTML never land whole in the log.
export function cut(v: unknown): unknown {
  if (typeof v === "string") return v.length > CUT ? `${v.slice(0, CUT)}...` : v;
  if (Array.isArray(v)) return v.map(cut);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]));
  return v;
}

export function writeLog(store: Store, e: Omit<LogEntry, "at">): void {
  try {
    const f = logFile(store);
    mkdirSync(dirname(f), { recursive: true });
    const entry: LogEntry = { at: new Date().toISOString(), ...e, message: String(cut(e.message)) };
    if (!entry.card) delete entry.card;
    appendFileSync(f, `${JSON.stringify(entry)}\n`);
    // Past the cap, drop the oldest half.
    if (statSync(f).size > LOG_MAX) {
      const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
      writeFileSync(f, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`);
    }
  } catch {
    // Logging must never break the flow it reports on.
  }
}

export function readLog(store: Store, opts: { limit?: number; level?: string } = {}): LogEntry[] {
  const f = logFile(store);
  if (!existsSync(f)) return [];
  const all = readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as LogEntry];
      } catch {
        return [];
      }
    })
    .filter((e) => !opts.level || e.level === opts.level);
  return opts.limit ? all.slice(-opts.limit) : all;
}

export function formatLog(e: LogEntry): string {
  return `${e.at.replace("T", " ").slice(0, 19)}  ${e.level.padEnd(5)}  ${e.source.padEnd(6)}  ${e.what}${e.card ? ` ${e.card}` : ""}: ${e.message}`;
}
