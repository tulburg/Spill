// S-34: a diff between two versions of a spec's text. Shared by the board (spill_get's summary) and
// the app (the diff view). Specs are short, so plain LCS tables are fine.
// Lines are compared without their list numbers, so renumbering is not a change. In each run of
// changed lines, a removed and an added line that keep about half their words become one "mod" line
// with word-level segments; only lines with no counterpart stay whole adds and dels.
export type Seg = { op: "same" | "add" | "del"; text: string };
export type DiffLine = { op: "same" | "add" | "del" | "mod"; text: string; segs?: Seg[] };

const NUM = /^(\s*)(\d+)\.(\s+)/;
const key = (line: string) => line.replace(NUM, "$1#.$3");

// LCS over two sequences, as a list of same/del/add steps.
function lcs<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): { op: "same" | "del" | "add"; i: number; j: number }[] {
  const n = a.length;
  const m = b.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = eq(a[i], b[j]) ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: { op: "same" | "del" | "add"; i: number; j: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) out.push({ op: "same", i: i++, j: j++ });
    else if (t[i + 1][j] >= t[i][j + 1]) out.push({ op: "del", i: i++, j });
    else out.push({ op: "add", i, j: j++ });
  }
  while (i < n) out.push({ op: "del", i: i++, j });
  while (j < m) out.push({ op: "add", i, j: j++ });
  return out;
}

// Words for similarity: letters and digits only, without the list number.
const words = (s: string) => s.replace(NUM, "$1").match(/[\p{L}\p{N}]+/gu) ?? [];

// How alike two lines are, 0 to 1; 0 when they are not the same line. A line is the same line when
// it keeps about half its words, or when one is mostly contained in the other (text added at the end).
function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return 0;
  const same = lcs(wa, wb, (x, y) => x === y).filter((s) => s.op === "same").length;
  const ofMax = same / Math.max(wa.length, wb.length);
  const ofMin = same / Math.min(wa.length, wb.length);
  return ofMax >= 0.5 || (ofMin >= 0.75 && same >= 3) ? ofMax + ofMin : 0;
}

// The best in-order pairing of removed and added lines (most total similarity), as [del, add] indexes.
function pairLines(dels: string[], adds: string[]): [number, number][] {
  const n = dels.length;
  const m = adds.length;
  const sim = dels.map((d) => adds.map((a) => similarity(d, a)));
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) t[i][j] = Math.max(t[i + 1][j], t[i][j + 1], sim[i][j] ? sim[i][j] + t[i + 1][j + 1] : 0);
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sim[i][j] && t[i][j] === sim[i][j] + t[i + 1][j + 1]) out.push([i++, j++]);
    else if (t[i][j] === t[i + 1][j]) i++;
    else j++;
  }
  return out;
}

// Word-level segments from a to b. The new list number leads as unchanged text.
export function wordDiff(a: string, b: string): Seg[] {
  const na = NUM.exec(a);
  const nb = NUM.exec(b);
  const lead = na && nb ? nb[0] : "";
  const ra = lead ? a.slice(na![0].length) : a;
  const rb = lead ? b.slice(nb![0].length) : b;
  const ta = ra.match(/\s+|\S+/g) ?? [];
  const tb = rb.match(/\s+|\S+/g) ?? [];
  const segs: Seg[] = lead ? [{ op: "same", text: lead }] : [];
  const push = (op: Seg["op"], text: string) => {
    const last = segs[segs.length - 1];
    if (last && last.op === op) last.text += text;
    else segs.push({ op, text });
  };
  // Steps, with lone spaces between two changes folded into the change, so "larger canvas" to
  // "design window" reads as one phrase replaced, not word by word.
  const steps = lcs(ta, tb, (x, y) => x === y).map((s) => (s.op === "add" ? { op: s.op, text: tb[s.j] } : { op: s.op, text: ta[s.i] }));
  for (let k = 1; k < steps.length - 1; k++)
    if (steps[k].op === "same" && /^\s+$/.test(steps[k].text) && steps[k - 1].op !== "same" && steps[k + 1].op !== "same") {
      steps.splice(k, 1, { op: "del", text: steps[k].text }, { op: "add", text: steps[k].text });
      k++;
    }
  let run: { del: string; add: string } = { del: "", add: "" };
  const close = () => {
    if (run.del) push("del", run.del);
    if (run.add) push("add", run.add);
    run = { del: "", add: "" };
  };
  for (const s of steps) {
    if (s.op === "same") {
      close();
      push("same", s.text);
    } else run[s.op as "del" | "add"] += s.text;
  }
  close();
  return segs;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.trimEnd().split("\n");
  const b = after.trimEnd().split("\n");
  const out: DiffLine[] = [];
  let dels: string[] = [];
  let adds: string[] = [];
  const flush = () => {
    // Pair in order: each added line takes the first later removed line it is similar to.
    // Between pairs, unpaired removed lines come before unpaired added lines, as in a plain diff.
    let i = 0;
    let j = 0;
    for (const [pi, pj] of [...pairLines(dels, adds), [dels.length, adds.length] as [number, number]]) {
      for (; i < pi; i++) out.push({ op: "del", text: dels[i] });
      for (; j < pj; j++) out.push({ op: "add", text: adds[j] });
      if (pi < dels.length && pj < adds.length) out.push({ op: "mod", text: adds[pj], segs: wordDiff(dels[pi], adds[pj]) });
      i = pi + 1;
      j = pj + 1;
    }
    dels = [];
    adds = [];
  };
  for (const s of lcs(a, b, (x, y) => key(x) === key(y))) {
    if (s.op === "same") {
      flush();
      out.push({ op: "same", text: b[s.j] });
    } else if (s.op === "del") dels.push(a[s.i]);
    else adds.push(b[s.j]);
  }
  flush();
  return out;
}
