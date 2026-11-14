import { Designs } from "./designs";
import { type DiffLine, lineDiff } from "./diff";
import { type Actor, type Card, type CheckRun, type FileEntry, type Focus, type TodoList, type Kind, Store, type Version, kindOf } from "./store";
import { replyTarget, threads } from "./threads";
import { pendingUpdate } from "./updates";

const INVERSE: Record<string, string> = { blocks: "blocked_by", answers: "answered_by", follows: "followed_by" };
const LINK_TYPES = ["blocks", "answers", "depends_on", "follows"];
export const REPLACE_OPTIONS = (old: string, by: string) => `- A. Replace: remove ${old}'s code\n- B. Keep ${old}; branch ${by} from it instead`;

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

export const DELETE_OPTIONS = "- A. Delete it\n- B. Keep it";
// S-53: cards with no code behind them, which a delete may be proposed for.
const DELETABLE: Record<string, string[]> = { spec: ["draft", "discussing", "approved", "rejected"], question: ["open", "dropped"] };

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
    // S-29 / S-46: the one design sign-off for a spec. It blocks that spec, and its options come from
    // the spec's designs: one per variant, or "Approve this design", then "Needs changes".
    if (args.design) {
      if (args.blocks?.length !== 1) throw new Error("A design question must block exactly the one spec it signs off");
      if (args.multi) throw new Error("A design question takes one answer");
      const opts = new Designs(this.store).signOffOptions(args.blocks[0]);
      const lines = [...opts.map((o) => o.text), "Needs changes"].map((t, i) => `- ${String.fromCharCode(65 + i)}. ${t}`);
      body = `${body.replace(/^\s*-\s*[A-Z]\.\s+.*$/gm, "").trim()}\n\n${lines.join("\n")}`.trim();
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

  draftSpec(args: { title: string; body?: string; section?: string; depends_on?: string[]; follows?: string }): Card {
    // S-35: a branched spec follows a done spec and sits next to it, in its section.
    const followed = args.follows ? this.store.get(args.follows) : undefined;
    if (followed && (followed.kind !== "spec" || followed.status !== "done")) throw new Error(`${followed.id} is ${followed.status}; a spec can follow only a done spec`);
    const s = this.create("spec", args.title, args.body ?? "", "draft", args.section ?? followed?.section);
    for (const d of args.depends_on ?? []) {
      this.store.get(d);
      this.addLink(s, "depends_on", d);
    }
    if (followed) {
      this.addLink(s, "follows", followed.id);
      this.addLink(followed, "followed_by", s.id);
      this.store.save(followed);
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
      const before = card.body;
      card.body = args.body.trim() ? `${args.body.trim()}\n\n` : "";
      changed.push("body");
      // S-34: a spec keeps every version of its text. The first edit also saves the original.
      if (card.kind === "spec" && card.body.trim() !== before.trim()) {
        if (!this.store.versions(card.id).length) {
          const born = this.store.events().find((e) => e.card === card.id);
          this.store.addVersion(card.id, { at: born?.at ?? new Date(0).toISOString(), actor: born?.actor ?? this.actor, body: before, seq: born ? this.store.events().indexOf(born) + 1 : 0 });
        }
        this.store.addVersion(card.id, { at: new Date().toISOString(), actor: this.actor, body: card.body, seq: this.store.events().length });
      }
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
    // S-33: an open update request on a done spec lets Claude build it again without a new approval.
    if (args.status === "active" && this.actor === "claude" && card.status !== "queued" && !(card.status === "done" && this.pendingUpdate(card)))
      throw new Error(`${card.id} is ${card.status}; start only specs the user queued with Build, or a done spec with an open update request`);
    // S-35: only a done spec whose replacement the user confirmed (answer A) becomes replaced.
    let replacedBy: string | undefined;
    if (args.status === "replaced") {
      if (card.status !== "done") throw new Error(`${card.id} is ${card.status}; only a done spec can be replaced`);
      replacedBy = this.confirmedReplacement(card);
      if (!replacedBy) throw new Error(`${card.id} has no confirmed replacement. Propose it with spill_propose_replace and wait for the user to pick A`);
    }
    // S-21: a spec with open questions cannot be approved.
    if (args.status === "approved" && card.kind === "spec") {
      const open = this.openQuestions(card);
      if (open.length) throw new Error(`${card.id} has open questions: ${open.join(", ")}. Answer them first.`);
      // S-46: a spec with designs is approved through its design question.
      if (new Designs(this.store).awaitingReview(card.id)) throw new Error(`${card.id} has designs waiting for sign-off. Answer its design question first.`);
    }
    const from = card.status;
    card.status = args.status;
    if (args.note) this.addComment(card, args.note);
    if (replacedBy) {
      this.addLink(card, "replaced_by", replacedBy);
      const by = this.store.get(replacedBy);
      this.addLink(by, "replaces", card.id);
      this.store.save(by);
    }
    this.store.save(card);
    this.store.log({ actor: this.actor, action: "status", card: card.id, detail: `${from} -> ${args.status}${args.note ? `: ${args.note}` : ""}` });
    // S-48 req 2: each build (first or update) starts with an empty todo list.
    if (args.status === "active" && card.kind === "spec") this.store.saveTodos(card.id, null);
    // S-47 (D-35): approval keeps the spec's designs as they were approved.
    if (args.status === "approved" && card.kind === "spec") new Designs(this.store).snapshot(card.id, this.store.events().length - 1);
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
    if (new Designs(this.store).awaitingReview(fresh.id)) return false;
    const from = fresh.status;
    fresh.status = "approved";
    let c = fresh.comments;
    if (c && !c.endsWith("\n")) c += "\n";
    fresh.comments = `${c}- Auto (${today()}): Approved, ${reason}\n`;
    this.store.save(fresh);
    this.store.log({ actor: "auto", action: "status", card: fresh.id, detail: `${from} -> approved (auto: ${reason})` });
    new Designs(this.store).snapshot(fresh.id, this.store.events().length - 1);
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

  // S-33: the user asks for an update to a done spec. Claude handles it on the same spec when it can.
  requestUpdate(args: { id: string; text: string }): Card {
    if (this.actor !== "user") throw new Error("Only the user can ask for an update");
    const text = args.text?.trim();
    if (!text) throw new Error("Say what should be updated");
    const card = this.store.get(args.id);
    if (card.kind !== "spec" || card.status !== "done") throw new Error(`${card.id} is ${card.status}; only a done spec takes an update request`);
    this.addComment(card, `Update: ${text}`);
    this.store.save(card);
    this.store.log({ actor: this.actor, action: "update_request", card: card.id, detail: text });
    return card;
  }

  pendingUpdate(card: Card): { texts: string[]; at: string } | null {
    return pendingUpdate(card, this.store.all(), this.store.events());
  }

  // S-34: a spec's versions, oldest first; the one it had when last approved is marked.
  versions(card: Card): (Version & { approved: boolean; v: number; edit: number })[] {
    const vs = this.store.versions(card.id);
    const events = this.store.events();
    const approval = events.findLastIndex((e) => e.card === card.id && e.action === "status" && /-> approved/.test(e.detail ?? ""));
    const approvedAt = approval >= 0 ? events[approval].at : undefined;
    const ai = approvedAt ? vs.findLastIndex((v) => (v.seq !== undefined ? v.seq <= approval : v.at <= approvedAt)) : -1;
    const rounds = this.rounds(card.id, vs);
    return vs.map((v, i) => ({ ...v, approved: i === ai, ...rounds[i] }));
  }

  // S-49: a spec's version counts approval rounds, not text edits. Each saved text gets a version
  // number and its edit number within that version: a text written after an approval of the one
  // before it starts the next version.
  private rounds(id: string, vs: Version[]): { v: number; edit: number }[] {
    const approvals = this.approvalSeqs(id);
    const events = this.store.events();
    const seqOf = (x: Version) => x.seq ?? 0;
    // An edit made while the spec is being built (a decision recorded mid-build) stays in the
    // version being built; only an edit outside a build starts the next version.
    const building = (seq: number) => {
      const e = events.slice(0, seq).findLast((x) => x.card === id && x.action === "status");
      return /-> active\b/.test(e?.detail ?? "");
    };
    const out: { v: number; edit: number }[] = [];
    let start = 0; // seq where the current version's text began
    vs.forEach((x, i) => {
      if (!i) return (start = seqOf(x)), out.push({ v: 1, edit: 1 });
      const prev = out[i - 1];
      // The current version was approved since it began, and this edit is not part of its build.
      const next = !building(seqOf(x)) && approvals.some((a) => a >= start && a < seqOf(x));
      if (next) start = seqOf(x);
      out.push(next ? { v: prev.v + 1, edit: 1 } : { v: prev.v, edit: prev.edit + 1 });
    });
    return out;
  }

  private approvalSeqs(id: string): number[] {
    return this.store
      .events()
      .map((e, i) => (e.card === id && e.action === "status" && /-> approved/.test(e.detail ?? "") ? i : -1))
      .filter((i) => i >= 0);
  }

  // S-49: the spec's current version, and whether it is a newer version waiting for approval
  // (its text changed since the last approval, which is not yet approved again).
  version(card: Card): { v: number; isNew: boolean; prevApprovedAt?: string } {
    const vs = this.store.versions(card.id);
    const approvals = this.approvalSeqs(card.id);
    if (!vs.length) return { v: 1, isNew: false };
    const rounds = this.rounds(card.id, vs);
    const last = rounds[rounds.length - 1];
    const start = vs[rounds.findIndex((r) => r.v === last.v)];
    const approved = approvals.some((a) => a >= (start.seq ?? 0));
    const before = approvals.filter((a) => a < (start.seq ?? 0)).pop();
    // "new" only while that version waits for approval.
    const waiting = ["draft", "discussing"].includes(card.status);
    return { v: last.v, isNew: last.v > 1 && !approved && waiting, prevApprovedAt: before !== undefined ? this.store.events()[before].at : undefined };
  }

  versionLabel(card: Card): string {
    const x = this.version(card);
    return `v${x.v}${x.isNew ? " new" : ""}`;
  }

  // S-34: what changed since the approved version, when the text differs from it.
  changesSinceApproved(card: Card): { at: string; lines: DiffLine[] } | null {
    const v = this.versions(card).find((x) => x.approved);
    if (!v || v.body.trim() === card.body.trim()) return null;
    return { at: v.at, lines: lineDiff(v.body, card.body).filter((l) => l.op !== "same") };
  }

  // S-35 / D-20: the files Claude touched building a spec. Recording a path again updates its change.
  recordFiles(args: { id: string; files: FileEntry[] }): FileEntry[] {
    if (this.actor !== "claude") throw new Error("Only Claude records files");
    const card = this.store.get(args.id);
    if (card.kind !== "spec") throw new Error(`${card.id} is not a spec`);
    if (!args.files?.length) throw new Error("List at least one file");
    const list = [...(this.store.files()[card.id] ?? [])];
    for (const f of args.files) {
      if (!f.path?.trim()) throw new Error("Each file needs a path");
      if (!["new", "changed", "removed"].includes(f.change)) throw new Error(`${f.path}: change must be new, changed or removed`);
      const i = list.findIndex((x) => x.path === f.path.trim());
      const entry = { path: f.path.trim(), change: f.change };
      if (i >= 0) list[i] = entry;
      else list.push(entry);
    }
    this.store.saveFiles(card.id, list);
    this.store.log({ actor: this.actor, action: "files", card: card.id, detail: args.files.map((f) => `${f.change} ${f.path}`).join(", ") });
    return list;
  }

  files(id: string): FileEntry[] {
    return this.store.files()[id] ?? [];
  }

  // S-35: propose replacing a done spec. A question names both specs and the files to remove; it
  // blocks the replacement, and nothing is removed until the user picks A.
  proposeReplace(args: { id: string; by: string; reason?: string }): Card {
    const old = this.store.get(args.id);
    const by = this.store.get(args.by);
    if (old.kind !== "spec" || old.status !== "done") throw new Error(`${old.id} is ${old.status}; only a done spec can be replaced`);
    if (by.kind !== "spec" || by.id === old.id) throw new Error(`${by.id} must be another spec`);
    const files = this.files(old.id).filter((f) => f.change !== "removed");
    const list = files.length ? files.map((f) => `- \`${f.path}\``).join("\n") : `(${old.id} has no Files list; Claude finds its code before removing it)`;
    const body = [
      `${args.reason?.trim() ? `${args.reason.trim()} ` : ""}${by.id} "${by.title}" replaces ${old.id} "${old.title}". These files from ${old.id} would be removed or reverted:`,
      list,
      REPLACE_OPTIONS(old.id, by.id),
    ].join("\n\n");
    const q = this.ask({ title: `Replace ${old.id} with ${by.id}?`, body, blocks: [by.id], section: old.section ?? undefined });
    this.addLink(q, "replaces", old.id);
    this.store.save(q);
    return q;
  }

  // S-53: propose deleting a card that should not exist. Nothing is deleted until the user picks A.
  proposeDelete(args: { id: string; reason: string }): Card {
    const card = this.store.get(args.id);
    const reason = args.reason?.trim();
    if (!reason) throw new Error("Say why the card should be deleted");
    this.checkDeletable(card);
    const pending = this.store.all().find((q) => q.kind === "question" && q.status === "open" && q.links.some((l) => l.type === "deletes" && l.target === card.id));
    if (pending) throw new Error(`${pending.id} already asks to delete ${card.id}`);
    const body = `${reason}\n\nDeleting ${card.id} "${card.title}" removes its card and every link to it, and its open questions that block nothing else. This cannot be undone.\n\n${DELETE_OPTIONS}`;
    const q = this.ask({ title: `Delete ${card.id}?`, body, section: card.section ?? undefined });
    this.addLink(q, "deletes", card.id);
    this.store.save(q);
    return q;
  }

  private checkDeletable(card: Card): void {
    if (card.kind === "spec" && card.status === "done") throw new Error(`${card.id} is done; propose replacing it with spill_propose_replace instead`);
    if (!DELETABLE[card.kind]?.includes(card.status))
      throw new Error(`${card.id} is ${card.status}; only ${Object.entries(DELETABLE).map(([k, v]) => `${k}s that are ${v.join(", ")}`).join(", or ")} can be deleted`);
  }

  // S-53: the user picked A on a delete question. Removes the card, the links to it, and its open
  // questions that block nothing else. The question stays, answered, as the record.
  private deleteCard(q: Card, id: string): void {
    if (!this.store.has(id)) return;
    const card = this.store.get(id);
    try {
      this.checkDeletable(card);
    } catch (e) {
      this.addComment(q, `Not deleted: ${(e as Error).message}`);
      this.store.save(q);
      return;
    }
    const gone = new Set([id]);
    for (const l of card.links.filter((l) => l.type === "blocked_by")) {
      const b = this.store.has(l.target) ? this.store.get(l.target) : undefined;
      if (b?.kind === "question" && b.status === "open" && b.links.filter((x) => x.type === "blocks").every((x) => x.target === id)) gone.add(b.id);
    }
    for (const c of this.store.all()) {
      if (gone.has(c.id)) continue;
      const keep = c.links.filter((l) => !gone.has(l.target) || (c.id === q.id && l.type === "deletes"));
      if (keep.length !== c.links.length) {
        c.links = keep;
        this.store.save(c);
      }
    }
    for (const g of gone) this.store.remove(g);
    const f = this.store.focus();
    if (f && [...f.discussing, ...f.next].some((x) => gone.has(x)))
      this.store.saveFocus({ ...f, discussing: f.discussing.filter((x) => !gone.has(x)), next: f.next.filter((x) => !gone.has(x)) });
    const reason = q.body.split("\n\n")[0].trim();
    const also = [...gone].filter((g) => g !== id);
    this.store.log({ actor: this.actor, action: "delete", card: id, detail: `deleted ${id}: ${reason}${also.length ? ` (with ${also.join(", ")})` : ""}` });
  }

  // The replacement spec of a confirmed proposal for `card`, if the user picked A.
  confirmedReplacement(card: Card): string | undefined {
    for (const q of this.store.all()) {
      if (q.kind !== "question" || q.status !== "answered" || !q.links.some((l) => l.type === "replaces" && l.target === card.id)) continue;
      const d = q.links.filter((l) => l.type === "answered_by").map((l) => this.store.all().find((c) => c.id === l.target)).find(Boolean);
      if (d && /^A\./.test(d.title)) return q.links.find((l) => l.type === "blocks")?.target;
    }
    return undefined;
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

  // Remove a link and its inverse, e.g. to move a question from a spec to the part it belongs to
  // when the spec is split.
  unlink(args: { from: string; type: string; to: string }): Card {
    if (!LINK_TYPES.includes(args.type)) throw new Error(`Link type must be one of ${LINK_TYPES.join(", ")}`);
    const a = this.store.get(args.from);
    const b = this.store.get(args.to);
    const drop = (c: Card, type: string, target: string) => {
      const before = c.links.length;
      c.links = c.links.filter((l) => !(l.type === type && l.target === target));
      return c.links.length < before;
    };
    if (!drop(a, args.type, b.id)) throw new Error(`${a.id} has no ${args.type} link to ${b.id}`);
    this.store.save(a);
    const inverse = INVERSE[args.type];
    if (inverse && drop(b, inverse, a.id)) this.store.save(b);
    this.store.log({ actor: this.actor, action: "unlink", card: a.id, detail: `${args.type} ${b.id}` });
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
    // S-53: A on a delete question deletes the card; B keeps it.
    const del = q?.links.find((l) => l.type === "deletes");
    if (q && del) {
      if (/^A\./.test(d.title)) this.deleteCard(q, del.target);
      return d;
    }
    // S-46: a design question answered with a variant (or "Approve this design") records the choice
    // and approves the spec; "Needs changes" (or a free answer) leaves it waiting.
    if (q?.design) {
      const spec = q.links.find((l) => l.type === "blocks")?.target;
      const m = /^[A-Z]\.\s+(?:Variant ([A-Z])\b|(Approve this design))/.exec(d.title);
      if (spec && this.store.has(spec) && m && !/; Other:/.test(d.title)) {
        try {
          new Designs(this.store, "user").choose(spec, m[1] ?? "");
        } catch (e) {
          this.addComment(q, `Not signed off: ${(e as Error).message}`);
          this.store.save(q);
          return d;
        }
        this.autoApprove(this.store.get(spec), m[1] ? `design approved (variant ${m[1]})` : "design approved");
      }
      return d;
    }
    // D-11 / S-29: the last blocking question answered approves the spec.
    // S-35: a replacement answer settles the old spec only; the replacement still needs its own approval.
    if (q && !q.links.some((l) => l.type === "replaces"))
      for (const id of q.links.filter((l) => l.type === "blocks").map((l) => l.target))
        if (this.store.has(id)) this.autoApprove(this.store.get(id), "all questions answered");
    return d;
  }

  // S-20/S-24: the user's answer to an open question, from the app or the CLI. Picks are option
  // letters ("- A. text" lines in the body); text is a free answer, alone or added to the picks.
  // S-26: free text alone on a question with options is a redirect. No decision is recorded; the
  // question stays open for Claude to record, drop or rewrite, and the question card itself is returned.
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
  // S-48: Claude's todo list for the active build, replaced whole on each call. Not logged: it
  // shows only as the card's todo progress bar (req 6).
  todos(args: { id: string; items: { text: string; done?: boolean }[] }): TodoList {
    const card = this.store.get(args.id);
    if (card.kind !== "spec") throw new Error(`${card.id} is not a spec`);
    if (card.status !== "active") throw new Error(`${card.id} is ${card.status}; a todo list is for a spec you are building (active)`);
    if (!Array.isArray(args.items) || !args.items.length) throw new Error("Pass the full todo list: items, each with text and done");
    const items = args.items.map((x) => ({ text: String(x?.text ?? "").trim(), done: x?.done === true }));
    if (items.some((x) => !x.text)) throw new Error("Each todo needs text");
    const list: TodoList = { at: new Date().toISOString(), items };
    this.store.saveTodos(card.id, list);
    return list;
  }

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
