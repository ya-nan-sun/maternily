// Reads a registry page with free local tools first, and asks Claude only about
// what they could not read:
//   1. PaddleOCR (local) reads every text line on the photo.
//   2. Printed labels identify the form template and page, and give the alignment
//      between the photo and the template.
//   3. Handwritten lines are placed into fields by position (shared/template.ts).
//   4. Checkboxes are read by measuring ink inside each box (no AI).
//   5. Fields that are still uncertain go to Claude in one targeted call per page,
//      listing only those fields. Without Claude they go to the midwife as questions.

import fs from "node:fs";
import path from "node:path";
import { fieldsOf, type Section } from "../../shared/catalog.ts";
import { fold, levenshtein } from "../../shared/normalize.ts";
import { assignRuns, joinRuns, normLabel, sameText, type Run, type Template, type TemplatePage } from "../../shared/template.ts";
import { config } from "../config.ts";
import { inkRatios, ocrPage, type OcrLine } from "./ocr-client.ts";
import { postprocess } from "./postprocess.ts";
import { AiUnavailableError, type Extractor, type ExtractorUsage, type FallbackReader, type RawExtraction } from "./types.ts";

type Affine = [number, number, number, number, number, number]; // x' = a·x + b·y + c, y' = d·x + e·y + f
const apply = (t: Affine, x: number, y: number): [number, number] => [t[0] * x + t[1] * y + t[2], t[3] * x + t[4] * y + t[5]];

function solve3(m: number[][], v: number[]): number[] {
  const a = m.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c || !a[c][c]) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

/** Least-squares affine map from template points to photo points, refit without outliers. */
function fitAffine(pairs: { src: [number, number]; dst: [number, number] }[]): Affine | null {
  const fit = (ps: typeof pairs): Affine | null => {
    if (ps.length < 3) return null;
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const vx = [0, 0, 0];
    const vy = [0, 0, 0];
    for (const { src: [x, y], dst: [u, v] } of ps) {
      const row = [x, y, 1];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) m[i][j] += row[i] * row[j];
        vx[i] += row[i] * u;
        vy[i] += row[i] * v;
      }
    }
    const [a, b, c] = solve3(m, vx);
    const [d, e, f] = solve3(m, vy);
    return [a, b, c, d, e, f].some((n) => !Number.isFinite(n)) ? null : [a, b, c, d, e, f];
  };
  let t = fit(pairs);
  if (!t) return null;
  const err = pairs.map((p) => Math.hypot(apply(t!, ...p.src)[0] - p.dst[0], apply(t!, ...p.src)[1] - p.dst[1]));
  const median = [...err].sort((a, b) => a - b)[Math.floor(err.length / 2)];
  const kept = pairs.filter((_, i) => err[i] <= Math.max(3 * median, 12));
  t = fit(kept) ?? t;
  return t;
}

function invert(t: Affine): Affine {
  const [a, b, c, d, e, f] = t;
  const det = a * e - b * d;
  return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det];
}

const BOX_GLYPHS = /[□■☐☑☒✓✔✗✘○●◯]/g;
const DASH = /^[-—–一_~=]+$/;
const COMMON_WORDS = ["RAS", "Néant", "Aucun", "Aucune", "Normales", "Normaux", "Normal", "Fermé", "Céphalique", "Voie basse", "Non fait", "Cycles réguliers", "Oui", "Non", "Neg", "Pos", "Immune"];

/** Replace a near-miss of a common registry word by the word itself (e.g. "RA5" → "RAS"). */
function snapWord(v: string): string {
  const n = fold(v).replace(/[^a-z0-9 ]/g, "");
  const exact = COMMON_WORDS.find((w) => fold(w) === n);
  if (exact) return exact;
  return COMMON_WORDS.find((w) => fold(w).length >= 4 && levenshtein(n, fold(w)) <= 1) ?? v;
}

export function loadTemplates(dir = "templates"): Template[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Template);
}

interface Match { template: Template; page: TemplatePage; score: number; toPhoto: Affine }

/** Which template page is this photo, and how does it map onto the photo? */
function identify(templates: Template[], lines: OcrLine[]): Match | null {
  let best: Match | null = null;
  for (const template of templates) {
    for (const page of template.pages) {
      const counts = new Map<string, number>();
      for (const l of page.labels) counts.set(normLabel(l.text), (counts.get(normLabel(l.text)) ?? 0) + 1);
      const pairs: { src: [number, number]; dst: [number, number] }[] = [];
      let score = 0;
      for (const label of page.labels) {
        const key = normLabel(label.text);
        if (key.length < 4 || counts.get(key)! > 1) continue;
        const hits = lines.filter((l) => sameText(l.text, label.text) || (key.length >= 5 && normLabel(l.text).startsWith(key)));
        if (hits.length !== 1) continue;
        const [x0, y0, , y1] = hits[0].box;
        pairs.push({ src: [label.x, label.y + 3], dst: [x0, (y0 + y1) / 2] });
        score += label.text === page.title ? 6 : 1;
      }
      if (!best || score > best.score) {
        const toPhoto = fitAffine(pairs);
        if (toPhoto) best = { template, page, score, toPhoto };
      }
    }
  }
  return best && best.score >= 8 ? best : null;
}

/** OCR lines in template coordinates, with printed text removed and label prefixes stripped. */
function handwrittenRuns(page: TemplatePage, lines: OcrLine[], toTemplate: Affine): Run[] {
  const runs: Run[] = [];
  for (const line of lines) {
    const [x0, y0, x1, y1] = line.box;
    let text = line.text.replace(BOX_GLYPHS, " ").trim();
    let [x, yc] = apply(toTemplate, x0, (y0 + y1) / 2);
    let y = yc - 3;
    for (let pass = 0; pass < 3 && text; pass++) {
      const nearby = page.labels.filter((l) => Math.abs(l.x - x) < 15 && Math.abs(l.y - y) < 6);
      // Printed text on its own: drop. A line longer than the label is label + handwriting: strip below.
      if (nearby.some((l) => sameText(text, l.text) && normLabel(text).length <= normLabel(l.text).length)) {
        text = "";
        break;
      }
      const prefix = nearby
        .filter((l) => normLabel(l.text).length >= 1 && normLabel(text).startsWith(normLabel(l.text)))
        .sort((a, b) => normLabel(b.text).length - normLabel(a.text).length)[0];
      if (!prefix) break;
      const target = normLabel(prefix.text);
      let cut = 0;
      while (cut < text.length && normLabel(text.slice(0, cut)) !== target) cut++;
      while (cut < text.length && normLabel(text.slice(0, cut + 1)) === target) cut++; // trailing ")", ":", spaces
      const rest = text.slice(cut).replace(/^[\s:：;.,\-]+/, "");
      x = apply(toTemplate, x0 + (cut / Math.max(1, line.text.length)) * (x1 - x0), (y0 + y1) / 2)[0] + 4;
      text = rest;
    }
    text = text.replace(/^[_|/\\\s]+|[_|\s]+$/g, ""); // the writing line under the text is often read as "_"
    if (text) runs.push({ x, y, t: text, score: line.score });
  }
  return runs;
}

/** Bump when the reading logic below changes: it is part of the result cache key. */
const PIPELINE_VERSION = 3;

export class TemplateExtractor implements Extractor {
  name = "template";
  model: string;
  private templates = loadTemplates();

  constructor(private fallback: FallbackReader | null, private ocrSize = process.env.OCR_MODEL_SIZE ?? "medium") {
    this.model = `paddleocr-${this.ocrSize}-v${PIPELINE_VERSION}+${fallback ? fallback.model : "no-ai-fallback"}`;
  }

  /** Raw OCR lines are cached on disk per image: re-reading the same photo is instant. */
  private async readLines(image: Buffer, contentHash: string) {
    const file = path.join(process.env.OCR_CACHE_DIR ?? "work/ocr-cache", `${this.ocrSize}-${contentHash}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as Awaited<ReturnType<typeof ocrPage>>;
    const page = await ocrPage(image);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(page));
    return page;
  }

  async extract(image: Buffer, mime: string, contentHash: string) {
    const ocr = await this.readLines(image, contentHash);
    const match = identify(this.templates, ocr.lines);
    if (!match) return this.unknownPage(image, mime, ocr.lines.length);

    const { page, template, toPhoto } = match;
    const toTemplate = invert(toPhoto);
    const section = page.section as Section;
    const { written } = assignRuns(page, handwrittenRuns(page, ocr.lines, toTemplate));

    // One ink measurement call for every checkbox and every empty table cell.
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      const pts = [apply(toPhoto, x0, y0), apply(toPhoto, x1, y1), apply(toPhoto, x0, y1), apply(toPhoto, x1, y0)];
      return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
    };
    const boxes = page.mappings.filter((m) => m.kind === "box");
    const emptyCells = page.mappings.filter((m) => m.kind === "cell" && !written.has(m.key) && !m.yBand);
    const s = template.boxSize;
    const [boxRatios, cellRatios] = await Promise.all([
      inkRatios(image, boxes.map((b) => rect(b.bx, b.by, b.bx + s, b.by + s)), true),
      inkRatios(image, emptyCells.map((c) => (c.kind === "cell" ? rect(c.x0 + 2, c.y - 4, c.x1 - 2, c.y + 10) : [])), false),
    ]);
    const ratios = [...boxRatios, ...cellRatios];
    const boxInk = new Map(boxes.map((b, i) => [b, ratios[i]]));
    const cellInk = new Map(emptyCells.map((c, i) => [c.key, ratios[boxes.length + i]]));

    const fields: RawExtraction["fields"] = [];
    for (const def of fieldsOf(section)) {
      if (def.input === "checkbox" && boxes.some((b) => b.key === def.key)) {
        const own = boxes.filter((b) => b.key === def.key).map((b) => ({ option: b.kind === "box" ? b.option : undefined, ink: boxInk.get(b)! }));
        const sure = (ink: number) => (ink >= 0.05 || ink <= 0.015 ? 0.95 : 0.55);
        const conf = Math.min(...own.map((o) => sure(o.ink)));
        const marked = own.filter((o) => o.ink > 0.03);
        if (def.type === "bool") fields.push({ k: def.key, v: marked.length ? "checked" : "unchecked", s: "K", c: conf });
        else if (def.type === "multi") fields.push({ k: def.key, v: marked.map((o) => o.option).join(", "), s: "K", c: conf });
        else if (marked.length) fields.push({ k: def.key, v: marked.map((o) => o.option).join(", "), s: "K", c: marked.length > 1 ? 0.4 : conf });
        continue;
      }
      const runs = written.get(def.key);
      if (runs?.length) {
        const v = joinRuns(runs);
        const c = Math.min(...runs.map((r) => r.score ?? 0.5));
        if (DASH.test(v.replace(/\s/g, ""))) fields.push({ k: def.key, v: "—", s: "NA", c });
        else fields.push({ k: def.key, v: def.type === "text" ? snapWord(v) : v, s: "K", c });
      } else if ((cellInk.get(def.key) ?? 0) > 0.012) {
        // Ink in the cell but no text recognized: something is written that OCR could not read.
        fields.push({ k: def.key, v: "", s: "I", c: 0.3 });
      }
    }

    const raw: RawExtraction = { section, section_confidence: Math.min(1, match.score / 40), page_usable: true, quality_issues: [], fields };
    return this.askClaudeAboutDoubts(image, mime, raw);
  }

  /** One targeted Claude call per page for the fields local reading was unsure of. */
  private async askClaudeAboutDoubts(image: Buffer, mime: string, raw: RawExtraction) {
    const checked = postprocess(raw, config.reviewThreshold, null);
    const doubtful = Object.values(checked.fields).filter((f) => f.status === "NEEDS_REVIEW" || f.status === "ILLEGIBLE").map((f) => f.key);
    if (!this.fallback || !doubtful.length) return { raw, costUsd: 0, claudeCalls: 0 };
    try {
      const answer = await this.fallback.extractKeys(image, mime, raw.section, doubtful);
      const byKey = new Map(answer.raw.fields.filter((f) => doubtful.includes(f.k)).map((f) => [f.k, f]));
      raw.fields = [...raw.fields.filter((f) => !byKey.has(f.k)), ...byKey.values()];
      return { raw, usage: answer.usage, costUsd: this.cost(answer.usage), claudeCalls: 1 };
    } catch (e) {
      // No Claude (no key, no credit, offline): the midwife is asked about these fields instead.
      if (!(e instanceof AiUnavailableError)) console.warn(`Claude fallback failed: ${(e as Error).message}`);
      return { raw, costUsd: 0, claudeCalls: 0 };
    }
  }

  /** Not a registered template (e.g. a different booklet): whole-page Claude, or manual entry. */
  private async unknownPage(image: Buffer, mime: string, lineCount: number) {
    if (this.fallback) {
      try {
        const answer = await this.fallback.extract(image, mime);
        return { raw: answer.raw, usage: answer.usage, costUsd: this.cost(answer.usage), claudeCalls: 1 };
      } catch (e) {
        if (!(e instanceof AiUnavailableError)) throw e;
      }
    }
    const raw: RawExtraction = { section: "UNKNOWN", section_confidence: 0, page_usable: lineCount > 5, quality_issues: lineCount > 5 ? [] : ["not_a_registry_page"], fields: [] };
    return { raw, costUsd: 0, claudeCalls: 0 };
  }

  /** API price of the fallback call; Claude Code runs on the logged-in plan and is not billed per call. */
  private cost(u?: ExtractorUsage) {
    const p = config.pricing[this.fallback?.model ?? ""];
    if (!u || !p) return 0;
    return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1e6;
  }
}
