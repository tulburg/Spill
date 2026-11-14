// S-44: a spec's designs. Each artboard is one HTML file with inline CSS in .spill/designs/S-n/,
// listed in that folder's index.json. Every element carries a data-node id so part of an
// artboard can be read or changed without rewriting the rest. Tool names and shapes follow
// OpenDraw's MCP tools (shared/mcp, MIT).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store";

// ---- A small HTML tree: enough for inline-styled design HTML, not a full browser parser.

export interface El {
  tag: string;
  attrs: [string, string][];
  children: Node[];
}
export type Node = El | { text: string };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["style", "script", "textarea", "title"]);
const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

export function parseHtml(src: string): Node[] {
  const root: El = { tag: "#root", attrs: [], children: [] };
  const stack: El[] = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 ? src.length : end + 3;
    } else if (src.startsWith("<!", i) || src.startsWith("<?", i)) {
      const end = src.indexOf(">", i);
      i = end < 0 ? src.length : end + 1;
    } else if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i);
      const name = src.slice(i + 2, end < 0 ? src.length : end).trim().toLowerCase();
      i = end < 0 ? src.length : end + 1;
      const at = stack.map((e) => e.tag.toLowerCase()).lastIndexOf(name);
      if (at > 0) stack.length = at;
    } else if (src[i] === "<" && /[a-zA-Z]/.test(src[i + 1] ?? "")) {
      // Find the end of the tag, skipping ">" inside quoted attribute values.
      let j = i + 1;
      let quote = "";
      for (; j < src.length; j++) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
      }
      const inner = src.slice(i + 1, j);
      i = j + 1;
      const tag = /^[^\s/>]+/.exec(inner)![0];
      const selfClose = inner.trimEnd().endsWith("/");
      const attrs: [string, string][] = [];
      const rest = inner.slice(tag.length).replace(/\/\s*$/, "");
      for (const m of rest.matchAll(ATTR)) attrs.push([m[1], m[2] ?? m[3] ?? m[4] ?? ""]);
      const el: El = { tag, attrs, children: [] };
      top().children.push(el);
      const low = tag.toLowerCase();
      if (RAW.has(low)) {
        const close = src.toLowerCase().indexOf(`</${low}`, i);
        const end = close < 0 ? src.length : close;
        if (end > i) el.children.push({ text: src.slice(i, end) });
        const gt = close < 0 ? src.length : src.indexOf(">", close);
        i = gt < 0 ? src.length : gt + 1;
      } else if (!selfClose && !VOID.has(low)) stack.push(el);
    } else {
      const next = src.indexOf("<", i + 1);
      const end = next < 0 ? src.length : next;
      top().children.push({ text: src.slice(i, end) });
      i = end;
    }
  }
  return root.children;
}

const isEl = (n: Node): n is El => "tag" in n;

export function serialize(nodes: Node[]): string {
  return nodes.map(one).join("");
}

function one(n: Node): string {
  if (!isEl(n)) return n.text;
  const attrs = n.attrs.map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`).join("");
  if (VOID.has(n.tag.toLowerCase())) return `<${n.tag}${attrs}>`;
  return `<${n.tag}${attrs}>${serialize(n.children)}</${n.tag}>`;
}

function attr(el: El, name: string): string | undefined {
  return el.attrs.find(([k]) => k === name)?.[1];
}

function setAttr(el: El, name: string, value: string | null): void {
  const at = el.attrs.findIndex(([k]) => k === name);
  if (value === null) {
    if (at >= 0) el.attrs.splice(at, 1);
  } else if (at >= 0) el.attrs[at][1] = value;
  else el.attrs.push([name, value]);
}

function walk(nodes: Node[], fn: (el: El) => void): void {
  for (const n of nodes)
    if (isEl(n)) {
      fn(n);
      walk(n.children, fn);
    }
}

// ---- Inline styles.

const kebab = (k: string) => (k.startsWith("--") ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));

export function parseStyle(s: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let quote = "";
  let start = 0;
  const take = (part: string) => {
    const c = part.indexOf(":");
    if (c > 0) out.set(part.slice(0, c).trim().toLowerCase(), part.slice(c + 1).trim());
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth === 0) {
      take(s.slice(start, i));
      start = i + 1;
    }
  }
  take(s.slice(start));
  return out;
}

export function formatStyle(m: Map<string, string>): string {
  return [...m].map(([k, v]) => `${k}: ${v}`).join("; ");
}

export type Styles = Record<string, string | number | null>;

function styleValue(k: string, v: string | number): string {
  // Bare numbers are pixels, except for properties that take plain numbers.
  if (typeof v === "number" && !/^(opacity|z-index|flex|flex-grow|flex-shrink|font-weight|line-height|order)$/.test(k)) return `${v}px`;
  return String(v);
}

function applyStyles(el: El, styles: Styles): void {
  const m = parseStyle(attr(el, "style") ?? "");
  for (const [raw, v] of Object.entries(styles)) {
    const k = kebab(raw);
    if (v === null || v === "") m.delete(k);
    else m.set(k, styleValue(k, v));
  }
  setAttr(el, "style", m.size ? formatStyle(m) : null);
}

// ---- The store.

export interface Artboard {
  id: string;
  title: string;
  // "" when the spec has no variants; A, B, C when it offers several directions.
  variant: string;
  width: string;
  height: string;
  created: string;
  // S-46: "chosen" once the design question picked this variant (or approved the whole design).
  status: "waiting" | "chosen";
}

interface Index {
  next: number;
  artboards: Artboard[];
}

// S-46: review feedback, in feedback.json next to index.json. A review key is a variant letter, or ""
// for the whole design when the spec has fewer than two variants.
export interface Reply {
  by: "user" | "claude";
  text: string;
  at: string;
}
export interface Pin {
  n: number;
  artboard: string;
  x: number;
  y: number;
  text: string;
  at: string;
  replies: Reply[];
  resolved?: string;
}
export interface Note {
  id: string;
  variant: string;
  text: string;
  at: string;
  replies: Reply[];
  resolved?: string;
}
export interface Review {
  status: "accepted" | "rejected";
  reason?: string;
  at: string;
}
export interface Feedback {
  next: number;
  nextNote: number;
  pins: Pin[];
  notes: Note[];
  // S-46: earlier accept and reject records; kept, no longer shown.
  reviews: Record<string, Review>;
  // S-46: what the design question's answer chose: a variant key, or "" for the whole design.
  chosen?: { variant: string; at: string };
}

const SPEC = /^S-\d+$/;

export class Designs {
  constructor(
    private store: Store,
    private actor: "user" | "claude" = "claude",
  ) {}

  private root(): string {
    return join(this.store.dir, "designs");
  }

  private dir(spec: string): string {
    return join(this.root(), spec);
  }

  private checkSpec(spec: string): void {
    if (!SPEC.test(spec ?? "")) throw new Error(`Designs belong to a spec (S-n), not ${spec}`);
    if (!this.store.has(spec)) throw new Error(`No card ${spec}`);
  }

  private index(spec: string): Index {
    const p = join(this.dir(spec), "index.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { next: 1, artboards: [] };
  }

  private saveIndex(spec: string, ix: Index): void {
    mkdirSync(this.dir(spec), { recursive: true });
    writeFileSync(join(this.dir(spec), "index.json"), JSON.stringify(ix, null, 2) + "\n");
  }

  private file(spec: string, id: string): string {
    return join(this.dir(spec), `${id}.html`);
  }

  private load(spec: string, id: string): El {
    const nodes = parseHtml(readFileSync(this.file(spec, id), "utf8"));
    const el = nodes.find(isEl);
    if (!el) throw new Error(`Artboard ${id} is empty`);
    return el;
  }

  private write(spec: string, id: string, el: El): void {
    writeFileSync(this.file(spec, id), serialize([el]) + "\n");
  }

  private log(spec: string, detail: string, action = "design"): void {
    this.store.log({ actor: this.actor, action, card: spec, detail });
  }

  // Give every element a fresh node id, dropping any ids the HTML brought with it.
  private stamp(nodes: Node[], ix: Index): void {
    walk(nodes, (el) => {
      setAttr(el, "data-node", null);
      el.attrs.unshift(["data-node", `n-${ix.next++}`]);
    });
  }

  // Find the artboard and element holding a node id (an artboard id finds its root element).
  private locate(spec: string, nodeId: string): { board: Artboard; root: El; el: El; parent: El | null } {
    for (const board of this.index(spec).artboards) {
      const root = this.load(spec, board.id);
      if (nodeId === board.id) return { board, root, el: root, parent: null };
      let found: { el: El; parent: El } | null = null;
      const search = (p: El) => {
        for (const c of p.children) {
          if (found || !isEl(c)) continue;
          if (attr(c, "data-node") === nodeId) found = { el: c, parent: p };
          else search(c);
        }
      };
      search(root);
      if (found) return { board, root, ...(found as { el: El; parent: El }) };
    }
    throw new Error(`No node ${nodeId} in ${spec}'s designs`);
  }

  // S-46: an artboard is "chosen" when the design question's answer picked its variant (or the whole design).
  private reviewed(spec: string): Artboard[] {
    const boards = this.index(spec).artboards;
    const fb = this.feedbackOf(spec);
    const keys = variantKeys(boards);
    return boards.map((a) => ({ ...a, status: fb.chosen && fb.chosen.variant === keyOf(a, keys) ? "chosen" : "waiting" }));
  }

  // S-46: the options of a spec's design question: one per variant, or approve the whole design.
  signOffOptions(spec: string): { key: string; text: string }[] {
    this.checkSpec(spec);
    const boards = this.index(spec).artboards;
    if (!boards.length) throw new Error(`${spec} has no designs yet; draw them before asking for sign-off`);
    const keys = variantKeys(boards);
    if (!keys.length) return [{ key: "", text: "Approve this design" }];
    return keys.map((k) => {
      const first = boards.find((b) => b.variant === k);
      return { key: k, text: `Variant ${k}${first ? `: ${first.title}` : ""}` };
    });
  }

  // S-46: the design question was answered with a variant (or "Approve this design").
  choose(spec: string, variant: string): void {
    if (this.actor !== "user") throw new Error("Only the user signs off a design");
    const key = this.checkKey(spec, variant);
    const fb = this.feedbackOf(spec);
    fb.chosen = { variant: key, at: new Date().toISOString() };
    this.saveFeedback(spec, fb);
  }

  list(spec?: string): { spec: string; artboards: Artboard[] }[] {
    if (spec) {
      this.checkSpec(spec);
      return [{ spec, artboards: this.reviewed(spec) }];
    }
    if (!existsSync(this.root())) return [];
    return readdirSync(this.root())
      .filter((d) => SPEC.test(d))
      .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
      .map((d) => ({ spec: d, artboards: this.reviewed(d) }))
      .filter((x) => x.artboards.length);
  }

  createArtboard(a: { spec: string; title: string; variant?: string; styles: Styles }): Artboard {
    this.checkSpec(a.spec);
    if (!a.styles?.width || !a.styles?.height) throw new Error("styles needs width and height");
    const ix = this.index(a.spec);
    const id = `ab-${ix.next++}`;
    const el: El = { tag: "div", attrs: [["data-node", id]], children: [] };
    applyStyles(el, a.styles);
    const m = parseStyle(attr(el, "style") ?? "");
    const board: Artboard = {
      id,
      title: a.title || "Artboard",
      variant: (a.variant ?? "").trim().toUpperCase(),
      width: m.get("width")!,
      height: m.get("height")!,
      created: new Date().toISOString(),
      status: "waiting",
    };
    ix.artboards.push(board);
    this.saveIndex(a.spec, ix);
    this.write(a.spec, id, el);
    this.log(a.spec, `created artboard ${id} "${board.title}"${board.variant ? ` (variant ${board.variant})` : ""}`);
    return board;
  }

  // insert-children appends the HTML inside target; replace swaps target for it. Returns the new top-level node ids.
  writeHtml(a: { spec: string; html: string; target: string; mode: "insert-children" | "replace" }): string[] {
    this.checkSpec(a.spec);
    if (a.mode !== "insert-children" && a.mode !== "replace") throw new Error('mode is "insert-children" or "replace"');
    const ix = this.index(a.spec);
    const nodes = parseHtml(a.html ?? "");
    if (!nodes.some(isEl)) throw new Error("html has no elements");
    this.stamp(nodes, ix);
    const { board, root, el, parent } = this.locate(a.spec, a.target);
    if (a.mode === "insert-children") el.children.push(...nodes);
    else {
      if (!parent) throw new Error(`${a.target} is an artboard; replace its children with insert-children after deleting them`);
      parent.children.splice(parent.children.indexOf(el), 1, ...nodes);
    }
    this.saveIndex(a.spec, ix);
    this.write(a.spec, board.id, root);
    const ids = nodes.filter(isEl).map((n) => attr(n, "data-node")!);
    this.log(a.spec, `${a.mode === "replace" ? `replaced ${a.target} with` : `added to ${a.target}:`} ${ids.join(", ")}`);
    return ids;
  }

  read(a: { spec: string; node: string }): string {
    this.checkSpec(a.spec);
    return serialize([this.locate(a.spec, a.node).el]);
  }

  updateStyles(a: { spec: string; updates: { nodeIds: string[]; styles: Styles }[] }): string[] {
    this.checkSpec(a.spec);
    const changed: string[] = [];
    for (const u of a.updates ?? []) {
      for (const id of u.nodeIds ?? []) {
        const { board, root, el, parent } = this.locate(a.spec, id);
        applyStyles(el, u.styles ?? {});
        if (!parent) {
          // An artboard's size lives in the index too.
          const m = parseStyle(attr(el, "style") ?? "");
          const ix = this.index(a.spec);
          const b = ix.artboards.find((x) => x.id === board.id)!;
          b.width = m.get("width") ?? b.width;
          b.height = m.get("height") ?? b.height;
          this.saveIndex(a.spec, ix);
        }
        this.write(a.spec, board.id, root);
        changed.push(id);
      }
    }
    this.log(a.spec, `styled ${changed.join(", ")}`);
    return changed;
  }

  // Copies nodes with fresh ids, after the original or appended into parentId. An artboard copy is a
  // new artboard (in variant, if given). Returns the new ids in order.
  duplicate(a: { spec: string; nodes: { id: string; parentId?: string; variant?: string; title?: string }[] }): string[] {
    this.checkSpec(a.spec);
    const out: string[] = [];
    for (const n of a.nodes ?? []) {
      const src = this.locate(a.spec, n.id);
      const copy: El = structuredClone(src.el);
      const ix = this.index(a.spec);
      if (!src.parent) {
        const id = `ab-${ix.next++}`;
        this.stamp(copy.children, ix);
        setAttr(copy, "data-node", id);
        ix.artboards.push({
          ...src.board,
          id,
          title: n.title || `${src.board.title} copy`,
          variant: (n.variant ?? src.board.variant).trim().toUpperCase(),
          created: new Date().toISOString(),
          status: "waiting",
        });
        this.saveIndex(a.spec, ix);
        this.write(a.spec, id, copy);
        out.push(id);
        continue;
      }
      this.stamp([copy], ix);
      this.saveIndex(a.spec, ix);
      if (n.parentId) {
        const dest = this.locate(a.spec, n.parentId);
        dest.el.children.push(copy);
        this.write(a.spec, dest.board.id, dest.root);
      } else {
        src.parent.children.splice(src.parent.children.indexOf(src.el) + 1, 0, copy);
        this.write(a.spec, src.board.id, src.root);
      }
      out.push(attr(copy, "data-node")!);
    }
    this.log(a.spec, `duplicated ${a.nodes.map((n) => n.id).join(", ")} as ${out.join(", ")}`);
    return out;
  }

  // Deletes nodes and everything in them; an artboard id deletes the artboard.
  delete(a: { spec: string; nodeIds: string[] }): string[] {
    this.checkSpec(a.spec);
    for (const id of a.nodeIds ?? []) {
      const { board, root, el, parent } = this.locate(a.spec, id);
      if (!parent) {
        const ix = this.index(a.spec);
        ix.artboards = ix.artboards.filter((b) => b.id !== board.id);
        this.saveIndex(a.spec, ix);
        rmSync(this.file(a.spec, board.id), { force: true });
      } else {
        parent.children.splice(parent.children.indexOf(el), 1);
        this.write(a.spec, board.id, root);
      }
    }
    this.log(a.spec, `deleted ${a.nodeIds.join(", ")}`);
    return a.nodeIds;
  }

  // A full HTML page of the artboard holding a node, for rendering. The renderer crops to the node.
  page(a: { spec: string; node: string }): { html: string; width: number; height: number } {
    this.checkSpec(a.spec);
    const { board, root } = this.locate(a.spec, a.node);
    const px = (v: string) => Math.max(1, Math.round(parseFloat(v) || 0));
    return {
      html: `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}body>*{box-sizing:border-box}</style></head><body>${serialize([root])}</body></html>`,
      width: px(board.width),
      height: px(board.height),
    };
  }

  // ---- S-46: review feedback.

  private feedbackOf(spec: string): Feedback {
    const p = join(this.dir(spec), "feedback.json");
    const f = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
    return { next: f.next ?? 1, nextNote: f.nextNote ?? 1, pins: f.pins ?? [], notes: f.notes ?? [], reviews: f.reviews ?? {}, ...(f.chosen ? { chosen: f.chosen } : {}) };
  }

  private saveFeedback(spec: string, fb: Feedback): void {
    mkdirSync(this.dir(spec), { recursive: true });
    writeFileSync(join(this.dir(spec), "feedback.json"), JSON.stringify(fb, null, 2) + "\n");
  }

  private checkKey(spec: string, variant: string | undefined): string {
    const keys = variantKeys(this.index(spec).artboards);
    const v = (variant ?? "").trim().toUpperCase();
    if (!keys.length) return "";
    if (!keys.includes(v)) throw new Error(`${spec} offers variants ${keys.join(", ")}; name one of them`);
    return v;
  }

  private where(spec: string, key: string): string {
    return key ? `${spec} variant ${key}` : `${spec}'s design`;
  }

  // Everything said about a spec's designs, with each pin's review key.
  feedback(spec: string): Feedback & { keys: string[]; artboards: Artboard[]; pinKey: Record<number, string> } {
    this.checkSpec(spec);
    const fb = this.feedbackOf(spec);
    const artboards = this.reviewed(spec);
    const keys = variantKeys(artboards);
    const pinKey: Record<number, string> = {};
    for (const p of fb.pins) {
      const a = artboards.find((x) => x.id === p.artboard);
      pinKey[p.n] = a ? keyOf(a, keys) : "";
    }
    return { ...fb, keys, artboards, pinKey };
  }

  // True while a spec has designs and its design question has not chosen one.
  awaitingReview(spec: string): boolean {
    if (!SPEC.test(spec) || !existsSync(join(this.dir(spec), "index.json"))) return false;
    return this.index(spec).artboards.length > 0 && !this.feedbackOf(spec).chosen;
  }

  pin(a: { spec: string; artboard: string; x: number; y: number; text: string }): Pin {
    this.checkSpec(a.spec);
    const text = (a.text ?? "").trim();
    if (!text) throw new Error("A pin needs a note");
    const board = this.index(a.spec).artboards.find((b) => b.id === a.artboard);
    if (!board) throw new Error(`No artboard ${a.artboard} in ${a.spec}`);
    const x = Math.round(Number(a.x));
    const y = Math.round(Number(a.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("A pin needs x and y");
    const fb = this.feedbackOf(a.spec);
    const pin: Pin = { n: fb.next++, artboard: board.id, x, y, text, at: new Date().toISOString(), replies: [] };
    fb.pins.push(pin);
    this.saveFeedback(a.spec, fb);
    const key = keyOf(board, variantKeys(this.index(a.spec).artboards));
    this.log(a.spec, `${key ? `variant ${key}, ` : ""}pin ${pin.n} on ${board.id} "${board.title}" at (${x}, ${y}): ${text}`, "design_pin");
    return pin;
  }

  note(a: { spec: string; variant?: string; text: string }): Note {
    this.checkSpec(a.spec);
    const text = (a.text ?? "").trim();
    if (!text) throw new Error("Comment text is required");
    const key = this.checkKey(a.spec, a.variant);
    const fb = this.feedbackOf(a.spec);
    const n: Note = { id: `c-${fb.nextNote++}`, variant: key, text, at: new Date().toISOString(), replies: [] };
    fb.notes.push(n);
    this.saveFeedback(a.spec, fb);
    this.log(a.spec, `${key ? `variant ${key}, ` : ""}comment ${n.id}: ${text}`, "design_comment");
    return n;
  }

  // A reply on a pin (by number) or a comment (c-n); resolve marks either one resolved, which
  // clears it from the review UI (S-46 reqs 5, 8). Only Claude resolves.
  reply(a: { spec: string; pin?: number; comment?: string; text?: string; resolve?: boolean }): string {
    this.checkSpec(a.spec);
    if (a.resolve && this.actor !== "claude") throw new Error("Only Claude resolves review notes");
    const text = (a.text ?? "").trim();
    const fb = this.feedbackOf(a.spec);
    const at = new Date().toISOString();
    if (a.pin !== undefined && a.pin !== null) {
      const p = fb.pins.find((x) => x.n === Number(a.pin));
      if (!p) throw new Error(`No pin ${a.pin} on ${a.spec}`);
      if (!text && !a.resolve) throw new Error("Reply text is required");
      if (text) p.replies.push({ by: this.actor, text, at });
      if (a.resolve) p.resolved = at;
      this.saveFeedback(a.spec, fb);
      const done = [text ? "replied to" : "", a.resolve ? "resolved" : ""].filter(Boolean).join(" and ");
      this.log(a.spec, `${done} pin ${p.n}${text ? `: ${text}` : ""}`);
      return `${done[0].toUpperCase()}${done.slice(1)} pin ${p.n}`;
    }
    if (a.comment) {
      const n = fb.notes.find((x) => x.id === a.comment);
      if (!n) throw new Error(`No comment ${a.comment} on ${a.spec}`);
      if (!text && !a.resolve) throw new Error("Reply text is required");
      if (text) n.replies.push({ by: this.actor, text, at });
      if (a.resolve) n.resolved = at;
      this.saveFeedback(a.spec, fb);
      const done = [text ? "replied to" : "", a.resolve ? "resolved" : ""].filter(Boolean).join(" and ");
      this.log(a.spec, `${done} comment ${n.id}${text ? `: ${text}` : ""}`);
      return `${done[0].toUpperCase()}${done.slice(1)} comment ${n.id}`;
    }
    throw new Error("Name a pin (number) or a comment (c-n)");
  }

  // ---- S-47: approved snapshots, in .spill/versions/designs/.

  private snapDir(): string {
    return join(this.store.dir, "versions", "designs");
  }

  // Called when a spec is approved: copies its designs, statuses, pins and comments. seq is the
  // approval's index in the event log, so the snapshot belongs to the version current at that point.
  snapshot(spec: string, seq: number): string | null {
    if (!SPEC.test(spec) || !existsSync(join(this.dir(spec), "index.json"))) return null;
    const boards = this.reviewed(spec);
    if (!boards.length) return null;
    const fb = this.feedbackOf(spec);
    const snap: Snapshot = {
      artboards: boards.map((a) => {
        const f = this.file(spec, a.id);
        const html = existsSync(f) ? readFileSync(f, "utf8") : "";
        return { ...a, html, h: htmlHash(html) };
      }),
      feedback: { pins: fb.pins, notes: fb.notes, reviews: fb.reviews, chosen: fb.chosen },
    };
    const body = JSON.stringify(snap);
    const hash = Bun.hash(body).toString(36);
    mkdirSync(join(this.snapDir(), "blobs"), { recursive: true });
    const blob = join(this.snapDir(), "blobs", `${hash}.json`);
    if (!existsSync(blob)) writeFileSync(blob, body);
    const ref: SnapshotRef = { at: new Date().toISOString(), seq, hash };
    writeFileSync(join(this.snapDir(), `${spec}.jsonl`), (existsSync(join(this.snapDir(), `${spec}.jsonl`)) ? readFileSync(join(this.snapDir(), `${spec}.jsonl`), "utf8") : "") + JSON.stringify(ref) + "\n");
    return hash;
  }

  snapshots(spec: string): SnapshotRef[] {
    const p = join(this.snapDir(), `${spec}.jsonl`);
    if (!SPEC.test(spec) || !existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  readSnapshot(hash: string): Snapshot | null {
    if (!/^[0-9a-z]+$/.test(hash)) return null;
    const p = join(this.snapDir(), "blobs", `${hash}.json`);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  }

  // The current hash of each artboard's HTML, to tell which ones changed since a snapshot.
  htmlHashes(spec: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const a of this.index(spec).artboards) {
      const f = this.file(spec, a.id);
      out[a.id] = existsSync(f) ? htmlHash(readFileSync(f, "utf8")) : "";
    }
    return out;
  }
}

// S-47: a spec's designs as they were when it was approved, stored once per distinct state.
export interface Snapshot {
  artboards: (Artboard & { html: string; h: string })[];
  feedback: { pins: Pin[]; notes: Note[]; reviews: Record<string, Review>; chosen?: { variant: string; at: string } };
}
export interface SnapshotRef {
  at: string;
  seq: number;
  hash: string;
}

// S-46: variants count only when a spec offers two or more; otherwise reviews are for the whole design.
function variantKeys(boards: Artboard[]): string[] {
  const vs = [...new Set(boards.map((b) => b.variant))].filter(Boolean).sort();
  return vs.length >= 2 ? vs : [];
}
function keyOf(a: Artboard, keys: string[]): string {
  return keys.includes(a.variant) ? a.variant : "";
}
function htmlHash(html: string): string {
  return Bun.hash(html.trim()).toString(36);
}
