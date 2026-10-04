// Form templates: where each field sits on a given paper form.
// A template is registered once per form (e.g. per village's registry version) and
// lets the reader place handwriting into fields by position, without an AI.
// Coordinates are in template units (PDF points for the synthetic specimen, origin bottom-left).

import { fold, levenshtein } from "./normalize.ts";
import type { Section } from "./catalog.ts";

/** A handwritten value on the same line as a printed label at (lx, ly). */
export interface LineMap { kind: "line"; key: string; lx: number; ly: number; maxW?: number }
/** A checkbox at (bx, by), size 8. For choice/multi fields `option` is the option value. */
export interface BoxMap { kind: "box"; key: string; bx: number; by: number; option?: string }
/** A table cell: text whose x is in [x0, x1) and whose y is nearest to row y (or inside yBand). */
export interface CellMap { kind: "cell"; key: string; x0: number; x1: number; y: number; yBand?: [number, number] }
export type Mapping = LineMap | BoxMap | CellMap;

export interface TemplateLabel { text: string; x: number; y: number }
export interface TemplatePage {
  pageInRecord: number;
  section: Section;
  title: string;
  labels: TemplateLabel[];
  /** Printed lines next to which handwriting is a direct identifier: never read. */
  identifierLines: [number, number][];
  mappings: Mapping[];
}
export interface Template {
  id: string;
  name: string;
  /** Page size in template units and the box size used for checkboxes. */
  pageSize: [number, number];
  boxSize: number;
  pages: TemplatePage[];
}

/** A piece of text placed on the page in template coordinates (y = baseline-ish). */
export interface Run { x: number; y: number; t: string; score?: number }

const near = (a: number, b: number, tol: number) => Math.abs(a - b) < tol;
export const normLabel = (s: string) => fold(s).replace(/[^a-z0-9]/g, "");

/** Same-text test tolerant to OCR noise on long labels. */
export function sameText(a: string, b: string): boolean {
  const x = normLabel(a);
  const y = normLabel(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const longest = Math.max(x.length, y.length);
  return longest >= 6 && levenshtein(x, y) / longest <= 0.15;
}

/**
 * Place runs into fields. Returns the runs assigned to each written field and the
 * runs left over. Identical rules are used for the ground truth and for OCR.
 */
export function assignRuns(page: TemplatePage, runs: Run[]): { written: Map<string, Run[]>; leftovers: Run[] } {
  const used = new Set<Run>();
  const written = new Map<string, Run[]>();
  for (const [lx, ly] of page.identifierLines) {
    for (const r of runs) if (near(r.y, ly, 5) && r.x > lx && r.x < lx + 250) used.add(r);
  }
  for (const m of page.mappings) {
    if (m.kind !== "line") continue;
    const maxW = m.maxW ?? 260;
    const hits = runs.filter((r) => !used.has(r) && near(r.y, m.ly, 5) && r.x > m.lx + 3 && r.x < m.lx + maxW);
    hits.sort((a, b) => a.x - b.x);
    hits.forEach((r) => used.add(r));
    if (hits.length) written.set(m.key, hits);
  }
  const cells = page.mappings.filter((m): m is CellMap => m.kind === "cell");
  for (const r of runs) {
    if (used.has(r)) continue;
    let best: CellMap | undefined;
    let bestDy = Infinity;
    for (const c of cells) {
      if (r.x < c.x0 || r.x >= c.x1) continue;
      const dy = c.yBand ? (r.y >= c.yBand[0] && r.y <= c.yBand[1] ? 0 : Infinity) : Math.abs(r.y - c.y);
      if (dy < bestDy) {
        bestDy = dy;
        best = c;
      }
    }
    if (best && bestDy <= 14) {
      used.add(r);
      written.set(best.key, [...(written.get(best.key) ?? []), r]);
    }
  }
  return { written, leftovers: runs.filter((r) => !used.has(r)) };
}

/** Join the runs of one field into the text as written (top to bottom, left to right). */
export function joinRuns(runs: Run[]): string {
  return [...runs].sort((a, b) => b.y - a.y || a.x - b.x).map((r) => r.t).join(" ").trim();
}
