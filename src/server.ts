import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Board } from "./board";
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

async function bundle(): Promise<string> {
  const out = await Bun.build({ entrypoints: [join(UI_DIR, "main.ts")], target: "browser" });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  return out.outputs[0].text();
}

// Serves the canvas UI and the board API for one project, with live updates over SSE.
export async function startServer(store: Store, port = 4747) {
  const clients = new Set<ReadableStreamDefaultController>();
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
      "/api/board": () => json({ project: store.config().project, cards: store.all(), focus: store.focus(), checks: store.checks(), files: store.files(), rejections: new Board(store, "user").rejections().map((r) => ({ id: r.card.id, reason: r.reason, at: r.at })), events: store.events().slice(-200), versions: Object.fromEntries(store.all().filter((c) => c.kind === "spec" && store.versions(c.id).length).map((c) => [c.id, new Board(store, "user").versions(c)])), messages: store.events().filter((e) => e.card === "-" && (e.action === "message" || e.action === "reply")), messageState: store.messageState(), root: dirname(store.dir) }),
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
