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

  test("a spec with an open question cannot be approved until it is answered (S-21)", () => {
    const s = claude.draftSpec({ title: "a" });
    const q = claude.ask({ title: "which?", blocks: [s.id] });
    expect(() => user.setStatus({ id: s.id, status: "approved" })).toThrow(`${s.id} has open questions: ${q.id}. Answer them first.`);
    expect(store.get(s.id).status).toBe("draft");
    user.setStatus({ id: s.id, status: "rejected", note: "no" });
    expect(store.get(s.id).status).toBe("rejected");
    user.record({ question: q.id, title: "this one" });
    user.setStatus({ id: s.id, status: "approved" });
    expect(store.get(s.id).status).toBe("approved");
  });

  test("dropped questions do not block approval (S-21)", () => {
    const s = claude.draftSpec({ title: "a" });
    const q = claude.ask({ title: "which?", blocks: [s.id] });
    claude.setStatus({ id: q.id, status: "dropped" });
    user.setStatus({ id: s.id, status: "approved" });
    expect(store.get(s.id).status).toBe("approved");
  });

  test("statuses must fit the card kind", () => {
    const q = claude.ask({ title: "q" });
    expect(() => claude.setStatus({ id: q.id, status: "active" })).toThrow(/not a question status/);
  });

  test("maxActiveSpecs is enforced", () => {
    const a = claude.draftSpec({ title: "a" });
    const b = claude.draftSpec({ title: "b" });
    for (const c of [a, b]) user.setStatus({ id: c.id, status: "approved" }), user.build({ id: c.id });
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

  test("unlink moves a question from a split spec to its part", () => {
    const big = claude.draftSpec({ title: "big" });
    const part = claude.draftSpec({ title: "part", depends_on: [big.id] });
    const q = claude.ask({ title: "q", blocks: [big.id] });
    claude.unlink({ from: q.id, type: "blocks", to: big.id });
    claude.link({ from: q.id, type: "blocks", to: part.id });
    expect(store.get(q.id).links).toEqual([{ type: "blocks", target: part.id }]);
    expect(store.get(big.id).links).toEqual([]);
    expect(store.get(part.id).links).toContainEqual({ type: "blocked_by", target: q.id });
    expect(() => claude.unlink({ from: q.id, type: "blocks", to: big.id })).toThrow("no blocks link");
  });
});

describe("MCP instructions", () => {
  test("initialize sends the full rules to the client", () => {
    const r = handle(store, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) as any;
    const text: string = r.result.instructions;
    for (const rule of ["fetch and update spec state", "A split is a reorganization", "Specs before code", "Only the user approves", "Read what the user wrote and act on what it means", "spill_checks", "(reverted)", "Fix failing check", "spill_reply", "update_request"])
      expect(text).toContain(rule);
  });
});

describe("revert (S-5)", () => {
  test("the user reverts an active spec to discussing with a reason; the inbox reports it", () => {
    claude.draftSpec({ title: "a" });
    user.setStatus({ id: "S-1", status: "approved" });
    user.build({ id: "S-1" });
    claude.setStatus({ id: "S-1", status: "active" });
    claude.inbox();
    user.revert({ id: "S-1", reason: "wrong direction" });
    expect(store.get("S-1").status).toBe("discussing");
    expect(store.get("S-1").comments).toContain("Reverted: wrong direction");
    expect(claude.inbox().map((e) => e.detail)).toEqual(["active -> discussing (reverted): wrong direction"]);
  });

  test("Claude cannot revert, and only approved, active or done specs can be", () => {
    claude.draftSpec({ title: "a" });
    expect(() => user.revert({ id: "S-1" })).toThrow("only approved, queued, active or done");
    user.setStatus({ id: "S-1", status: "approved" });
    expect(() => claude.revert({ id: "S-1" })).toThrow("Only the user");
  });
});

describe("update requests (S-33)", () => {
  const shipped = () => {
    claude.draftSpec({ title: "a" });
    user.setStatus({ id: "S-1", status: "approved" });
    user.build({ id: "S-1" });
    claude.setStatus({ id: "S-1", status: "active" });
    claude.setStatus({ id: "S-1", status: "done" });
    claude.inbox();
  };

  test("the user asks for an update on a done spec; the inbox reports it and Claude may reopen it", () => {
    shipped();
    expect(() => claude.setStatus({ id: "S-1", status: "active" })).toThrow("open update request");
    user.requestUpdate({ id: "S-1", text: "keep the panel responsive" });
    expect(claude.inbox().map((e) => `${e.action} ${e.detail}`)).toEqual(["update_request keep the panel responsive"]);
    expect(claude.pendingUpdate(store.get("S-1"))?.texts).toEqual(["keep the panel responsive"]);
    claude.setStatus({ id: "S-1", status: "active" });
    expect(store.get("S-1").status).toBe("active");
    expect(claude.pendingUpdate(store.get("S-1"))).toBeNull();
  });

  test("more text adds to the open request; a blocking question from Claude clears it", () => {
    shipped();
    user.requestUpdate({ id: "S-1", text: "one" });
    user.requestUpdate({ id: "S-1", text: "two" });
    expect(claude.pendingUpdate(store.get("S-1"))?.texts).toEqual(["one", "two"]);
    claude.ask({ title: "Which?", body: "x\n\n- A. a\n- B. b", blocks: ["S-1"] });
    expect(claude.pendingUpdate(store.get("S-1"))).toBeNull();
  });

  test("only the user asks, only on a done spec, and only with text", () => {
    shipped();
    claude.draftSpec({ title: "b" });
    expect(() => user.requestUpdate({ id: "S-2", text: "x" })).toThrow("only a done spec");
    expect(() => claude.requestUpdate({ id: "S-1", text: "x" })).toThrow("Only the user");
    expect(() => user.requestUpdate({ id: "S-1", text: "  " })).toThrow("Say what should be updated");
  });
});

describe("branch and replace (S-35)", () => {
  const shipped = (title: string) => {
    const s = claude.draftSpec({ title });
    user.setStatus({ id: s.id, status: "approved" });
    user.build({ id: s.id });
    claude.setStatus({ id: s.id, status: "active" });
    claude.recordFiles({ id: s.id, files: [{ path: "src/a.ts", change: "new" }, { path: "src/b.ts", change: "changed" }] });
    claude.setStatus({ id: s.id, status: "done" });
    return s.id;
  };

  test("a branched spec follows a done spec, in its section, linked both ways", () => {
    const old = shipped("old");
    store.save({ ...store.get(old), section: "SEC-1" });
    const b = claude.draftSpec({ title: "branch", follows: old });
    expect(b.section).toBe("SEC-1");
    expect(b.links).toContainEqual({ type: "follows", target: old });
    expect(store.get(old).links).toContainEqual({ type: "followed_by", target: b.id });
    const draft = claude.draftSpec({ title: "x" });
    expect(() => claude.draftSpec({ title: "y", follows: draft.id })).toThrow("only a done spec");
  });

  test("files Claude records make the spec's Files list; recording a path again updates it", () => {
    const id = shipped("a");
    claude.recordFiles({ id, files: [{ path: "src/a.ts", change: "removed" }] });
    expect(claude.files(id)).toEqual([{ path: "src/a.ts", change: "removed" }, { path: "src/b.ts", change: "changed" }]);
    expect(() => user.recordFiles({ id, files: [{ path: "x", change: "new" }] })).toThrow("Only Claude");
  });

  test("a replacement is a question naming the files; replaced only after the user picks A", () => {
    const old = shipped("old");
    const by = claude.draftSpec({ title: "new" });
    const q = claude.proposeReplace({ id: old, by: by.id, reason: "Too big." });
    expect(q.title).toBe(`Replace ${old} with ${by.id}?`);
    expect(q.body).toContain("`src/a.ts`");
    expect(q.body).toContain(`- A. Replace: remove ${old}'s code`);
    expect(store.get(by.id).links).toContainEqual({ type: "blocked_by", target: q.id });
    expect(() => claude.setStatus({ id: old, status: "replaced" })).toThrow("no confirmed replacement");
    user.answer({ id: q.id, picks: ["A"] });
    expect(store.get(by.id).status).toBe("draft");
    claude.setStatus({ id: old, status: "replaced", note: "Removed src/a.ts" });
    expect(store.get(old).status).toBe("replaced");
    expect(store.get(old).links).toContainEqual({ type: "replaced_by", target: by.id });
    expect(store.get(by.id).links).toContainEqual({ type: "replaces", target: old });
  });

  test("answer B keeps the spec", () => {
    const old = shipped("old");
    const by = claude.draftSpec({ title: "new" });
    const q = claude.proposeReplace({ id: old, by: by.id });
    user.answer({ id: q.id, picks: ["B"] });
    expect(() => claude.setStatus({ id: old, status: "replaced" })).toThrow("no confirmed replacement");
    expect(() => claude.proposeReplace({ id: by.id, by: old })).toThrow("only a done spec");
  });
});

describe("spec versions (S-34)", () => {
  const call = (name: string, args: object = {}) =>
    handle(store, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any;
  test("each text change keeps a version; the approved one is marked; spill_get lists the changes", () => {
    claude.draftSpec({ title: "a", body: "## Requirements\n1. one\n2. two" });
    user.setStatus({ id: "S-1", status: "approved" });
    claude.update({ id: "S-1", body: "## Requirements\n1. one\n2. two, faster\n3. three" });
    claude.update({ id: "S-1", title: "a2" });
    claude.update({ id: "S-1", body: "## Requirements\n1. one\n2. two, faster\n3. three\n4. four" });
    const vs = claude.versions(store.get("S-1"));
    expect(vs).toHaveLength(3);
    expect(vs.map((v) => v.approved)).toEqual([true, false, false]);
    expect(vs.map((v) => v.actor)).toEqual(["claude", "claude", "claude"]);
    const text = call("spill_get", { id: "S-1" }).result.content[0].text;
    expect(text).toContain("## Changes since the approved version");
    expect(text).toContain("+3 -1 lines");
    expect(text).toContain("- 2. two\n");
    expect(text).toContain("+ 4. four");
  });

  test("a spec never edited has no versions and no changes", () => {
    claude.draftSpec({ title: "a", body: "x" });
    expect(claude.versions(store.get("S-1"))).toEqual([]);
    expect(call("spill_get", { id: "S-1" }).result.content[0].text).not.toContain("Changes since");
  });
});

describe("redirects (S-26)", () => {
  test("free text on a question with options redirects: no decision, still open, inbox line", () => {
    const q = claude.ask({ title: "Color", body: "x\n\n- A. red\n- B. blue" });
    claude.inbox();
    const r = user.answer({ id: q.id, text: "neither, try warmer" });
    expect(r.id).toBe(q.id);
    expect(store.get(q.id).status).toBe("open");
    expect(store.all().filter((c) => c.kind === "decision")).toHaveLength(0);
    expect(store.get(q.id).comments).toContain("Redirect: neither, try warmer");
    expect(claude.inbox().map((e) => `${e.action} ${e.detail}`)).toEqual(["redirect neither, try warmer"]);
  });

  test("a free answer on a question without options still records a decision", () => {
    const q = claude.ask({ title: "Name?" });
    expect(user.answer({ id: q.id, text: "Spill" }).kind).toBe("decision");
    expect(store.get(q.id).status).toBe("answered");
  });
});

describe("answers (S-24)", () => {
  const body = "Pick.\n\n- A. red\n- B. green\n- C. blue";

  test("multi select records every pick in one decision, with Other", () => {
    const q = claude.ask({ title: "Colors", body, multi: true });
    expect(store.get(q.id).select).toBe("multi");
    const d = user.answer({ id: q.id, picks: ["A", "C"], text: "teal" });
    expect(d.title).toBe("A, C. red; blue; Other: teal");
    expect(store.get(q.id).status).toBe("answered");
  });

  test("single select takes one pick; unknown letters and empty answers are refused", () => {
    const q = claude.ask({ title: "Color", body });
    expect(store.get(q.id).select).toBeUndefined();
    expect(() => user.answer({ id: q.id, picks: ["A", "B"] })).toThrow("takes one answer");
    expect(() => user.answer({ id: q.id, picks: ["Z"] })).toThrow("no option Z");
    expect(() => user.answer({ id: q.id })).toThrow("An answer is required");
    expect(user.answer({ id: q.id, picks: ["B"] }).title).toBe("B. green");
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

  test("initialize and list the 17 tools", () => {
    const init = handle(store, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) as any;
    expect(init.result.serverInfo.name).toBe("spill");
    const list = handle(store, { jsonrpc: "2.0", id: 2, method: "tools/list" }) as any;
    expect(list.result.tools.map((t: any) => t.name)).toEqual([
      "spill_board", "spill_get", "spill_ask", "spill_draft_spec", "spill_update",
      "spill_set_status", "spill_comment", "spill_link", "spill_unlink", "spill_record", "spill_files", "spill_propose_replace", "spill_rejections", "spill_focus", "spill_checks", "spill_reply", "spill_inbox",
    ]);
  });

  test("check results are stored per spec and logged (S-13)", () => {
    call("spill_draft_spec", { title: "a" });
    expect(call("spill_checks", { id: "S-1", running: true }).result.content[0].text).toBe("Checks running on S-1");
    expect(store.checks()["S-1"].running).toBe(true);
    const r = call("spill_checks", { id: "S-1", results: [{ name: "focus is stored", pass: true }, { name: "weights_sum.py", pass: false, detail: "sum 0.98" }] });
    expect(r.result.content[0].text).toBe("S-1: 1 of 2 checks pass; failing: weights_sum.py");
    expect(store.checks()["S-1"]).toMatchObject({ running: false, results: [{ pass: true }, { name: "weights_sum.py", pass: false }] });
    expect(store.events().at(-1)!.detail).toBe("1 of 2 passed; weights_sum.py failed");
    expect(call("spill_checks", { id: "S-1" }).result.isError).toBe(true);
    expect(call("spill_checks", { id: "SEC-1", running: true }).result.isError).toBe(true);
  });

  test("board-level messages reach the inbox and Claude replies (S-23)", () => {
    user.message("What is left before v1?");
    expect(call("spill_inbox").result.content[0].text).toMatch(/user\s+message\s+-\s+What is left before v1\?/);
    expect(call("spill_reply", { text: "Q-5, then S-13." }).result.content[0].text).toBe("Replied");
    const last = store.events().at(-1)!;
    expect([last.actor, last.action, last.card, last.detail]).toEqual(["claude", "reply", "-", "Q-5, then S-13."]);
    expect(() => user.message("  ")).toThrow(/required/);
  });

  test("messages carry attachments and a received/working state (S-8)", () => {
    expect(store.messageState()).toBeNull();
    const path = store.saveAttachment("../shot one.png", new Uint8Array([1, 2, 3]));
    expect(path.startsWith(join(dir, "attachments"))).toBe(true);
    expect(path.endsWith("-shot_one.png")).toBe(true);
    expect([...readFileSync(path)]).toEqual([1, 2, 3]);
    const again = store.saveAttachment("shot one.png", new Uint8Array([4]));
    expect(again).not.toBe(path);
    expect([...readFileSync(path)]).toEqual([1, 2, 3]);
    user.message("Search feels slow", [path]);
    expect(store.messageState()).toBe("received");
    expect(call("spill_inbox").result.content[0].text).toContain(`Search feels slow [attached: ${path}]`);
    expect(store.messageState()).toBe("working");
    call("spill_focus", { discussing: ["SEC-1"] });
    expect(store.messageState()).toBe("working");
    call("spill_reply", { text: "Looking." });
    expect(store.messageState()).toBeNull();
    user.message("", [path]);
    expect(store.messageState()).toBe("received");
    call("spill_inbox");
    claude.ask({ title: "Which page?" });
    expect(store.messageState()).toBeNull();
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

describe("spotlight", () => {
  const call = (name: string, args: object = {}) =>
    handle(store, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any;

  test("focus is stored, logged, and shown on the board", () => {
    claude.draftSpec({ title: "a" });
    claude.draftSpec({ title: "b" });
    const r = call("spill_focus", { discussing: ["S-1"], next: ["S-2", "SEC-1"], note: "header lines" });
    expect(r.result.content[0].text).toBe("Spotlight: discussing S-1; next S-2, SEC-1 (header lines)");
    expect(store.focus()).toMatchObject({ discussing: ["S-1"], next: ["S-2", "SEC-1"], note: "header lines" });
    expect(store.events().at(-1)).toMatchObject({ actor: "claude", action: "focus", card: "S-1" });
    expect(call("spill_board").result.content[0].text.split("\n")[0]).toBe("Spotlight: discussing S-1; next S-2, SEC-1 (header lines)");
  });

  test("unknown IDs are refused and change nothing", () => {
    claude.draftSpec({ title: "a" });
    claude.setFocus({ discussing: ["S-1"] });
    const r = call("spill_focus", { discussing: ["S-9"] });
    expect(r.result.isError).toBe(true);
    expect(store.focus()!.discussing).toEqual(["S-1"]);
  });

  test("clear removes the spotlight", () => {
    claude.draftSpec({ title: "a" });
    claude.setFocus({ next: ["S-1"] });
    expect(call("spill_focus", { clear: true }).result.content[0].text).toBe("Spotlight cleared");
    expect(store.focus()).toBeNull();
    expect(call("spill_board").result.content[0].text.split("\n")[0]).toBe("Spotlight: none");
  });
});

describe("rejection queue", () => {
  const call = (name: string, args: object = {}) =>
    handle(store, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any;
  const text = (name: string, args: object = {}) => call(name, args).result.content[0].text as string;

  test("a rejection waits with its reason and heads the board and inbox", () => {
    claude.draftSpec({ title: "a" });
    user.setStatus({ id: "S-1", status: "rejected", note: "too broad" });
    expect(text("spill_rejections")).toMatch(/^S-1 a\n  rejected .*: too broad$/);
    expect(text("spill_board").split("\n")[0]).toBe("Rejections waiting: S-1 (see spill_rejections)");
    expect(text("spill_inbox").split("\n")[0]).toBe("Rejections waiting: S-1 (see spill_rejections)");
  });

  test("moving the card to discussing empties the queue; re-rejecting brings it back", () => {
    claude.draftSpec({ title: "a" });
    user.setStatus({ id: "S-1", status: "rejected", note: "first" });
    claude.setStatus({ id: "S-1", status: "discussing" });
    expect(text("spill_rejections")).toBe("No rejections waiting.");
    user.setStatus({ id: "S-1", status: "rejected", note: "second" });
    expect(text("spill_rejections")).toMatch(/: second$/);
  });

  test("resolve keeps the card rejected, comments, and empties the queue", () => {
    claude.draftSpec({ title: "a" });
    user.setStatus({ id: "S-1", status: "rejected", note: "no" });
    expect(text("spill_rejections", { resolve: "S-1", note: "dropping it" })).toBe("Resolved S-1; it stays rejected");
    expect(store.get("S-1").status).toBe("rejected");
    expect(store.get("S-1").comments).toContain("dropping it");
    expect(text("spill_rejections")).toBe("No rejections waiting.");
    expect(call("spill_rejections", { resolve: "S-1", note: "again" }).result.isError).toBe(true);
  });
});

describe("approval separate from building (S-29)", () => {
  const reqs = "## Requirements\n1. one\n2. two\n";
  const status = (id: string) => store.get(id).status;
  const autoLine = () => store.events().filter((e) => e.actor === "auto").map((e) => `${e.card} ${e.detail}`);

  test("Build queues an approved spec; only queued specs can be started; reject still works", () => {
    claude.draftSpec({ title: "a" });
    expect(() => user.build({ id: "S-1" })).toThrow(/only an approved spec/);
    user.setStatus({ id: "S-1", status: "approved" });
    expect(() => claude.setStatus({ id: "S-1", status: "active" })).toThrow(/queued with Build/);
    expect(() => claude.build({ id: "S-1" })).toThrow(/Only the user/);
    claude.inbox();
    user.build({ id: "S-1" });
    expect(claude.inbox().map((e) => e.detail)).toEqual(["approved -> queued"]);
    claude.setStatus({ id: "S-1", status: "active" });
    claude.draftSpec({ title: "b" });
    user.setStatus({ id: "S-2", status: "approved" });
    user.setStatus({ id: "S-2", status: "rejected", note: "not now" });
    expect(status("S-2")).toBe("rejected");
  });

  test("the last blocking question answered auto-approves; another open question holds it", () => {
    claude.draftSpec({ title: "a" });
    claude.ask({ title: "q1", body: "x\n\n- A. yes\n- B. no", blocks: ["S-1"] });
    claude.ask({ title: "q2", body: "x\n\n- A. yes\n- B. no", blocks: ["S-1"] });
    user.answer({ id: "Q-1", picks: ["A"] });
    expect(status("S-1")).toBe("draft");
    claude.inbox();
    user.answer({ id: "Q-2", picks: ["B"] });
    expect(status("S-1")).toBe("approved");
    expect(autoLine()).toEqual(["S-1 draft -> approved (auto: all questions answered)"]);
    expect(claude.inbox().some((e) => e.actor === "auto")).toBe(true);
  });

  test("every child spec done auto-approves the parent", () => {
    claude.draftSpec({ title: "parent" });
    for (const t of ["c1", "c2"]) {
      claude.draftSpec({ title: t, depends_on: ["S-1"] });
    }
    for (const id of ["S-2", "S-3"]) user.setStatus({ id, status: "approved" }), user.build({ id });
    claude.setStatus({ id: "S-2", status: "active" });
    claude.setStatus({ id: "S-2", status: "done" });
    expect(status("S-1")).toBe("draft");
    claude.setStatus({ id: "S-3", status: "active" });
    claude.setStatus({ id: "S-3", status: "done" });
    expect(status("S-1")).toBe("approved");
    expect(autoLine()).toEqual(["S-1 draft -> approved (auto: all child specs done)"]);
  });

  test("Reqs 1-n done covering every requirement auto-approves, unless a question is open", () => {
    claude.draftSpec({ title: "a", body: reqs });
    claude.comment({ id: "S-1", text: "Req 1 done" });
    expect(status("S-1")).toBe("draft");
    claude.comment({ id: "S-1", text: "Req 2 done" });
    expect(status("S-1")).toBe("approved");
    expect(autoLine()).toEqual(["S-1 draft -> approved (auto: all requirements met)"]);
    claude.draftSpec({ title: "b", body: reqs });
    claude.ask({ title: "q", body: "x\n\n- A. yes", blocks: ["S-2"] });
    claude.comment({ id: "S-2", text: "Reqs 1-2 done" });
    expect(status("S-2")).toBe("draft");
  });

  test("a design question answered A approves with design approved; B does not", () => {
    claude.draftSpec({ title: "a" });
    expect(() => claude.ask({ title: "d", design: true })).toThrow(/must block/);
    const q = claude.ask({ title: "Design for S-1", body: "Board: https://app.paper.design/file/x", blocks: ["S-1"], design: true });
    expect(q.design).toBe(true);
    expect(q.body).toContain("- A. Approve this design\n- B. Needs changes");
    expect(parseCard(formatCard(q)).design).toBe(true);
    user.answer({ id: q.id, text: "make it blue" });
    expect(status(q.id)).toBe("open");
    user.answer({ id: q.id, picks: ["A"] });
    expect(status("S-1")).toBe("approved");
    expect(autoLine()).toEqual(["S-1 draft -> approved (auto: design approved)"]);
    claude.draftSpec({ title: "b" });
    claude.ask({ title: "Design for S-2", blocks: ["S-2"], design: true });
    user.answer({ id: "Q-2", picks: ["B"] });
    expect(status("S-2")).toBe("draft");
  });
});

describe("message threads (S-30)", () => {
  const call = (name: string, args: object = {}) =>
    (handle(store, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any).result.content[0].text as string;
  const msgs = () => store.events().filter((e) => e.card === "-");

  test("replies go to the latest open thread or a named one; inbox lines name the thread", () => {
    user.message("first");
    const t1 = msgs()[0].at;
    claude.message("answer one");
    Bun.sleepSync(2);
    user.message("second");
    const t2 = msgs()[2].at;
    expect(store.messageState()).toBe("received");
    Bun.sleepSync(2);
    user.message("follow up", [], t1);
    const lines = call("spill_inbox").split("\n");
    expect(lines[0]).toMatch(/first  \(new thread\)$/);
    expect(lines[2]).toContain(`follow up  (in thread of ${t1.slice(0, 16).replace("T", " ")})`);
    // Default: the latest open thread, which is t1 now (its follow up is newest).
    claude.message("answer follow up");
    expect(msgs().at(-1)!.thread).toBe(t1);
    // t2 is still waiting; its message is not the latest, so the button settles on t1's reply.
    expect(store.messageState()).toBeNull();
    expect(call("spill_reply", { text: "answer two", thread: t2.slice(0, 16).replace("T", " ") })).toBe("Replied");
    expect(msgs().at(-1)!.thread).toBe(t2);
    expect(() => user.message("x", [], "2001-01-01T00:00:00.000Z")).toThrow(/No thread/);
  });

  test("a reply in another thread does not settle the latest message", () => {
    user.message("a");
    const t1 = msgs()[0].at;
    Bun.sleepSync(2); // threads are named by time; keep the two apart
    user.message("b");
    claude.message("for a", [], t1);
    expect(store.messageState()).toBe("received");
    claude.inbox();
    claude.message("for a again", [], t1);
    expect(store.messageState()).toBe("working");
  });
});
