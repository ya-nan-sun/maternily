// Field-level evaluation of the extraction pipeline against the PDF-derived ground truth.
// Used by eval/run.ts (one configuration) and eval/compare.ts (several models side by side).
// Results are cached per image and model (work/eval.db), so re-running costs nothing.

import fs from "node:fs";
import path from "node:path";
import { FIELD_BY_KEY, type Section } from "../shared/catalog.ts";
import { fold, valuesEqual } from "../shared/normalize.ts";
import type { FieldStatus, FieldValue } from "../shared/status.ts";
import { config, type ExtractorKind } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { createExtractor, extractImage } from "../server/extraction/index.ts";
import type { PageExtraction } from "../server/extraction/types.ts";
import { AiUnavailableError } from "../server/extraction/types.ts";

const IMAGES = "dayone-participants/data/Paper Registry";
const FONTS = ["Caveat", "ShadowsIntoLight", "NanumPen", "Gaegu", "ReenieBeanie"];

export interface EvalOptions {
  split: string;
  kind: ExtractorKind;
  model?: string;
  effort?: string;
  fallback?: "claude" | "claude-code" | "none";
  limit?: number;
  includeRealPhotos?: boolean;
  quiet?: boolean;
}

interface GtField { raw: string | null; status: FieldStatus; value: unknown; missingGlyph?: boolean }
type Bucket = { n: number; correct: number };
const bucket = (): Bucket => ({ n: 0, correct: 0 });
const pct = (b: Bucket) => (b.n ? `${((100 * b.correct) / b.n).toFixed(1)}%` : "—");

/** Text with glyphs missing from the handwriting font: any letter may fill each gap. */
function matchesWithGaps(gtRaw: string, predicted: unknown): boolean {
  const pattern = gtRaw
    .split("\u0000")
    .map((part) => fold(part).replace(/[^a-z0-9]/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[a-z]?");
  return new RegExp(`^${pattern}$`).test(fold(String(predicted)).replace(/[^a-z0-9]/g, ""));
}

function correct(key: string, gt: GtField, pred: FieldValue | undefined): boolean {
  if (!pred || pred.value === null || pred.value === undefined) return false;
  if (gt.missingGlyph && gt.raw && FIELD_BY_KEY.get(key)?.type === "text") return matchesWithGaps(gt.raw, pred.value);
  return valuesEqual(key, pred.value, gt.value);
}

export async function evaluate(opts: EvalOptions) {
  const index = JSON.parse(fs.readFileSync("eval/ground_truth/index.json", "utf8")) as {
    images: { file: string; sha256: string; pdfPage: number | null; patient: number | null }[];
    split: Record<string, string[]>;
  };
  if (opts.split === "real" && !opts.includeRealPhotos) {
    throw new Error("The real booklet photos may contain real patient data. Pass --include-real-photos to send them to the AI.");
  }
  const files = (index.split[opts.split === "real" ? "realPhotos" : opts.split] ?? []).slice(0, opts.limit ?? Infinity);
  if (!files.length) throw new Error(`unknown or empty split "${opts.split}"`);

  const db = openDb(path.join("work", "eval.db"));
  const extractor = createExtractor(opts.kind, { model: opts.model, effort: opts.effort, fallback: opts.fallback });
  const firstCallId = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM ai_calls").get() as { id: number }).id;

  const overall = bucket();
  const bySection = new Map<string, Bucket>();
  const byType = new Map<string, Bucket>();
  const byInput = new Map<string, Bucket>();
  const byFont = new Map<string, Bucket>();
  const statusConfusion: Record<string, Record<string, number>> = {};
  const calibration = Array.from({ length: 5 }, bucket);
  let sectionsRight = 0;
  let wrongFlagged = 0, wrongSilent = 0, rightFlagged = 0, rightAccepted = 0;
  const errors: { file: string; key: string; expected: string | null; got: string | null; status: string; confidence: number }[] = [];
  const add = (m: Map<string, Bucket>, k: string, ok: boolean) => {
    const b = m.get(k) ?? bucket();
    b.n++;
    if (ok) b.correct++;
    m.set(k, b);
  };

  const realOutputs: Record<string, PageExtraction> = {};
  const failures: { file: string; error: string }[] = [];
  for (const file of files) {
    const img = index.images.find((i) => i.file === file)!;
    const bytes = fs.readFileSync(path.join(IMAGES, file));
    let result: PageExtraction;
    try {
      result = await extractImage(db, extractor, bytes, file.endsWith(".png") ? "image/png" : "image/jpeg", img.sha256, null);
    } catch (e) {
      if (e instanceof AiUnavailableError) throw e; // no point trying the other pages
      failures.push({ file, error: (e as Error).message });
      if (!opts.quiet) console.error(`✗ ${file}: ${(e as Error).message}`);
      continue;
    }
    if (!opts.quiet) process.stdout.write(".");
    if (opts.split === "real") {
      realOutputs[file] = result;
      continue;
    }
    const gt = JSON.parse(fs.readFileSync(`eval/ground_truth/page-${String(img.pdfPage).padStart(2, "0")}.json`, "utf8")) as { section: Section; fields: Record<string, GtField> };
    if (result.section === gt.section) sectionsRight++;
    const font = FONTS[(img.patient! - 1) % 5];
    for (const [key, truth] of Object.entries(gt.fields)) {
      const pred = result.section === gt.section ? result.fields[key] : undefined;
      const predStatus = pred?.status ?? "NOT_PROVIDED";
      statusConfusion[truth.status] ??= {};
      statusConfusion[truth.status][predStatus] = (statusConfusion[truth.status][predStatus] ?? 0) + 1;
      if (truth.status !== "KNOWN") continue;
      const ok = correct(key, truth, pred);
      overall.n++;
      if (ok) overall.correct++;
      const def = FIELD_BY_KEY.get(key)!;
      add(bySection, gt.section, ok);
      add(byType, def.type, ok);
      add(byInput, def.input, ok);
      add(byFont, font, ok);
      if (pred && pred.value !== null) {
        const b = calibration[Math.min(4, Math.floor(pred.confidence * 5))];
        b.n++;
        if (ok) b.correct++;
      }
      const flagged = predStatus === "NEEDS_REVIEW" || predStatus === "ILLEGIBLE";
      if (!ok && flagged) wrongFlagged++;
      else if (!ok) wrongSilent++;
      else if (flagged) rightFlagged++;
      else rightAccepted++;
      if (!ok && errors.length < 300) errors.push({ file, key, expected: truth.raw, got: pred?.raw ?? null, status: predStatus, confidence: pred?.confidence ?? 0 });
    }
  }
  if (!opts.quiet) console.log();

  // Cost and speed of this run only (cached pages cost nothing and are counted as such).
  const run = db
    .prepare(
      `SELECT COUNT(*) AS calls, SUM(cached) AS cached, SUM(cost_usd) AS cost, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
              SUM(cache_read_tokens) AS cacheRead, AVG(CASE WHEN cached = 0 THEN latency_ms END) AS latencyMs
       FROM ai_calls WHERE id > ? AND model = ?`,
    )
    .get(firstCallId, extractor.model) as Record<string, number | null>;
  // Price per page as if nothing were cached, from the stored token counts of these images.
  const hashes = files.map((f) => index.images.find((i) => i.file === f)!.sha256);
  const firstCalls = db
    .prepare(`SELECT content_hash, cost_usd, output_tokens, latency_ms FROM ai_calls WHERE model = ? AND cached = 0 AND ok = 1 AND content_hash IN (${hashes.map(() => "?").join(",")}) GROUP BY content_hash`)
    .all(extractor.model, ...hashes) as { cost_usd: number; output_tokens: number; latency_ms: number }[];
  const costPerPage = firstCalls.length ? firstCalls.reduce((s, c) => s + c.cost_usd, 0) / firstCalls.length : null;

  const wrong = wrongFlagged + wrongSilent;
  const pagesScored = files.length - failures.length;
  return {
    extractor: extractor.name,
    model: extractor.model,
    effort: extractor.model.startsWith("claude-haiku-4-5") ? "n/a" : opts.effort ?? config.effort,
    split: opts.split,
    pages: files.length,
    failures,
    realOutputs: opts.split === "real" ? realOutputs : undefined,
    sectionAccuracy: pagesScored ? sectionsRight / pagesScored : 0,
    fieldAccuracy: overall.n ? overall.correct / overall.n : 0,
    fieldsScored: overall.n,
    uncertainty: {
      errors: wrong,
      errorsFlagged: wrong ? wrongFlagged / wrong : null,
      silentErrors: wrongSilent,
      silentErrorRate: overall.n ? wrongSilent / overall.n : 0,
      questionsAsked: wrongFlagged + rightFlagged,
      flaggedButCorrect: rightFlagged,
      acceptedAndCorrect: rightAccepted,
    },
    bySection: Object.fromEntries([...bySection].map(([k, b]) => [k, pct(b)])),
    byType: Object.fromEntries([...byType].map(([k, b]) => [k, pct(b)])),
    byInput: Object.fromEntries([...byInput].map(([k, b]) => [k, pct(b)])),
    byFont: Object.fromEntries([...byFont].map(([k, b]) => [k, pct(b)])),
    calibration: calibration.map((b, i) => ({ confidence: `${i * 20}-${i * 20 + 20}%`, n: b.n, accuracy: pct(b) })),
    statusConfusion,
    cost: {
      thisRunUsd: run.cost ?? 0,
      perPageUsd: costPerPage,
      perRegistryUsd: costPerPage === null ? null : costPerPage * 8,
      avgOutputTokens: firstCalls.length ? firstCalls.reduce((s, c) => s + c.output_tokens, 0) / firstCalls.length : null,
      avgLatencyMs: firstCalls.length ? firstCalls.reduce((s, c) => s + c.latency_ms, 0) / firstCalls.length : null,
      calls: run.calls ?? 0,
      cachedCalls: run.cached ?? 0,
    },
    errors,
  };
}

export type EvalReport = Awaited<ReturnType<typeof evaluate>>;

export function saveReport(report: EvalReport, label = `${report.model}-${report.split}`) {
  fs.mkdirSync("eval/results", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join("eval/results", `${report.extractor === "mock" ? "mock" : label}-${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  return out;
}

/** CLI flags: --split dev --extractor claude --model claude-sonnet-5-5 --effort low --limit 8 */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args.set(a.slice(2), argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? "true" : argv[++i]);
  }
  return args;
}
