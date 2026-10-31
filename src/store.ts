import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Kind = "spec" | "question" | "decision" | "section";
// S-29: "auto" marks an approval the board made itself (D-11).
export type Actor = "user" | "claude" | "auto";

export interface Link {
  type: string;
  target: string;
}

export interface Card {
  id: string;
  kind: Kind;
  title: string;
  status: string;
  section: string | null;
  links: Link[];
  // S-24: questions only; "multi" means pick any number of the options.
  select?: "multi";
  // S-29: questions only; a design approval question. Answer A approves the spec it blocks.
  design?: true;
  // Text between the front matter and the "## Comments" heading, kept verbatim.
  body: string;
  // Text after the "## Comments" heading, kept verbatim.
  comments: string;
}

export interface SpillEvent {
  at: string;
  actor: Actor;
  action: string;
  card: string;
  detail?: string;
  // S-30: board messages only; the time of the thread's first message.
  thread?: string;
}

export const PREFIX: Record<Kind, string> = { spec: "S", question: "Q", decision: "D", section: "SEC" };
const KIND_BY_PREFIX: Record<string, Kind> = { S: "spec", Q: "question", D: "decision", SEC: "section" };

export function kindOf(id: string): Kind | undefined {
  const m = /^([A-Z]+)-(\d+)$/.exec(id);
  return m ? KIND_BY_PREFIX[m[1]] : undefined;
}

// Walk up from `start` until a directory containing `.spill/` is found.
export function findSpillDir(start: string): string {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".spill");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No .spill folder found from ${start}`);
    dir = parent;
  }
}

function parseValue(raw: string): string | null {
  const v = raw.trim();
  if (v === "null" || v === "") return null;
  if (v.startsWith('"')) return JSON.parse(v);
  return v;
}

function formatValue(v: string | null): string {
  if (v === null) return "null";
  return /^[\s"'{[]|: |#|\s$/.test(v) ? JSON.stringify(v) : v;
}

export function parseCard(text: string): Card {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("Card has no front matter");
  const fields: Record<string, string | null> = {};
  const links: Link[] = [];
  for (const line of m[1].split("\n")) {
    const link = /^\s+-\s*\{\s*type:\s*([^,]+?),\s*target:\s*([^}]+?)\s*\}\s*$/.exec(line);
    if (link) {
      links.push({ type: link[1], target: link[2] });
      continue;
    }
    const kv = /^(\w+):(.*)$/.exec(line);
    if (kv && kv[1] !== "links") fields[kv[1]] = parseValue(kv[2]);
  }
  const rest = m[2];
  const idx = rest.search(/^## Comments\s*$/m);
  const body = idx === -1 ? rest : rest.slice(0, idx);
  const comments = idx === -1 ? "" : rest.slice(idx).replace(/^## Comments[^\n]*\n?/, "");
  return {
    id: fields.id ?? "",
    kind: (fields.kind ?? "spec") as Kind,
    title: fields.title ?? "",
    status: fields.status ?? "draft",
    section: fields.section ?? null,
    links,
    ...(fields.select === "multi" ? { select: "multi" as const } : {}),
    ...(fields.design === "true" ? { design: true as const } : {}),
    body,
    comments,
  };
}

export function formatCard(c: Card): string {
  const links = c.links.length
    ? "links:\n" + c.links.map((l) => `  - { type: ${l.type}, target: ${l.target} }`).join("\n")
    : "links: []";
  const fm = [
    `id: ${c.id}`,
    `kind: ${c.kind}`,
    `title: ${formatValue(c.title)}`,
    `status: ${c.status}`,
    `section: ${formatValue(c.section)}`,
    ...(c.select ? [`select: ${c.select}`] : []),
    ...(c.design ? ["design: true"] : []),
    links,
  ].join("\n");
  let body = c.body;
  if (body && !body.endsWith("\n")) body += "\n";
  return `---\n${fm}\n---\n${body}## Comments\n${c.comments}`;
}

export interface Config {
  project: string;
  statuses: { spec: string[]; question: string[] };
  userOnlyStatuses: string[];
  maxActiveSpecs: number;
}

export interface Focus {
  discussing: string[];
  next: string[];
  note?: string;
  at: string;
}

// S-13: the latest acceptance check run for a spec, written by Claude (D-4).
export interface CheckRun {
  at: string;
  running: boolean;
  results: { name: string; pass: boolean; detail?: string }[];
}

interface State {
  highest: Record<string, number>;
  inboxCursor: number;
}

export class Store {
  readonly dir: string;
  readonly cardsDir: string;

  constructor(spillDir: string) {
    this.dir = spillDir;
    this.cardsDir = join(spillDir, "cards");
    if (!existsSync(this.cardsDir)) mkdirSync(this.cardsDir, { recursive: true });
  }

  config(): Config {
    const raw = JSON.parse(readFileSync(join(this.dir, "config.json"), "utf8"));
    const statuses = raw.statuses ?? { spec: [], question: [] };
    // S-29: boards made before queued existed get it after approved.
    if (statuses.spec.includes("approved") && !statuses.spec.includes("queued")) statuses.spec.splice(statuses.spec.indexOf("approved") + 1, 0, "queued");
    const userOnly: string[] = raw.userOnlyStatuses ?? ["approved", "rejected"];
    if (!userOnly.includes("queued")) userOnly.push("queued");
    return {
      project: raw.project ?? "",
      statuses,
      userOnlyStatuses: userOnly,
      maxActiveSpecs: raw.maxActiveSpecs ?? 1,
    };
  }

  private state(): State {
    const p = join(this.dir, "state.json");
    const s = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
    return { highest: s.highest ?? {}, inboxCursor: s.inboxCursor ?? 0 };
  }

  private saveState(s: State): void {
    writeFileSync(join(this.dir, "state.json"), JSON.stringify(s, null, 2) + "\n");
  }

  ids(): string[] {
    return readdirSync(this.cardsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((id) => kindOf(id));
  }

  all(): Card[] {
    const order = ["SEC", "S", "Q", "D"];
    return this.ids()
      .map((id) => this.get(id))
      .sort((a, b) => {
        const [pa, na] = a.id.split("-");
        const [pb, nb] = b.id.split("-");
        return order.indexOf(pa) - order.indexOf(pb) || Number(na) - Number(nb);
      });
  }

  has(id: string): boolean {
    return existsSync(join(this.cardsDir, `${id}.md`));
  }

  get(id: string): Card {
    const p = join(this.cardsDir, `${id}.md`);
    if (!existsSync(p)) throw new Error(`No card ${id}`);
    return parseCard(readFileSync(p, "utf8"));
  }

  save(card: Card): void {
    writeFileSync(join(this.cardsDir, `${card.id}.md`), formatCard(card));
  }

  // Next free ID for a kind. Never reuses a number, even if its file was removed.
  nextId(kind: Kind): string {
    const prefix = PREFIX[kind];
    const s = this.state();
    let max = s.highest[prefix] ?? 0;
    for (const id of this.ids()) {
      const [p, n] = id.split("-");
      if (p === prefix) max = Math.max(max, Number(n));
    }
    s.highest[prefix] = max + 1;
    this.saveState(s);
    return `${prefix}-${max + 1}`;
  }

  log(e: Omit<SpillEvent, "at">): void {
    const line: SpillEvent = { at: new Date().toISOString(), ...e };
    appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify(line) + "\n");
  }

  events(): SpillEvent[] {
    const p = join(this.dir, "events.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  // The spotlight: what Claude is discussing now and what comes next. Null when cleared.
  focus(): Focus | null {
    const p = join(this.dir, "focus.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  }

  saveFocus(f: Focus | null): void {
    const p = join(this.dir, "focus.json");
    if (f) writeFileSync(p, JSON.stringify(f, null, 2) + "\n");
    else if (existsSync(p)) rmSync(p);
  }

  checks(): Record<string, CheckRun> {
    const p = join(this.dir, "checks.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  }

  saveChecks(id: string, run: CheckRun): void {
    const all = this.checks();
    all[id] = run;
    writeFileSync(join(this.dir, "checks.json"), JSON.stringify(all, null, 2) + "\n");
  }

  // S-8: a file sent with a message, saved under .spill/attachments/. Returns its absolute path.
  saveAttachment(name: string, bytes: Uint8Array): string {
    const dir = join(this.dir, "attachments");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const safe = (name.split(/[\\/]/).pop() || "file").replace(/[^\w.-]+/g, "_").slice(-80);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    // Two files with the same name in one message must not overwrite each other.
    let p = join(dir, `${stamp}-${safe}`);
    for (let n = 2; existsSync(p); n++) p = join(dir, `${stamp}-${n}-${safe}`);
    writeFileSync(p, bytes);
    return p;
  }

  // S-8: where the user's latest board message stands. "received" until Claude reads it in the
  // inbox, then "working" until Claude replies or makes its next board change.
  messageState(): "received" | "working" | null {
    const all = this.events();
    const i = all.findLastIndex((e) => e.actor === "user" && e.action === "message");
    if (i < 0) return null;
    const after = all.slice(i + 1);
    const thread = all[i].thread ?? all[i].at;
    if (after.some((e) => e.actor === "claude" && e.action === "reply" && (e.thread ?? thread) === thread)) return null;
    const cursor = this.state().inboxCursor;
    if (cursor <= i) return "received";
    return all.slice(cursor).some((e) => e.actor === "claude" && e.action !== "focus" && !(e.action === "reply" && (e.thread ?? thread) !== thread)) ? null : "working";
  }

  // User and auto-approval events since the last call, then advance the cursor.
  takeInbox(): SpillEvent[] {
    const all = this.events();
    const s = this.state();
    const fresh = all.slice(s.inboxCursor).filter((e) => e.actor !== "claude");
    s.inboxCursor = all.length;
    this.saveState(s);
    return fresh;
  }
}
