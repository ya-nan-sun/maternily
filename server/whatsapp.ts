// WhatsApp Cloud API adapter (Meta, Graph API).
//
// Inbound: the webhook turns WhatsApp messages (text, photos, button and list taps)
// into the same InboundMessage the rest of the app uses. Outbound: every message
// the agent writes for a WhatsApp midwife is sent by the dispatcher, in order, as
// text, reply buttons (≤ 3) or a list (≤ 10 rows).
//
// Replies inside the 24-hour customer service window are free. A message the agent
// writes outside that window (e.g. the office resolved a match the next day) is held
// until the midwife writes again, so nothing paid is ever sent.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { Button, InboundMessage, OutboundMessage } from "../shared/messages.ts";
import type { Agent } from "./agent.ts";
import { config } from "./config.ts";
import { OutboundDispatcher, onDelivered, onFailed, type ChannelSender } from "./channels.ts";
import { now, type Db } from "./db.ts";

const graph = (path: string) => `https://graph.facebook.com/${config.whatsapp.apiVersion}/${path}`;
const auth = () => ({ Authorization: `Bearer ${config.whatsapp.accessToken}` });

export const whatsappEnabled = () => Boolean(config.whatsapp.phoneNumberId && config.whatsapp.accessToken);
export const midwifeIdFor = (phone: string) => `wa:${phone}`;

// ------------------------------------------------------------------ webhook: verification
/** GET /webhook/whatsapp — Meta checks the verify token once when the webhook is configured. */
export function verifyWebhook(req: Request, res: Response) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  if (mode === "subscribe" && config.whatsapp.verifyToken && token === config.whatsapp.verifyToken) {
    return res.status(200).send(String(req.query["hub.challenge"] ?? ""));
  }
  res.sendStatus(403);
}

/** With WHATSAPP_APP_SECRET set, reject webhook calls that Meta did not sign. */
export function signatureValid(rawBody: Buffer | undefined, header: string | undefined): boolean {
  if (!config.whatsapp.appSecret) return true;
  if (!rawBody || !header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", config.whatsapp.appSecret).update(rawBody).digest();
  const got = Buffer.from(header.slice(7), "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// ------------------------------------------------------------------ webhook: messages
interface WaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string };
  document?: { id: string; mime_type: string };
  interactive?: { type: string; button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
  button?: { payload: string; text: string };
}
interface WaStatus { id: string; status: string; recipient_id: string; errors?: { title?: string; message?: string }[] }
interface WaWebhook {
  entry?: { changes?: { value?: { contacts?: { wa_id: string; profile?: { name?: string } }[]; messages?: WaMessage[]; statuses?: WaStatus[] } }[] }[];
}

async function downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }> {
  const meta = await fetch(graph(`${mediaId}?phone_number_id=${config.whatsapp.phoneNumberId}`), { headers: auth() });
  if (!meta.ok) throw new Error(`media lookup ${meta.status}: ${await meta.text()}`);
  const { url, mime_type } = (await meta.json()) as { url: string; mime_type: string };
  const file = await fetch(url, { headers: auth() }); // the URL expires after 5 minutes
  if (!file.ok) throw new Error(`media download ${file.status}`);
  return { data: Buffer.from(await file.arrayBuffer()), mime: mime_type.split(";")[0] };
}

/** POST /webhook/whatsapp — acknowledge at once (Meta retries slow webhooks), then process. */
export function receiveWebhook(db: Db, agent: Agent, kick: () => void) {
  return (req: Request, res: Response) => {
    if (!signatureValid((req as Request & { rawBody?: Buffer }).rawBody, req.header("x-hub-signature-256"))) return res.sendStatus(401);
    res.sendStatus(200);
    void processWebhook(db, agent, req.body as WaWebhook).then(kick).catch((e) => console.error("WhatsApp webhook:", e));
  };
}

export async function processWebhook(db: Db, agent: Agent, body: WaWebhook) {
  const values = (body.entry ?? []).flatMap((e) => (e.changes ?? []).map((c) => c.value ?? {}));
  const counts = { messages: values.reduce((n, v) => n + (v.messages?.length ?? 0), 0), statuses: values.reduce((n, v) => n + (v.statuses?.length ?? 0), 0) };
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) console.log(`WhatsApp webhook: ${counts.messages} message(s), ${counts.statuses} status update(s)`);
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      for (const status of value.statuses ?? []) onStatus(db, status);
      for (const m of value.messages ?? []) {
        const name = value.contacts?.find((c) => c.wa_id === m.from)?.profile?.name;
        await onMessage(db, agent, m, name);
      }
    }
  }
}

async function onMessage(db: Db, agent: Agent, m: WaMessage, profileName?: string) {
  const midwifeId = midwifeIdFor(m.from);
  // Staff contact details: the midwife's own WhatsApp number is needed to reply to her.
  db.prepare("INSERT OR IGNORE INTO midwives (id, name, lang, created_at, channel, phone) VALUES (?, ?, 'fr', ?, 'whatsapp', ?)").run(
    midwifeId, profileName ?? m.from, now(), m.from,
  );
  db.prepare("UPDATE midwives SET channel = 'whatsapp', phone = ? WHERE id = ?").run(m.from, midwifeId);
  void markRead(m.id);

  const base = { id: m.id, midwifeId, capturedAt: new Date(Number(m.timestamp) * 1000).toISOString() };
  let msg: InboundMessage | null = null;
  if (m.type === "text" && m.text) msg = { ...base, kind: "text", text: m.text.body };
  else if (m.type === "interactive" && m.interactive) {
    const reply = m.interactive.button_reply ?? m.interactive.list_reply;
    if (reply) msg = { ...base, kind: "button", buttonId: reply.id };
  } else if (m.type === "button" && m.button) msg = { ...base, kind: "button", buttonId: m.button.payload };
  else if ((m.type === "image" && m.image) || (m.type === "document" && m.document?.mime_type.startsWith("image/"))) {
    const media = (m.image ?? m.document)!;
    try {
      const { data, mime } = await downloadMedia(media.id);
      msg = { ...base, kind: "image", image: { data: data.toString("base64"), mime: mime as "image/jpeg" } };
    } catch (e) {
      console.error("WhatsApp media:", (e as Error).message);
      agent.send(midwifeId, "⚠️ Je n'ai pas pu récupérer cette photo. Pouvez-vous la renvoyer ? / I couldn't fetch this photo. Can you send it again?");
      return;
    }
  }
  if (!msg) {
    agent.send(midwifeId, "Je lis les photos et les messages texte. / I read photos and text messages.");
    return;
  }
  agent.handle(msg);
}

/** Delivery receipts: the "saved" confirmation reaching the phone completes the record (SYNCED). */
function onStatus(db: Db, status: WaStatus) {
  if (!process.env.VITEST) {
    const err = status.errors?.map((e) => `${(e as { code?: number }).code ?? ""} ${e.title ?? e.message ?? ""}`.trim()).join("; ");
    console.log(`WhatsApp status: ${status.status}${err ? ` (${err})` : ""}`);
  }
  if (status.status === "failed") onFailed(db, status.id, status.errors?.map((e) => e.message ?? e.title).join("; ") ?? "failed");
  if (["delivered", "read"].includes(status.status)) onDelivered(db, status.id);
}

async function markRead(messageId: string) {
  try {
    await fetch(graph(`${config.whatsapp.phoneNumberId}/messages`), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
    });
  } catch {
    /* read receipts are cosmetic */
  }
}

// ------------------------------------------------------------------ outbound
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

/** Turn one agent message into the WhatsApp payloads that carry it (respecting Meta's limits). */
export function toWhatsApp(msg: OutboundMessage, to: string, lang: "fr" | "en"): Record<string, unknown>[] {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  const text = (body: string) => ({ ...base, type: "text", text: { body, preview_url: false } });
  const buttons: Button[] = msg.buttons ?? [];
  if (!buttons.length) return chunks(msg.text, 4096).map(text);

  const out: Record<string, unknown>[] = [];
  let body = msg.text;
  if (body.length > 1024) {
    // Long summaries go first as plain text; the interactive part gets a short prompt.
    out.push(...chunks(body, 4096).map(text));
    body = lang === "fr" ? "👉 Votre choix :" : "👉 Your choice:";
  }
  if (buttons.length <= 3 && buttons.every((b) => b.title.length <= 20)) {
    out.push({
      ...base,
      type: "interactive",
      interactive: { type: "button", body: { text: body }, action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) } },
    });
    return out;
  }
  const rows = buttons.slice(0, 10).map((b) => ({ id: b.id, title: clip(b.title, 24), ...(b.title.length > 24 ? { description: clip(b.title, 72) } : {}) }));
  out.push({
    ...base,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body.length > 4096 ? clip(body, 4096) : body },
      action: { button: lang === "fr" ? "Choisir" : "Choose", sections: [{ title: lang === "fr" ? "Options" : "Options", rows }] },
    },
  });
  return out;
}

function chunks(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [""];
}

/** Meta Cloud API sender for the shared outbound dispatcher. */
export const metaSender: ChannelSender = {
  channel: "whatsapp",
  enabled: whatsappEnabled,
  maxText: 1000, // keeps a merged message within one interactive body
  async send(msg, phone, lang) {
    let wamid: string | null = null;
    for (const body of toWhatsApp(msg, phone, lang)) {
      const r = await fetch(graph(`${config.whatsapp.phoneNumberId}/messages`), {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await r.json()) as { messages?: { id: string }[]; error?: { message: string; code: number } };
      if (!r.ok) throw Object.assign(new Error(json.error?.message ?? `HTTP ${r.status}`), { permanent: r.status >= 400 && r.status < 500 && r.status !== 429 });
      wamid = json.messages?.[0]?.id ?? wamid;
    }
    return wamid;
  },
};

/** Dispatcher for Meta WhatsApp only (kept for tests and single-channel setups). */
export class WhatsAppDispatcher extends OutboundDispatcher {
  constructor(db: Db, coalesceMs = 0) {
    super(db, [metaSender], coalesceMs);
  }
}
