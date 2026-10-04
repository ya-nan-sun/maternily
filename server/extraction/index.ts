import { config } from "../config.ts";
import { now, type Db } from "../db.ts";
import { ClaudeExtractor } from "./claude.ts";
import { ClaudeCodeExtractor } from "./claude-code.ts";
import { MockExtractor } from "./mock.ts";
import { TemplateExtractor } from "./template-extractor.ts";
import { postprocess } from "./postprocess.ts";
import { PROMPT_VERSION } from "./prompt.ts";
import { RawExtraction, type Extractor, type PageExtraction } from "./types.ts";

export function createExtractor(kind = config.extractor, opts: { model?: string; effort?: string; fallback?: typeof config.aiFallback } = {}): Extractor {
  const claude = () => new ClaudeExtractor(opts.model ?? config.model, (opts.effort ?? config.effort) as typeof config.effort);
  if (kind === "claude") return claude();
  if (kind === "template") {
    const fallback = opts.fallback ?? config.aiFallback;
    return new TemplateExtractor(fallback === "claude" ? claude() : fallback === "claude-code" ? new ClaudeCodeExtractor() : null);
  }
  return new MockExtractor();
}

/**
 * Extract one image. Results are cached per (image hash, prompt version, model),
 * so a retake of the same photo, a duplicate, or a re-run never pays twice.
 * Every call, cached or not, is logged with its token usage and cost.
 */
export async function extractImage(
  db: Db,
  extractor: Extractor,
  image: Buffer,
  mime: string,
  contentHash: string,
  captureId: string | null,
): Promise<PageExtraction> {
  const cached = db
    .prepare("SELECT result FROM ai_cache WHERE content_hash = ? AND prompt_version = ? AND model = ?")
    .get(contentHash, PROMPT_VERSION, extractor.model) as { result: string } | undefined;
  if (cached) {
    logCall(db, { captureId, contentHash, model: extractor.model, cached: true, ok: true });
    return postprocess(RawExtraction.parse(JSON.parse(cached.result)), config.reviewThreshold, captureId);
  }
  const started = Date.now();
  try {
    const { raw, usage, costUsd } = await extractor.extract(image, mime, contentHash);
    db.prepare("INSERT OR REPLACE INTO ai_cache (content_hash, prompt_version, model, result, created_at) VALUES (?, ?, ?, ?, ?)").run(
      contentHash, PROMPT_VERSION, extractor.model, JSON.stringify(raw), now(),
    );
    const p = config.pricing[extractor.model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const cost = costUsd !== undefined ? costUsd : usage
      ? (usage.inputTokens * p.input + usage.outputTokens * p.output + usage.cacheReadTokens * p.cacheRead + usage.cacheWriteTokens * p.cacheWrite) / 1e6
      : 0;
    logCall(db, { captureId, contentHash, model: extractor.model, cached: false, ok: true, usage, cost, latencyMs: Date.now() - started });
    return postprocess(raw, config.reviewThreshold, captureId);
  } catch (e) {
    logCall(db, { captureId, contentHash, model: extractor.model, cached: false, ok: false, error: (e as Error).message, latencyMs: Date.now() - started });
    throw e;
  }
}

function logCall(
  db: Db,
  c: {
    captureId: string | null; contentHash: string; model: string; cached: boolean; ok: boolean; error?: string;
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
    cost?: number; latencyMs?: number;
  },
) {
  db.prepare(
    `INSERT INTO ai_calls (capture_id, content_hash, model, cached, ok, error, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.captureId, c.contentHash, c.model, c.cached ? 1 : 0, c.ok ? 1 : 0, c.error ?? null,
    c.usage?.inputTokens ?? null, c.usage?.outputTokens ?? null, c.usage?.cacheReadTokens ?? null, c.usage?.cacheWriteTokens ?? null,
    c.cost ?? 0, c.latencyMs ?? null, now(),
  );
}
