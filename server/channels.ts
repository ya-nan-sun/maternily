// Outbound delivery for real messaging channels (Meta WhatsApp Cloud API, Twilio).
// The agent only writes to the `outbound` table; this dispatcher sends each
// midwife's messages strictly in order, merges bursts into one message (fewer
// messages = lower cost and less noise), retries failures, and never sends
// outside the free 24-hour WhatsApp window.

import type { OutboundMessage } from "../shared/messages.ts";
import { now, setState, type Db } from "./db.ts";

export const WINDOW_MS = 23.5 * 60 * 60 * 1000; // stay just inside the 24 h customer service window

export interface ChannelSender {
  /** Value of midwives.channel this sender serves. */
  channel: string;
  enabled(): boolean;
  /** Longest text this channel accepts in one message (bursts are merged up to this). */
  maxText: number;
  /** WhatsApp only allows free replies within 24 h of the midwife's last message; Telegram has no such rule. */
  freeWindowOnly?: boolean;
  /** True when a successful send already means the message reached the phone (no separate receipt). */
  sendMeansDelivered?: boolean;
  /** Send one message; returns the provider's message id. Throw an Error with `permanent: true` for 4xx errors. */
  send(msg: OutboundMessage, phone: string, lang: "fr" | "en"): Promise<string | null>;
}

interface Pending {
  seq: number; id: string; payload: string; phone: string; lang: "fr" | "en"; midwife_id: string; channel: string;
  created_at: string; attempts: number | null; next_attempt_at: string | null;
}

/** A delivery receipt arrived: if it confirms the "saved" message of a registered record, the record is SYNCED. */
export function onDelivered(db: Db, providerId: string) {
  const rows = db
    .prepare("SELECT o.payload FROM wa_deliveries d JOIN outbound o ON o.id = d.outbound_id WHERE d.wamid = ?")
    .all(providerId) as { payload: string }[];
  for (const row of rows) {
    const docId = (JSON.parse(row.payload) as OutboundMessage).refs?.docId;
    const doc = docId && (db.prepare("SELECT state FROM documents WHERE id = ?").get(docId) as { state: string } | undefined);
    if (doc && doc.state === "REGISTERED") setState(db, "document", docId!, "SYNCED", "confirmation delivered to the midwife's phone");
  }
}

export function onFailed(db: Db, providerId: string, error: string) {
  db.prepare("UPDATE wa_deliveries SET status = 'failed', error = ?, updated_at = ? WHERE wamid = ?").run(error, now(), providerId);
}

export class OutboundDispatcher {
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private senders: Map<string, ChannelSender>;

  /** coalesceMs: wait this long after a midwife's latest message before sending, to merge bursts. */
  constructor(private db: Db, senders: ChannelSender[], private coalesceMs = 0) {
    this.senders = new Map(senders.map((s) => [s.channel, s]));
  }

  start(intervalMs = 700) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    const channels = [...this.senders.values()].filter((s) => s.enabled()).map((s) => s.channel);
    if (this.busy || !channels.length) return;
    this.busy = true;
    try {
      const pending = this.db
        .prepare(
          `SELECT o.seq, o.id, o.payload, o.midwife_id, o.created_at, m.phone, m.lang, m.channel, d.attempts, d.next_attempt_at
           FROM outbound o JOIN midwives m ON m.id = o.midwife_id
           LEFT JOIN wa_deliveries d ON d.outbound_id = o.id
           WHERE m.channel IN (${channels.map(() => "?").join(",")}) AND (d.status IS NULL OR d.status = 'retry')
           ORDER BY o.seq`,
        )
        .all(...channels) as unknown as Pending[];
      const byMidwife = new Map<string, Pending[]>();
      for (const p of pending) byMidwife.set(p.midwife_id, [...(byMidwife.get(p.midwife_id) ?? []), p]);
      for (const queue of byMidwife.values()) await this.flushMidwife(queue);
    } finally {
      this.busy = false;
    }
  }

  private async flushMidwife(queue: Pending[]) {
    const first = queue[0];
    const sender = this.senders.get(first.channel)!;
    if (first.next_attempt_at && first.next_attempt_at > now()) return;
    if (sender.freeWindowOnly !== false) {
      const lastInbound = this.db.prepare("SELECT MAX(received_at) AS t FROM inbound WHERE midwife_id = ?").get(first.midwife_id) as { t: string | null };
      if (!lastInbound.t || Date.now() - Date.parse(lastInbound.t) > WINDOW_MS) return; // outside the free window: wait for her next message
    }

    // Build one batch: consecutive messages, ending at the first one with choices.
    const batch: Pending[] = [];
    let length = 0;
    for (const [i, p] of queue.entries()) {
      const msg = JSON.parse(p.payload) as OutboundMessage;
      if (batch.length && length + msg.text.length + 2 > sender.maxText) break;
      batch.push(p);
      length += msg.text.length + 2;
      // A lone "Done" button is superseded by whatever follows (e.g. 8 page receipts become one message);
      // any real choice ends the message so it stays answerable.
      const onlyDone = msg.buttons?.length === 1 && msg.buttons[0].id === "done";
      if ((msg.buttons?.length && !(onlyDone && i < queue.length - 1)) || (p.attempts ?? 0) > 0) break;
    }
    const newest = batch[batch.length - 1];
    if (this.coalesceMs && Date.now() - Date.parse(newest.created_at) < this.coalesceMs && batch.length === queue.length) return; // more may come

    const messages = batch.map((p) => JSON.parse(p.payload) as OutboundMessage);
    const merged: OutboundMessage = {
      ...messages[messages.length - 1],
      text: messages.map((m) => m.text).join("\n\n"),
      refs: [...messages].reverse().find((m) => m.refs?.docId)?.refs ?? messages[messages.length - 1].refs,
    };
    const attempts = (first.attempts ?? 0) + 1;
    try {
      const providerId = await sender.send(merged, first.phone, first.lang);
      for (const p of batch) this.record(p.id, "sent", providerId, attempts, null, null);
      if (sender.sendMeansDelivered && providerId) onDelivered(this.db, providerId);
      if (batch.length < queue.length) await this.flushMidwife(queue.slice(batch.length));
    } catch (e) {
      const permanent = (e as { permanent?: boolean }).permanent && attempts >= 3;
      const next = new Date(Date.now() + Math.min(60_000, 2_000 * 2 ** attempts)).toISOString();
      for (const p of batch) this.record(p.id, permanent || attempts >= 8 ? "failed" : "retry", null, attempts, (e as Error).message, next);
      console.error(`${sender.channel} send failed (${attempts}):`, (e as Error).message);
    }
  }

  private record(outboundId: string, status: string, providerId: string | null, attempts: number, error: string | null, next: string | null) {
    this.db
      .prepare(
        `INSERT INTO wa_deliveries (outbound_id, wamid, status, attempts, next_attempt_at, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(outbound_id) DO UPDATE SET wamid = COALESCE(excluded.wamid, wamid), status = excluded.status, attempts = excluded.attempts,
           next_attempt_at = excluded.next_attempt_at, error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run(outboundId, providerId, status, attempts, next, error, now());
  }
}
