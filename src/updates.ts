import type { Card, SpillEvent } from "./store";

// S-33: an update the user asked for on a done spec, still waiting on Claude. Claude acts on it by
// doing anything to the spec (moving it, commenting, editing it) or by asking a question that blocks
// it; until then every request since the last such act counts. Shared by the board and the app.
export function pendingUpdate(spec: Card, cards: Card[], events: SpillEvent[]): { texts: string[]; at: string } | null {
  if (spec.kind !== "spec") return null;
  const blocksSpec = (id: string) => cards.find((c) => c.id === id)?.links.some((l) => l.type === "blocks" && l.target === spec.id) ?? false;
  let texts: string[] = [];
  let at = "";
  for (const e of events) {
    if (e.card === spec.id && e.action === "update_request" && e.actor === "user") {
      if (!texts.length) at = e.at;
      texts.push(e.detail ?? "");
    } else if (texts.length && e.actor === "claude" && (e.card === spec.id || (["ask", "link"].includes(e.action) && blocksSpec(e.card)))) {
      texts = [];
      at = "";
    }
  }
  return texts.length ? { texts, at } : null;
}
