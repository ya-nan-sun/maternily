// Evaluate one configuration.
//
//   npm run eval -- --split test                                   # Claude if configured, else mock
//   npm run eval -- --split dev --model claude-sonnet-5-5 --effort low --limit 8
//   npm run eval -- --split real --include-real-photos             # qualitative only, no ground truth

import { config, type ExtractorKind } from "../server/config.ts";
import { evaluate, parseArgs, saveReport } from "./evaluate.ts";

const args = parseArgs();
const report = await evaluate({
  split: args.get("split") ?? "test",
  kind: (args.get("extractor") ?? config.extractor) as ExtractorKind,
  model: args.get("model"),
  effort: args.get("effort"),
  fallback: args.get("fallback") as "claude" | "claude-code" | "none" | undefined,
  limit: args.has("limit") ? Number(args.get("limit")) : undefined,
  includeRealPhotos: args.get("include-real-photos") === "true",
});
const out = saveReport(report);

if (report.split === "real") {
  console.log(`Real photos: ${report.pages - report.failures.length} processed, ${report.failures.length} failed. No ground truth: review ${out} by hand.`);
} else {
  const u = report.uncertainty;
  console.log(`\n${report.extractor} (${report.model}, effort ${report.effort}) on ${report.split}: ${report.pages} pages, ${report.failures.length} failed`);
  console.log(`Section accuracy: ${(100 * report.sectionAccuracy).toFixed(1)}%`);
  console.log(`Field accuracy:   ${(100 * report.fieldAccuracy).toFixed(1)}% of ${report.fieldsScored} filled fields`);
  console.log(`Errors caught by a question: ${u.errorsFlagged === null ? "—" : (100 * u.errorsFlagged).toFixed(1) + "%"}; silent errors: ${u.silentErrors} (${(100 * u.silentErrorRate).toFixed(2)}% of fields); questions asked: ${u.questionsAsked}`);
  console.log("By section:", report.bySection);
  console.log("By type:   ", report.byType);
  console.log("By font:   ", report.byFont);
  console.log("Calibration:", report.calibration.map((c) => `${c.confidence}: ${c.accuracy} (n=${c.n})`).join(" | "));
  const c = report.cost;
  console.log(`AI: ${c.calls} calls (${c.cachedCalls} cached), this run $${c.thisRunUsd.toFixed(3)}; per page $${c.perPageUsd?.toFixed(4) ?? "—"}, per 8-page registry $${c.perRegistryUsd?.toFixed(3) ?? "—"}`);
  console.log(`Report: ${out}`);
  if (report.extractor === "mock") console.log("Note: the mock replays ground truth with injected noise; these numbers only validate the harness.");
}
