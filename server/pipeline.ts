// Background worker: takes pages in PENDING_AI, runs extraction, and retries
// with exponential backoff. State lives in SQLite, so a restart resumes the
// queue without losing anything.

import { config } from "./config.ts";
import { now, setState, type Db } from "./db.ts";
import { readImage } from "./images.ts";
import { extractImage } from "./extraction/index.ts";
import { AiUnavailableError, type Extractor } from "./extraction/types.ts";
import type { Agent } from "./agent.ts";

export class Pipeline {
  private inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private db: Db, private extractor: Extractor, private agent: Agent, private concurrency = 3) {}

  start(intervalMs = 500) {
    this.timer = setInterval(() => {
      this.kick();
      this.agent.tick();
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Pick up due pages now (also called right after a message arrives). */
  kick() {
    const free = this.concurrency - this.inFlight.size;
    if (free <= 0) return;
    const due = this.db
      .prepare(
        `SELECT capture_id FROM pages WHERE state = 'PENDING_AI' AND replaced_by IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY received_at LIMIT ?`,
      )
      .all(now(), free + this.inFlight.size) as { capture_id: string }[];
    for (const { capture_id } of due) {
      if (this.inFlight.has(capture_id) || this.inFlight.size >= this.concurrency) continue;
      this.inFlight.add(capture_id);
      void this.process(capture_id).finally(() => this.inFlight.delete(capture_id));
    }
  }

  /** Wait until no page is queued or in flight (tests and the eval use this). */
  async drain(timeoutMs = 60_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      this.kick();
      const pending = (this.db.prepare("SELECT COUNT(*) AS n FROM pages WHERE state = 'PENDING_AI' AND replaced_by IS NULL").get() as { n: number }).n;
      if (!pending && !this.inFlight.size) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("pipeline drain timed out");
  }

  private async process(captureId: string) {
    const page = this.db.prepare("SELECT * FROM pages WHERE capture_id = ?").get(captureId) as {
      capture_id: string; midwife_id: string; image_path: string; mime: string; content_hash: string; attempts: number;
    };
    if (!page) return; // deleted by a reset
    try {
      const image = readImage(page.image_path);
      const result = await extractImage(this.db, this.extractor, image, page.mime, page.content_hash, captureId);
      // The midwife may have reset her conversation while the page was being read.
      if (!this.db.prepare("SELECT 1 FROM pages WHERE capture_id = ?").get(captureId)) return;
      this.db
        .prepare("UPDATE pages SET section = ?, section_confidence = ?, quality = ?, fields = ?, error = NULL WHERE capture_id = ?")
        .run(result.section, result.sectionConfidence, JSON.stringify(result.quality), JSON.stringify(result.fields), captureId);
      setState(this.db, "page", captureId, "AI_PROCESSED", `extracted by ${this.extractor.name} (${result.section})`);
    } catch (e) {
      const message = (e as Error).message;
      const attempts = page.attempts + 1;
      if (e instanceof AiUnavailableError || attempts >= config.maxAttempts) {
        this.db.prepare("UPDATE pages SET attempts = ?, error = ? WHERE capture_id = ?").run(attempts, message, captureId);
        setState(this.db, "page", captureId, "PROCESSING_FAILED", e instanceof AiUnavailableError ? `AI unavailable: ${message}` : `failed after ${attempts} attempts: ${message}`);
      } else {
        const delay = 5_000 * 2 ** (attempts - 1);
        this.db
          .prepare("UPDATE pages SET attempts = ?, error = ?, next_attempt_at = ? WHERE capture_id = ?")
          .run(attempts, message, new Date(Date.now() + delay).toISOString(), captureId);
        return; // stays PENDING_AI, retried later
      }
    }
    this.agent.onPageProcessed(page.midwife_id, captureId);
  }
}
