import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Kind = "spec" | "question" | "decision" | "section";
export type Actor = "user" | "claude";

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
    return {
      project: raw.project ?? "",
      statuses: raw.statuses ?? { spec: [], question: [] },
      userOnlyStatuses: raw.userOnlyStatuses ?? ["approved", "rejected"],
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

  // User events since the last call, then advance the cursor.
  takeInbox(): SpillEvent[] {
    const all = this.events();
    const s = this.state();
    const fresh = all.slice(s.inboxCursor).filter((e) => e.actor === "user");
    s.inboxCursor = all.length;
    this.saveState(s);
    return fresh;
  }
}
