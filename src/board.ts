import { type Actor, type Card, type Kind, Store, kindOf } from "./store";

const INVERSE: Record<string, string> = { blocks: "blocked_by", answers: "answered_by" };
const LINK_TYPES = ["blocks", "answers", "depends_on"];

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

  ask(args: { title: string; body?: string; section?: string; blocks?: string[] }): Card {
    const q = this.create("question", args.title, args.body ?? "", "open", args.section);
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
    const from = card.status;
    card.status = args.status;
    if (args.note) this.addComment(card, args.note);
    this.store.save(card);
    this.store.log({ actor: this.actor, action: "status", card: card.id, detail: `${from} -> ${args.status}${args.note ? `: ${args.note}` : ""}` });
    return card;
  }

  comment(args: { id: string; text: string }): Card {
    if (!args.text?.trim()) throw new Error("Comment text is required");
    const card = this.store.get(args.id);
    this.addComment(card, args.text);
    this.store.save(card);
    this.store.log({ actor: this.actor, action: "comment", card: card.id, detail: args.text.trim() });
    return card;
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
    return d;
  }

  inbox() {
    return this.store.takeInbox();
  }
}
