// S-44: spill_design_screenshot. Renders with headless WebKit (src/render.swift), compiled once
// into ~/.spill/bin and rebuilt when the source changes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Designs } from "./designs";

const SOURCE = join(import.meta.dir, "render.swift");

function renderer(): string {
  const src = readFileSync(SOURCE);
  const hash = Bun.hash(src).toString(36);
  const bin = join(homedir(), ".spill", "bin", `spill-render-${hash}`);
  if (existsSync(bin)) return bin;
  mkdirSync(join(homedir(), ".spill", "bin"), { recursive: true });
  const r = Bun.spawnSync(["swiftc", "-O", "-o", bin, SOURCE], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`Could not build the renderer (needs the Xcode command line tools): ${r.stderr.toString().trim()}`);
  return bin;
}

export function screenshot(designs: Designs, a: { spec: string; node: string; scale?: number }): Uint8Array {
  const scale = Math.min(4, Math.max(0.25, a.scale ?? 1));
  const page = designs.page(a);
  const dir = mkdtempSync(join(tmpdir(), "spill-render-"));
  try {
    const html = join(dir, "page.html");
    const png = join(dir, "out.png");
    writeFileSync(html, page.html);
    const r = Bun.spawnSync([renderer(), html, png, String(page.width), String(page.height), String(scale), a.node], { stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`Render failed: ${r.stderr.toString().trim()}`);
    return readFileSync(png);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
