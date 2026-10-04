// The device-side queue. Like WhatsApp, every message (photo, text, button tap)
// is stored first and sent later, in order. Unlike WhatsApp, the storage is
// encrypted and the queue exposes lifecycle states so nothing is ever silently lost.
//
//   CAPTURED -> PENDING_AI -> (upload) -> delivered; server states take over
//                  ^   |
//                  |   v  connection lost / server error
//               SYNC_FAILED  (retried with backoff when online)

import { transition, type RecordState } from "../../../shared/lifecycle.ts";
import type { InboundMessage } from "../../../shared/messages.ts";
import type { Vault } from "./vault.ts";

export type LocalState = "CAPTURED" | "PENDING_AI" | "SYNC_FAILED" | "DELIVERED" | "SYNCED";

export interface OutboxItem {
  id: string;
  message: InboundMessage;
  state: LocalState;
  attempts: number;
  lastError?: string;
  createdAt: string;
  deliveredAt?: string;
  /** Small preview for the queue panel (the image itself stays in `message`). */
  label: string;
  log: { at: string; from: string | null; to: string; reason: string }[];
}

export type Transport = (msg: InboundMessage, signal: AbortSignal) => Promise<void>;

const PREFIX = "outbox:";

export class Outbox {
  private items = new Map<string, OutboxItem>();
  private online = false;
  private flushing = false;
  private controller: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  uploadingId: string | null = null;

  constructor(private vault: Vault, private transport: Transport, private retryBaseMs = 2000) {}

  async load() {
    for (const key of await this.vault.keys(PREFIX)) {
      const item = await this.vault.get<OutboxItem>(key);
      if (item) this.items.set(item.id, item);
    }
    this.emit();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  list(): OutboxItem[] {
    return [...this.items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  private async move(item: OutboxItem, to: LocalState, reason: string) {
    // Lifecycle states are validated by the shared state machine; DELIVERED/SYNCED are device bookkeeping.
    if (to !== "DELIVERED" && to !== "SYNCED" && item.state !== "DELIVERED") transition(`capture:${item.id}`, item.state as RecordState, to as RecordState, reason);
    item.log.push({ at: new Date().toISOString(), from: item.state, to, reason });
    item.state = to;
    await this.vault.put(PREFIX + item.id, item);
    this.emit();
  }

  /** Store a message encrypted on the device, then queue it. Works offline. */
  async add(message: InboundMessage, label: string) {
    const item: OutboxItem = { id: message.id, message, state: "CAPTURED", attempts: 0, createdAt: new Date().toISOString(), label, log: [] };
    item.log.push({ at: item.createdAt, from: null, to: "CAPTURED", reason: message.kind === "image" ? "photo taken" : "message written" });
    this.items.set(item.id, item);
    await this.vault.put(PREFIX + item.id, item);
    await this.move(item, "PENDING_AI", this.online ? "queued for upload" : "offline: waiting for connectivity");
    void this.flush();
  }

  setOnline(online: boolean) {
    this.online = online;
    if (!online) {
      this.controller?.abort(); // simulates the connection dropping mid-upload
      if (this.retryTimer) clearTimeout(this.retryTimer);
    } else void this.flush();
    this.emit();
  }

  pending() {
    return this.list().filter((i) => i.state === "PENDING_AI" || i.state === "SYNC_FAILED" || i.state === "CAPTURED");
  }

  /** Send queued messages strictly in order; stop at the first failure to keep the order. */
  async flush() {
    if (this.flushing || !this.online) return;
    this.flushing = true;
    try {
      for (const item of this.pending()) {
        if (!this.online) break;
        if (item.state === "SYNC_FAILED") await this.move(item, "PENDING_AI", "retrying");
        this.controller = new AbortController();
        this.uploadingId = item.id;
        this.emit();
        try {
          item.attempts++;
          await this.transport(item.message, this.controller.signal);
          item.deliveredAt = new Date().toISOString();
          await this.move(item, "DELIVERED", "server acknowledged");
        } catch (e) {
          item.lastError = (e as Error).name === "AbortError" ? "connection lost during upload" : (e as Error).message;
          await this.move(item, "SYNC_FAILED", item.lastError);
          this.scheduleRetry(item.attempts);
          break;
        } finally {
          this.uploadingId = null;
          this.controller = null;
        }
      }
    } finally {
      this.flushing = false;
      this.emit();
    }
  }

  private scheduleRetry(attempts: number) {
    if (!this.online) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = Math.min(30_000, this.retryBaseMs * 2 ** Math.max(0, attempts - 1));
    this.retryTimer = setTimeout(() => void this.flush(), delay);
  }

  /** The server registered the record: drop the photo from the device, keep a receipt. */
  async markSynced(ids: string[]) {
    for (const id of ids) {
      const item = this.items.get(id);
      if (!item || item.state === "SYNCED") continue;
      if (item.message.image) item.message = { ...item.message, image: undefined };
      await this.move(item, "SYNCED", "record registered on the server; local photo deleted");
    }
  }
}
