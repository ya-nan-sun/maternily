// Twilio WhatsApp adapter (used for the hackathon demo through Twilio's WhatsApp
// Sandbox, which needs no Meta business verification).
//
// Twilio's WhatsApp messages are plain text here, so choices are numbered
// (see numbered-choices.ts).

import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { Request, Response } from "express";
import type { InboundMessage } from "../shared/messages.ts";
import type { Agent } from "./agent.ts";
import { onDelivered, onFailed, type ChannelSender } from "./channels.ts";
import { now, type Db } from "./db.ts";
import { numberedText, rememberChoices, resolveChoice } from "./numbered-choices.ts";

export { resolveChoice };

const env = (k: string) => (process.env[k] ?? "").trim();
const SID = () => env("TWILIO_ACCOUNT_SID");
const TOKEN = () => env("TWILIO_AUTH_TOKEN");
const FROM = () => {
  const f = env("TWILIO_WHATSAPP_FROM");
  return !f ? "" : f.startsWith("whatsapp:") ? f : `whatsapp:${f.startsWith("+") ? f : "+" + f}`;
};
const basicAuth = () => ({ Authorization: "Basic " + Buffer.from(`${SID()}:${TOKEN()}`).toString("base64") });

export const twilioEnabled = () => Boolean(SID() && TOKEN() && FROM());
export const midwifeIdForTwilio = (waId: string) => `tw:${waId}`;

/** The public base URL providers call (webhooks, signatures): PUBLIC_URL, else NGROK_DOMAIN, else the cloudflared tunnel. */
export function publicUrl(): string {
  if (env("PUBLIC_URL")) return env("PUBLIC_URL").replace(/\/$/, "");
  if (env("NGROK_DOMAIN")) return `https://${env("NGROK_DOMAIN").replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  const log = fs.existsSync("work/tunnel.log") ? fs.readFileSync("work/tunnel.log", "utf8") : "";
  return log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? "";
}


// ------------------------------------------------------------------ signature
/** Twilio signs base URL + POST params (sorted by key, key+value concatenated) with HMAC-SHA1 of the auth token. */
export function twilioSignatureValid(url: string, params: Record<string, string>, header: string | undefined): boolean {
  if (!header || !TOKEN()) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", TOKEN()).update(data).digest();
  const got = Buffer.from(header, "base64");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// ------------------------------------------------------------------ inbound
async function downloadMedia(url: string): Promise<Buffer> {
  const r = await fetch(url, { headers: basicAuth() }); // Twilio redirects to the media file
  if (!r.ok) throw new Error(`media download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** POST /webhook/twilio — incoming WhatsApp message from the sandbox. */
export function receiveTwilio(db: Db, agent: Agent, kick: () => void) {
  return (req: Request, res: Response) => {
    const params = req.body as Record<string, string>;
    if (!twilioSignatureValid(publicUrl() + req.originalUrl, params, req.header("x-twilio-signature"))) {
      console.warn("Twilio webhook: bad signature (is PUBLIC_URL / the tunnel address current?)");
      return res.sendStatus(403);
    }
    res.type("text/xml").send("<Response></Response>"); // reply asynchronously through the API
    void processTwilio(db, agent, params).then(kick).catch((e) => console.error("Twilio webhook:", e));
  };
}

export async function processTwilio(db: Db, agent: Agent, p: Record<string, string>) {
  const waId = p.WaId || (p.From ?? "").replace(/^whatsapp:\+?/, "");
  const midwifeId = midwifeIdForTwilio(waId);
  if (!process.env.VITEST) console.log(`Twilio webhook: message (${Number(p.NumMedia ?? 0)} media)`);
  db.prepare("INSERT OR IGNORE INTO midwives (id, name, lang, created_at, channel, phone) VALUES (?, ?, 'fr', ?, 'twilio', ?)").run(
    midwifeId, p.ProfileName || waId, now(), waId,
  );
  db.prepare("UPDATE midwives SET channel = 'twilio', phone = ? WHERE id = ?").run(waId, midwifeId);

  const base = { midwifeId, capturedAt: now() };
  const media = Number(p.NumMedia ?? 0);
  if (media > 0) {
    // One Twilio message can carry several photos: each becomes its own page.
    for (let i = 0; i < media; i++) {
      const type = (p[`MediaContentType${i}`] ?? "").split(";")[0];
      if (!type.startsWith("image/")) continue;
      try {
        const data = await downloadMedia(p[`MediaUrl${i}`]);
        agent.handle({ ...base, id: `${p.MessageSid}:${i}`, kind: "image", image: { data: data.toString("base64"), mime: type as "image/jpeg" } });
      } catch (e) {
        console.error("Twilio media:", (e as Error).message);
        agent.send(midwifeId, "⚠️ Je n'ai pas pu récupérer cette photo. Pouvez-vous la renvoyer ? / I couldn't fetch this photo. Please send it again.");
      }
    }
    if (!p.Body?.trim()) return;
  }
  const text = (p.Body ?? "").trim();
  if (!text) return;
  const choice = resolveChoice(db, midwifeId, text);
  const msg: InboundMessage = choice
    ? { ...base, id: `${p.MessageSid}:t`, kind: "button", buttonId: choice }
    : { ...base, id: `${p.MessageSid}:t`, kind: "text", text };
  agent.handle(msg);
}

/** POST /webhook/twilio/status — delivery receipts for messages we sent. */
export function twilioStatus(db: Db) {
  return (req: Request, res: Response) => {
    const p = req.body as Record<string, string>;
    if (!twilioSignatureValid(publicUrl() + req.originalUrl, p, req.header("x-twilio-signature"))) return res.sendStatus(403);
    res.sendStatus(204);
    if (!process.env.VITEST) console.log(`Twilio status: ${p.MessageStatus}${p.ErrorCode ? ` (${p.ErrorCode})` : ""}`);
    if (["delivered", "read"].includes(p.MessageStatus)) onDelivered(db, p.MessageSid);
    if (["failed", "undelivered"].includes(p.MessageStatus)) onFailed(db, p.MessageSid, `Twilio ${p.ErrorCode ?? p.MessageStatus}`);
  };
}

// ------------------------------------------------------------------ outbound
/** Text of an agent message as sent on Twilio: choices become a numbered list. */
export const toTwilioText = numberedText;

export function twilioSender(db: Db): ChannelSender {
  return {
    channel: "twilio",
    enabled: twilioEnabled,
    maxText: 1400, // WhatsApp via Twilio accepts up to 1600 characters per message
    async send(msg, phone, lang) {
      const form = new URLSearchParams({ From: FROM(), To: `whatsapp:+${phone.replace(/^\+/, "")}`, Body: toTwilioText(msg, lang) });
      if (publicUrl()) form.set("StatusCallback", `${publicUrl()}/webhook/twilio/status`);
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID()}/Messages.json`, { method: "POST", headers: basicAuth(), body: form });
      const json = (await r.json()) as { sid?: string; message?: string; code?: number };
      if (!r.ok) throw Object.assign(new Error(`${json.code ?? r.status} ${json.message ?? ""}`), { permanent: r.status >= 400 && r.status < 500 && r.status !== 429 });
      rememberChoices(db, midwifeIdForTwilio(phone.replace(/^\+/, "")), msg); // so "2" maps back to a button
      return json.sid ?? null;
    },
  };
}
