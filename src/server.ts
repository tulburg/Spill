import { watch } from "node:fs";
import { join } from "node:path";
import { Board } from "./board";
import type { Store } from "./store";

const UI_DIR = join(import.meta.dir, "..", "ui");

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
      "/app.js": async () => new Response(await bundle(), { headers: { "content-type": "text/javascript" } }),
      "/api/board": () => json({ project: store.config().project, cards: store.all(), events: store.events().slice(-200) }),
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
      "/api/cards/:id/reject": {
        POST: (req) =>
          act(req, (b) => {
            if (!b.reason?.trim()) throw new Error("A reason is required to reject");
            user().setStatus({ id: req.params.id, status: "rejected", note: b.reason });
          }),
      },
      "/api/cards/:id/comment": {
        POST: (req) => act(req, (b) => user().comment({ id: req.params.id, text: b.text })),
      },
    },
  });
  return server;
}
