// Telegram adapter (free; the hackathon demo channel).
//
// The bot fetches its messages with long polling (getUpdates), so it needs no
// public URL or webhook. Photos, text and button taps become the same
// InboundMessage as every other channel; the agent's choices are real inline
// buttons. Tapped keyboards are removed so old buttons cannot be pressed again.

import type { InboundMessage, OutboundMessage } from "../shared/messages.ts";
import type { Agent } from "./agent.ts";
import type { ChannelSender } from "./channels.ts";
import { now, type Db } from "./db.ts";

const token = () => (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const api = (method: string) => `https://api.telegram.org/bot${token()}/${method}`;

export const telegramEnabled = () => Boolean(token());
export const midwifeIdForTelegram = (chatId: number | string) => `tg:${chatId}`;

async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const r = await fetch(api(method), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const json = (await r.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };
  if (!json.ok) {
    throw Object.assign(new Error(`Telegram ${method}: ${json.error_code ?? r.status} ${json.description ?? ""}`), {
      permanent: (json.error_code ?? r.status) >= 400 && (json.error_code ?? r.status) < 500 && json.error_code !== 429,
    });
  }
  return json.result as T;
}

// ------------------------------------------------------------------ inbound
interface TgUser { id: number; first_name?: string; username?: string; language_code?: string }
interface TgPhoto { file_id: string; width: number; height: number; file_size?: number }
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  date: number;
  text?: string;
  caption?: string;
  photo?: TgPhoto[];
  document?: { file_id: string; mime_type?: string; file_name?: string };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: { message_id: number; chat: { id: number } } };
}

async function downloadFile(fileId: string): Promise<Buffer> {
  const file = await call<{ file_path: string }>("getFile", { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${token()}/${file.file_path}`);
  if (!r.ok) throw new Error(`Telegram file download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Bot commands map to the agent's words: /start and /aide show help, /statut, /langue… */
const COMMANDS: Record<string, string> = { "/start": "aide", "/aide": "aide", "/help": "help", "/statut": "statut", "/status": "status", "/langue": "langue", "/fin": "terminé" };

export async function processTelegramUpdate(db: Db, agent: Agent, u: TgUpdate) {
  const user = u.message?.from ?? u.callback_query?.from;
  const chatId = u.message?.chat.id ?? u.callback_query?.message?.chat.id;
  if (!user || chatId === undefined) return;
  const midwifeId = midwifeIdForTelegram(chatId);
  const lang = user.language_code?.startsWith("en") ? "en" : "fr";
  // Staff contact: the chat id is all we need to reply; no phone number is collected.
  db.prepare("INSERT OR IGNORE INTO midwives (id, name, lang, created_at, channel, phone) VALUES (?, ?, ?, ?, 'telegram', ?)").run(
    midwifeId, user.first_name ?? user.username ?? String(chatId), lang, now(), String(chatId),
  );

  if (u.callback_query) {
    const cb = u.callback_query;
    void call("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
    if (cb.message) void call("editMessageReplyMarkup", { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (cb.data) agent.handle({ id: `tgcb:${cb.id}`, midwifeId, kind: "button", buttonId: cb.data, capturedAt: now() });
    return;
  }

  const m = u.message!;
  const base = { midwifeId, capturedAt: new Date(m.date * 1000).toISOString() };
  const isImageDoc = m.document && (m.document.mime_type ?? "").startsWith("image/");
  if (m.photo?.length || isImageDoc) {
    // Photos arrive in several sizes: take the largest. Images sent "as a file" are not compressed.
    const fileId = m.photo?.length ? [...m.photo].sort((a, b) => b.width * b.height - a.width * a.height)[0].file_id : m.document!.file_id;
    const mime = m.photo?.length ? "image/jpeg" : (m.document!.mime_type as "image/jpeg");
    try {
      const data = await downloadFile(fileId);
      agent.handle({ ...base, id: `tg:${chatId}:${m.message_id}`, kind: "image", image: { data: data.toString("base64"), mime: mime as "image/jpeg" } });
    } catch (e) {
      console.error("Telegram photo:", (e as Error).message);
      agent.send(midwifeId, "⚠️ Je n'ai pas pu récupérer cette photo. Pouvez-vous la renvoyer ? / I couldn't fetch this photo. Please send it again.");
    }
    return;
  }
  const raw = (m.text ?? "").trim();
  if (!raw) {
    agent.send(midwifeId, "Je lis les photos et les messages texte. / I read photos and text messages.");
    return;
  }
  const text = COMMANDS[raw.split(/[\s@]/)[0].toLowerCase()] ?? raw;
  const msg: InboundMessage = { ...base, id: `tg:${chatId}:${m.message_id}`, kind: "text", text };
  agent.handle(msg);
}

/** Long-polls Telegram for updates; no webhook or public URL needed. */
export class TelegramPoller {
  private offset = 0;
  private stopped = false;
  private controller: AbortController | null = null;

  constructor(private db: Db, private agent: Agent, private kick: () => void) {}

  async start() {
    if (!telegramEnabled()) return;
    try {
      const me = await call<{ username: string }>("getMe", {});
      await call("deleteWebhook", { drop_pending_updates: false }); // polling and webhooks are exclusive
      await call("setMyCommands", {
        commands: [
          { command: "aide", description: "Aide / Help" },
          { command: "statut", description: "Registres en cours / Status" },
          { command: "fin", description: "J'ai envoyé toutes les pages / Done" },
          { command: "langue", description: "Français ↔ English" },
        ],
      }).catch(() => {});
      console.log(`Telegram: on (@${me.username}), polling for messages`);
    } catch (e) {
      console.error(`Telegram: could not start (${(e as Error).message})`);
      return;
    }
    while (!this.stopped) {
      try {
        this.controller = new AbortController();
        const updates = await call<TgUpdate[]>("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, this.controller.signal);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await processTelegramUpdate(this.db, this.agent, u).catch((e) => console.error("Telegram update:", e));
        }
        if (updates.length) {
          if (!process.env.VITEST) console.log(`Telegram: ${updates.length} update(s)`);
          this.kick();
        }
      } catch (e) {
        if (this.stopped) break;
        console.error("Telegram polling:", (e as Error).message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  stop() {
    this.stopped = true;
    this.controller?.abort();
  }
}

// ------------------------------------------------------------------ outbound
export function toTelegram(msg: OutboundMessage, chatId: string) {
  const text = msg.text.length > 4096 ? msg.text.slice(0, 4093) + "…" : msg.text;
  const keyboard = (msg.buttons ?? []).map((b) => [{ text: b.title, callback_data: b.id.slice(0, 64) }]);
  return { chat_id: Number(chatId), text, ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}) };
}

export const telegramSender: ChannelSender = {
  channel: "telegram",
  enabled: telegramEnabled,
  maxText: 3500,
  freeWindowOnly: false,
  sendMeansDelivered: true,
  async send(msg, chatId) {
    const sent = await call<{ message_id: number }>("sendMessage", toTelegram(msg, chatId));
    return `tg:${chatId}:${sent.message_id}`;
  },
};
