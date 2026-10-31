import { beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/board";
import { handle } from "../src/mcp";
import { Store, formatCard, parseCard } from "../src/store";

const REPO_SPILL = join(import.meta.dir, "..", ".spill");

let dir: string;
let store: Store;
let claude: Board;
let user: Board;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "spill-")), ".spill");
  cpSync(join(REPO_SPILL, "config.json"), join(dir, "config.json"), { recursive: true });
  store = new Store(dir);
  writeFileSync(
    join(store.cardsDir, "SEC-1.md"),
    "---\nid: SEC-1\nkind: section\ntitle: Core\nstatus: open\nsection: null\nlinks: []\n---\nCore.\n\n## Comments\n",
  );
  claude = new Board(store, "claude");
  user = new Board(store, "user");
});

describe("card files", () => {
  test("every card in this repo survives a parse and format round trip", () => {
    const files = readdirSync(join(REPO_SPILL, "cards")).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(REPO_SPILL, "cards", f), "utf8");
      expect(formatCard(parseCard(text))).toBe(text);
    }
  });

  test("titles with a colon are quoted and read back", () => {
    const s = claude.draftSpec({ title: "Inbox: what changed", body: "x" });
    expect(readFileSync(join(store.cardsDir, `${s.id}.md`), "utf8")).toContain('title: "Inbox: what changed"');
    expect(store.get(s.id).title).toBe("Inbox: what changed");
  });
});

describe("ids", () => {
  test("next free number per kind, never reused after removal", () => {
    expect(claude.draftSpec({ title: "a" }).id).toBe("S-1");
    expect(claude.draftSpec({ title: "b" }).id).toBe("S-2");
    rmSync(join(store.cardsDir, "S-2.md"));
    expect(claude.draftSpec({ title: "c" }).id).toBe("S-3");
    expect(claude.ask({ title: "q" }).id).toBe("Q-1");
  });
});

describe("status rules", () => {
  test("Claude cannot approve or reject", () => {
    const s = claude.draftSpec({ title: "a" });
    expect(() => claude.setStatus({ id: s.id, status: "approved" })).toThrow(/Only the user/);
    expect(() => claude.setStatus({ id: s.id, status: "rejected" })).toThrow(/Only the user/);
  });

  test("the user can approve, with a note as a comment", () => {
    const s = claude.draftSpec({ title: "a" });
    user.setStatus({ id: s.id, status: "approved", note: "ship it" });
    const c = store.get(s.id);
    expect(c.status).toBe("approved");
    expect(c.comments).toMatch(/- User \(\d{4}-\d{2}-\d{2}\): ship it/);
  });

  test("statuses must fit the card kind", () => {
    const q = claude.ask({ title: "q" });
    expect(() => claude.setStatus({ id: q.id, status: "active" })).toThrow(/not a question status/);
  });

  test("maxActiveSpecs is enforced", () => {
    const a = claude.draftSpec({ title: "a" });
    const b = claude.draftSpec({ title: "b" });
    claude.setStatus({ id: a.id, status: "active" });
    expect(() => claude.setStatus({ id: b.id, status: "active" })).toThrow(/maxActiveSpecs/);
  });

  test("unknown sections are refused", () => {
    expect(() => claude.draftSpec({ title: "a", section: "SEC-9" })).toThrow(/No section/);
    expect(claude.draftSpec({ title: "a", section: "SEC-1" }).section).toBe("SEC-1");
  });
});

describe("links and decisions", () => {
  test("ask with blocks links both cards", () => {
    const s = claude.draftSpec({ title: "a" });
    const q = claude.ask({ title: "q", blocks: [s.id] });
    expect(store.get(q.id).links).toEqual([{ type: "blocks", target: s.id }]);
    expect(store.get(s.id).links).toEqual([{ type: "blocked_by", target: q.id }]);
  });

  test("record closes the question", () => {
    const q = claude.ask({ title: "q" });
    const d = user.record({ question: q.id, title: "Use files" });
    expect(store.get(q.id).status).toBe("answered");
    expect(store.get(q.id).links).toContainEqual({ type: "answered_by", target: d.id });
    expect(store.get(d.id).links).toContainEqual({ type: "answers", target: q.id });
  });
});

describe("inbox", () => {
  test("returns only user events since the last call", () => {
    const s = claude.draftSpec({ title: "a" });
    user.setStatus({ id: s.id, status: "approved" });
    user.comment({ id: s.id, text: "nice" });
    const first = claude.inbox();
    expect(first.map((e) => e.action)).toEqual(["status", "comment"]);
    expect(first[0].detail).toBe("draft -> approved");
    expect(claude.inbox()).toEqual([]);
    claude.comment({ id: s.id, text: "thanks" });
    expect(claude.inbox()).toEqual([]);
  });
});

describe("mcp", () => {
  const call = (name: string, args: object = {}) =>
    handle(store, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any;

  test("initialize and list the 10 tools", () => {
    const init = handle(store, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) as any;
    expect(init.result.serverInfo.name).toBe("spill");
    const list = handle(store, { jsonrpc: "2.0", id: 2, method: "tools/list" }) as any;
    expect(list.result.tools.map((t: any) => t.name)).toEqual([
      "spill_board", "spill_get", "spill_ask", "spill_draft_spec", "spill_update",
      "spill_set_status", "spill_comment", "spill_link", "spill_record", "spill_inbox",
    ]);
  });

  test("notifications get no reply", () => {
    expect(handle(store, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
  });

  test("tool errors come back as isError results", () => {
    call("spill_draft_spec", { title: "a" });
    const r = call("spill_set_status", { id: "S-1", status: "approved" });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/spill approve S-1/);
  });

  test("tools act as Claude", () => {
    call("spill_draft_spec", { title: "a" });
    call("spill_link", { from: "S-1", type: "depends_on", to: "SEC-1" });
    expect(store.get("S-1").links).toEqual([{ type: "depends_on", target: "SEC-1" }]);
    expect(store.events().every((e) => e.actor === "claude")).toBe(true);
  });
});
