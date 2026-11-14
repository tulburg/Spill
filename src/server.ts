import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Board } from "./board";
import { Designs } from "./designs";
import type { Store } from "./store";

const UI_DIR = join(import.meta.dir, "..", "ui");
const VERSION: string = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version;

// S-39: app-wide settings shared by every project window, in ~/.spill/settings.json.
const THEMES = ["system", "light", "dark"];
function settingsFile() {
  return join(homedir(), ".spill", "settings.json");
}
function readSettings(): { theme: string } {
  try {
    const s = JSON.parse(readFileSync(settingsFile(), "utf8"));
    return { theme: THEMES.includes(s.theme) ? s.theme : "system" };
  } catch {
    return { theme: "system" };
  }
}

// S-45: ask the Spill app for a native design window over its socket (~/.spill/app.sock). Resolves
// false when no app is listening, so the page opens a browser tab instead.
function tellApp(line: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(join(homedir(), ".spill", "app.sock"));
    let got = "";
    const done = (ok: boolean) => (sock.destroy(), resolve(ok));
    sock.setTimeout(1500, () => done(false));
    sock.on("error", () => done(false));
    sock.on("connect", () => sock.write(`${line}\n`));
    sock.on("data", (d) => {
      got += d.toString();
      if (got.includes("\n")) done(got.startsWith("ok"));
    });
  });
}
const clean = (v: unknown) => String(v ?? "").replace(/[\t\n]/g, "");

async function bundle(): Promise<string> {
  const out = await Bun.build({ entrypoints: [join(UI_DIR, "main.ts")], target: "browser" });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  return out.outputs[0].text();
}

// Serves the canvas UI and the board API for one project, with live updates over SSE.
export async function startServer(store: Store, port = 4747) {
  const clients = new Set<ReadableStreamDefaultController>();
  // S-45: every spec's artboards, each with v (its file's mtime) so the UI refetches only what changed.
  const designSummary = () =>
    Object.fromEntries(
      new Designs(store).list().map((s) => {
        // S-47: h is the HTML's hash, to tell which artboards changed since an approved snapshot.
        const hashes = new Designs(store).htmlHashes(s.spec);
        return [
          s.spec,
          s.artboards.map((a) => {
            const f = join(store.dir, "designs", s.spec, `${a.id}.html`);
            return { ...a, v: existsSync(f) ? statSync(f).mtimeMs : 0, h: hashes[a.id] ?? "" };
          }),
        ];
      }),
    );
  // S-47: each spec's approved design snapshots, with the index of the version that was approved.
  const approvedSummary = () =>
    Object.fromEntries(
      store
        .all()
        .filter((c) => c.kind === "spec")
        .map((c) => {
          const vs = new Board(store, "user").versions(c);
          // S-49: label a snapshot with the approval-round version of the text it was taken with.
          const snaps = new Designs(store).snapshots(c.id).map((r) => {
            const i = vs.findLastIndex((v) => (v.seq !== undefined ? v.seq <= r.seq : v.at <= r.at));
            return { ...r, version: i, v: i >= 0 ? vs[i].v : 1 };
          });
          return [c.id, snaps];
        })
        .filter(([, snaps]) => (snaps as unknown[]).length),
    );
  // S-46: each spec's review feedback (pins, comments, reviews), for the viewer.
  const feedbackSummary = () => Object.fromEntries(new Designs(store).list().map((s) => [s.spec, new Designs(store).feedback(s.spec)]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(store.dir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const c of clients) {
        try {
          c.enqueue("data: change\n\n");
        } catch {
          clients.delete(c);
        }
      }
    }, 80);
  });

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const user = () => new Board(store, "user");
  const act = async (req: Request, fn: (body: any) => unknown) => {
    try {
      const body = req.headers.get("content-type")?.includes("json") ? await req.json() : {};
      fn(body);
      return json({ ok: true });
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  };

  const server = Bun.serve({
    port,
    idleTimeout: 0,
    routes: {
      "/": () => new Response(Bun.file(join(UI_DIR, "index.html"))),
      "/app.css": () => new Response(Bun.file(join(UI_DIR, "app.css"))),
      "/logo.svg": () => new Response(Bun.file(join(UI_DIR, "logo.svg")), { headers: { "content-type": "image/svg+xml" } }),
      "/app.js": async () => new Response(await bundle(), { headers: { "content-type": "text/javascript" } }),
      "/api/board": () => json({ project: store.config().project, cards: store.all(), focus: store.focus(), checks: store.checks(), todos: store.todos(), files: store.files(), rejections: new Board(store, "user").rejections().map((r) => ({ id: r.card.id, reason: r.reason, at: r.at })), events: store.events().slice(-200), versions: Object.fromEntries(store.all().filter((c) => c.kind === "spec" && store.versions(c.id).length).map((c) => [c.id, new Board(store, "user").versions(c)])), messages: store.events().filter((e) => e.card === "-" && (e.action === "message" || e.action === "reply")), messageState: store.messageState(), root: dirname(store.dir), designs: designSummary(), feedback: feedbackSummary(), approvedDesigns: approvedSummary(), specVersions: Object.fromEntries(store.all().filter((c) => c.kind === "spec").map((c) => [c.id, new Board(store, "user").version(c)])) }),
      // S-45: one artboard's HTML, for the spec viewer's previews and larger canvas.
      "/api/designs/:spec/:id": (req) => {
        const { spec, id } = req.params;
        if (!/^S-\d+$/.test(spec) || !/^ab-\d+$/.test(id)) return new Response("Not found", { status: 404 });
        const f = join(store.dir, "designs", spec, `${id}.html`);
        return existsSync(f) ? new Response(Bun.file(f), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }) : new Response("Not found", { status: 404 });
      },
      // S-46: review a spec's designs: feedback, pins, comments and replies.
      "/api/designs/:spec/feedback": (req) => {
        try {
          return json(new Designs(store, "user").feedback(req.params.spec));
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      },
      // S-47: one approved snapshot of a spec's designs (read only).
      "/api/designs/:spec/approved/:hash": (req) => {
        const snap = new Designs(store).readSnapshot(req.params.hash);
        return snap ? json(snap) : json({ error: "Not found" }, 404);
      },
      "/api/designs/:spec/pin": { POST: (req) => act(req, (b) => new Designs(store, "user").pin({ spec: req.params.spec, artboard: b.artboard, x: b.x, y: b.y, text: b.text })) },
      "/api/designs/:spec/comment": { POST: (req) => act(req, (b) => new Designs(store, "user").note({ spec: req.params.spec, variant: b.variant, text: b.text })) },
      "/api/designs/:spec/reply": { POST: (req) => act(req, (b) => new Designs(store, "user").reply({ spec: req.params.spec, pin: b.pin, comment: b.comment, text: b.text })) },
      // S-45: open (or bring forward) this spec's design window in the desktop app, or close it.
      "/api/designs-window": {
        POST: async (req) => {
          const b = await req.json().catch(() => ({}));
          if (!/^S-\d+$/.test(b.spec ?? "")) return json({ error: "Bad spec" }, 400);
          const view = b.view === "one" ? "one" : "board";
          const ok = await tellApp(["designs", dirname(store.dir), b.spec, view, clean(b.id), clean(b.snap)].join("\t"));
          return ok ? json({ ok: true }) : json({ error: "No Spill app" }, 404);
        },
      },
      "/api/designs-window/close": {
        POST: async (req) => {
          const b = await req.json().catch(() => ({}));
          if (!/^S-\d+$/.test(b.spec ?? "")) return json({ error: "Bad spec" }, 400);
          return (await tellApp(["close-designs", dirname(store.dir), b.spec].join("\t"))) ? json({ ok: true }) : json({ error: "No Spill app" }, 404);
        },
      },
      "/api/stream": () => {
        let ctl: ReadableStreamDefaultController;
        return new Response(
          new ReadableStream({
            start(c) {
              ctl = c;
              clients.add(c);
              c.enqueue("data: hello\n\n");
            },
            cancel() {
              clients.delete(ctl);
            },
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
        );
      },
      "/api/cards/:id/approve": {
        POST: (req) => act(req, (b) => user().setStatus({ id: req.params.id, status: "approved", note: b.note || undefined })),
      },
      // S-29: same as `spill build S-n`.
      "/api/cards/:id/build": {
        POST: (req) => act(req, () => user().build({ id: req.params.id })),
      },
      "/api/cards/:id/reject": {
        POST: (req) =>
          act(req, (b) => {
            if (!b.reason?.trim()) throw new Error("A reason is required to reject");
            user().setStatus({ id: req.params.id, status: "rejected", note: b.reason });
          }),
      },
      // S-5: same as `spill revert S-n [reason]`.
      "/api/cards/:id/revert": {
        POST: (req) => act(req, (b) => user().revert({ id: req.params.id, reason: b.reason })),
      },
      // S-1: a macOS notification for a new spec while the app is in the background. Title and body go
      // to osascript as arguments, never into the script text.
      "/api/notify": {
        POST: (req) =>
          act(req, (b) => {
            if (process.platform !== "darwin") return;
            const script = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"];
            Bun.spawn(["osascript", ...script.flatMap((l) => ["-e", l]), String(b.title ?? "Spill").slice(0, 120), String(b.body ?? "").slice(0, 240)]);
          }),
      },
      // S-7: the project menu's "Open .spill folder".
      "/api/open-folder": {
        POST: (req) =>
          act(req, (body) => {
            // S-39: Settings > General reveals the project folder instead.
            const target = body?.what === "project" ? dirname(store.dir) : store.dir;
            if (process.platform === "darwin") Bun.spawn(["open", target]);
          }),
      },
      "/api/settings": {
        GET: () => json({ ...readSettings(), version: VERSION }),
        POST: (req) =>
          act(req, (body) => {
            if (!THEMES.includes(body?.theme)) throw new Error("Theme must be system, light or dark");
            const dir = join(homedir(), ".spill");
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), theme: body.theme }, null, 2) + "\n");
          }),
      },
      // S-23: a board-level message to Claude.
      // S-8: files come as base64 and are saved under .spill/attachments/ first.
      "/api/message": {
        POST: (req) =>
          act(req, (b) => {
            const files: { name: string; data: string }[] = Array.isArray(b.files) ? b.files : [];
            const paths = files.map((f) => store.saveAttachment(String(f.name ?? "file"), Buffer.from(String(f.data ?? ""), "base64")));
            user().message(String(b.text ?? ""), paths, b.thread ? String(b.thread) : undefined);
          }),
      },
      // S-30: a saved message attachment, for thumbnails in thread cards.
      "/api/attachments/:name": (req) => {
        const name = req.params.name;
        if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) return json({ error: "Bad name" }, 400);
        const f = Bun.file(join(store.dir, "attachments", name));
        return f.size ? new Response(f) : json({ error: "Not found" }, 404);
      },
      // S-22: the raw card file for the side sheet's File tab.
      "/api/cards/:id/file": (req) => {
        const id = req.params.id;
        if (!/^[A-Z]+-\d+$/.test(id)) return json({ error: "Bad id" }, 400);
        const f = Bun.file(join(store.cardsDir, `${id}.md`));
        return new Response(f, { headers: { "content-type": "text/plain; charset=utf-8" } });
      },
      // S-20: same as `spill answer Q-n text`.
      "/api/cards/:id/answer": {
        POST: (req) =>
          act(req, (b) => user().answer({ id: req.params.id, picks: Array.isArray(b.picks) ? b.picks.map(String) : undefined, text: b.text })),
      },
      // S-33: ask for an update to a done spec.
      "/api/cards/:id/update": {
        POST: (req) => act(req, (b) => user().requestUpdate({ id: req.params.id, text: b.text })),
      },
      "/api/cards/:id/comment": {
        POST: (req) => act(req, (b) => user().comment({ id: req.params.id, text: b.text })),
      },
    },
  });
  return server;
}
