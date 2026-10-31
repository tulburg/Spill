import type { SpillEvent } from "./store";

// S-30: board messages grouped into threads. A thread is named by the time of its first message.
// A user message with no thread starts one; a reply with no thread joins the latest thread, which
// is how messages written before threads existed are read.
export interface Thread {
  id: string;
  items: SpillEvent[];
  open: boolean;
}

export function threads(events: SpillEvent[]): Thread[] {
  const out: Thread[] = [];
  const byId = new Map<string, Thread>();
  for (const e of events) {
    if (e.card !== "-" || (e.action !== "message" && e.action !== "reply")) continue;
    const key = e.thread ?? (e.action === "message" ? e.at : out.at(-1)?.id);
    if (!key) continue;
    let t = byId.get(key);
    if (!t) {
      t = { id: key, items: [], open: false };
      byId.set(key, t);
      out.push(t);
    }
    t.items.push(e);
  }
  for (const t of out) t.open = t.items.at(-1)!.action === "message";
  return out;
}

// The thread a Claude reply goes to: the given one (full time or a "YYYY-MM-DD HH:MM" prefix as the
// inbox prints it), else the open thread with the newest message, else the latest thread.
export function replyTarget(all: Thread[], given?: string): Thread | undefined {
  if (given?.trim()) {
    const g = given.trim().replace(" ", "T");
    return [...all].reverse().find((t) => t.id.startsWith(g));
  }
  const open = all.filter((t) => t.open).sort((a, b) => a.items.at(-1)!.at.localeCompare(b.items.at(-1)!.at));
  return open.at(-1) ?? all.at(-1);
}
