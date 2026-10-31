import type { Card, SpillEvent } from "../src/store";

interface BoardData {
  project: string;
  cards: Card[];
  events: SpillEvent[];
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
  active: `<svg width="16" height="16" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke="#16A34A" stroke-width="1.5"/><path d="M7 2.5a4.5 4.5 0 0 1 0 9z" fill="#16A34A"/></svg>`,
  draft: `<svg width="16" height="16" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke="#A1A1AA" stroke-width="1.4" stroke-dasharray="2.2 2"/></svg>`,
  discussing: `<svg width="16" height="16" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke="#D97706" stroke-width="1.4"/><path d="M7 4v3.2l2 1.3" fill="none" stroke="#D97706" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  rejected: `<svg width="16" height="16" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke="#A1A1AA" stroke-width="1.4"/><path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" stroke="#A1A1AA" stroke-width="1.4" stroke-linecap="round"/></svg>`,
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
  approved: "Certified",
  active: "Claude building",
  rejected: "Rejected",
  done: "Done",
};

// ---------- data helpers ----------

let data: BoardData = { project: "", cards: [], events: [] };
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

function isNew(c: Card): boolean {
  const e = firstEvent(c.id);
  return !!e && e.actor === "claude" && Date.now() - new Date(e.at).getTime() < 30 * 60 * 1000;
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
  const m = /##\s*Requirements\s*\n([\s\S]*?)(\n##|$)/.exec(c.body);
  return m ? (m[1].match(/^\d+\./gm) ?? []).length : 0;
}

function hasChecks(c: Card): boolean {
  return /##\s*Acceptance checks/.test(c.body);
}

function isOpen(c: Card | undefined): boolean {
  if (!c) return false;
  if (c.kind === "question") return c.status === "open";
  if (c.kind === "spec") return !["approved", "active", "done"].includes(c.status);
  return false;
}

// Cards this card waits on (S-14): open blockers only.
function waitsOn(c: Card): Card[] {
  return linksOf(c, "blocked_by")
    .map((id) => byId.get(id))
    .filter((b): b is Card => isOpen(b));
}

function blocksOpen(c: Card): Card[] {
  return data.cards.filter((o) => waitsOn(o).some((b) => b.id === c.id));
}

function needsYou(c: Card): boolean {
  return (c.kind === "question" && c.status === "open") || (c.kind === "spec" && c.status === "discussing");
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
  return roots.sort(order).map((c) => make(c, 0));
}

function maxDepth(nodes: Node[]): number {
  return nodes.reduce((m, n) => Math.max(m, n.depth, maxDepth(n.children)), 0);
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
function panTo(id: string) {
  const el = document.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

// ---------- cards ----------

function checkRow(c: Card): HTMLElement | null {
  if (c.kind !== "spec" || !hasChecks(c)) return null;
  // Q-5 decides where results come from; until then nothing has run.
  return h("div", { class: "checks" }, h("i", { class: "dot", style: "background:#D4D4D8" }), "No checks run");
}

function blockMarkers(c: Card): HTMLElement | null {
  const waits = waitsOn(c);
  const blocks = blocksOpen(c);
  if (!waits.length && !blocks.length) return null;
  return h(
    "div",
    { class: "foot" },
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

function specActions(c: Card): HTMLElement | null {
  if (!["draft", "discussing"].includes(c.status)) return null;
  const wrap = h("div", { class: "actions-wrap", style: "display:flex;flex-direction:column;gap:6px" });
  const err = h("div", { class: "err" });
  const approve = h("button", { class: "btn primary" }, "Approve") as HTMLButtonElement;
  const reject = h("button", { class: "btn" }, "Reject") as HTMLButtonElement;
  approve.onclick = async () => {
    approve.disabled = reject.disabled = true;
    const e = await post(`/api/cards/${c.id}/approve`, {});
    if (e) {
      err.textContent = e;
      approve.disabled = reject.disabled = false;
    }
  };
  reject.onclick = () => {
    const input = h("input", { placeholder: "Why reject it?" }) as HTMLInputElement;
    const confirm = h("button", { class: "btn", style: "flex:0 0 auto;padding:0 12px" }, "Reject") as HTMLButtonElement;
    const send = async () => {
      confirm.disabled = true;
      const e = await post(`/api/cards/${c.id}/reject`, { reason: input.value });
      if (e) {
        err.textContent = e;
        confirm.disabled = false;
      }
    };
    confirm.onclick = send;
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") send();
      if (ev.key === "Escape") render();
    };
    wrap.replaceChildren(h("div", { class: "reason" }, input, confirm), err);
    input.focus();
  };
  wrap.append(h("div", { class: "actions" }, approve, reject), err);
  return wrap;
}

function specCard(c: Card): HTMLElement {
  const isNewDraft = c.status === "draft" && isNew(c);
  const icon = ICON[c.status as keyof typeof ICON] ?? ICON.draft;
  const sec = c.section ? byId.get(c.section) : undefined;
  let status: HTMLElement;
  if (c.status === "approved") status = h("span", { class: "pill", style: "background:#16A34A;color:#fff" }, "Certified");
  else if (isNewDraft) status = h("span", { class: "pill", style: "background:var(--indigo-bg);color:var(--indigo-text)" }, h("i", { class: "dot", style: "background:var(--indigo)" }), "New");
  else
    status = h(
      "span",
      { class: "status", style: c.status === "active" ? "color:var(--green-text);font-weight:600" : c.status === "discussing" ? "color:var(--amber-text);font-weight:600" : "" },
      SPEC_STATUS_LABEL[c.status] ?? c.status,
    );

  const st = lastStatusEvent(c);
  const facts: HTMLElement[] = [];
  const reqs = requirementsCount(c);
  if (reqs && c.status !== "done") facts.push(h("div", { class: "row" }, h("span", { class: "k" }, "Scope"), h("span", {}, `${reqs} requirements`)));
  if (c.status === "rejected" && st?.detail?.includes(": "))
    facts.push(h("div", { class: "row" }, h("span", { class: "k" }, "Reason"), h("span", {}, st.detail.split(": ").slice(1).join(": "))));

  let foot: string | null = provenance(c);
  if (st && ["approved", "rejected"].includes(c.status) && st.actor === "user") foot = `${c.status === "approved" ? "Approved" : "Rejected"} by you, ${ago(st.at)}`;

  return h(
    "div",
    { class: `card spec s-${c.status}${isNewDraft ? " is-new" : ""}`, "data-id": c.id },
    h("div", { class: "head" }, svg(icon), h("span", { class: "id" }, c.id), h("span", { class: "sp" }), status),
    h("div", { style: "display:flex;flex-direction:column;gap:4px" }, h("div", { class: "title" }, c.title), whyLine(c) ? h("div", { class: "why" }, whyLine(c)) : null),
    facts.length && c.status !== "approved" ? h("div", { class: "facts" }, facts) : null,
    specActions(c),
    blockMarkers(c),
    foot || sec ? h("div", { class: "foot" }, foot ? h("span", {}, foot) : null, h("span", { class: "sp" }), c.status === "approved" && sec ? h("span", {}, sec.title) : null) : null,
    checkRow(c),
  );
}

function questionCard(c: Card): HTMLElement {
  const opts = options(c);
  const open = c.status === "open";
  const answeredBy = linksOf(c, "answered_by")[0];
  const statusText = open ? "Needs you" : c.status === "answered" ? `Answered${answeredBy ? ` in ${answeredBy}` : ""}` : "Dropped";
  const blocks = linksOf(c, "blocks");
  const intro = c.body.split(/\n\s*\n/)[0]?.trim() ?? "";
  return h(
    "div",
    { class: `card question q-${c.status}`, "data-id": c.id },
    h(
      "div",
      { class: "head" },
      svg(open ? ICON.question : ICON.questionDone),
      h("span", { class: "id" }, c.id),
      open ? h("span", { class: "kindpill" }, opts.length ? `Pick one of ${opts.length}` : "Yes or no") : null,
      h("span", { class: "sp" }),
      h("span", { class: "status" }, statusText),
    ),
    h("div", { class: "title" }, c.title),
    open && opts.length
      ? h("div", { class: "options" }, opts.map((o) => h("div", { class: "opt" }, h("span", { class: "l" }, o.letter), h("span", {}, o.text))))
      : open && intro
        ? h("div", { class: "proposal" }, h("span", { class: "k" }, "Context"), h("span", {}, intro))
        : null,
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
    { class: "card decision", "data-id": c.id },
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
    { class: `node depth${n.depth}` },
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
function toggleSection(key: string) {
  collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
  try {
    localStorage.setItem("spill.collapsed", JSON.stringify([...collapsed]));
  } catch {}
  render();
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
    { class: `section${isCollapsed ? " collapsed" : ""}` },
    h(
      "div",
      { class: "sechead", onclick: () => toggleSection(key) },
      svg(ICON.chev),
      h("i", { class: "sq", style: `background:${color}` }),
      h("span", { class: "name" }, title),
      h("span", { class: "n" }, `${specs} spec${specs === 1 ? "" : "s"}${isCollapsed ? ", collapsed" : ""}`),
      needs ? h("span", { class: "needs" }, `${needs} needs you`) : null,
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
    if (c.status === "approved" || c.status === "active") return "#22A55B";
    if (c.status === "discussing") return "#F59E0B";
    if (isNew(c)) return "#818CF8";
    return "#D4D4D8";
  };
  const dotColor = (c: Card) => (c.kind === "spec" && ["approved", "active"].includes(c.status) ? "#22A55B" : c.kind === "question" && c.status === "open" ? "#F59E0B" : "#A1A1AA");

  for (const nodeDiv of content.querySelectorAll<HTMLElement>(".node")) {
    const parentCard = nodeDiv.querySelector(":scope > .card") as HTMLElement;
    const kids = nodeDiv.querySelectorAll<HTMLElement>(":scope > .children > .node > .card");
    if (!kids.length || !parentCard.offsetParent) continue;
    const pr = parentCard.getBoundingClientRect();
    const x1 = pr.right - box.left;
    const y1 = pr.top - box.top + 26;
    const pc = byId.get(parentCard.dataset.id!)!;
    kids.forEach((k, i) => {
      const kr = k.getBoundingClientRect();
      const x2 = kr.left - box.left;
      const y2 = kr.top - box.top + 20;
      const c = byId.get(k.dataset.id!)!;
      const mx = x1 + 24 + Math.min(i, 6) * 6;
      const r = 10;
      const d =
        Math.abs(y2 - y1) < 28
          ? `M${x1} ${y1} C${x1 + 28} ${y1} ${x1 + 28} ${y2} ${x2} ${y2}`
          : `M${x1} ${y1} H${mx - r} Q${mx} ${y1} ${mx} ${y1 + r} V${y2 - r} Q${mx} ${y2} ${mx + r} ${y2} H${x2}`;
      paths.push(`<path d="${d}" stroke="${color(c)}"/>`);
    });
    paths.push(`<circle cx="${x1}" cy="${y1}" r="3" fill="#fff" stroke="${dotColor(pc)}"/>`);
  }
  const el = svg(`<svg id="lines" width="${W}" height="${H}" fill="none" stroke-width="1.5">${paths.join("")}</svg>`);
  content.prepend(el);
}

// ---------- page ----------

let live = false;

function render() {
  const app = document.getElementById("app")!;
  const prev = document.getElementById("canvas");
  const scroll = prev ? { left: prev.scrollLeft, top: prev.scrollTop } : null;

  byId.clear();
  for (const c of data.cards) byId.set(c.id, c);
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

  const depth = maxDepth(tree);
  const titles = ["Specs", "Branches", "Next level"];
  const subs = ["", "Questions, decisions, child specs", "From branches"];
  const colX = (d: number) => (d === 0 ? 0 : 280 + 64 + (d - 1) * (360 + 64));
  const content = h(
    "div",
    { id: "content" },
    Array.from({ length: depth + 1 }, (_, d) =>
      h("div", { class: "coltitle", style: `left:${296 + colX(d)}px` }, h("b", {}, titles[d] ?? `Level ${d + 1}`), h("span", {}, d === 0 ? String(tree.filter((n) => n.card.kind === "spec").length) : (subs[d] ?? ""))),
    ),
    groups.filter((g) => g.roots.length).map((g) => sectionEl(g.key, g.title, g.color, g.roots)),
  );

  const canvas = h("div", { id: "canvas" }, content);
  enablePan(canvas);

  const open = data.cards.filter(needsYou).length;
  const topbar = h(
    "div",
    { class: "topbar" },
    h("div", { class: "logo" }, "S"),
    h("span", { class: "project" }, data.project || "Spill"),
    h("span", { class: `live${live ? "" : " off"}` }, h("i", {}), live ? "Live" : "Offline"),
    h("span", { class: "counts" }, `${data.cards.filter((c) => c.kind === "spec").length} specs`, open ? h("b", {}, `, ${open} need you`) : null),
  );

  const decisions = data.cards.filter((c) => c.kind === "decision").sort((a, b) => num(b.id) - num(a.id));
  const strip = decisions.length
    ? h(
        "div",
        { class: "strip" },
        h("div", { class: "hd" }, h("b", {}, "Recent decisions"), h("span", {}, `All ${decisions.length}`)),
        decisions.slice(0, 3).map((d) => {
          const e = firstEvent(d.id);
          return h(
            "div",
            {
              class: "item",
              onmouseenter: () => focus([d.id, ...changedBy(d)]),
              onmouseleave: unfocus,
              onclick: () => panTo(d.id),
            },
            h("span", { class: "id" }, d.id),
            h("span", { class: "t" }, d.title),
            e ? h("span", { class: "a" }, ago(e.at).replace(" ago", "")) : null,
          );
        }),
      )
    : null;

  app.replaceChildren(canvas, topbar, ...(strip ? [strip] : []), ...(data.cards.length ? [] : [h("div", { class: "empty" }, "No cards yet. Claude adds them through the spill MCP server.")]));
  if (scroll) {
    canvas.scrollLeft = scroll.left;
    canvas.scrollTop = scroll.top;
  }
  requestAnimationFrame(() => drawLines(content));
}

// Drag empty canvas to pan. Window listeners are added once and follow the current canvas.
let pan: { el: HTMLElement; x: number; y: number; l: number; t: number } | null = null;
function enablePan(canvas: HTMLElement) {
  canvas.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest(".card, .sechead, button, input")) return;
    pan = { el: canvas, x: e.clientX, y: e.clientY, l: canvas.scrollLeft, t: canvas.scrollTop };
    canvas.classList.add("panning");
  });
}
window.addEventListener("mousemove", (e) => {
  if (!pan) return;
  pan.el.scrollLeft = pan.l - (e.clientX - pan.x);
  pan.el.scrollTop = pan.t - (e.clientY - pan.y);
});
window.addEventListener("mouseup", () => {
  pan?.el.classList.remove("panning");
  pan = null;
});

async function load() {
  const r = await fetch("/api/board");
  data = await r.json();
  render();
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

load().then(connect);
