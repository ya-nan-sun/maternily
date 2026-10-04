// Turns the raw PDF vector dump (tools/pdf_ground_truth.py -> work/) into
// per-page ground truth keyed by catalog field, plus an image index and the
// dev/test split. Output: eval/ground_truth/*.json (redacted, safe to commit).
//
//   npm run gt

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FIELDS, FIELD_BY_KEY, SECTIONS, type Section } from "../shared/catalog.ts";
import { parseField } from "../shared/normalize.ts";
import type { FieldStatus } from "../shared/status.ts";
import { assignRuns, joinRuns, type TemplatePage } from "../shared/template.ts";
import { IDENTIFIER_LINES, TEMPLATE } from "./template-map.ts";

const RAW = "work/pdf_ground_truth_draft.json";
const IMAGES = "dayone-participants/data/Paper Registry";
const OUT = "eval/ground_truth";

interface Run { x: number; y: number; t: string; missing_glyph: boolean }
interface Box { x: number; y: number; checked: boolean; mark: string | null }
interface RawPage { pdf_page: number; patient_index: number; page_in_record: number; runs: Run[]; boxes: Box[]; printed: { x: number; y: number; t: string }[] }

export interface GtField { raw: string | null; status: FieldStatus; value: unknown; missingGlyph?: boolean }
export interface GtPage { pdfPage: number; patient: number; pageInRecord: number; section: Section; fields: Record<string, GtField> }

const raw: RawPage[] = JSON.parse(fs.readFileSync(RAW, "utf8"));
fs.mkdirSync(OUT, { recursive: true });

const near = (a: number, b: number, tol = 1) => Math.abs(a - b) < tol;
const warnings: string[] = [];
let unmapped = 0;
let mappedRuns = 0;

for (const page of raw) {
  const section = SECTIONS[page.page_in_record - 1];
  const maps = TEMPLATE[page.page_in_record];
  const checked = new Map<string, string[]>();
  const sawBox = new Set<string>();
  for (const m of maps) {
    if (m.kind !== "box") continue;
    const b = page.boxes.find((x) => near(x.x, m.bx) && near(x.y, m.by));
    if (!b) {
      warnings.push(`p${page.pdf_page}: no box at ${m.bx},${m.by} for ${m.key}`);
      continue;
    }
    sawBox.add(m.key);
    if (b.checked) checked.set(m.key, [...(checked.get(m.key) ?? []), m.option ?? "true"]);
  }
  const templatePage: TemplatePage = {
    pageInRecord: page.page_in_record, section, title: "", labels: [],
    identifierLines: IDENTIFIER_LINES[page.page_in_record] ?? [], mappings: maps,
  };
  const runs = page.runs.filter((r) => r.t !== "[REDACTED]");
  const { written: assigned, leftovers } = assignRuns(templatePage, runs);
  const written = assigned as Map<string, Run[]>;
  // Runs next to identifier labels are dropped by assignRuns and never become ground truth.
  const unmappedHere = leftovers.filter((r) => !(IDENTIFIER_LINES[page.page_in_record] ?? []).some(([lx, ly]) => near(r.y, ly, 5) && r.x > lx && r.x < lx + 250));
  unmapped += unmappedHere.length;
  mappedRuns += runs.length - unmappedHere.length;
  for (const r of unmappedHere) warnings.push(`p${page.pdf_page}: unmapped run "${r.t}" at ${r.x},${r.y}`);

  const fields: Record<string, GtField> = {};
  for (const def of FIELDS.filter((f) => f.section === section)) {
    const runs = written.get(def.key);
    if (def.input === "checkbox" && sawBox.has(def.key)) {
      const opts = checked.get(def.key) ?? [];
      if (def.type === "bool") fields[def.key] = { raw: opts.length ? "checked" : "unchecked", status: "KNOWN", value: opts.length > 0 };
      else if (def.type === "multi") fields[def.key] = { raw: opts.join(", "), status: "KNOWN", value: opts };
      else if (opts.length === 1) fields[def.key] = { raw: opts[0], status: "KNOWN", value: opts[0] };
      else if (opts.length === 0) fields[def.key] = { raw: null, status: "NOT_PROVIDED", value: null };
      else fields[def.key] = { raw: opts.join(", "), status: "NEEDS_REVIEW", value: null };
      continue;
    }
    if (!runs?.length) {
      fields[def.key] = { raw: null, status: "NOT_PROVIDED", value: null };
      continue;
    }
    const text = joinRuns(runs);
    const missingGlyph = runs.some((r) => r.missing_glyph);
    // Glyphs missing from the handwriting font render as gaps; parse with them blanked.
    const parsed = parseField(def.key, text.replace(/\u0000/g, ""));
    if (!parsed.ok && !parsed.status) warnings.push(`p${page.pdf_page}: ${def.key} could not parse "${text}" (${parsed.note})`);
    fields[def.key] = {
      raw: text,
      status: parsed.status ?? "KNOWN",
      value: parsed.ok ? parsed.value ?? null : null,
      ...(missingGlyph ? { missingGlyph: true } : {}),
    };
  }

  const gt: GtPage = { pdfPage: page.pdf_page, patient: page.patient_index, pageInRecord: page.page_in_record, section, fields };
  fs.writeFileSync(path.join(OUT, `page-${String(page.pdf_page).padStart(2, "0")}.json`), JSON.stringify(gt, null, 1));
}

// ---------------------------------------------------------------- image index + split
interface ImageEntry { file: string; sha256: string; pdfPage: number | null; patient: number | null; duplicateOf: string | null; realPhoto: boolean }
const seen = new Map<string, string>();
const images: ImageEntry[] = fs
  .readdirSync(IMAGES)
  .filter((f) => /\.(png|jpe?g)$/i.test(f))
  .sort()
  .map((file) => {
    const sha256 = createHash("sha256").update(fs.readFileSync(path.join(IMAGES, file))).digest("hex");
    const m = file.match(/patientes-(\d+)/);
    const pdfPage = m ? Number(m[1]) : null;
    const duplicateOf = seen.get(sha256) ?? null;
    if (!duplicateOf) seen.set(sha256, file);
    return { file, sha256, pdfPage, patient: pdfPage ? Math.floor((pdfPage - 1) / 8) + 1 : null, duplicateOf, realPhoto: /^1-\d\.jpg$/i.test(file) };
  });

const unique = images.filter((i) => !i.duplicateOf && i.pdfPage);
const split = {
  rule: "Split by patient so no patient's pages appear in both sets. Deterministic, no seed needed.",
  dev: unique.filter((i) => i.patient! <= 5).map((i) => i.file),
  test: unique.filter((i) => i.patient! >= 6).map((i) => i.file),
  realPhotos: images.filter((i) => i.realPhoto).map((i) => i.file),
};
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ images, split }, null, 1));

const checked = fs.readdirSync(OUT).filter((f) => f.startsWith("page-")).length;
console.log(`ground truth: ${checked} pages, ${FIELD_BY_KEY.size} catalog fields`);
console.log(`runs mapped: ${mappedRuns}, unmapped: ${unmapped}`);
console.log(`images: ${images.length} files, ${seen.size} unique; dev ${split.dev.length} / test ${split.test.length} pages`);
if (warnings.length) {
  console.log(`${warnings.length} warnings:`);
  for (const w of warnings.slice(0, 60)) console.log("  " + w);
}
