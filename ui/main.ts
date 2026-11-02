import { lineDiff } from "../src/diff";
import type { Card, CheckRun, Focus, SpillEvent, Version } from "../src/store";
import { type Thread, threads } from "../src/threads";
import { pendingUpdate } from "../src/updates";

interface BoardData {
  project: string;
  cards: Card[];
  focus: Focus | null;
  rejections: { id: string; reason: string; at: string }[];
  events: SpillEvent[];
  checks: Record<string, CheckRun>;
  messageState?: "received" | "working" | null;
  // S-30: every board message, older than the event window too.
  messages?: SpillEvent[];
  root?: string;
  // S-34: versions of every spec whose text has changed, oldest first.
  versions?: Record<string, (Version & { approved: boolean })[]>;
  // S-35: the files Claude recorded building each spec.
  files?: Record<string, { path: string; change: "new" | "changed" | "removed" }[]>;
}

interface Node {
  card: Card;
  depth: number;
  children: Node[];
}

// ---------- tiny DOM helper ----------

type Child = Node_ | string | null | undefined | false;
type Node_ = HTMLElement | SVGElement;
function h(tag: string, attrs: Record<string, any> = {}, ...kids: (Child | Child[])[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return el;
}
function svg(markup: string): SVGElement {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as SVGElement;
}

const ICON = {
  approved: `<svg width="16" height="16" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.5" fill="#16A34A"/><path d="M4.3 7.2l1.8 1.8 3.6-3.8" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  active: `<svg width="16" height="16" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke="#18181B" stroke-width="1.5"/><path d="M7 2.5a4.5 4.5 0 0 1 0 9z" fill="#18181B"/></svg>`,
  draft: `<svg width="16" height="16" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke="#A1A1AA" stroke-width="1.4" stroke-dasharray="2.2 2"/></svg>`,
  discussing: `<svg width="16" height="16" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke="#D97706" stroke-width="1.4"/><path d="M7 7V1a6 6 0 0 1 6 6z" fill="#D97706"/></svg>`,
  rejected: `<svg width="16" height="16" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke="#A1A1AA" stroke-width="1.4"/><path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" stroke="#A1A1AA" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  replaced: `<svg width="16" height="16" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke="#A1A1AA" stroke-width="1.4"/><path d="M4 7h6" stroke="#A1A1AA" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  done: `<svg width="16" height="16" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.5" fill="#A1A1AA"/><path d="M4.3 7.2l1.8 1.8 3.6-3.8" fill="none" stroke="#FAFAFA" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  question: `<svg width="16" height="16" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke="#D97706" stroke-width="1.4"/><path d="M5.4 5.4a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.5-.7 1v.3" fill="none" stroke="#D97706" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="10.2" r=".8" fill="#D97706"/></svg>`,
  questionDone: `<svg width="16" height="16" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke="#A1A1AA" stroke-width="1.4"/><path d="M4.5 7.2l1.7 1.7 3.3-3.4" fill="none" stroke="#A1A1AA" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  seal: `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1l1.6 1.3 2-.2.6 2 1.7 1.1-.7 1.9.7 1.9-1.7 1.1-.6 2-2-.2L7 13l-1.6-1.3-2 .2-.6-2-1.7-1.1.7-1.9-.7-1.9 1.7-1.1.6-2 2 .2z" fill="#0D9488"/><path d="M4.6 7.1l1.6 1.6 3.2-3.3" fill="none" stroke="#FFF" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  lock: `<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2.5" y="5" width="7" height="5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 5V3.8a2 2 0 0 1 4 0V5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`,
  chev: `<svg class="chev" width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const SECTION_COLORS = ["#8B5CF6", "#3B82F6", "#F97316", "#14B8A6", "#EC4899", "#84CC16"];
const SPEC_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  discussing: "Needs your approval",
  approved: "Approved",
  queued: "Queued",
  active: "Claude building",
  rejected: "Rejected",
  done: "Done",
  replaced: "Replaced",
};

// ---------- data helpers ----------

let data: BoardData = { project: "", cards: [], focus: null, rejections: [], events: [], checks: {} };
const byId = new Map<string, Card>();

const num = (id: string) => Number(id.split("-")[1]);
const linksOf = (c: Card, type: string) => c.links.filter((l) => l.type === type).map((l) => l.target);

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function firstEvent(id: string) {
  return data.events.find((e) => e.card === id);
}

// S-1 req 3: a new card keeps its "New" pill until the user opens or hovers it.
const seenNew: Set<string> = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem("spill.seenNew") ?? "[]"));
  } catch {
    return new Set();
  }
})();
function markSeen(id: string) {
  if (seenNew.has(id)) return false;
  seenNew.add(id);
  try {
    localStorage.setItem("spill.seenNew", JSON.stringify([...seenNew]));
  } catch {}
  return true;
}
function isNew(c: Card): boolean {
  const e = firstEvent(c.id);
  return !!e && e.actor === "claude" && Date.now() - new Date(e.at).getTime() < 30 * 60 * 1000 && !seenNew.has(c.id);
}

// The first paragraph of the Purpose section, or of the body.
function whyLine(c: Card): string {
  const purpose = /##\s*Purpose\s*\n+([\s\S]*?)(\n\s*\n|\n##|$)/.exec(c.body);
  const text = purpose ? purpose[1] : c.body.replace(/^##.*$/gm, "");
  return text.trim().split("\n")[0]?.trim() ?? "";
}

function options(c: Card): { letter: string; text: string }[] {
  return [...c.body.matchAll(/^\s*-\s*([A-Z])\.\s+(.+)$/gm)].map((m) => ({ letter: m[1], text: m[2] }));
}

function requirementsCount(c: Card): number {
  const m = /##\s*Requirements\s*\n([\s\S]*?)(\n##(?!#)|$)/.exec(c.body);
  return m ? (m[1].match(/^\d+\./gm) ?? []).length : 0;
}

// ---------- building (S-2) ----------

// Requirements Claude has checked off in comments: "Req 2 done", "Reqs 1, 3 and 4 done", "Reqs 1-3 done".
function progress(c: Card): { done: number; total: number } {
  const total = requirementsCount(c);
  const done = new Set<number>();
  for (const line of c.comments.split("\n")) {
    if (!line.startsWith("- Claude")) continue;
    for (const m of line.matchAll(/\bReq(?:uirement)?s?\s+((?:\d+(?:\s*-\s*\d+)?(?:\s*,\s*|\s+and\s+)?)+)\s+done/gi))
      for (const part of m[1].match(/\d+(?:\s*-\s*\d+)?/g) ?? []) {
        // "1-3" is a range.
        const [a, b = a] = part.split("-").map((x) => +x.trim());
        for (let n = a; n <= b; n++) if (n >= 1 && n <= total) done.add(n);
      }
  }
  return { done: done.size, total };
}

function activeSince(c: Card): string | undefined {
  return [...data.events].reverse().find((e) => e.card === c.id && e.action === "status" && /-> active/.test(e.detail ?? ""))?.at;
}

// The latest thing Claude did on the card, as one line.
function latestAction(c: Card): string | null {
  const e = [...data.events].reverse().find((e) => e.card === c.id && e.actor === "claude" && e.action !== "status" && e.action !== "focus");
  if (!e) return null;
  const verb: Record<string, string> = { comment: "Commented", update: "Updated", link: "Linked", draft_spec: "Drafted", record: "Recorded" };
  return `${verb[e.action] ?? e.action}: ${e.detail ?? ""}`;
}

function elapsed(at: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 1000));
  const hms = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0"));
  return s >= 3600 ? hms.join(":") : hms.slice(1).join(":");
}
setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>("[data-since]")) el.textContent = elapsed(el.dataset.since!);
}, 1000);

// Redraws rebuild every card; a negative delay keeps looping animations in phase instead of restarting.
function phase(ms: number): string {
  return `animation-delay:-${(Date.now() % ms) / 1000}s`;
}

const SPINNER = `<svg class="spin" width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="#E4E4E7" stroke-width="2"/><path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" fill="none" stroke="#18181B" stroke-width="2" stroke-linecap="round"/></svg>`;

function progressBar(c: Card, compact = false): HTMLElement | null {
  const p = progress(c);
  if (!p.total) return null;
  const bar = h("div", { class: "bar" }, h("i", { style: `width:${Math.round((p.done / p.total) * 100)}%;--d:-${(Date.now() % 2000) / 1000}s` }));
  if (compact) return h("div", { class: "prog compact" }, bar, h("span", { class: "n" }, `${p.done}/${p.total}`));
  return h("div", { class: "prog" }, h("div", { class: "row" }, h("span", {}, "Progress"), h("span", { class: "sp" }), h("span", { class: "n" }, `${p.done} of ${p.total}`)), bar);
}

const seenLatest = new Map<string, string>();
function latestLine(c: Card): HTMLElement | null {
  const text = latestAction(c);
  if (!text) return null;
  const fresh = seenLatest.has(c.id) && seenLatest.get(c.id) !== text;
  seenLatest.set(c.id, text);
  return h("div", { class: `latest${fresh ? " fresh" : ""}`, title: text }, text);
}

// A spec that just went from active to done shows a check in the panel for a moment.
let prevActive = new Set<string>();
let justDone: { id: string; until: number } | null = null;
// S-4: specs approved while the app is open get one certifying sweep.
let prevApproved: Set<string> | null = null;
const certified = new Map<string, number>();
function trackApproved() {
  const now = new Set(data.cards.filter((c) => c.kind === "spec" && c.status === "approved").map((c) => c.id));
  if (prevApproved)
    for (const id of now)
      if (!prevApproved.has(id)) {
        certified.set(id, Date.now());
        setTimeout(render, 1450);
      }
  prevApproved = now;
}
function certifying(id: string): boolean {
  return Date.now() - (certified.get(id) ?? 0) < 1400;
}

function trackDone() {
  const now = new Set(data.cards.filter((c) => c.kind === "spec" && c.status === "active").map((c) => c.id));
  for (const id of prevActive) if (!now.has(id) && byId.get(id)?.status === "done") {
    justDone = { id, until: Date.now() + 1500 };
    setTimeout(render, 1550);
  }
  prevActive = now;
  if (justDone && Date.now() > justDone.until) justDone = null;
}

function buildingGroup(): HTMLElement | null {
  const c = data.cards.find((x) => x.kind === "spec" && x.status === "active");
  if (justDone && !c)
    return h(
      "div",
      { class: "group" },
      h("div", { class: "hd" }, h("b", { class: "build" }, "Building")),
      h("div", { class: "item build done-check", onclick: () => panTo(justDone!.id) }, svg(ICON.approved), h("span", { class: "id" }, justDone.id), h("span", { class: "t" }, "Shipped")),
    );
  if (!c) return null;
  const since = activeSince(c);
  const held = stalledOn(c);
  const quiet = quietFor(c);
  if (quiet)
    return h(
      "div",
      { class: "group" },
      h("div", { class: "hd" }, h("b", { class: "quiet" }, "No update from Claude")),
      h("div", { class: "item build quiet", onclick: () => panTo(c.id) }, h("div", { class: "top" }, h("span", { class: "id" }, c.id), h("span", { class: "t" }, c.title)), h("div", { class: "why" }, `Still active, but Claude has not updated the board in ${quietLabel(quiet).replace("No update in ", "")}. Its session may have stopped.`)),
    );
  if (held.length)
    return h(
      "div",
      { class: "group" },
      h("div", { class: "hd" }, h("b", { class: "waiting" }, "Waiting on you")),
      h("div", { class: "item build held", onclick: () => panTo(held[0].id) }, h("div", { class: "top" }, h("span", { class: "id" }, c.id), h("span", { class: "t" }, c.title)), h("div", { class: "why" }, `${waitingLabel(held)} before building can go on`)),
    );
  return h(
    "div",
    { class: "group" },
    h("div", { class: "hd" }, h("b", { class: "build" }, svg(SPINNER), "Building"), since ? h("span", { class: "timer", "data-since": since }, elapsed(since)) : null),
    h(
      "div",
      { class: "item build", style: `--d:-${(Date.now() % 2000) / 1000}s`, onclick: () => panTo(c.id) },
      h("div", { class: "top" }, h("span", { class: "id" }, c.id), h("span", { class: "t" }, c.title)),
      progressBar(c, true),
    ),
  );
}

function hasChecks(c: Card): boolean {
  return /##\s*Acceptance checks/.test(c.body);
}

function isOpen(c: Card | undefined): boolean {
  if (!c) return false;
  if (c.kind === "question") return c.status === "open";
  if (c.kind === "spec") return !["approved", "queued", "active", "done", "replaced"].includes(c.status);
  return false;
}

// Cards this card waits on (S-14): open blockers only.
function waitsOn(c: Card): Card[] {
  return linksOf(c, "blocked_by")
    .map((id) => byId.get(id))
    .filter((b): b is Card => isOpen(b));
}

// An active spec held by open questions is not being built: Claude is waiting on the user.
function stalledOn(c: Card): Card[] {
  return c.kind === "spec" && c.status === "active" ? waitsOn(c).filter((q) => q.kind === "question") : [];
}
const waitingLabel = (qs: Card[]) => `Waiting on ${qs.map((q) => q.id).join(", ")}`;

// An active spec Claude has not touched the board about for a while has probably stopped: the
// session ended or moved on without updating it. Shown as quiet rather than building.
const QUIET_MIN = 20;
function quietFor(c: Card): number {
  if (c.kind !== "spec" || c.status !== "active" || stalledOn(c).length) return 0;
  const last = [activeSince(c), data.events.findLast((e) => e.actor === "claude")?.at].filter(Boolean).sort().at(-1);
  if (!last) return 0;
  const mins = Math.floor((Date.now() - Date.parse(last)) / 60000);
  return mins >= QUIET_MIN ? mins : 0;
}
const quietLabel = (mins: number) => `No update in ${mins >= 60 ? `${Math.floor(mins / 60)}h` : `${mins}m`}`;
// Quiet is time-based, so redraw now and then while a spec is active.
setInterval(() => {
  if (!data.cards.some((x) => x.kind === "spec" && x.status === "active")) return;
  if (mouseDown) renderPending = true;
  else render();
}, 60000);

function blocksOpen(c: Card): Card[] {
  return data.cards.filter((o) => waitsOn(o).some((b) => b.id === c.id));
}

function needsYou(c: Card): boolean {
  return (c.kind === "question" && c.status === "open" && redirectNote(c) === null) || (c.kind === "spec" && c.status === "discussing") || (c.kind === "spec" && waitsOn(c).some((q) => q.kind === "question" && redirectNote(q) === null)) || failingChecks(c).length > 0;
}

// S-13: failing checks from the spec's latest finished run.
function failingChecks(c: Card) {
  const run = data.checks?.[c.id];
  return c.kind === "spec" && run && !run.running ? run.results.filter((r) => !r.pass) : [];
}

// Specs a decision changed (S-12): specs blocked by the question it answers, and specs depending on it.
function changedBy(d: Card): string[] {
  const out = new Set<string>();
  for (const q of linksOf(d, "answers")) {
    const qc = byId.get(q);
    if (qc) for (const s of linksOf(qc, "blocks")) out.add(s);
  }
  for (const c of data.cards) if (linksOf(c, "depends_on").includes(d.id)) out.add(c.id);
  return [...out];
}

// Hierarchy (S-17 requirement 3).
function parentOf(c: Card): string | undefined {
  const pick = (type: string, kind: string) => linksOf(c, type).find((id) => byId.get(id)?.kind === kind);
  if (c.kind === "question") return pick("blocks", "spec");
  if (c.kind === "decision") return pick("answers", "question");
  if (c.kind === "spec") return pick("depends_on", "spec");
  return undefined;
}

function buildTree(): Node[] {
  const kids = new Map<string, Card[]>();
  const roots: Card[] = [];
  for (const c of data.cards) {
    if (c.kind === "section") continue;
    const p = parentOf(c);
    if (p && byId.has(p) && p !== c.id) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p)!.push(c);
    } else if (c.kind === "spec") roots.push(c);
    else roots.push(c);
  }
  const order = (a: Card, b: Card) => {
    const rank = (c: Card) => ({ question: 0, decision: 1, spec: 2, section: 3 })[c.kind];
    return rank(a) - rank(b) || num(a.id) - num(b.id);
  };
  const seen = new Set<string>();
  const make = (c: Card, depth: number): Node => {
    seen.add(c.id);
    const children = (kids.get(c.id) ?? []).filter((k) => !seen.has(k.id)).sort(order).map((k) => make(k, depth + 1));
    return { card: c, depth, children };
  };
  // S-35: a branched spec is drawn right after the done spec it follows.
  const sorted = roots.sort(order);
  const followed = (c: Card) => linksOf(c, "follows").find((id) => sorted.some((r) => r.id === id));
  const placed = sorted.filter((c) => !followed(c));
  for (const c of sorted.filter((c) => followed(c))) {
    let i = placed.findIndex((r) => r.id === followed(c));
    while (i + 1 < placed.length && followed(placed[i + 1]) === followed(c)) i++;
    placed.splice(i + 1, 0, c);
  }
  return placed.map((c) => make(c, 0));
}

// ---------- actions ----------

async function post(path: string, body: object): Promise<string | undefined> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) return (await r.json()).error ?? "Something went wrong";
}

// ---------- focus (S-12, S-14) ----------

function focus(ids: string[], src?: HTMLElement) {
  const canvas = document.getElementById("canvas")!;
  canvas.classList.add("focusing");
  src?.closest(".card")?.classList.add("focus-src");
  for (const id of ids) document.querySelector(`[data-id="${id}"]`)?.classList.add("ring");
}
function unfocus() {
  document.getElementById("canvas")?.classList.remove("focusing");
  document.querySelectorAll(".ring, .focus-src").forEach((e) => e.classList.remove("ring", "focus-src"));
}
function panTo(id: string, smooth = true) {
  // A card inside a collapsed section is not on the canvas: open the section first.
  const key = sectionOf.get(id);
  if (!document.querySelector(`[data-id="${id}"]`) && key && collapsed.has(key)) {
    toggleSection(key);
    return requestAnimationFrame(() => panTo(id, smooth));
  }
  const el = document.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
  if (!el) return;
  el.scrollIntoView({ behavior: smooth ? "smooth" : "instant", block: "center", inline: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

// ---------- spotlight (S-18) ----------

// S-31: the bottom-left panel starts open and stays as the user leaves it (D-14).
let panelCollapsed = (() => {
  try {
    return localStorage.getItem("spill.panel") === "collapsed";
  } catch {
    return false;
  }
})();
function togglePanel() {
  panelCollapsed = !panelCollapsed;
  try {
    localStorage.setItem("spill.panel", panelCollapsed ? "collapsed" : "open");
  } catch {}
  render();
}
let spotSeen = "";
const sectionOf = new Map<string, string>();

function spotRole(id: string): { now: boolean; next: number } {
  const f = data.focus;
  const holding = data.cards.some((c) => stalledOn(c).some((q) => q.id === id));
  return { now: holding || !!f?.discussing.includes(id), next: f ? f.next.indexOf(id) + 1 : 0 };
}

function spotItem(id: string, n?: number): HTMLElement {
  const c = byId.get(id);
  return h(
    "div",
    { class: "item spot", onclick: () => panTo(id) },
    n ? h("span", { class: "k" }, String(n)) : null,
    h("span", { class: "id" }, id),
    h("span", { class: "t" }, c?.title ?? ""),
  );
}

function spotClass(c: Card): string {
  const r = spotRole(c.id);
  return r.now ? " spot-now" : r.next ? " spot-next" : "";
}

function spotTag(c: Card): HTMLElement | null {
  const r = spotRole(c.id);
  if (stalledOn(c).length) return h("span", { class: "spot-tag waiting" }, waitingLabel(stalledOn(c)));
  if (quietFor(c)) return h("span", { class: "spot-tag quiet" }, quietLabel(quietFor(c)));
  if (c.kind === "spec" && c.status === "active") return h("span", { class: "spot-tag build" }, h("i", {}), "Building");
  if (r.now) return h("span", { class: "spot-tag now" }, "In discussion");
  if (r.next) return h("span", { class: "spot-tag" }, `Next ${r.next}`);
  return null;
}

// Rejections waiting on Claude (S-19), at the top of the bottom-left panel.
function rejectionsPanel(): HTMLElement | null {
  const r = data.rejections ?? [];
  if (!r.length) return null;
  return h(
    "div",
    { class: "group" },
    h("div", { class: "hd" }, h("b", { class: "rej" }, "Rejected, waiting on Claude"), h("span", {}, String(r.length))),
    r.map((x) =>
      h(
        "div",
        { class: "item rej", title: x.reason, onclick: () => panTo(x.id) },
        h("div", { class: "top" }, h("span", { class: "id" }, x.id), h("span", { class: "t" }, byId.get(x.id)?.title ?? ""), h("span", { class: "a" }, ago(x.at).replace(" ago", ""))),
        x.reason ? h("div", { class: "why" }, x.reason) : null,
      ),
    ),
  );
}

// The spotlight lives in the bottom-left panel, above recent decisions.
// S-28: specs waiting on the user's approval, unblocked ones first, oldest first.
const statusSince = (c: Card) => lastStatusEvent(c)?.at ?? firstEvent(c.id)?.at ?? "";
// Specs already showing in the spotlight are not listed again in the groups below it.
function inSpotlight(): Set<string> {
  const f = data.focus;
  return new Set(f ? [...(data.cards.some((c) => c.kind === "spec" && c.status === "active") ? [] : f.discussing), ...f.next] : []);
}
function pendingSpecs(): Card[] {
  const since = statusSince;
  const blockers = (c: Card) => waitsOn(c).filter((q) => q.kind === "question");
  const shown = inSpotlight();
  const pending = data.cards
    .filter((c) => c.kind === "spec" && ["draft", "discussing"].includes(c.status) && !shown.has(c.id))
    .sort((a, b) => Number(blockers(a).length > 0) - Number(blockers(b).length > 0) || since(a).localeCompare(since(b)));
  // S-29 req 10: approved specs waiting for Build come after the unapproved ones.
  const ready = data.cards.filter((c) => c.kind === "spec" && c.status === "approved" && !shown.has(c.id)).sort((a, b) => since(a).localeCompare(since(b)));
  return [...pending, ...ready];
}
function pendingGroup(): HTMLElement | null {
  const since = statusSince;
  const blockers = (c: Card) => waitsOn(c).filter((q) => q.kind === "question");
  const specs = pendingSpecs();
  if (!specs.length) return null;
  return h(
    "div",
    { class: "group" },
    h("div", { class: "hd" }, h("b", { class: "pend" }, "Pending approval"), h("span", {}, `All ${specs.length}`)),
    specs.slice(0, 3).map((c) => {
      const q = blockers(c);
      const at = since(c);
      return h(
        "div",
        { class: `item pend${c.status === "approved" ? " ready" : q.length ? " blocked" : ""}`, onmouseenter: () => focus([c.id]), onmouseleave: unfocus, onclick: () => panTo(c.id) },
        h("span", { class: "id" }, c.id),
        h("span", { class: "t" }, c.title),
        c.status === "approved" ? h("span", { class: "a ready" }, "Ready to build") : q.length ? h("span", { class: "a q" }, svg(ICON.lock), q[0].id) : at ? h("span", { class: "a" }, ago(at).replace(" ago", "")) : null,
      );
    }),
  );
}
function spotlightPanel(): HTMLElement | null {
  const f = data.focus;
  const building = buildingGroup();
  if (!f) return building;
  return h(
    "div",
    { class: "group" },
    ...(building ? [building] : [h("div", { class: "hd" }, f.discussing.length || f.note ? h("b", { class: "now" }, h("i", {}), "Discussing") : h("b", {}, "Spotlight")), ...f.discussing.map((id) => spotItem(id)), f.note ? h("div", { class: "note" }, f.note) : null]),
    f.next.length ? h("div", { class: "hd sub" }, h("b", { class: "now" }, "Up next in the spotlight")) : null,
    f.next.map((id, i) => spotItem(id, i + 1)),
  );
}

// S-31: queued specs in the order Build was pressed, and the latest shipped specs.
function queuedSpecs(): Card[] {
  const shown = inSpotlight();
  return data.cards.filter((c) => c.kind === "spec" && c.status === "queued" && !shown.has(c.id)).sort((a, b) => statusSince(a).localeCompare(statusSince(b)));
}
function builtSpecs(): Card[] {
  return data.cards.filter((c) => c.kind === "spec" && c.status === "done").sort((a, b) => statusSince(b).localeCompare(statusSince(a)));
}
const decisionCards = () => data.cards.filter((c) => c.kind === "decision").sort((a, b) => num(b.id) - num(a.id));
const openQuestions = () => data.cards.filter((c) => c.kind === "question" && c.status === "open" && redirectNote(c) === null);

function upNextGroup(): HTMLElement | null {
  const specs = queuedSpecs();
  if (!specs.length) return null;
  return h(
    "div",
    { class: "group" },
    h("div", { class: "hd" }, h("b", {}, "Up next"), specs.length > 3 ? h("span", {}, `All ${specs.length}`) : null),
    specs.slice(0, 3).map((c, i) => h("div", { class: "item queued", onclick: () => panTo(c.id) }, h("span", { class: "k" }, String(i + 1)), h("span", { class: "id" }, c.id), h("span", { class: "t" }, c.title))),
  );
}
function lastBuiltGroup(): HTMLElement | null {
  const specs = builtSpecs();
  if (!specs.length) return null;
  return h(
    "div",
    { class: "group" },
    h("div", { class: "hd" }, h("b", { class: "built" }, "Last built"), specs.length > 3 ? h("span", {}, `All ${specs.length}`) : null),
    specs.slice(0, 3).map((c) => {
      const at = statusSince(c);
      return h("div", { class: "item built", onclick: () => panTo(c.id) }, svg(CHIP.built), h("span", { class: "id" }, c.id), h("span", { class: "t" }, c.title), at ? h("span", { class: "a" }, ago(at).replace(" ago", "")) : null);
    }),
  );
}
function decisionsGroup(): HTMLElement | null {
  const decisions = decisionCards();
  if (!decisions.length) return null;
  return h(
    "div",
    { class: "group" },
    // S-12 req 4: All opens the decisions log (S-7).
    h("div", { class: "hd" }, h("b", {}, "Recent decisions"), h("button", { class: "link", onclick: () => openSearch(null, "D-") }, `All ${decisions.length}`)),
    decisions.slice(0, 3).map((d) => {
      const e = firstEvent(d.id);
      return h(
        "div",
        {
          class: "item",
          onmouseenter: () => focus([d.id, ...changedBy(d)]),
          onmouseleave: unfocus,
          onclick: () => openSheet(d.id, true),
        },
        h("span", { class: "id" }, d.id),
        h("span", { class: "t" }, d.title),
        e ? h("span", { class: "a" }, ago(e.at).replace(" ago", "")) : null,
      );
    }),
  );
}

const CHIP = {
  rejected: `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="none" stroke="#B91C1C" stroke-width="1.4"/><path d="M4.2 4.2l3.6 3.6M7.8 4.2l-3.6 3.6" stroke="#B91C1C" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  held: `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.6" fill="none" stroke="#F59E0B" stroke-width="1.6"/><path d="M4.6 4v4M7.4 4v4" stroke="#B45309" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  quiet: `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.6" fill="none" stroke="#A1A1AA" stroke-width="1.6" stroke-dasharray="1.8 1.6"/></svg>`,
  spot: `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="#6366F1" stroke-width="1.4"/><circle cx="6" cy="6" r="2" fill="#6366F1"/></svg>`,
  question: `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="#F59E0B"/><path d="M4.6 4.7a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/><circle cx="6" cy="8.7" r=".7" fill="#fff"/></svg>`,
  pending: `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="#B45309" stroke-width="1.4" stroke-dasharray="2 1.6"/></svg>`,
  queued: `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 2.5l4 3.5-4 3.5M7 2.5l3 3.5-3 3.5" fill="none" stroke="#3F3F46" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  built: `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="#16A34A"/><path d="M3.8 6.2l1.5 1.5 3-3.2" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  decision: `<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.5" transform="rotate(45 6 6)" fill="none" stroke="#0F766E" stroke-width="1.4"/></svg>`,
};

// S-31: one chip per group with something in it, at the top of the panel; collapsed, it is the whole panel.
function countsRow(): HTMLElement {
  const chip = (cls: string, icon: string, n: number | string, title: string) => h("span", { class: `chip ${cls}`, title }, svg(icon), h("span", {}, String(n)));
  const active = data.cards.find((x) => x.kind === "spec" && x.status === "active");
  const held = active ? stalledOn(active) : [];
  const quiet = active ? quietFor(active) : 0;
  const f = data.focus;
  const spot = f ? f.discussing.length + f.next.length : 0;
  const rejections = data.rejections?.length ?? 0;
  const chips = [
    rejections ? chip("rej", CHIP.rejected, rejections, "Rejected, waiting on Claude") : null,
    active
      ? held.length
        ? chip("held", CHIP.held, held[0].id, `${active.id}: ${waitingLabel(held)}`)
        : quiet
          ? chip("quiet", CHIP.quiet, quietLabel(quiet).replace("No update in ", ""), `${active.id}: ${quietLabel(quiet)}`)
          : chip("build", SPINNER, 1, `Building ${active.id}`)
      : null,
    spot ? chip("spot", CHIP.spot, spot, "In the spotlight") : null,
    openQuestions().length ? chip("q", CHIP.question, openQuestions().length, "Open questions waiting on you") : null,
    pendingSpecs().length ? chip("pend", CHIP.pending, pendingSpecs().length, "Pending approval") : null,
    queuedSpecs().length ? chip("queued", CHIP.queued, queuedSpecs().length, "Up next: queued to build") : null,
    builtSpecs().length ? chip("built", CHIP.built, builtSpecs().length, "Built") : null,
    decisionCards().length ? chip("dec", CHIP.decision, decisionCards().length, "Decisions") : null,
  ];
  return h(
    "div",
    { class: "counts", onclick: () => panelCollapsed && togglePanel() },
    h("div", { class: "chips" }, chips),
    h("button", { class: "fold", title: panelCollapsed ? "Expand" : "Collapse", onclick: (e: Event) => (e.stopPropagation(), togglePanel()) }, svg(ICON.chev)),
  );
}

// ---------- cards ----------

// S-13: results come from Claude through spill_checks (D-4). Clicking opens the viewer at Acceptance checks.
function checkRow(c: Card): HTMLElement | null {
  const run = data.checks?.[c.id];
  if (c.kind !== "spec" || (!hasChecks(c) && !run)) return null;
  const open = () => openSheet(c.id, false, "checks");
  if (!run) return h("div", { class: "checks" }, h("i", { class: "dot", style: "background:#D4D4D8" }), "No checks run");
  if (run.running) return h("div", { class: "checks run", onclick: open }, h("i", { class: "dot running" }), "Running checks", h("span", { class: "sp" }), h("span", {}, ago(run.at)));
  const failed = run.results.filter((r) => !r.pass);
  return h(
    "div",
    { class: `checks ${failed.length ? "fail" : "pass"}`, onclick: open, title: "Open the acceptance checks" },
    h("i", { class: "dot" }),
    h("span", { class: "count" }, `${run.results.length - failed.length} of ${run.results.length} checks`),
    failed.length ? h("span", { class: "failed" }, `${failed[0].name} failed`) : null,
    h("span", { class: "sp" }),
    failed.length ? fixButton(c, failed.map((r) => r.name)) : h("span", { class: "at" }, ago(run.at)),
  );
}

// S-25: a tiny Fix button posts "Fix failing check: <name>" comments for Claude. It reads Sent while a
// fix comment for those checks is newer than the latest run.
function fixSent(c: Card, names: string[]): boolean {
  const run = data.checks?.[c.id];
  if (!run) return false;
  const asked = data.events.filter((e) => e.card === c.id && e.action === "comment" && e.actor === "user" && e.at > run.at).map((e) => e.detail ?? "");
  return names.every((n) => asked.some((d) => d.split("\n").includes(`Fix failing check: ${n}`)));
}
function fixButton(c: Card, names: string[]): HTMLElement {
  const sent = fixSent(c, names);
  const b = h("button", { class: "fix", disabled: sent, title: sent ? "Sent to Claude" : `Ask Claude to fix ${names.length > 1 ? "these checks" : "this check"}` }, sent ? "Sent" : "Fix") as HTMLButtonElement;
  b.onclick = async (ev) => {
    ev.stopPropagation();
    b.disabled = true;
    b.textContent = "Sent";
    const e = await post(`/api/cards/${c.id}/comment`, { text: names.map((n) => `Fix failing check: ${n}`).join("\n") });
    if (e) {
      b.disabled = false;
      b.textContent = "Fix";
      b.title = e;
    }
  };
  return b;
}

function checksBox(c: Card): HTMLElement | null {
  const run = data.checks?.[c.id];
  if (!run) return null;
  const failed = run.results.filter((r) => !r.pass).length;
  return h(
    "div",
    { class: "checkbox" },
    h("div", { class: "hd" }, h("b", {}, "Checks"), h("span", { class: "sp" }), h("span", {}, run.running ? `Running, started ${ago(run.at)}` : `${failed ? `${failed} failing` : `${run.results.length} passing`}, ${ago(run.at)}`)),
    run.results.map((r) => h("div", { class: `r ${r.pass ? "pass" : "fail"}` }, h("i", { class: "dot" }), h("span", { class: "n" }, r.name), r.detail ? h("span", { class: "d" }, r.detail) : null, ...(!r.pass && !run.running ? [fixButton(c, [r.name])] : []))),
  );
}

// S-14 requirement 5: once every blocker is resolved, the card shows "Ready" until the user clicks it away.
const readySeen: Set<string> = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem("spill.ready") ?? "[]"));
  } catch {
    return new Set();
  }
})();
function isReady(c: Card): boolean {
  const blockers = linksOf(c, "blocked_by");
  return c.kind === "spec" && ["draft", "discussing"].includes(c.status) && blockers.length > 0 && !waitsOn(c).length && !readySeen.has(c.id);
}
function dismissReady(id: string) {
  readySeen.add(id);
  try {
    localStorage.setItem("spill.ready", JSON.stringify([...readySeen]));
  } catch {}
  render();
}

function blockMarkers(c: Card): HTMLElement | null {
  const waits = waitsOn(c);
  const blocks = blocksOpen(c);
  const ready = isReady(c);
  if (!waits.length && !blocks.length && !ready) return null;
  return h(
    "div",
    { class: "foot" },
    ready
      ? h("span", { class: "pill ready", title: `Unblocked: ${linksOf(c, "blocked_by").join(", ")} resolved. Click to dismiss.`, onclick: () => dismissReady(c.id) }, "Ready")
      : null,
    waits.map((b) =>
      h(
        "span",
        {
          class: "waits",
          onmouseenter: (e: Event) => focus([b.id], e.currentTarget as HTMLElement),
          onmouseleave: unfocus,
          onclick: () => panTo(b.id),
        },
        svg(ICON.lock),
        `Waits on ${b.id}`,
      ),
    ),
    h("span", { class: "sp" }),
    blocks.length
      ? h(
          "span",
          {
            class: "pill blocks",
            onmouseenter: (e: Event) => focus(blocks.map((b) => b.id), e.currentTarget as HTMLElement),
            onmouseleave: unfocus,
          },
          `Blocks ${blocks.length}`,
        )
      : null,
  );
}

function provenance(c: Card): string | null {
  const e = firstEvent(c.id);
  if (!e) return null;
  const who = e.actor === "claude" ? "Claude" : "you";
  const verb = c.kind === "question" ? "Asked by" : c.kind === "decision" ? "Recorded by" : e.actor === "claude" ? "Drafted by" : "Added by";
  return `${verb} ${who}, ${ago(e.at)}`;
}

function lastStatusEvent(c: Card) {
  return [...data.events].reverse().find((e) => e.card === c.id && e.action === "status");
}

// `draft` is the side sheet comment box: text there is the reject reason, with no second field.
function specActions(c: Card, draft?: () => string): HTMLElement | null {
  if (!["draft", "discussing", "approved", "queued"].includes(c.status)) return null;
  const wrap = h("div", { class: "actions-wrap", style: "display:flex;flex-direction:column;gap:6px" });
  const err = h("div", { class: "err" });
  // S-29: once approved, Approve becomes Build; Reject stays on approved and queued specs.
  const building = c.status === "approved";
  const approve = h("button", { class: "btn primary" }, building ? "Build" : "Approve") as HTMLButtonElement;
  const reject = h("button", { class: "btn danger" }, "Reject") as HTMLButtonElement;
  // S-21: open questions must be answered before approval.
  const openQs = waitsOn(c).filter((b) => b.kind === "question");
  if (openQs.length) {
    approve.disabled = true;
    approve.title = "Answer the open questions first";
  }
  approve.onclick = async () => {
    approve.disabled = reject.disabled = true;
    const e = await post(`/api/cards/${c.id}/${building ? "build" : "approve"}`, {});
    if (e) {
      err.textContent = e;
      approve.disabled = reject.disabled = false;
    } else if (openId === c.id) closeSheet(); // S-22 req 8
  };
  reject.onclick = async () => {
    const reason = draft?.().trim();
    if (reason) {
      approve.disabled = reject.disabled = true;
      const e = await post(`/api/cards/${c.id}/reject`, { reason });
      if (e) {
        err.textContent = e;
        approve.disabled = reject.disabled = false;
      } else {
        commentDraft = "";
        if (openId === c.id) closeSheet();
      }
      return;
    }
    const input = h("input", { placeholder: "Why reject it?" }) as HTMLInputElement;
    const confirm = h("button", { class: "btn danger", style: "flex:0 0 auto;padding:0 12px" }, "Reject") as HTMLButtonElement;
    const send = async () => {
      confirm.disabled = true;
      const e = await post(`/api/cards/${c.id}/reject`, { reason: input.value });
      if (e) {
        err.textContent = e;
        confirm.disabled = false;
      } else if (openId === c.id) closeSheet(); // S-22 req 8
    };
    confirm.onclick = send;
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") send();
      if (ev.key === "Escape") render();
    };
    wrap.replaceChildren(h("div", { class: "reason" }, input, confirm), err);
    input.focus();
  };
  wrap.append(
    h("div", { class: "actions" }, c.status === "queued" ? null : approve, reject),
    ...(openQs.length
      ? [h("div", { class: "gate" }, "Answer ", openQs.flatMap((q, i) => [i ? (i === openQs.length - 1 ? " and " : ", ") : "", h("button", { class: "qid", onclick: () => panTo(q.id) }, q.id)]), " to approve")]
      : []),
    err,
  );
  return wrap;
}

// S-24 req 6: open questions blocking this spec, for the header badge.

// S-5: the latest revert, while the spec has not been approved again since.
function revertNote(c: Card): { reason: string; at: string } | null {
  if (c.kind !== "spec" || !["draft", "discussing"].includes(c.status)) return null;
  const evs = data.events.filter((e) => e.card === c.id && e.action === "status");
  const i = evs.findLastIndex((e) => /\(reverted\)/.test(e.detail ?? ""));
  if (i < 0 || evs.slice(i + 1).some((e) => /-> approved/.test(e.detail ?? ""))) return null;
  return { reason: (evs[i].detail ?? "").replace(/^.*?\(reverted\):?\s*/, ""), at: evs[i].at };
}

// S-5: Revert in the side sheet for approved, active and done specs. Comment box text is the reason.
function revertAction(c: Card, draft: () => string): HTMLElement | null {
  // S-33 / D-16: a done spec is updated, not reverted.
  if (c.kind !== "spec" || !["approved", "queued", "active"].includes(c.status)) return null;
  const err = h("div", { class: "err" });
  const btn = h("button", { class: "btn" }, "Revert") as HTMLButtonElement;
  btn.title = "Take this spec back to discussing. Text in the comment box becomes the reason.";
  btn.onclick = async () => {
    btn.disabled = true;
    const e = await post(`/api/cards/${c.id}/revert`, { reason: draft().trim() });
    if (e) {
      err.textContent = e;
      btn.disabled = false;
    } else commentDraft = "";
  };
  return h("div", { style: "display:flex;flex-direction:column;gap:6px" }, h("div", { class: "actions" }, btn), err);
}

function commentCount(c: Card): number {
  return (c.comments.match(/^- /gm) ?? []).length;
}
// S-10: what hangs off a spec in the Branches column, by kind.
function branches(c: Card) {
  const under = (p: string, kind: string) => data.cards.filter((k) => k.kind === kind && parentOf(k) === p);
  const qs = under(c.id, "question");
  return { open: qs.filter(isOpen), decisions: qs.flatMap((q) => under(q.id, "decision")), specs: under(c.id, "spec") };
}
function designBoards(c: Card): string[] {
  return [...new Set(c.body.match(/https?:\/\/(?:[\w-]+\.)*(?:paper\.design|figma\.com)\/[^\s)>\]]*/g) ?? [])];
}
function sectionChip(c: Card): HTMLElement | null {
  const secs = data.cards.filter((k) => k.kind === "section");
  const i = secs.findIndex((k) => k.id === c.section);
  if (i < 0) return null;
  return h("span", { class: "secchip", title: secs[i].title }, h("i", { style: `background:${SECTION_COLORS[i % SECTION_COLORS.length]}` }), h("span", {}, secs[i].title));
}
function branchChips(c: Card): HTMLElement | null {
  const b = branches(c);
  const chip = (cards: Card[], label: string, cls = "") =>
    cards.length
      ? h(
          "span",
          {
            class: `bchip${cls}`,
            onmouseenter: (e: Event) => focus(cards.map((k) => k.id), e.currentTarget as HTMLElement),
            onmouseleave: unfocus,
            onclick: (e: Event) => (e.stopPropagation(), panTo(cards[0].id)),
          },
          h("b", {}, String(cards.length)),
          label,
        )
      : null;
  const chips = [chip(b.open, "open", " amber"), chip(b.decisions, b.decisions.length === 1 ? "decision" : "decisions"), chip(b.specs, b.specs.length === 1 ? "child spec" : "child specs")].filter(Boolean);
  return chips.length ? h("div", { class: "bchips" }, chips) : null;
}
function specFacts(c: Card): HTMLElement[] {
  const row = (k: string, v: string) => h("div", { class: "row" }, h("span", { class: "k" }, k), h("span", {}, v));
  const reqs = requirementsCount(c);
  if (["draft", "discussing"].includes(c.status)) {
    const waits = waitsOn(c);
    return [
      ...(reqs ? [row("Scope", `${reqs} requirement${reqs === 1 ? "" : "s"}`)] : []),
      ...(waits.length ? [row("Blocked", `by ${waits.map((w) => w.id).join(", ")}`)] : []),
    ];
  }
  if (c.status === "replaced") {
    const removed = filesOf(c).filter((f) => f.change === "removed").length;
    const decided = branches(c).decisions.length;
    return [
      ...(removed ? [row("Removed", `${removed} file${removed === 1 ? "" : "s"}`)] : []),
      ...(decided ? [row("Kept", `${decided} decision${decided === 1 ? "" : "s"}`)] : []),
    ];
  }
  if (["approved", "queued", "done"].includes(c.status)) {
    const decided = branches(c).decisions.length;
    return [
      ...(reqs ? [row(c.status === "done" ? "Produced" : "Scope", c.status === "done" ? `${reqs} of ${reqs} requirements` : `${reqs} requirement${reqs === 1 ? "" : "s"}`)] : []),
      ...(decided ? [row("Decided", `${decided} rule${decided === 1 ? "" : "s"}`)] : []),
    ];
  }
  return [];
}
// S-29 req 7: who or what approved the spec, and when Build was pressed.
function approvalNote(c: Card): string | null {
  const evs = data.events.filter((e) => e.card === c.id && e.action === "status");
  const a = evs.findLast((e) => /-> approved/.test(e.detail ?? ""));
  if (!a) return null;
  const by = a.actor === "auto" ? `Auto-approved, ${(a.detail ?? "").match(/\(auto: ([^)]+)\)/)?.[1] ?? "requirements met"}` : "Approved by you";
  const q = c.status === "queued" ? evs.findLast((e) => /-> queued/.test(e.detail ?? "")) : undefined;
  return q ? `${by}; Build ${ago(q.at)}` : `${by}, ${ago(a.at)}`;
}
function specCard(c: Card): HTMLElement {
  const isNewDraft = c.status === "draft" && isNew(c);
  const icon = ICON[(c.status === "queued" ? "approved" : c.status) as keyof typeof ICON] ?? ICON.draft;
  let status: HTMLElement;
  if (c.status === "approved" || c.status === "queued")
    status = h("span", { class: "seal" }, svg(`<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.5" fill="#fff"/><path d="M4.3 7.2l1.8 1.8 3.6-3.8" fill="none" stroke="#16A34A" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`), c.status === "queued" ? "Queued" : "Approved");
  else if (isNewDraft) status = h("span", { class: "pill", style: "background:var(--indigo-bg);color:var(--indigo-text)" }, h("i", { class: "dot", style: "background:var(--indigo)" }), "New");
  else if (stalledOn(c).length) status = h("span", { class: "status held" }, waitingLabel(stalledOn(c)));
  else if (updateOf(c)) status = h("span", { class: "status upd" }, "Update requested");
  else if (quietFor(c)) status = h("span", { class: "status quiet" }, quietLabel(quietFor(c)));
  else if (c.status === "active")
    status = h("span", { class: "status building" }, "Claude building", h("span", { class: "dots" }, h("i", { style: phase(1200) }), h("i", { style: phase(1200) }), h("i", { style: phase(1200) })));
  else if (c.status === "replaced") status = h("span", { class: "status replaced" }, linksOf(c, "replaced_by").length ? `Replaced by ${linksOf(c, "replaced_by")[0]}` : "Replaced");
  else if (c.status === "draft") status = h("span", { class: "status" }, firstEvent(c.id) ? `Draft by ${firstEvent(c.id)!.actor === "claude" ? "Claude" : "you"}` : "Draft");
  else
    status = h(
      "span",
      { class: "status", style: c.status === "active" ? "color:var(--text);font-weight:600" : c.status === "discussing" ? "color:var(--amber-text);font-weight:600" : "" },
      SPEC_STATUS_LABEL[c.status] ?? c.status,
    );

  const st = lastStatusEvent(c);
  const facts = specFacts(c);
  const rev = revertNote(c);
  if (rev) facts.unshift(h("div", { class: "row reverted" }, h("span", { class: "k" }, "Reverted"), h("span", {}, `${rev.reason || "No reason given"}, ${ago(rev.at)}`)));
  if (c.status === "rejected" && st?.detail?.includes(": "))
    facts.push(h("div", { class: "row" }, h("span", { class: "k" }, "Reason"), h("span", {}, st.detail.split(": ").slice(1).join(": "))));

  let foot: string | null = provenance(c);
  const active = c.status === "active";
  const since = active ? activeSince(c) : undefined;
  if (since) foot = `Started ${ago(since)}`;
  if (st && c.status === "rejected" && st.actor === "user") foot = `Rejected by you, ${ago(st.at)}`;
  if (["approved", "queued"].includes(c.status)) foot = approvalNote(c) ?? foot;
  if (rev) foot = `Reverted by you, ${ago(rev.at)}`;
  const boards = designBoards(c);

  return h(
    "div",
    {
      class: `card spec s-${c.status}${stalledOn(c).length ? " held" : quietFor(c) ? " quiet" : updateOf(c) ? " upd" : ""}${c.status === "queued" ? " s-approved" : ""}${c.status === "approved" && certifying(c.id) ? " certify" : ""}${isNewDraft ? " is-new" : ""}${Date.now() - (entered.get(c.id) ?? 0) < 600 ? " entering" : ""}${spotClass(c)}`,
      "data-id": c.id,
      // A redraw mid-sweep continues it rather than restarting.
      style: active ? phase(2400) : c.status === "approved" && certifying(c.id) ? `--cd:-${Date.now() - certified.get(c.id)!}ms` : undefined,
      onmouseenter: isNewDraft ? () => markSeen(c.id) && setTimeout(render, 0) : undefined,
    },
    spotTag(c),
    h(
      "div",
      { class: "head" },
      active && !stalledOn(c).length && !quietFor(c) ? svg(SPINNER.replace('width="12" height="12"', 'width="16" height="16"')) : svg(icon),
      h("span", { class: "id" }, c.id),
      sectionChip(c),
      linksOf(c, "follows").length ? h("span", { class: "follows", onclick: (e: Event) => (e.stopPropagation(), panTo(linksOf(c, "follows")[0])) }, `Follows ${linksOf(c, "follows")[0]}`) : null,
      c.status === "discussing" && commentCount(c) ? h("span", { class: "ccount", title: "Comments" }, svg(MSG_ICON.replace('width="16" height="16"', 'width="12" height="12"')), String(commentCount(c))) : null,
      h("span", { class: "sp" }),
      status,
    ),
    h("div", { style: "display:flex;flex-direction:column;gap:4px" }, h("div", { class: "title" }, c.title), active ? latestLine(c) : whyLine(c) ? h("div", { class: "why" }, whyLine(c)) : null),
    active ? progressBar(c) : facts.length ? h("div", { class: "facts" }, facts.slice(0, 3)) : null,
    specActions(c),
    branchChips(c),
    blockMarkers(c),
    foot || boards.length
      ? h(
          "div",
          { class: "foot" },
          foot ? h("span", {}, foot) : null,
          h("span", { class: "sp" }),
          boards.length ? h("a", { class: "boards", href: boards[0], target: "_blank", title: boards.join("\n"), onclick: (e: Event) => e.stopPropagation() }, `${boards.length} board${boards.length === 1 ? "" : "s"}`) : null,
        )
      : null,
    checkRow(c),
  );
}

// S-20: an answer in progress lives here so live redraws keep it.
const answerDrafts = new Map<string, { pick?: string; picks?: string[]; text: string; focused?: boolean; error?: string }>();

function answerForm(c: Card, opts: { letter: string; text: string }[]): HTMLElement {
  const d = answerDrafts.get(c.id) ?? { text: "" };
  const set = (patch: Partial<typeof d>) => {
    answerDrafts.set(c.id, { ...d, ...patch });
    render();
  };
  const multi = c.select === "multi";
  const send = async (text: string, picks?: string[]) => {
    if (!text.trim() && !picks?.length) return;
    const e = await post(`/api/cards/${c.id}/answer`, picks?.length ? { picks, text } : { text });
    if (e) set({ error: e });
    else answerDrafts.delete(c.id);
  };
  // S-24: multi select toggles any number of options and keeps Other alongside them.
  const picks = d.picks ?? [];
  const toggle = (l: string) => set({ picks: picks.includes(l) ? picks.filter((p) => p !== l) : [...picks, l].sort(), error: undefined });
  const list = multi
    ? opts.map((o) => h("button", { class: `opt check${picks.includes(o.letter) ? " on" : ""}`, role: "checkbox", "aria-checked": String(picks.includes(o.letter)), onclick: () => toggle(o.letter) }, h("span", { class: "box" }), h("span", { class: "l" }, o.letter), h("span", {}, o.text)))
    : opts.map((o) =>
    h("button", { class: `opt pick${d.pick === o.letter ? " on" : ""}`, onclick: () => set({ pick: d.pick === o.letter ? undefined : o.letter, text: "", error: undefined }) }, h("span", { class: "l" }, o.letter), h("span", {}, o.text)),
  );
  // A free answer can run to several lines: the box grows with it; Enter sends, Shift+Enter breaks the line.
  const input = h("textarea", { rows: 1, placeholder: opts.length ? "Other: type your own answer" : "Type your answer" }) as HTMLTextAreaElement;
  input.value = d.text;
  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight + 2}px`;
  };
  requestAnimationFrame(grow);
  input.oninput = () => {
    grow();
    if (multi) {
      const toggled = !d.text.trim() !== !input.value.trim();
      d.text = input.value;
      if (toggled) set({ text: input.value, focused: true });
      else answerDrafts.set(c.id, { ...d, focused: true });
      return;
    }
    const toggled = !d.text.trim() !== !input.value.trim();
    d.text = input.value;
    if (d.pick || toggled) set({ pick: undefined, text: input.value, focused: true });
    else answerDrafts.set(c.id, { ...d, focused: true });
  };
  input.onfocus = () => answerDrafts.set(c.id, { ...d, focused: true });
  // A redraw removes the focused box, which fires blur too; only a real blur (the box still on the
  // page) gives up the focus, or a second quick redraw would drop it.
  input.onblur = () => setTimeout(() => input.isConnected && answerDrafts.has(c.id) && (answerDrafts.get(c.id)!.focused = false), 0);
  input.onkeydown = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      send(input.value, multi ? picks : undefined);
    }
    if (ev.key === "Escape") {
      answerDrafts.delete(c.id);
      render();
    }
  };
  if (d.focused)
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
  const picked = opts.find((o) => o.letter === d.pick);
  const confirm = multi
    ? h(
        "div",
        { class: "actions" },
        h("button", { class: "btn primary", disabled: !picks.length && !d.text.trim(), onclick: () => send(d.text, picks) }, picks.length ? `Answer ${picks.join(", ")}` : "Answer"),
        ...(picks.length || d.text.trim() ? [h("button", { class: "btn", onclick: () => (answerDrafts.delete(c.id), render()) }, "Cancel")] : []),
      )
    : picked
    ? h(
        "div",
        { class: "actions" },
        h("button", { class: "btn primary", onclick: () => send("", [picked.letter]) }, `Answer ${picked.letter}`),
        h("button", { class: "btn", onclick: () => (answerDrafts.delete(c.id), render()) }, "Cancel"),
      )
    : d.text.trim()
      ? h("div", { class: "actions" }, h("button", { class: "btn primary", onclick: () => send(d.text) }, "Answer"))
      : null;
  return h(
    "div",
    { class: "answer" },
    opts.length ? h("div", { class: "options" }, list) : null,
    h("div", { class: "reason other" }, input),
    confirm,
    d.error ? h("div", { class: "err" }, d.error) : null,
  );
}

// S-20: an answered question shows what was chosen.
function answeredView(c: Card, opts: { letter: string; text: string }[], answer: string): HTMLElement {
  // "B. text" for one pick, "A, C. text; text" for several (S-24).
  const letters = /^([A-Z](?:, [A-Z])*)\.\s/.exec(answer)?.[1].split(", ") ?? [];
  const other = /; Other: (.+)$/.exec(answer)?.[1];
  if (letters.length && letters.every((l) => opts.some((o) => o.letter === l)))
    return h(
      "div",
      { class: "options" },
      opts.map((o) => h("div", { class: `opt${letters.includes(o.letter) ? " chosen" : " dim"}` }, h("span", { class: "l" }, o.letter), h("span", {}, o.text))),
      ...(other ? [h("div", { class: "opt chosen" }, h("span", { class: "l" }, "Other"), h("span", {}, other))] : []),
    );
  return h("div", { class: "options" }, h("div", { class: "opt chosen" }, h("span", { class: "l" }, "Answer"), h("span", {}, answer)));
}

// S-26: a redirect waits until Claude acts on it: an update rewrites the question; recording or dropping closes it.
function redirectNote(c: Card): string | null {
  if (c.kind !== "question" || c.status !== "open") return null;
  const evs = data.events.filter((e) => e.card === c.id && (e.action === "redirect" || e.action === "update"));
  const last = evs[evs.length - 1];
  return last?.action === "redirect" ? (last.detail ?? "") : null;
}
function redirectBox(text: string, label = "Your answer"): HTMLElement {
  return h("div", { class: "redirect" }, h("div", { class: "k" }, label), h("div", { class: "t" }, text), h("div", { class: "w" }, h("span", { class: "dots" }, h("i", { style: phase(1200) }), h("i", { style: phase(1200) }), h("i", { style: phase(1200) })), "Waiting on Claude"));
}

function questionCard(c: Card): HTMLElement {
  const opts = options(c);
  const open = c.status === "open";
  const answeredBy = linksOf(c, "answered_by")[0];
  const answer = answeredBy ? byId.get(answeredBy)?.title : undefined;
  const statusText = open ? "Needs you" : c.status === "answered" ? `Answered${answeredBy ? ` in ${answeredBy}` : ""}` : "Dropped";
  const blocks = linksOf(c, "blocks");
  const intro = c.body.split(/\n\s*\n/)[0]?.trim() ?? "";
  return h(
    "div",
    { class: `card question q-${c.status}${spotClass(c)}`, "data-id": c.id },
    spotTag(c),
    h(
      "div",
      { class: "head" },
      svg(open ? ICON.question : ICON.questionDone),
      h("span", { class: "id" }, c.id),
      c.design ? h("span", { class: "kindpill design" }, "Design") : linksOf(c, "replaces").length ? h("span", { class: "kindpill replace" }, "Replacement") : open ? h("span", { class: "kindpill" }, opts.length ? `Pick ${c.select === "multi" ? "any" : "one"} of ${opts.length}` : "Yes or no") : null,
      h("span", { class: "sp" }),
      h("span", { class: "status" }, statusText),
    ),
    c.design && designBoards(c).length ? h("a", { class: "opendesign", href: designBoards(c)[0], target: "_blank", onclick: (e: Event) => e.stopPropagation() }, "Open design") : null,
    h("div", { class: "title" }, c.title),
    open && !opts.length && intro ? h("div", { class: "proposal" }, h("span", { class: "k" }, "Context"), h("span", {}, intro)) : null,
    open ? (redirectNote(c) !== null ? redirectBox(redirectNote(c)!) : answerForm(c, opts)) : answer ? answeredView(c, opts, answer) : null,
    h("div", { class: "foot" }, h("span", {}, provenance(c) ?? ""), h("span", { class: "sp" }), blocks.length ? h("span", { style: "color:var(--text-2)" }, `Blocks ${blocks.join(", ")}`) : null),
  );
}

function decisionCard(c: Card): HTMLElement {
  const e = firstEvent(c.id);
  const answers = linksOf(c, "answers")[0];
  const changed = changedBy(c);
  const text = c.body.split(/\n\s*\n/)[0]?.trim() ?? "";
  return h(
    "div",
    { class: `card decision${spotClass(c)}`, "data-id": c.id },
    spotTag(c),
    h("div", { class: "band" }, svg(ICON.seal), h("span", { class: "lbl" }, "DECISION"), h("span", { class: "id" }, c.id), e ? h("span", { class: "age" }, ago(e.at)) : null),
    h(
      "div",
      { class: "dbody" },
      h("div", { class: "title" }, c.title),
      text ? h("div", { class: "dtext" }, text) : null,
      h("div", { class: "foot" }, h("span", {}, answers ? `Answers ${answers}` : "Recorded"), h("span", { class: "sp" }), changed.length ? h("span", { style: "color:var(--text-2)" }, `Changed ${changed.join(", ")}`) : null),
    ),
  );
}

function cardFor(c: Card): HTMLElement {
  if (c.kind === "question") return questionCard(c);
  if (c.kind === "decision") return decisionCard(c);
  return specCard(c);
}

// ---------- layout ----------

function groupTitle(n: Node): HTMLElement {
  const count = (kind: string) => n.children.filter((c) => c.card.kind === kind).length;
  const parts = [
    [count("question"), "question"],
    [count("decision"), "decision"],
    [count("spec"), n.card.kind === "spec" ? "child spec" : "spec"],
  ]
    .filter(([k]) => k)
    .map(([k, w]) => `${k} ${w}${k === 1 ? "" : "s"}`);
  return h("div", { class: "grouptitle" }, `From ${n.card.id} `, h("span", {}, parts.join(", ")));
}

function nodeEl(n: Node): HTMLElement {
  return h(
    "div",
    // A parent with many children gets a wider gutter, so each child's line keeps an 8px lane.
    { class: `node depth${n.depth}`, style: n.children.length > 5 ? `gap:${32 + 8 * (n.children.length - 1)}px` : undefined },
    cardFor(n.card),
    n.children.length ? h("div", { class: "children" }, groupTitle(n), n.children.map(nodeEl)) : null,
  );
}

const collapsed: Set<string> = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem("spill.collapsed") ?? "[]"));
  } catch {
    return new Set();
  }
})();
function saveCollapsed() {
  try {
    localStorage.setItem("spill.collapsed", JSON.stringify([...collapsed]));
  } catch {}
}
function toggleSection(key: string) {
  collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
  saveCollapsed();
  render();
}
// New specs and spotlit cards open their section once; the user can collapse it again after.
const toReveal = new Set<string>();
let spotRevealed = "";
function openSections() {
  const f = data.focus;
  const spot = [...data.cards.flatMap((c) => stalledOn(c)).map((q) => q.id), ...(f?.discussing ?? []), ...(f?.next ?? [])];
  const key = `${f?.at ?? ""} ${spot.join(",")}`;
  if (key !== spotRevealed) {
    spotRevealed = key;
    spot.forEach((id) => toReveal.add(id));
  }
  let changed = false;
  for (const id of toReveal) {
    const sec = sectionOf.get(id);
    if (sec && collapsed.delete(sec)) changed = true;
  }
  toReveal.clear();
  if (changed) saveCollapsed();
}

function subtree(n: Node): Card[] {
  return [n.card, ...n.children.flatMap(subtree)];
}

function sectionEl(key: string, title: string, color: string, roots: Node[]): HTMLElement {
  const specs = roots.filter((r) => r.card.kind === "spec").length;
  const needs = roots.flatMap(subtree).filter(needsYou).length;
  const isCollapsed = collapsed.has(key);
  return h(
    "div",
    { class: `section${isCollapsed ? " collapsed" : ""}`, "data-sec": key },
    h(
      "div",
      { class: "sechead", onclick: () => toggleSection(key) },
      svg(ICON.chev),
      h("i", { class: "sq", style: `background:${color}` }),
      h("span", { class: "name" }, title),
      h("span", { class: "n" }, `${specs} spec${specs === 1 ? "" : "s"}`),
      needs ? h("span", { class: "needs" }, `${needs} ${needs === 1 ? "needs" : "need"} you`) : null,
    ),
    h("div", { class: "roots" }, roots.map(nodeEl)),
  );
}

function drawLines(content: HTMLElement) {
  const old = document.getElementById("lines");
  old?.remove();
  const box = content.getBoundingClientRect();
  const W = content.scrollWidth;
  const H = content.scrollHeight;
  const paths: string[] = [];
  const color = (c: Card) => {
    if (c.kind === "decision") return "#14B8A6";
    if (c.kind === "question") return c.status === "open" ? "#F59E0B" : "#D4D4D8";
    if (c.status === "active") return "#18181B"; // S-27: ink, like the building ring
    if (c.status === "approved" || c.status === "queued") return "#22A55B";
    if (c.status === "discussing") return "#F59E0B";
    if (isNew(c)) return "#818CF8";
    return "#D4D4D8";
  };
  const dotColor = (c: Card) => (c.kind === "spec" && c.status === "active" ? "#18181B" : c.kind === "spec" && ["approved", "queued"].includes(c.status) ? "#22A55B" : c.kind === "question" && c.status === "open" ? "#F59E0B" : "#A1A1AA");

  for (const nodeDiv of content.querySelectorAll<HTMLElement>(".node")) {
    const parentCard = nodeDiv.querySelector(":scope > .card") as HTMLElement;
    const kids = nodeDiv.querySelectorAll<HTMLElement>(":scope > .children > .node > .card");
    if (!kids.length || !parentCard.offsetParent) continue;
    const pr = parentCard.getBoundingClientRect();
    const x1 = pr.right - box.left;
    const y1 = pr.top - box.top + 26;
    const pc = byId.get(parentCard.dataset.id!)!;
    // Each child gets its own lane across the gutter, nested so no lines cross: the nearest child
    // turns down closest to the cards, the farthest closest to the parent.
    const n = kids.length;
    kids.forEach((k, i) => {
      const kr = k.getBoundingClientRect();
      const x2 = kr.left - box.left;
      const y2 = kr.top - box.top + 20;
      const c = byId.get(k.dataset.id!)!;
      const span = x2 - x1 - 32;
      const step = n > 1 ? Math.min(8, span / (n - 1)) : 0;
      const mx = x1 + 16 + (n - 1 - i) * step;
      const r = 10;
      const d =
        Math.abs(y2 - y1) < 28
          ? `M${x1} ${y1} C${x1 + 28} ${y1} ${x1 + 28} ${y2} ${x2} ${y2}`
          : `M${x1} ${y1} H${mx - r} Q${mx} ${y1} ${mx} ${y1 + r} V${y2 - r} Q${mx} ${y2} ${mx + r} ${y2} H${x2}`;
      paths.push(`<path d="${d}" stroke="${color(c)}"${c.status === "active" && !stalledOn(c).length && !quietFor(c) ? ' class="flow"' : ""}/>`);
    });
    paths.push(`<circle cx="${x1}" cy="${y1}" r="3" fill="#fff" stroke="${dotColor(pc)}"/>`);
  }
  // Section headers branch down to their specs (S-11).
  for (const sec of content.querySelectorAll<HTMLElement>(".section:not(.collapsed)")) {
    const sq = sec.querySelector(".sechead .sq") as HTMLElement | null;
    if (!sq) continue;
    const sr = sq.getBoundingClientRect();
    const x = sr.left + sr.width / 2 - box.left;
    const y0 = sr.bottom - box.top + 6;
    let any = false;
    for (const k of sec.querySelectorAll<HTMLElement>(":scope > .roots > .node > .card")) {
      const kr = k.getBoundingClientRect();
      const y = kr.top - box.top + 26;
      const x2 = kr.left - box.left;
      const c = byId.get(k.dataset.id!)!;
      paths.push(`<path d="M${x} ${y0} V${y - 10} Q${x} ${y} ${x + 10} ${y} H${x2}" stroke="${color(c)}"${c.status === "active" && !stalledOn(c).length && !quietFor(c) ? ' class="flow"' : ""}/>`);
      any = true;
    }
    if (any) paths.push(`<circle cx="${x}" cy="${y0}" r="3" fill="#fff" stroke="#A1A1AA"/>`);
  }
  const el = svg(`<svg id="lines" width="${W}" height="${H}" fill="none" stroke-width="1.5">${paths.join("")}</svg>`);
  content.prepend(el);
}

// ---------- side sheet (S-22) ----------

let openId: string | null = decodeURIComponent(location.hash.slice(1)) || null;
let sheetTab: "overview" | "links" | "activity" | "file" | "code" = "overview";
let sheetFile: { id: string; text: string } | null = null;
// S-34: which version the Overview compares the spec with (an index into its versions, or -1 for none).
const compareSel = new Map<string, number>();
const versionsOf = (c: Card) => data.versions?.[c.id] ?? [];
function changedSinceApproved(c: Card): boolean {
  const v = versionsOf(c).find((x) => x.approved);
  return c.kind === "spec" && ["draft", "discussing"].includes(c.status) && !!v && v.body.trim() !== c.body.trim();
}
function compareIndex(c: Card): number {
  const vs = versionsOf(c);
  const sel = compareSel.get(c.id);
  if (sel !== undefined && sel < vs.length) return sel;
  return changedSinceApproved(c) ? vs.findIndex((x) => x.approved) : -1;
}
function versionLabel(vs: (Version & { approved: boolean })[], i: number): string {
  const v = vs[i];
  const who = v.actor === "user" ? "you" : v.actor === "auto" ? "Spill" : "Claude";
  const what = i === vs.length - 1 ? "Current" : v.approved ? "Approved version" : i === 0 ? "First draft" : "Edited";
  return `v${i + 1} ${what}, ${who}, ${ago(v.at)}`;
}
function compareBar(c: Card): HTMLElement | null {
  const vs = versionsOf(c);
  if (vs.length < 2) return null;
  const ci = compareIndex(c);
  const sel = h(
    "select",
    { onchange: (e: Event) => (compareSel.set(c.id, Number((e.target as HTMLSelectElement).value)), render()) },
    h("option", { value: "-1" }, "Nothing, show the spec"),
    vs.slice(0, -1).map((_, i) => h("option", { value: String(i), selected: i === ci ? "" : undefined }, versionLabel(vs, i))),
  ) as HTMLSelectElement;
  sel.value = String(ci);
  const d = ci >= 0 ? lineDiff(vs[ci].body, c.body) : [];
  const add = d.filter((l) => l.op === "add").length;
  const del = d.filter((l) => l.op === "del").length;
  return h("div", { class: "compare" }, h("span", {}, "Compared with"), sel, h("span", { class: "sp" }), ci >= 0 ? h("span", { class: "plus" }, `+${add}`) : null, ci >= 0 ? h("span", { class: "minus" }, `-${del}`) : null);
}
// The diff of the picked version against the current text. Unchanged runs fold into one grey line
// naming their sections; the heading right before a change stays, so each change has its place.
function diffView(c: Card): HTMLElement {
  const vs = versionsOf(c);
  const lines = lineDiff(vs[compareIndex(c)].body, c.body).filter((l) => l.text.trim());
  const out: HTMLElement[] = [];
  const heading = (t: string) => /^#{1,6}\s/.test(t);
  const fold = (run: string[]) => {
    if (!run.length) return;
    const names = run.filter(heading).map((t) => t.replace(/^#+\s*/, ""));
    out.push(h("div", { class: "fold" }, names.length ? `${names.join(", ")} unchanged` : `${run.length} unchanged line${run.length === 1 ? "" : "s"}`));
  };
  let run: string[] = [];
  const flush = (beforeChange: boolean) => {
    const hi = beforeChange ? run.findLastIndex(heading) : -1;
    if (hi < 0) {
      if (run.length <= 2 && beforeChange) run.forEach((t) => out.push(h("div", { class: "dl same" }, h("span", { class: "op" }, ""), h("span", {}, t))));
      else fold(run);
    } else {
      fold(run.slice(0, hi));
      out.push(h("div", { class: "dh" }, run[hi].replace(/^#+\s*/, "")));
      const after = run.slice(hi + 1);
      if (after.length <= 2) after.forEach((t) => out.push(h("div", { class: "dl same" }, h("span", { class: "op" }, ""), h("span", {}, t))));
      else fold(after);
    }
    run = [];
  };
  for (const l of lines) {
    if (l.op === "same") {
      run.push(l.text);
      continue;
    }
    if (run.length) flush(true);
    out.push(h("div", { class: `dl ${l.op}` }, h("span", { class: "op" }, l.op === "add" ? "+" : "-"), h("span", {}, l.text)));
  }
  flush(false);
  return h("div", { class: "diff" }, out);
}

let commentDraft = "";
let commentFocused = false;
let commentError = "";

// A spec being built opens on its activity, the live record of the build.
function defaultTab(id: string): typeof sheetTab {
  const c = data.cards.find((x) => x.id === id);
  return c?.kind === "spec" && c.status === "active" ? "activity" : "overview";
}

let sheetScrollTo: string | null = null;
function openSheet(id: string, pan = false, scrollTo: string | null = null) {
  sheetScrollTo = scrollTo;
  markSeen(id);
  if (scrollTo) sheetTab = "overview";
  if (openId !== id) {
    sheetTab = scrollTo ? "overview" : defaultTab(id);
    sheetFile = null;
    commentDraft = "";
    commentError = "";
  }
  openId = id;
  history.replaceState(null, "", `#${id}`);
  render();
  if (pan) requestAnimationFrame(() => panTo(id));
}
function closeSheet() {
  openId = null;
  history.replaceState(null, "", location.pathname);
  render();
}

// Cards in the same column as the open one, in board order.
function columnOf(id: string): string[] {
  const depth = (el: Element) => { let d = 0; for (let p = el.parentElement; p; p = p.parentElement) if (p.classList.contains("children")) d++; return d; };
  const el = document.querySelector(`#content [data-id="${id}"]`);
  if (!el) return [];
  const d = depth(el);
  return [...document.querySelectorAll<HTMLElement>("#content .card[data-id]")].filter((c) => depth(c) === d).map((c) => c.dataset.id!);
}
function stepSheet(by: number) {
  if (!openId) return;
  const col = columnOf(openId);
  const next = col[col.indexOf(openId) + by];
  if (next) openSheet(next, true);
}

window.addEventListener("keydown", (e) => {
  if (!openId) return;
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea")) return;
  if (e.key === "Escape") closeSheet();
  else if (e.key === "ArrowUp") (e.preventDefault(), stepSheet(-1));
  else if (e.key === "ArrowDown") (e.preventDefault(), stepSheet(1));
});

function esc(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inline(t: string): string {
  return esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}
// Enough markdown for card bodies: headings, numbered and bulleted lists, paragraphs.
function markdown(src: string): HTMLElement {
  const out: string[] = [];
  let list: "ol" | "ul" | null = null;
  const close = () => { if (list) out.push(`</${list}>`); list = null; };
  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    if ((m = /^#{2,}\s+(.*)$/.exec(line))) { close(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if ((m = /^\s*(\d+)\.\s+(.*)$/.exec(line))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li><span class="n">${m[1]}</span><span>${inline(m[2])}</span></li>`); }
    else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  const el = h("div", { class: "md" });
  el.innerHTML = out.join("");
  return el;
}

const LINK_LABEL: Record<string, string> = { blocked_by: "Blocked by", blocks: "Blocks", depends_on: "Depends on", answers: "Answers", answered_by: "Answered by", follows: "Follows", followed_by: "Followed by", replaces: "Replaces", replaced_by: "Replaced by" };

// S-33: an update the user asked for on a done spec, until Claude acts on it.
const updateOf = (c: Card) => (c.kind === "spec" && c.status === "done" ? pendingUpdate(c, data.cards, data.events) : null);

function statusPill(c: Card): HTMLElement {
  if (updateOf(c)) return h("span", { class: "spill-pill st-upd" }, "Update requested");
  const label = c.kind === "spec" ? (SPEC_STATUS_LABEL[c.status] ?? c.status) : c.status[0].toUpperCase() + c.status.slice(1);
  return h("span", { class: `spill-pill st-${c.status}` }, label);
}

function sheetLinks(c: Card): HTMLElement {
  if (!c.links.length) return h("div", { class: "empty-tab" }, "No links.");
  return h(
    "div",
    { class: "links" },
    c.links.map((l) => {
      const t = byId.get(l.target);
      return h(
        "button",
        { class: "linkrow", onclick: () => openSheet(l.target, true) },
        h("span", { class: "k" }, LINK_LABEL[l.type] ?? l.type),
        h("span", { class: "id" }, l.target),
        h("span", { class: "t" }, t?.title ?? ""),
        t ? h("span", { class: "s" }, t.kind === "spec" ? (SPEC_STATUS_LABEL[t.status] ?? t.status) : t.status) : null,
      );
    }),
  );
}

// Activity reads like a log: oldest at the top, newest at the bottom, where the sheet stays scrolled.
// Entries that arrive while it is open slide in, and a spec being built ends in a live row.
const seenEvents = new Map<string, Set<string>>();
function sheetActivity(c: Card): HTMLElement {
  const evs = data.events.filter((e) => e.card === c.id && e.action !== "focus");
  const held = stalledOn(c);
  const building = c.kind === "spec" && c.status === "active";
  if (!evs.length && !building) return h("div", { class: "empty-tab" }, "No activity yet.");
  const verb: Record<string, string> = { comment: "commented", status: "moved it", update: "updated", link: "linked", unlink: "unlinked", record: "recorded", draft_spec: "drafted it", ask: "asked", create: "created it", checks: "ran checks", redirect: "answered", update_request: "asked for an update" };
  const key = (e: SpillEvent) => `${e.at} ${e.action}`;
  const seen = seenEvents.get(c.id);
  seenEvents.set(c.id, new Set(evs.map(key)));
  // "queued -> active: note" or "draft -> approved (auto: reason)": the two statuses as pills, and
  // anything after the new status as its own line under them.
  const status = (d: string) => {
    const m = /^(\S+) -> (\S+?)(?::\s*|\s+|$)([\s\S]*)$/.exec(d);
    if (!m) return h("div", { class: "d" }, d);
    const note = m[3].trim().replace(/^\((.*)\)$/s, "$1");
    return h(
      "div",
      { class: "d" },
      h("div", { class: "move" }, h("span", { class: "st" }, m[1]), h("span", { class: "arr" }, "\u2192"), h("span", { class: "st to" }, m[2])),
      note ? h("div", { class: "note" }, note) : null,
    );
  };
  return h(
    "div",
    { class: "activity" },
    evs.map((e) =>
      h(
        "div",
        { class: `ev ${e.actor}${seen && !seen.has(key(e)) ? " fresh" : ""}` },
        h("span", { class: `who ${e.actor}` }, e.actor === "user" ? "You" : e.actor === "auto" ? "Auto" : "Claude"),
        h("div", { class: "body" }, h("div", { class: "line" }, h("b", {}, verb[e.action] ?? e.action), h("span", { class: "a" }, ago(e.at))), e.detail ? (e.action === "status" ? status(e.detail) : h("div", { class: "d" }, e.detail)) : null),
      ),
    ),
    building
      ? quietFor(c)
        ? h("div", { class: "ev live quiet" }, h("span", { class: "who claude" }, "Claude"), h("div", { class: "body" }, h("div", { class: "line" }, h("b", {}, quietLabel(quietFor(c))), h("span", { class: "a" }, "its session may have stopped"))))
        : held.length
        ? h("div", { class: "ev live held" }, h("span", { class: "who claude" }, "Claude"), h("div", { class: "body" }, h("div", { class: "line" }, h("b", {}, waitingLabel(held)), h("span", { class: "a" }, "your answer lets the build go on"))))
        : h("div", { class: "ev live" }, h("span", { class: "who claude" }, "Claude"), h("div", { class: "body" }, h("div", { class: "line" }, h("b", {}, "building"), h("span", { class: "dots" }, h("i", { style: phase(1200) }), h("i", { style: phase(1200) }), h("i", { style: phase(1200) })))))
      : null,
  );
}

// S-35 / D-20: the files Claude touched building the spec, named "Code" beside the card's own File tab.
const filesOf = (c: Card) => data.files?.[c.id] ?? [];
function sheetCode(c: Card): HTMLElement {
  const files = filesOf(c);
  if (!files.length) return h("div", { class: "empty-tab" }, "No files recorded.");
  return h(
    "div",
    { class: "codefiles" },
    h("div", { class: "note" }, c.status === "replaced" ? "Recorded by Claude while building, and removed when this spec was replaced." : "Recorded by Claude while building. Replacing this spec removes these."),
    files.map((f) => h("div", { class: `frow ${f.change}` }, h("span", { class: "p" }, f.path), h("span", { class: "c" }, f.change))),
  );
}

function sheetFileTab(c: Card): HTMLElement {
  if (sheetFile?.id !== c.id) {
    fetch(`/api/cards/${c.id}/file`).then(async (r) => {
      sheetFile = { id: c.id, text: r.ok ? await r.text() : "Could not read the file." };
      if (openId === c.id && sheetTab === "file") render();
    });
    return h("div", { class: "empty-tab" }, "Loading...");
  }
  return h("pre", { class: "file" }, sheetFile.text);
}

function sheet(): HTMLElement | null {
  const c = openId ? byId.get(openId) : undefined;
  if (!c) return null;
  const sec = c.section ? byId.get(c.section) : undefined;
  const col = columnOf(c.id);
  const pos = col.indexOf(c.id);
  const evs = data.events.filter((e) => e.card === c.id && e.action !== "focus");
  const overviewTab: [typeof sheetTab, string, number | null] = ["overview", "Overview", null];
  const activityTab: [typeof sheetTab, string, number | null] = ["activity", "Activity", evs.length];
  const building = c.kind === "spec" && c.status === "active";
  const tabs: [typeof sheetTab, string, number | null][] = [...(building ? [activityTab, overviewTab] : [overviewTab, activityTab]), ["links", "Links", c.links.length], ...(filesOf(c).length ? [["code", "Code", filesOf(c).length] as [typeof sheetTab, string, number | null]] : []), ["file", "File", null]];
  const p = c.kind === "spec" ? progress(c) : null;
  const body =
    sheetTab === "links" ? sheetLinks(c)
    : sheetTab === "activity" ? sheetActivity(c)
    : sheetTab === "file" ? sheetFileTab(c)
    : sheetTab === "code" ? sheetCode(c)
    : h(
        "div",
        { class: "overview" },
        updateOf(c) ? redirectBox(updateOf(c)!.texts.join("\n\n"), "Your update") : null,
        p && p.total && ["active", "done"].includes(c.status) ? h("div", { class: "built" }, `${p.done} of ${p.total} built`) : null,
        // S-12 req 3: what a decision changed.
        c.kind === "decision" && changedBy(c).length
          ? h("div", { class: "changed" }, "Changed: ", changedBy(c).flatMap((id, i) => [i ? ", " : "", h("button", { class: "qid", onclick: () => openSheet(id, true) }, id)]))
          : null,
        compareBar(c),
        compareIndex(c) >= 0 ? diffView(c) : markdown(c.body),
        checksBox(c),
        c.kind === "question" && c.status === "open" ? (redirectNote(c) !== null ? redirectBox(redirectNote(c)!) : answerForm(c, options(c))) : null,
      );
  // An open question's options are the answer buttons below, not a second list.
  if (c.kind === "question" && c.status === "open" && options(c).length && sheetTab === "overview") body.querySelectorAll(".md ul").forEach((u) => u.remove());

  // A comment can run to several lines: the box grows with it; Enter sends, Shift+Enter breaks the
  // line. Live redraws keep the draft, the focus and the caret.
  // S-33: on a done spec the box asks for an update; while one is open it adds to it.
  const updating = c.kind === "spec" && c.status === "done";
  const pendingUpd = updateOf(c);
  const input = h("textarea", { rows: 1, placeholder: updating ? (pendingUpd ? "Add to the update" : `How should ${c.id} be updated?`) : `Comment to Claude about ${c.id}` }) as HTMLTextAreaElement;
  input.value = commentDraft;
  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight + 2}px`;
  };
  requestAnimationFrame(grow);
  input.oninput = () => {
    commentDraft = input.value;
    grow();
  };
  input.onfocus = () => (commentFocused = true);
  input.onblur = () => setTimeout(() => input.isConnected && (commentFocused = false), 0);
  if (commentFocused)
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
  const send = async () => {
    const text = input.value;
    if (!text.trim()) return;
    commentDraft = "";
    commentError = "";
    input.value = "";
    grow();
    const e = await post(`/api/cards/${c.id}/${updating ? "update" : "comment"}`, { text });
    if (e) {
      commentDraft = text;
      commentError = e;
      render();
    }
  };
  const updateBtn = updating ? (h("button", { class: "btn primary", onclick: send }, pendingUpd ? "Send" : "Update") as HTMLButtonElement) : null;
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
    if (e.key === "Escape") input.blur();
  };
  const acts = c.kind === "spec" ? [specActions(c, () => input.value), revertAction(c, () => input.value)].filter((x): x is HTMLElement => !!x) : [];
  const actions = acts.length ? h("div", { style: "display:flex;flex-direction:column;gap:8px" }, acts) : null;

  return h(
    "aside",
    { class: "sheet" },
    h(
      "div",
      { class: "sheet-head" },
      h(
        "div",
        { class: "meta" },
        h("span", { class: "id" }, c.id),
        sec ? h("span", {}, sec.title) : null,
        h("span", { class: "sp" }),
        pos >= 0 ? h("span", { class: "pos" }, `${pos + 1} of ${col.length}`) : null,
        h("button", { class: "kb", title: "Previous (Up)", disabled: pos <= 0, onclick: () => stepSheet(-1) }, "↑"),
        h("button", { class: "kb", title: "Next (Down)", disabled: pos < 0 || pos >= col.length - 1, onclick: () => stepSheet(1) }, "↓"),
        h("button", { class: "kb", title: "Close (Esc)", onclick: closeSheet }, "Esc"),
      ),
      h("h2", {}, c.title),
      h("div", { class: "prov" }, statusPill(c), changedSinceApproved(c) ? h("span", { class: "spill-pill st-changed" }, "Changed since approved") : null, h("span", {}, provenance(c) ?? "")),
      h(
        "div",
        { class: "tabs" },
        tabs.map(([k, label, n]) => h("button", { class: `tab${sheetTab === k ? " on" : ""}`, onclick: () => ((sheetTab = k), render()) }, label, n ? h("span", {}, String(n)) : null)),
      ),
    ),
    h("div", { class: "sheet-body" }, body),
    h("div", { class: "sheet-foot" }, h("div", { class: `reason comment${updateBtn ? " upd" : ""}` }, input, updateBtn), commentError ? h("div", { class: "err" }, commentError) : null, actions),
  );
}

// ---------- message Claude from the top bar (S-23) ----------

let msgOpen = false;
let msgError = "";
// S-8 / S-30: what is typed in each box, by key: "" is the new message box, else a thread being replied to.
type Draft = { text: string; files: { name: string; type: string; size: number; data: string; url?: string }[] };
const drafts = new Map<string, Draft>();
function draft(key: string): Draft {
  let d = drafts.get(key);
  if (!d) drafts.set(key, (d = { text: "", files: [] }));
  return d;
}
function hasDrafts(): boolean {
  return [...drafts.values()].some((d) => d.text.trim() || d.files.length);
}
let msgSending = false;
// S-30: the ring spins from the moment of sending, before the server has the message.
let msgPending = false;
let replyTo: string | null = null;
let olderShown = 3;
let seenAtOpen = "";
// Cards animate in only on the first build after opening, not on later rebuilds.
let animateIn = false;
let unreadTimer: ReturnType<typeof setTimeout> | null = null;
const expanded = new Set<string>();
let lastReplyAt: string | null = null;
let replyUntil = 0;
let seenReplyAt = (() => {
  try {
    return localStorage.getItem("spill.seenReply") ?? "";
  } catch {
    return "";
  }
})();

const MSG_ICON = `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11A1 1 0 0 1 3 10z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

function messages() {
  return data.messages ?? data.events.filter((e) => e.card === "-" && (e.action === "message" || e.action === "reply"));
}
function latestReply() {
  return [...messages()].reverse().find((e) => e.action === "reply");
}
function markRepliesSeen() {
  const r = latestReply();
  if (!r || r.at <= seenReplyAt) return;
  seenReplyAt = r.at;
  try {
    localStorage.setItem("spill.seenReply", r.at);
  } catch {}
}
function missedReplies() {
  return messages().filter((e) => e.action === "reply" && e.at > seenReplyAt);
}
function openMessage() {
  msgOpen = true;
  msgError = "";
  olderShown = 3;
  animateIn = true;
  seenAtOpen = seenReplyAt;
  replyUntil = 0;
  markRepliesSeen();
  render();
}
function closeMessage() {
  msgOpen = false;
  replyTo = null;
  render();
}

// A reply that arrives while the app is open drops under the bar for 8 seconds.
function trackReply() {
  const r = latestReply();
  if (lastReplyAt === null) lastReplyAt = r?.at ?? "";
  else if (r && r.at !== lastReplyAt) {
    lastReplyAt = r.at;
    replyUntil = Date.now() + 8000;
    // Seen only if it pops up where the user can see it; otherwise it waits as a badge on the button.
    if (document.visibilityState === "visible" && document.hasFocus()) markRepliesSeen();
    setTimeout(render, 8050);
  }
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && msgOpen) return closeMessage();
  if (e.key !== "/" || msgOpen || e.metaKey || e.ctrlKey) return;
  if ((e.target as HTMLElement).closest("input, textarea")) return;
  e.preventDefault();
  openMessage();
});
// S-8 / S-30: clicking away with nothing typed closes all the cards.
window.addEventListener("mousedown", (e) => {
  if (msgOpen && !hasDrafts() && !(e.target as HTMLElement).closest(".fab-wrap")) closeMessage();
});

// ---------- toolbar: project menu and search (S-7) ----------

let menuOpen = false;
let menuSections = false;
let searchOpen = false;
let searchQ = "";
let searchFilter: "needs" | "building" | "questions" | "drafts" | null = null;
let searchSel = 0;
const searchCaret = { start: -1, end: -1 };

const FILTERS: { key: NonNullable<typeof searchFilter>; label: string; test: (c: Card) => boolean }[] = [
  { key: "needs", label: "Needs you", test: needsYou },
  { key: "building", label: "Building", test: (c) => c.kind === "spec" && c.status === "active" },
  { key: "questions", label: "Open questions", test: (c) => c.kind === "question" && c.status === "open" },
  { key: "drafts", label: "Drafts", test: (c) => c.kind === "spec" && c.status === "draft" },
];

function openSearch(filter: typeof searchFilter = null, q = "") {
  searchOpen = true;
  menuOpen = false;
  searchFilter = filter;
  searchQ = q;
  searchSel = 0;
  searchCaret.start = searchCaret.end = -1;
  render();
}
function closeSearch() {
  searchOpen = false;
  render();
}
function searchResults(): Card[] {
  const q = searchQ.trim().toLowerCase();
  const f = FILTERS.find((x) => x.key === searchFilter);
  const rank = (c: Card) => ({ spec: 0, question: 1, decision: 2, section: 3 })[c.kind];
  return data.cards
    .filter((c) => c.kind !== "section" && (!f || f.test(c)) && (!q || c.id.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)))
    .sort((a, b) => rank(a) - rank(b) || Number(b.id.toLowerCase() === q) - Number(a.id.toLowerCase() === q) || num(b.id) - num(a.id));
}
function chooseResult(c: Card) {
  searchOpen = false;
  searchQ = "";
  render();
  requestAnimationFrame(() => panTo(c.id));
}
function resultLabel(c: Card): HTMLElement | null {
  const tag = (t: string, color = "var(--muted)") => h("span", { class: "rl", style: `color:${color}` }, t);
  if (c.kind === "decision") return null;
  if (c.kind === "question") return c.status === "open" ? tag(options(c).length ? (c.select === "multi" ? "Pick any" : "Pick one") : "Needs you", "var(--amber-text)") : tag(c.status === "answered" ? "Answered" : "Dropped");
  if (needsYou(c)) return tag("Needs you", "var(--amber-text)");
  if (c.status === "active") return tag("Building", "var(--text)");
  if (c.status === "approved") return tag("Ready to build", "var(--green-text)");
  if (c.status === "queued") return tag("Queued", "var(--green-text)");
  const q = waitsOn(c).filter((x) => x.kind === "question").length;
  if (q) return tag(`${q} question${q === 1 ? "" : "s"}`);
  return tag(SPEC_STATUS_LABEL[c.status] ?? c.status);
}
function mark(text: string): (string | HTMLElement)[] {
  const q = searchQ.trim();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return i < 0 ? [text] : [text.slice(0, i), h("b", {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}
function cardIcon(c: Card): string {
  if (c.kind === "question") return c.status === "open" ? ICON.question : ICON.questionDone;
  if (c.kind === "decision") return ICON.questionDone;
  return ICON[c.status as keyof typeof ICON] ?? ICON.draft;
}
function searchDrop(): HTMLElement {
  const results = searchResults();
  searchSel = Math.max(0, Math.min(searchSel, results.length - 1));
  const input = h("input", { class: "s-input", placeholder: "Search specs, questions, decisions" }) as HTMLInputElement;
  input.value = searchQ;
  input.oninput = () => {
    searchQ = input.value;
    searchSel = 0;
    searchCaret.start = input.selectionStart ?? -1;
    searchCaret.end = input.selectionEnd ?? -1;
    render();
  };
  input.onkeydown = (e) => {
    if (e.key === "Escape") return closeSearch();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      searchSel = Math.max(0, Math.min(results.length - 1, searchSel + (e.key === "ArrowDown" ? 1 : -1)));
      return render();
    }
    if (e.key === "Enter" && results[searchSel]) chooseResult(results[searchSel]);
  };
  setTimeout(() => {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(searchCaret.start >= 0 ? searchCaret.start : end, searchCaret.end >= 0 ? searchCaret.end : end);
  }, 0);
  const groups: [string, Card[]][] = [
    ["Specs", results.filter((c) => c.kind === "spec")],
    ["Questions", results.filter((c) => c.kind === "question")],
    ["Decisions", results.filter((c) => c.kind === "decision")],
  ];
  let i = -1;
  return h(
    "div",
    { class: "search-drop" },
    h("div", { class: "s-head" }, svg(SEARCH_ICON), input, h("span", { class: "kbd" }, "Esc")),
    h(
      "div",
      { class: "s-filters" },
      FILTERS.map((f) => {
        const n = data.cards.filter(f.test).length;
        return h(
          "button",
          { class: `s-filter${searchFilter === f.key ? " on" : ""}${f.key === "needs" ? " needs" : ""}`, onclick: () => ((searchFilter = searchFilter === f.key ? null : f.key), (searchSel = 0), render()) },
          f.label,
          h("span", {}, String(n)),
        );
      }),
    ),
    h(
      "div",
      { class: "s-results" },
      results.length ? null : h("div", { class: "s-empty" }, "No matches"),
      groups
        .filter(([, cs]) => cs.length)
        .flatMap(([title, cs]) => [
          h("div", { class: "s-group" }, title),
          ...cs.map((c) => {
            const idx = ++i;
            return h(
              "div",
              { class: `s-row${idx === searchSel ? " sel" : ""}`, onmousemove: () => idx !== searchSel && ((searchSel = idx), render()), onclick: () => chooseResult(c) },
              svg(cardIcon(c).replace(/width="16" height="16"/, 'width="14" height="14"')),
              h("span", { class: "id" }, c.id),
              h("span", { class: "t" }, ...mark(c.title)),
              resultLabel(c),
            );
          }),
        ]),
    ),
    h("div", { class: "s-foot" }, h("span", {}, "Enter to focus on canvas"), h("span", {}, "Up and down to move")),
  );
}
function projectMenu(): HTMLElement {
  const secs = data.cards.filter((c) => c.kind === "section");
  const decisions = data.cards.filter((c) => c.kind === "decision").length;
  const item = (label: string, opts: { right?: string; onclick?: () => void; soon?: boolean; chev?: boolean } = {}) =>
    h(
      "button",
      { class: `pm-item${opts.soon ? " soon" : ""}`, disabled: opts.soon ? "" : undefined, title: opts.soon ? "Not available yet" : undefined, onclick: opts.onclick },
      h("span", {}, label),
      h("span", { class: "sp" }),
      opts.soon ? h("span", { class: "r" }, "Soon") : opts.right ? h("span", { class: "r" }, opts.right) : null,
    );
  return h(
    "div",
    { class: "project-menu" },
    h("div", { class: "pm-head" }, h("b", {}, data.project || "Spill"), data.root ? h("span", {}, data.root.replace(/^\/Users\/[^/]+/, "~")) : null),
    item("Switch project", { soon: true }),
    item("Sections", { right: String(secs.length), onclick: () => ((menuSections = !menuSections), render()) }),
    menuSections
      ? h(
          "div",
          { class: "pm-sub" },
          secs.map((sec) =>
            h(
              "button",
              {
                class: "pm-item",
                onclick: () => {
                  menuOpen = false;
                  render();
                  requestAnimationFrame(() => document.querySelector(`[data-sec="${sec.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
                },
              },
              h("span", {}, sec.title),
            ),
          ),
        )
      : null,
    item("Decisions log", { right: String(decisions), onclick: () => openSearch(null, "D-") }),
    item("Open .spill folder", { onclick: () => (post("/api/open-folder", {}), (menuOpen = false), render()) }),
    h("div", { class: "pm-sep" }),
    item("Project settings", { soon: true }),
  );
}
const SEARCH_ICON = `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M9.2 9.2l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
function toolbar(needs: number): HTMLElement {
  return h(
    "div",
    { class: "topbar s7", "data-tauri-drag-region": "" },
    h(
      "button",
      { class: `pm-btn${menuOpen ? " on" : ""}`, onclick: () => ((menuOpen = !menuOpen), (searchOpen = false), (menuSections = false), render()) },
      h("div", { class: "logo" }, "S"),
      h("span", { class: "project" }, data.project || "Spill"),
      svg(`<svg width="12" height="12" viewBox="0 0 12 12"><path d="${menuOpen ? "M3 7.5l3-3 3 3" : "M3 4.5l3 3 3-3"}" fill="none" stroke="#71717A" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`),
    ),
    h("i", { class: "tb-sep" }),
    h(
      "div",
      { class: "s-field", onclick: () => openSearch() },
      svg(SEARCH_ICON),
      h("span", { class: "ph" }, "Search specs, questions, decisions"),
      live ? null : h("span", { class: "offline" }, "Offline"),
      needs ? h("button", { class: "needs", title: "Needs you", onclick: (e: Event) => (e.stopPropagation(), openSearch("needs")) }, h("i", {}), String(needs)) : null,
      h("span", { class: "kbd" }, "Cmd K"),
    ),
  );
}
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    searchOpen ? closeSearch() : openSearch();
  }
});
window.addEventListener("mousedown", (e) => {
  if ((menuOpen || searchOpen) && !(e.target as HTMLElement).closest(".bar-wrap")) {
    menuOpen = searchOpen = false;
    render();
  }
});

// ---------- corner message button (S-8) ----------

function addFiles(key: string, list: FileList | File[]) {
  for (const f of Array.from(list)) {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).split(",")[1] ?? "";
      draft(key).files.push({ name: f.name || "pasted.png", type: f.type, size: f.size, data, url: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined });
      render();
    };
    reader.readAsDataURL(f);
  }
}
async function sendMessage(key: string) {
  const d = draft(key);
  if (msgSending || (!d.text.trim() && !d.files.length)) return;
  msgSending = msgPending = true;
  render();
  const err = await post("/api/message", { text: d.text, files: d.files.map((f) => ({ name: f.name, data: f.data })), ...(key ? { thread: key } : {}) });
  msgSending = false;
  if (err) {
    msgError = err;
    msgPending = false;
    return render();
  }
  d.files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
  drafts.delete(key);
  if (key) replyTo = null;
  msgError = "";
  await load();
  msgPending = false;
  render();
}
function size(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
const caret = { start: -1, end: -1 };
// S-30: key "" is the new message box card; a thread id is the reply box inside that thread's card.
function messageBox(key: string): HTMLElement {
  const d = draft(key);
  const input = h("textarea", { class: "fab-input", rows: "1", placeholder: key ? "Reply" : "New message" }) as HTMLTextAreaElement;
  input.value = d.text;
  const fit = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  };
  input.oninput = () => {
    d.text = input.value;
    send.disabled = !d.text.trim() && !d.files.length;
    fit();
  };
  input.onfocus = () => {
    if ((replyTo ?? "") !== key) (replyTo = key || null), (caret.start = caret.end = -1);
  };
  input.onkeydown = (e) => {
    if (e.key === "Escape") return closeMessage();
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage(key);
    }
  };
  input.onpaste = (e) => {
    const files = e.clipboardData?.files;
    if (files?.length) {
      e.preventDefault();
      addFiles(key, files);
    }
  };
  input.onselect = input.onkeyup = input.onclick = () => ((caret.start = input.selectionStart), (caret.end = input.selectionEnd));
  const picker = h("input", { type: "file", multiple: "", style: "display:none" }) as HTMLInputElement;
  picker.onchange = () => picker.files && addFiles(key, picker.files);
  const send = h(
    "button",
    { class: "send", title: "Send", disabled: !d.text.trim() && !d.files.length ? "" : undefined, onclick: () => sendMessage(key) },
    svg(`<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 11V3M3.5 6.5L7 3l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`),
  ) as HTMLButtonElement;
  const box: HTMLElement = h(
    "div",
    {
      class: `fab-box${key ? " reply" : ""}`,
      ondragover: (e: DragEvent) => (e.preventDefault(), box.classList.add("drop")),
      ondragleave: () => box.classList.remove("drop"),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        box.classList.remove("drop");
        if (e.dataTransfer?.files.length) addFiles(key, e.dataTransfer.files);
      },
    },
    d.files.length
      ? h(
          "div",
          { class: "fab-files" },
          d.files.map((f, i) =>
            h(
              "div",
              { class: f.url ? "thumb" : "chip", title: `${f.name}, ${size(f.size)}` },
              f.url ? h("img", { src: f.url, alt: f.name }) : h("span", {}, f.name),
              h("button", { class: "x", title: "Remove", onclick: () => (d.files.splice(i, 1), render()) }, "x"),
            ),
          ),
        )
      : null,
    input,
    msgError && (replyTo ?? "") === key ? h("div", { class: "err" }, msgError) : null,
    h(
      "div",
      { class: "fab-row" },
      h("button", { class: "attach", title: "Attach files", onclick: () => picker.click() }, svg(`<svg width="16" height="16" viewBox="0 0 16 16"><path d="M10.5 4.5l-5 5a1.5 1.5 0 0 0 2.1 2.1l5.3-5.3a3 3 0 0 0-4.2-4.2L3.4 7.4a4.5 4.5 0 0 0 6.4 6.4l3.7-3.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`)),
      picker,
      h("span", { class: "sp" }),
      h("span", { class: "hint" }, "Enter to send"),
      send,
    ),
  );
  // Only the box being typed in takes focus on a redraw.
  if ((replyTo ?? "") === key)
    setTimeout(() => {
      fit();
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(caret.start >= 0 ? Math.min(caret.start, end) : end, caret.end >= 0 ? Math.min(caret.end, end) : end);
    }, 0);
  else setTimeout(fit, 0);
  return box;
}

// S-30: a message's own text and the files attached to it ("text [attached: p1, p2]").
function splitAttached(detail: string): { text: string; files: string[] } {
  const m = /\s*\[attached: (.+)\]$/.exec(detail);
  return m ? { text: detail.slice(0, m.index).trim(), files: m[1].split(", ") } : { text: detail.trim(), files: [] };
}
function attachmentEl(path: string): HTMLElement {
  const name = path.split("/").pop() ?? path;
  const shown = name.replace(/^[\dTZ-]+-(\d+-)?/, "");
  return /\.(png|jpe?g|gif|webp)$/i.test(name)
    ? h("div", { class: "thumb", title: shown }, h("img", { src: `/api/attachments/${encodeURIComponent(name)}`, alt: shown }))
    : h("div", { class: "chip", title: shown }, h("span", {}, shown));
}
// S-30: one thread as an isolated card. Your messages are faint captions; Claude's replies are the
// content, each one row in its own box until clicked.
function threadCard(t: Thread, latestUser: string | undefined): HTMLElement {
  const rows: HTMLElement[] = [];
  t.items.forEach((e, i) => {
    if (e.action === "message") {
      const m = splitAttached(e.detail ?? "");
      // The prompt unwraps while one of its replies is expanded.
      const next = t.items.findIndex((x, j) => j > i && x.action === "message");
      const open = t.items.slice(i + 1, next < 0 ? undefined : next).some((x) => expanded.has(x.at));
      rows.push(
        h(
          "div",
          { class: `th-cap${open ? " open" : ""}` },
          h("span", { class: "t" }, m.text || (m.files.length ? `${m.files.length} file${m.files.length === 1 ? "" : "s"}` : "")),
          i === 0 ? h("span", { class: "a" }, ago(t.items.at(-1)!.at).replace(" ago", "")) : null,
          i === 0 ? h("button", { class: "th-reply", onclick: () => ((replyTo = t.id), (caret.start = caret.end = -1), render()) }, "Reply") : null,
        ),
      );
      if (m.files.length) rows.push(h("div", { class: "fab-files th-files" }, m.files.map(attachmentEl)));
    } else {
      const open = expanded.has(e.at);
      rows.push(
        h(
          "div",
          { class: `th-resp${open ? " open" : ""}${e.at > seenAtOpen ? " new" : ""}` },
          h("div", { class: "x" }, e.detail ?? ""),
        ),
      );
    }
  });
  // Only the thread holding your latest message can still be in progress.
  if (t.open && latestUser && t.items.at(-1)!.at === latestUser && (data.messageState || msgPending)) rows.push(h("div", { class: "th-resp working" }, svg(SPINNER), "Working"));
  if (replyTo === t.id) rows.push(messageBox(t.id));
  // Clicking anywhere on the card (not its buttons or reply box) expands or collapses the whole thread.
  const replies = t.items.filter((e) => e.action === "reply").map((e) => e.at);
  const toggle = (ev: Event) => {
    if ((ev.target as HTMLElement).closest("button, a, .fab-box") || !replies.length) return;
    const anyOpen = replies.some((at) => expanded.has(at));
    for (const at of replies) anyOpen ? expanded.delete(at) : expanded.add(at);
    render();
  };
  return h("div", { class: `th-card${replyTo === t.id ? " replying" : ""}`, "data-thread": t.id, onclick: toggle }, rows);
}
// The corner cards live outside #app and are rebuilt only when what they show changes, so board
// updates do not re-create (and re-animate, refocus or re-scroll) them.
const fabRoot = document.body.appendChild(document.createElement("div"));
let fabKey = "";
function updateFab() {
  const msgs = messages();
  const key = JSON.stringify([
    msgOpen, replyTo, olderShown, [...expanded], msgs.length, msgs.at(-1)?.at, data.messageState, msgPending, msgSending, msgError, seenAtOpen,
    [...drafts].map(([k, d]) => [k, d.files.length]), missedReplies().length, Date.now() < replyUntil,
  ]);
  if (key === fabKey && fabRoot.firstChild) return;
  fabKey = key;
  fabRoot.replaceChildren(fab());
}
function fab(): HTMLElement {
  const missed = missedReplies().length;
  const r = latestReply();
  const state = data.messageState ?? (msgPending ? "received" : null);
  const button = h(
    "button",
    { class: `fab${state ? ` ${state}` : ""}`, title: state === "working" ? "Claude is working on your message" : state === "received" ? "Message received" : "Message Claude (/)", onclick: () => (msgOpen ? closeMessage() : openMessage()) },
    svg(MSG_ICON.replace('width="16" height="16"', 'width="20" height="20"')),
    missed ? h("span", { class: "badge" }, String(missed)) : null,
  );
  if (!msgOpen)
    return h("div", { class: "fab-wrap" }, r && Date.now() < replyUntil ? h("div", { class: "fab-pop", onclick: openMessage }, h("b", {}, "Claude "), r.detail ?? "") : null, button);
  const enter = animateIn;
  animateIn = false;
  const all = threads(data.messages ?? data.events);
  // Unread replies are tinted while the cards are open, then marked read after a few seconds.
  const newest = latestReply()?.at ?? "";
  if (newest > seenAtOpen && !unreadTimer)
    unreadTimer = setTimeout(() => {
      unreadTimer = null;
      seenAtOpen = newest;
      markRepliesSeen();
      if (msgOpen) render();
    }, 3000);
  const shown = all.slice(-olderShown);
  const older = all.length - shown.length;
  const latestUser = (data.messages ?? data.events).findLast((e) => e.card === "-" && e.action === "message")?.at;
  // The button hides while the cards are open; the box takes its place. Stacked bottom up, so the newest thread sits on the new message box and overflow scrolls from the bottom.
  return h(
    "div",
    { class: "fab-wrap open" },
    h(
      "div",
      { class: `fab-stack${enter ? " enter" : ""}` },
      messageBox(""),
      [...shown].reverse().map((t) => threadCard(t, latestUser)),
      older > 0 ? h("button", { class: "th-older", onclick: () => ((olderShown += 3), render()) }, `Show older (${older})`) : null,
    ),
  );
}

// ---------- new spec notices (S-1) ----------

let knownSpecs: Set<string> | null = null;
let notice: { ids: string[]; at: number; until: number } | null = null;
const entered = new Map<string, number>();

function trackNewSpecs() {
  const specs = data.cards.filter((c) => c.kind === "spec").map((c) => c.id);
  if (!knownSpecs) {
    knownSpecs = new Set(specs); // req 7: what exists at open does not notify
    return;
  }
  const fresh = specs.filter((id) => !knownSpecs!.has(id));
  if (!fresh.length) return;
  for (const id of fresh) {
    knownSpecs.add(id);
    entered.set(id, Date.now());
    toReveal.add(id);
  }
  const now = Date.now();
  // req 5: specs within 3 seconds of the first share one notice.
  if (notice && now - notice.at < 3000 && now < notice.until) notice = { ids: [...notice.ids, ...fresh], at: notice.at, until: now + 8000 };
  else notice = { ids: fresh, at: now, until: now + 8000 };
  setTimeout(render, 8050);
  // req 6: the OS hears about it only when Spill is in the background.
  if (document.hidden || !document.hasFocus()) {
    const first = byId.get(fresh[0]);
    const n = notice.ids.length;
    post("/api/notify", { title: n > 1 ? `${n} specs added` : `${first?.id} added`, body: n > 1 ? notice.ids.join(", ") : `${first?.title ?? ""} (by ${firstEvent(fresh[0])?.actor === "user" ? "you" : "Claude"})` });
  }
}

function noticeDrop(): HTMLElement | null {
  if (!notice || Date.now() > notice.until) return null;
  const n = notice.ids.length;
  const first = byId.get(notice.ids[0]);
  const who = firstEvent(notice.ids[0])?.actor === "user" ? "you" : "Claude";
  const show = () => {
    const id = notice!.ids[0];
    notice = null;
    openSheet(id, true);
  };
  return h(
    "div",
    { class: "msg-drop notice" },
    h("span", { class: "who" }, n > 1 ? `${n} specs added` : `${first?.id} added`),
    h("span", { class: "t" }, n > 1 ? notice.ids.join(", ") : `${first?.title ?? ""}, by ${who}`),
    h("button", { class: "show", onclick: show }, "Show"),
  );
}

function messageDrop(): HTMLElement | null {
  return notice && Date.now() < notice.until ? noticeDrop() : null;
}

// ---------- page ----------

let live = false;

function render() {
  const app = document.getElementById("app")!;
  const prev = document.getElementById("canvas");
  const scroll = prev ? { left: prev.scrollLeft, top: prev.scrollTop } : null;

  byId.clear();
  for (const c of data.cards) byId.set(c.id, c);
  trackDone();
  trackApproved();
  trackReply();
  trackNewSpecs();
  const tree = buildTree();

  const sections = data.cards.filter((c) => c.kind === "section");
  const groups: { key: string; title: string; color: string; roots: Node[] }[] = sections.map((s, i) => ({
    key: s.id,
    title: s.title,
    color: SECTION_COLORS[i % SECTION_COLORS.length],
    roots: tree.filter((n) => (n.card.section ?? "") === s.id),
  }));
  const loose = tree.filter((n) => !n.card.section || !byId.has(n.card.section));
  if (loose.length) groups.push({ key: "none", title: "No section", color: "#A1A1AA", roots: loose });
  sectionOf.clear();
  for (const g of groups) for (const c of g.roots.flatMap(subtree)) sectionOf.set(c.id, g.key);
  openSections();

  // Column 1 sits one indent (48px) right of the section headers.
  const content = h(
    "div",
    { id: "content" },
    // Only the spec column is titled; the group titles name what each branch holds.
    h("div", { class: "coltitle", style: "left:296px" }, h("b", {}, "Specs"), h("span", {}, String(tree.filter((n) => n.card.kind === "spec").length))),
    groups.filter((g) => g.roots.length).map((g) => sectionEl(g.key, g.title, g.color, g.roots)),
  );

  const spot = spotlightPanel();
  const rejected = rejectionsPanel();
  const canvas = h("div", { id: "canvas", class: data.focus || data.cards.some((c) => stalledOn(c).length) ? "spotlit" : "" }, content);
  enablePan(canvas);
  canvas.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("button, input, textarea, a, .waits, .pill, .checks.run, .checks.pass, .checks.fail")) return;
    const card = t.closest<HTMLElement>(".card[data-id]");
    if (card) openSheet(card.dataset.id!);
    // S-22 req 9: a click on empty canvas closes the sheet; the end of a drag-pan does not.
    else if (openId && !panMoved && !t.closest(".sechead, .coltitle")) closeSheet();
  });
  if (openId && !byId.has(openId)) openId = null;
  document.body.classList.toggle("sheet-open", !!openId);
  if (openId) content.querySelector(`[data-id="${openId}"]`)?.classList.add("selected");
  const prevBody = document.querySelector(".sheet-body");
  const sameSheet = !!prevBody && prevBody.closest(".sheet")?.getAttribute("data-for") === `${openId}:${sheetTab}`;
  let sheetScroll = sameSheet ? prevBody!.scrollTop : 0;
  // Activity sticks to its newest entry unless the user has scrolled up to read.
  if (sheetTab === "activity" && (!sameSheet || prevBody!.scrollHeight - prevBody!.scrollTop - prevBody!.clientHeight < 40)) sheetScroll = Infinity;
  const side = sheet();
  side?.setAttribute("data-for", `${openId}:${sheetTab}`);
  // The slide-in plays when a sheet opens, not on every live update while it stays open.
  if (side && prevBody?.closest(".sheet")?.getAttribute("data-for")?.startsWith(`${openId}:`)) side.classList.add("stay");

  const open = data.cards.filter(needsYou).length;
  const topbar = toolbar(open);

  // S-31 req 1: every group with something in it, in a fixed order, under the counts row.
  const panelGroups = [rejected, spot, pendingGroup(), upNextGroup(), lastBuiltGroup(), decisionsGroup()].filter(Boolean);
  const strip = panelGroups.length ? h("div", { class: `strip${panelCollapsed ? " collapsed" : ""}` }, countsRow(), ...(panelCollapsed ? [] : panelGroups)) : null;

  const chrome = h("div", { class: "chrome", "data-tauri-drag-region": "" }, h("div", { class: "bar-wrap" }, searchOpen ? searchDrop() : topbar, menuOpen ? projectMenu() : searchOpen ? null : messageDrop()));
  updateFab();
  app.replaceChildren(canvas, chrome, ...(strip ? [strip] : []), ...(side ? [side] : []), ...(data.cards.length ? [] : [h("div", { class: "empty" }, "No cards yet. Claude adds them through the spill MCP server.")]));
  if (scroll) {
    canvas.scrollLeft = scroll.left;
    canvas.scrollTop = scroll.top;
  }
  requestAnimationFrame(() => drawLines(content));
  if (side) side.querySelector(".sheet-body")!.scrollTop = sheetScroll === Infinity ? 1e9 : sheetScroll;
  if (side && sheetScrollTo === "checks") {
    sheetScrollTo = null;
    const target = [...side.querySelectorAll(".md h4")].find((x) => /acceptance checks/i.test(x.textContent ?? "")) ?? side.querySelector(".checkbox");
    target?.scrollIntoView({ block: "start" });
  }

  // When the spotlight moves (Claude sets a new focus, a card leaves it as done or answered, or a
  // question starts holding the active spec), show it again and pan to its first card, once.
  const f = data.focus;
  const held = data.cards.flatMap((c) => stalledOn(c))[0]?.id;
  const first = held ?? f?.discussing[0] ?? f?.next[0];
  if (first && `${f?.at ?? ""} ${first}` !== spotSeen) {
    spotSeen = `${f?.at ?? ""} ${first}`;
    // Instant, so a render right after (the live connection opening) keeps the position.
    requestAnimationFrame(() => panTo(first, false));
  }
}

// Drag empty canvas to pan. Window listeners are added once and follow the current canvas.
let pan: { el: HTMLElement; x: number; y: number; l: number; t: number } | null = null;
let panMoved = false;
function enablePan(canvas: HTMLElement) {
  canvas.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest(".card, .sechead, button, input, textarea")) return;
    pan = { el: canvas, x: e.clientX, y: e.clientY, l: canvas.scrollLeft, t: canvas.scrollTop };
    panMoved = false;
    canvas.classList.add("panning");
  });
}
window.addEventListener("mousemove", (e) => {
  if (!pan) return;
  if (Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 4) panMoved = true;
  pan.el.scrollLeft = pan.l - (e.clientX - pan.x);
  pan.el.scrollTop = pan.t - (e.clientY - pan.y);
});
window.addEventListener("mouseup", () => {
  pan?.el.classList.remove("panning");
  pan = null;
});

// A redraw replaces every card, so one landing between mousedown and mouseup would swallow the click.
// Live updates wait until the button is released.
let mouseDown = false;
let renderPending = false;
window.addEventListener("mousedown", () => (mouseDown = true), true);
window.addEventListener("mouseup", () => {
  mouseDown = false;
  if (renderPending) {
    renderPending = false;
    setTimeout(render, 0);
  }
});

// The spotlight Claude set can go stale: an answered question or a finished spec leaves it on its
// own, and with nothing left the spotlight goes away.
function pruneFocus() {
  const f = data.focus;
  if (!f) return;
  const live = (id: string) => {
    const c = data.cards.find((x) => x.id === id);
    if (!c) return false;
    if (c.kind === "question") return c.status === "open";
    if (c.kind === "spec") return !["done", "rejected", "replaced"].includes(c.status);
    return true;
  };
  const discussing = f.discussing.filter(live);
  // A card being built or discussed has moved past "next"; the one after it is next.
  const next = f.next.filter((id) => live(id) && !discussing.includes(id) && data.cards.find((x) => x.id === id)?.status !== "active");
  // The note describes the spotlight as Claude set it, so it goes once any card has left.
  const pruned = discussing.length < f.discussing.length || f.next.some((id) => !live(id));
  data.focus = discussing.length || next.length ? { ...f, discussing, next, note: pruned ? "" : f.note } : null;
}

async function load() {
  const r = await fetch("/api/board");
  const first = !data.cards.length;
  data = await r.json();
  pruneFocus();
  // A sheet opened from the URL picks its tab once the board is known.
  if (first && openId) sheetTab = defaultTab(openId);
  if (mouseDown) renderPending = true;
  else render();
}

function connect() {
  const es = new EventSource("/api/stream");
  es.onopen = () => {
    live = true;
    load();
  };
  es.onmessage = (e) => {
    if (e.data === "change") load();
  };
  es.onerror = () => {
    if (live) {
      live = false;
      render();
    }
  };
}

window.addEventListener("resize", () => {
  const content = document.getElementById("content");
  if (content) drawLines(content);
});

load().then(() => {
  // A reload with #ID reopens that card (S-22); bring it into view, after the spotlight's own pan.
  if (openId) requestAnimationFrame(() => requestAnimationFrame(() => openId && panTo(openId, false)));
  connect();
});
