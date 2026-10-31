import { type Actor, type Card, type CheckRun, type Focus, type Kind, Store, kindOf } from "./store";
import { replyTarget, threads } from "./threads";

const INVERSE: Record<string, string> = { blocks: "blocked_by", answers: "answered_by" };
const LINK_TYPES = ["blocks", "answers", "depends_on"];

// Requirements Claude has checked off in comments: "Req 2 done", "Reqs 1, 3 and 4 done", "Reqs 1-3 done".
// Same parsing as the app's progress bar.
export function reqProgress(c: Card): { done: number; total: number } {
  const m = /##\s*Requirements\s*\n([\s\S]*?)(\n##(?!#)|$)/.exec(c.body);
  const total = m ? (m[1].match(/^\d+\./gm) ?? []).length : 0;
  const done = new Set<number>();
  for (const line of c.comments.split("\n")) {
    if (!line.startsWith("- Claude")) continue;
    for (const r of line.matchAll(/\bReq(?:uirement)?s?\s+((?:\d+(?:\s*-\s*\d+)?(?:\s*,\s*|\s+and\s+)?)+)\s+done/gi))
      for (const part of r[1].match(/\d+(?:\s*-\s*\d+)?/g) ?? []) {
        const [a, b = a] = part.split("-").map((x) => +x.trim());
        for (let n = a; n <= b; n++) if (n >= 1 && n <= total) done.add(n);
      }
  }
  return { done: done.size, total };
}

export const DESIGN_OPTIONS = "- A. Approve this design\n- B. Needs changes";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// All board operations. Claude reaches these through MCP tools, the user through the CLI.
export class Board {
  constructor(
    readonly store: Store,
    readonly actor: Actor,
  ) {}

  private who(): string {
    return this.actor === "user" ? "User" : "Claude";
  }

  private addComment(card: Card, text: string): void {
    let c = card.comments;
    if (c && !c.endsWith("\n")) c += "\n";
    card.comments = `${c}- ${this.who()} (${today()}): ${text.trim()}\n`;
  }

  private addLink(card: Card, type: string, target: string): void {
    if (!card.links.some((l) => l.type === type && l.target === target)) card.links.push({ type, target });
  }

  private checkSection(section: string | null | undefined): string | null {
    if (!section) return null;
    if (kindOf(section) !== "section" || !this.store.has(section)) throw new Error(`No section ${section}`);
    return section;
  }

  private create(kind: Kind, title: string, body: string, status: string, section?: string | null): Card {
    if (!title?.trim()) throw new Error("A title is required");
    const card: Card = {
      id: this.store.nextId(kind),
      kind,
      title: title.trim(),
      status,
      section: this.checkSection(section),
      links: [],
      body: body ? `${body.trim()}\n\n` : "",
      comments: "",
    };
    return card;
  }

  validStatuses(kind: Kind): string[] {
    const cfg = this.store.config();
    if (kind === "spec") return cfg.statuses.spec;
    if (kind === "question") return cfg.statuses.question;
    return [];
  }

  board(): Card[] {
    return this.store.all();
  }

  get(id: string): Card {
    return this.store.get(id);
  }

  ask(args: { title: string; body?: string; section?: string; blocks?: string[]; multi?: boolean; design?: boolean }): Card {
    let body = args.body ?? "";
    // S-29: a design approval question blocks its spec and always offers approve or change.
    if (args.design) {
      if (!args.blocks?.length) throw new Error("A design question must block the spec it approves");
      if (args.multi) throw new Error("A design question takes one answer");
      if (!/^\s*-\s*[A-Z]\.\s+/m.test(body)) body = `${body.trim()}\n\n${DESIGN_OPTIONS}`;
    }
    const q = this.create("question", args.title, body, "open", args.section);
    if (args.multi) q.select = "multi";
    if (args.design) q.design = true;
    for (const s of args.blocks ?? []) {
      const spec = this.store.get(s);
      this.addLink(q, "blocks", s);
      this.addLink(spec, "blocked_by", q.id);
      this.store.save(spec);
    }
    this.store.save(q);
    this.store.log({ actor: this.actor, action: "ask", card: q.id, detail: q.title });
    return q;
  }

  draftSpec(args: { title: string; body?: string; section?: string; depends_on?: string[] }): Card {
    const s = this.create("spec", args.title, args.body ?? "", "draft", args.section);
    for (const d of args.depends_on ?? []) {
      this.store.get(d);
      this.addLink(s, "depends_on", d);
    }
    this.store.save(s);
    this.store.log({ actor: this.actor, action: "draft_spec", card: s.id, detail: s.title });
    return s;
  }

  update(args: { id: string; title?: string; body?: string; section?: string | null }): Card {
    const card = this.store.get(args.id);
    const changed: string[] = [];
    if (args.title !== undefined) {
      card.title = args.title.trim();
      changed.push("title");
    }
    if (args.body !== undefined) {
      card.body = args.body.trim() ? `${args.body.trim()}\n\n` : "";
      changed.push("body");
    }
    if (args.section !== undefined) {
      card.section = this.checkSection(args.section);
      changed.push("section");
    }
    if (!changed.length) throw new Error("Nothing to update");
    this.store.save(card);
    this.store.log({ actor: this.actor, action: "update", card: card.id, detail: changed.join(", ") });
    return card;
  }

  setStatus(args: { id: string; status: string; note?: string }): Card {
    const card = this.store.get(args.id);
    const cfg = this.store.config();
    const valid = this.validStatuses(card.kind);
    if (!valid.length) throw new Error(`${card.kind} cards have no status to set`);
    if (!valid.includes(args.status)) throw new Error(`${args.status} is not a ${card.kind} status (${valid.join(", ")})`);
    if (this.actor === "claude" && cfg.userOnlyStatuses.includes(args.status))
      throw new Error(`Only the user can set ${args.status}. Ask them to run: spill ${args.status === "approved" ? "approve" : "reject"} ${card.id}`);
    if (args.status === "active" && card.kind === "spec") {
      const active = this.store.all().filter((c) => c.kind === "spec" && c.status === "active" && c.id !== card.id);
      if (active.length >= cfg.maxActiveSpecs)
        throw new Error(`Already ${active.length} active (${active.map((c) => c.id).join(", ")}); maxActiveSpecs is ${cfg.maxActiveSpecs}`);
    }
    // S-29: approved, then the user presses Build. Claude starts only queued specs.
    if (args.status === "queued" && card.status !== "approved") throw new Error(`${card.id} is ${card.status}; only an approved spec can be queued to build`);
    if (args.status === "active" && this.actor === "claude" && card.status !== "queued")
      throw new Error(`${card.id} is ${card.status}; start only specs the user queued with Build`);
    // S-21: a spec with open questions cannot be approved.
    if (args.status === "approved" && card.kind === "spec") {
      const open = this.openQuestions(card);
      if (open.length) throw new Error(`${card.id} has open questions: ${open.join(", ")}. Answer them first.`);
    }
    const from = card.status;
    card.status = args.status;
    if (args.note) this.addComment(card, args.note);
    this.store.save(card);
    this.store.log({ actor: this.actor, action: "status", card: card.id, detail: `${from} -> ${args.status}${args.note ? `: ${args.note}` : ""}` });
    // D-11: the last child spec done approves the parent.
    if (args.status === "done" && card.kind === "spec")
      for (const p of card.links.filter((l) => l.type === "depends_on").map((l) => this.store.all().find((c) => c.id === l.target))) {
        if (p?.kind !== "spec") continue;
        const kids = this.store.all().filter((c) => c.kind === "spec" && c.links.some((l) => l.type === "depends_on" && l.target === p.id));
        if (kids.every((k) => k.status === "done")) this.autoApprove(p, "all child specs done");
      }
    return card;
  }

  // S-29: the user presses Build on an approved spec; Claude builds queued specs in this order.
  build(args: { id: string }): Card {
    if (this.actor !== "user") throw new Error("Only the user can queue a spec to build");
    return this.setStatus({ id: args.id, status: "queued" });
  }

  // D-11: approve a draft or discussing spec when nothing still blocks it. Logged as actor "auto".
  private autoApprove(card: Card, reason: string): boolean {
    const fresh = this.store.get(card.id);
    if (fresh.kind !== "spec" || !["draft", "discussing"].includes(fresh.status) || this.openQuestions(fresh).length) return false;
    const from = fresh.status;
    fresh.status = "approved";
    let c = fresh.comments;
    if (c && !c.endsWith("\n")) c += "\n";
    fresh.comments = `${c}- Auto (${today()}): Approved, ${reason}\n`;
    this.store.save(fresh);
    this.store.log({ actor: "auto", action: "status", card: fresh.id, detail: `${from} -> approved (auto: ${reason})` });
    return true;
  }

  // S-5: the user takes an approved, active or done spec back to discussing, with an optional reason.
  revert(args: { id: string; reason?: string }): Card {
    if (this.actor !== "user") throw new Error("Only the user can revert a spec; comment on it instead");
    const card = this.store.get(args.id);
    if (card.kind !== "spec" || !["approved", "queued", "active", "done"].includes(card.status))
      throw new Error(`${card.id} is ${card.status}; only approved, queued, active or done specs can be reverted`);
    const from = card.status;
    const reason = args.reason?.trim();
    card.status = "discussing";
    this.addComment(card, `Reverted${reason ? `: ${reason}` : ""}`);
    this.store.save(card);
    this.store.log({ actor: this.actor, action: "status", card: card.id, detail: `${from} -> discussing (reverted)${reason ? `: ${reason}` : ""}` });
    return card;
  }

  openQuestions(card: Card): string[] {
    return card.links
      .filter((l) => l.type === "blocked_by")
      .map((l) => this.store.all().find((c) => c.id === l.target))
      .filter((c): c is Card => !!c && c.kind === "question" && c.status === "open")
      .map((c) => c.id);
  }

  comment(args: { id: string; text: string }): Card {
    if (!args.text?.trim()) throw new Error("Comment text is required");
    const card = this.store.get(args.id);
    this.addComment(card, args.text);
    this.store.save(card);
    this.store.log({ actor: this.actor, action: "comment", card: card.id, detail: args.text.trim() });
    // D-11: Claude's "Reqs 1-n done" covering every requirement approves the spec.
    if (this.actor === "claude" && card.kind === "spec") {
      const p = reqProgress(card);
      if (p.total && p.done === p.total) this.autoApprove(card, "all requirements met");
    }
    return this.store.get(card.id);
  }

  link(args: { from: string; type: string; to: string }): Card {
    if (!LINK_TYPES.includes(args.type)) throw new Error(`Link type must be one of ${LINK_TYPES.join(", ")}`);
    const a = this.store.get(args.from);
    const b = this.store.get(args.to);
    this.addLink(a, args.type, b.id);
    this.store.save(a);
    const inverse = INVERSE[args.type];
    if (inverse) {
      this.addLink(b, inverse, a.id);
      this.store.save(b);
    }
    this.store.log({ actor: this.actor, action: "link", card: a.id, detail: `${args.type} ${b.id}` });
    return a;
  }

  // Record a decision and close the question it answers.
  record(args: { title: string; body?: string; question?: string; section?: string }): Card {
    const q = args.question ? this.store.get(args.question) : undefined;
    if (q && q.kind !== "question") throw new Error(`${q.id} is not a question`);
    const d = this.create("decision", args.title, args.body ?? "", "recorded", args.section ?? q?.section);
    if (q) {
      this.addLink(d, "answers", q.id);
      this.addLink(q, "answered_by", d.id);
      q.status = "answered";
      this.store.save(q);
    }
    this.store.save(d);
    this.store.log({ actor: this.actor, action: "record", card: d.id, detail: q ? `answers ${q.id}: ${d.title}` : d.title });
    // D-11 / S-29: the last blocking question answered approves the spec. A design question
    // approves only when its answer is A; "Needs changes" leaves the spec waiting.
    if (q && !(q.design && !/^A\./.test(d.title)))
      for (const id of q.links.filter((l) => l.type === "blocks").map((l) => l.target))
        if (this.store.has(id)) this.autoApprove(this.store.get(id), q.design ? "design approved" : "all questions answered");
    return d;
  }

  // S-20/S-24: the user's answer to an open question, from the app or the CLI. Picks are option
  // letters ("- A. text" lines in the body); text is a free answer, alone or added to the picks.
  // S-26: free text alone on a question with options is a redirect. No decision is recorded; the
  // question stays open for Claude to rewrite, and the question card itself is returned.
  answer(args: { id: string; picks?: string[]; text?: string }): Card {
    const q = this.store.get(args.id);
    if (q.kind !== "question" || q.status !== "open") throw new Error(`${q.id} is not an open question`);
    const opts = new Map([...q.body.matchAll(/^\s*-\s*([A-Z])\.\s+(.+)$/gm)].map((m) => [m[1], m[2].trim()]));
    const picks = [...new Set(args.picks ?? [])];
    const text = args.text?.trim() ?? "";
    for (const p of picks) if (!opts.has(p)) throw new Error(`${q.id} has no option ${p}`);
    if (picks.length > 1 && q.select !== "multi") throw new Error(`${q.id} takes one answer`);
    if (!picks.length && !text) throw new Error("An answer is required");
    if (!picks.length && opts.size) {
      this.addComment(q, `Redirect: ${text}`);
      this.store.save(q);
      this.store.log({ actor: this.actor, action: "redirect", card: q.id, detail: text });
      return q;
    }
    const chosen = picks.length ? `${picks.join(", ")}. ${picks.map((p) => opts.get(p)).join("; ")}` : "";
    const title = chosen && text ? `${chosen}; Other: ${text}` : chosen || text;
    return this.record({ question: q.id, title, body: `Answer to ${q.id} "${q.title}", by the user.` });
  }

  inbox() {
    return this.store.takeInbox();
  }

  // Rejection queue (S-19): rejected cards whose latest rejection Claude has not resolved.
  // Derived from the event log, so re-rejecting a card puts it back with the new reason.
  rejections(): { card: Card; reason: string; at: string }[] {
    const latest = new Map<string, { reason: string; at: string }>();
    for (const e of this.store.events()) {
      if (e.action === "status" && e.actor === "user" && /-> rejected/.test(e.detail ?? "")) {
        latest.set(e.card, { reason: (e.detail ?? "").replace(/^.*?-> rejected:?\s*/, ""), at: e.at });
      } else if (e.action === "resolve") latest.delete(e.card);
    }
    const out: { card: Card; reason: string; at: string }[] = [];
    for (const [id, r] of latest) {
      if (!this.store.has(id)) continue;
      const card = this.store.get(id);
      if (card.status === "rejected") out.push({ card, ...r });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  // Leave a rejected card rejected for good and take it off the queue; the note becomes a comment.
  resolveRejection(args: { id: string; note: string }): Card {
    const card = this.get(args.id);
    if (!this.rejections().some((r) => r.card.id === card.id)) throw new Error(`${card.id} is not waiting in the rejection queue`);
    if (!args.note?.trim()) throw new Error("A note is required to resolve a rejection");
    this.addComment(card, args.note);
    this.store.save(card);
    this.store.log({ actor: this.actor, action: "resolve", card: card.id, detail: args.note.trim() });
    return card;
  }

  focus(): Focus | null {
    return this.store.focus();
  }

  // Set the spotlight (S-18). Every ID must exist; clear removes it.
  // S-13 / D-4: Claude records the result of running a spec's acceptance checks.
  checks(args: { id: string; running?: boolean; results?: CheckRun["results"] }): CheckRun {
    const card = this.store.get(args.id);
    if (card.kind !== "spec") throw new Error(`${card.id} is not a spec`);
    const results = args.results ?? [];
    if (!args.running && !results.length) throw new Error("Pass running: true before a run, or results after it");
    for (const r of results) if (!r.name?.trim() || typeof r.pass !== "boolean") throw new Error("Each result needs a name and pass: true or false");
    const run: CheckRun = { at: new Date().toISOString(), running: !results.length, results };
    this.store.saveChecks(card.id, run);
    const failed = results.filter((r) => !r.pass);
    const detail = run.running ? "running" : `${results.length - failed.length} of ${results.length} passed${failed.length ? `; ${failed[0].name} failed` : ""}`;
    this.store.log({ actor: this.actor, action: "checks", card: card.id, detail });
    return run;
  }

  // S-23: board-level messages, not tied to a card. The user sends a message, Claude replies.
  // S-8: attachments are saved file paths, listed after the text so Claude can read them.
  // S-30: a user message with no thread starts one; Claude's reply goes to the given thread, else
  // the latest open one.
  message(text: string, attachments: string[] = [], thread?: string): void {
    if (!text?.trim() && !attachments.length) throw new Error("Message text is required");
    const all = threads(this.store.events());
    let t: string | undefined;
    if (this.actor === "user") {
      if (thread?.trim() && !all.some((x) => x.id === thread)) throw new Error(`No thread ${thread}`);
      t = thread?.trim() || undefined;
    } else {
      t = replyTarget(all, thread)?.id;
      if (thread?.trim() && !t) throw new Error(`No thread ${thread}`);
    }
    const files = attachments.length ? ` [attached: ${attachments.join(", ")}]` : "";
    this.store.log({ actor: this.actor, action: this.actor === "user" ? "message" : "reply", card: "-", detail: `${(text ?? "").trim()}${files}`.trim(), ...(t ? { thread: t } : {}) });
  }

  setFocus(args: { discussing?: string[]; next?: string[]; note?: string; clear?: boolean }): Focus | null {
    if (args.clear) {
      this.store.saveFocus(null);
      this.store.log({ actor: this.actor, action: "focus", card: "-", detail: "cleared" });
      return null;
    }
    const discussing = (args.discussing ?? []).map((id) => this.get(id).id);
    const next = (args.next ?? []).map((id) => this.get(id).id);
    if (!discussing.length && !next.length) throw new Error("Give discussing or next card IDs, or clear: true");
    const f: Focus = { discussing, next, note: args.note?.trim() || undefined, at: new Date().toISOString() };
    this.store.saveFocus(f);
    const parts = [discussing.length ? `discussing ${discussing.join(", ")}` : "", next.length ? `next ${next.join(", ")}` : ""].filter(Boolean);
    this.store.log({ actor: this.actor, action: "focus", card: discussing[0] ?? next[0], detail: parts.join("; ") + (f.note ? `: ${f.note}` : "") });
    return f;
  }
}
