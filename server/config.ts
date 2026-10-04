import fs from "node:fs";
import path from "node:path";
import { ocrInstalled } from "./ocr-runtime.ts";

function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadDotEnv(".env");

const env = (k: string, d: string) => process.env[k] ?? d;
const hasClaudeCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);

export type ExtractorKind = "template" | "claude" | "mock";
const requested = env("EXTRACTOR", "auto");
export const config = {
  port: Number(env("PORT", "8787")),
  dataDir: path.resolve(env("DATA_DIR", "data")),
  /**
   * "template": free local OCR + form templates, Claude only for what it cannot read (default when OCR is installed).
   * "claude": Claude reads every page. "mock": replays the PDF ground truth (demos without OCR or a key).
   */
  extractor: (requested === "auto" ? (ocrInstalled() ? "template" : hasClaudeCredentials ? "claude" : "mock") : requested) as ExtractorKind,
  /**
   * In template mode, who reads what local OCR could not:
   *   "none"        the midwife is asked (default: free, no keys, works anywhere)
   *   "claude-code" headless Claude Code on this laptop, logged-in plan (team demos only)
   *   "claude"      Claude API key (production path for DayOne)
   */
  aiFallback: env("AI_FALLBACK", "none") as "none" | "claude-code" | "claude",
  extractorWasAuto: requested === "auto",
  model: env("CLAUDE_MODEL", "claude-opus-5-5"),
  /** Thinking depth / token spend. "low" is cheaper; measure with `npm run eval` before changing. */
  effort: env("EXTRACTION_EFFORT", "medium") as "low" | "medium" | "high",
  /** Below this confidence a KNOWN field becomes NEEDS_REVIEW and the agent asks about it. */
  reviewThreshold: Number(env("REVIEW_THRESHOLD", "0.8")),
  /** Pages sent by one midwife form one document until "done" or this much silence. */
  sessionIdleMinutes: Number(env("SESSION_IDLE_MINUTES", "10")),
  maxAttempts: Number(env("AI_MAX_ATTEMPTS", "3")),
  /** USD per million tokens (input, output, cache read, cache write), used for the cost log only. */
  pricing: {
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  } as Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>,
  /** Demo role tokens for the office console. */
  roles: {
    supervisor: env("SUPERVISOR_TOKEN", "supervisor-demo"),
    analyst: env("ANALYST_TOKEN", "analyst-demo"),
  },
};

fs.mkdirSync(config.dataDir, { recursive: true });
