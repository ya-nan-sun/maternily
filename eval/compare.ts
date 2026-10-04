// Run several models on the same pages and judge each against a fixed bar.
//
//   npm run compare                                  # Haiku 4.5, Sonnet 5.5, Opus 5.5 on patient 1 (8 dev pages)
//   npm run compare -- --models claude-sonnet-5-5,claude-opus-5-5 --effort low
//   npm run compare -- --extractor mock              # dry run without an API key
//
// Expected cost for the default run: under $1 in total (each page is read once per model, then cached).

import fs from "node:fs";
import { type ExtractorKind } from "../server/config.ts";
import { AiUnavailableError } from "../server/extraction/types.ts";
import { evaluate, parseArgs, saveReport, type EvalReport } from "./evaluate.ts";

/**
 * The bar a model must clear to be usable. Field accuracy and silent errors matter most:
 * a silent error is a wrong value saved without asking the midwife, the one failure the
 * review flow cannot catch.
 */
const BAR = {
  sectionAccuracy: 1, // every page recognized
  fieldAccuracy: 0.95, // of filled fields, before the midwife's review
  silentErrorRate: 0.01, // wrong AND not asked about, as a share of filled fields
  errorsFlagged: 0.7, // share of the model's mistakes that become a question
  questionsPerPage: 12, // above this the midwife is retyping, not reviewing
};

const args = parseArgs();
const kind = (args.get("extractor") ?? "claude") as ExtractorKind;
const models = kind === "mock" ? ["mock"] : (args.get("models") ?? "claude-haiku-4-5,claude-sonnet-5-5,claude-opus-5-5").split(",");
const split = args.get("split") ?? "dev";
const limit = Number(args.get("limit") ?? 8);
const effort = args.get("effort") ?? "medium";

console.log(`Comparing ${models.join(", ")} on ${limit} ${split} pages (effort ${effort} where supported).`);
const reports: EvalReport[] = [];
for (const model of models) {
  process.stdout.write(`\n${model} `);
  try {
    const r = await evaluate({ split, kind, model: kind === "mock" ? undefined : model, effort, limit });
    saveReport(r, `compare-${model}-${split}`);
    reports.push(r);
  } catch (e) {
    if (e instanceof AiUnavailableError) {
      console.error(`\nCannot reach Claude: ${e.message}\nSet ANTHROPIC_API_KEY (or add it to .env) and run again.`);
      process.exit(1);
    }
    console.error(`\n${model} failed: ${(e as Error).message}`);
  }
}

function judge(r: EvalReport) {
  const reasons: string[] = [];
  const pages = r.pages - r.failures.length;
  const qpp = pages ? r.uncertainty.questionsAsked / pages : Infinity;
  if (r.failures.length) reasons.push(`${r.failures.length} page(s) failed`);
  if (r.sectionAccuracy < BAR.sectionAccuracy) reasons.push(`page type wrong on ${Math.round((1 - r.sectionAccuracy) * pages)} page(s)`);
  if (r.fieldAccuracy < BAR.fieldAccuracy) reasons.push(`accuracy ${(100 * r.fieldAccuracy).toFixed(1)}% < ${BAR.fieldAccuracy * 100}%`);
  if (r.uncertainty.silentErrorRate > BAR.silentErrorRate) reasons.push(`${r.uncertainty.silentErrors} silent errors (${(100 * r.uncertainty.silentErrorRate).toFixed(1)}% > ${BAR.silentErrorRate * 100}%)`);
  if (r.uncertainty.errorsFlagged !== null && r.uncertainty.errorsFlagged < BAR.errorsFlagged) reasons.push(`only ${(100 * r.uncertainty.errorsFlagged).toFixed(0)}% of its mistakes are asked about`);
  if (qpp > BAR.questionsPerPage) reasons.push(`${qpp.toFixed(1)} questions per page`);
  return { pass: reasons.length === 0, reasons, qpp };
}

const fmt$ = (n: number | null) => (n === null ? "—" : `$${n.toFixed(n < 0.1 ? 3 : 2)}`);
const rows = reports.map((r) => {
  const j = judge(r);
  return {
    r, j,
    line: `| ${r.model} | ${r.effort} | ${(100 * r.sectionAccuracy).toFixed(0)}% | ${(100 * r.fieldAccuracy).toFixed(1)}% | ${r.uncertainty.errorsFlagged === null ? "—" : (100 * r.uncertainty.errorsFlagged).toFixed(0) + "%"} | ${r.uncertainty.silentErrors} | ${j.qpp.toFixed(1)} | ${fmt$(r.cost.perRegistryUsd)} | ${r.cost.avgLatencyMs ? (r.cost.avgLatencyMs / 1000).toFixed(0) + " s" : "—"} | ${j.pass ? "✅ pass" : "❌ " + j.reasons.join("; ")} |`,
  };
});

const passing = rows.filter((x) => x.j.pass && x.r.cost.perRegistryUsd !== null).sort((a, b) => a.r.cost.perRegistryUsd! - b.r.cost.perRegistryUsd!);
const best = [...rows].sort((a, b) => b.r.fieldAccuracy - a.r.fieldAccuracy)[0];
const verdict = passing.length
  ? `**Recommendation: ${passing[0].r.model}** — the cheapest model that clears the bar, at ${fmt$(passing[0].r.cost.perRegistryUsd)} per 8-page registry.`
  : best
    ? `**No model clears the bar on this sample.** Most accurate: ${best.r.model} (${(100 * best.r.fieldAccuracy).toFixed(1)}%). Look at its errors before changing prompts or thresholds.`
    : "No results.";

const table = [
  `Comparison on ${limit} ${split} pages (${new Date().toISOString().slice(0, 10)})`,
  "",
  "| Model | Effort | Page type | Field accuracy | Mistakes asked about | Silent errors | Questions / page | Cost / registry | Time / page | Verdict |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((x) => x.line),
  "",
  `Bar: page type ${BAR.sectionAccuracy * 100}%, field accuracy ≥ ${BAR.fieldAccuracy * 100}%, silent errors ≤ ${BAR.silentErrorRate * 100}% of fields, ≥ ${BAR.errorsFlagged * 100}% of mistakes asked about, ≤ ${BAR.questionsPerPage} questions per page.`,
  "",
  verdict,
  "",
  `Spent on this run: ${fmt$(reports.reduce((s, r) => s + r.cost.thisRunUsd, 0))} (pages already read by a model are served from cache).`,
].join("\n");

console.log("\n\n" + table);
fs.mkdirSync("eval/results", { recursive: true });
const out = `eval/results/${kind === "mock" ? "mock-" : ""}compare-${split}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
fs.writeFileSync(out, table + "\n");
console.log(`\nSaved: ${out}`);
if (kind === "mock") console.log("Mock dry run: numbers only check the harness.");
