// Vonage Messages API adapter — the free WhatsApp sandbox used for the hackathon demo
// (no Meta business verification; free-form messages within the 24-hour window;
// ~100 messages per month). Choices are numbered, as on Twilio.
//
// Webhook protection: the sandbox does not sign webhooks by default, so the URLs
// carry a secret key derived from the API secret (shown at server start). If
// VONAGE_SIGNATURE_SECRET is set, Vonage's signed JWT is verified as well.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { InboundMessage } from "../shared/messages.ts";
import type { Agent } from "./agent.ts";
import { onDelivered, onFailed, type ChannelSender } from "./channels.ts";
import { now, type Db } from "./db.ts";
import { numberedText, rememberChoices, resolveChoice } from "./numbered-choices.ts";
import { publicUrl } from "./twilio.ts";

const env = (k: string) => (process.env[k] ?? "").trim();
const KEY = () => env("VONAGE_API_KEY");
const SECRET = () => env("VONAGE_API_SECRET");
const FROM = () => env("VONAGE_WHATSAPP_FROM").replace(/^\+/, "") || "14157386102"; // the sandbox number
const ENDPOINT = () => env("VONAGE_MESSAGES_URL") || "https://messages-sandbox.nexmo.com/v1/messages";
const basicAuth = () => ({ Authorization: "Basic " + Buffer.from(`${KEY()}:${SECRET()}`).toString("base64") });

export const vonageEnabled = () => Boolean(KEY() && SECRET());
export const midwifeIdForVonage = (phone: string) => `vg:${phone.replace(/^\+/, "")}`;

/** Secret key placed in the webhook URLs, derived from the API secret. */
export const webhookKey = () => createHmac("sha256", SECRET()).update("maternily-webhook").digest("hex").slice(0, 24);
/** The key is part of the path (some dashboards reject URLs with a query string). */
export const vonageWebhookUrls = () => ({
  inbound: `${publicUrl()}/webhook/vonage/${webhookKey()}/inbound`,
  status: `${publicUrl()}/webhook/vonage/${webhookKey()}/status`,
});

function authorized(req: Request): boolean {
  const k = String(req.params.key ?? req.query.k ?? "");
  const expected = webhookKey();
  if (k.length !== expected.length || !timingSafeEqual(Buffer.from(k), Buffer.from(expected))) return false;
  const sigSecret = env("VONAGE_SIGNATURE_SECRET");
  if (!sigSecret) return true;
  // Signed webhooks: Authorization: Bearer <JWT HS256>, with payload_hash = sha256(raw body).
  const jwt = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const [h, p, sig] = jwt.split(".");
  if (!h || !p || !sig) return false;
  const expectedSig = createHmac("sha256", sigSecret).update(`${h}.${p}`).digest("base64url");
  if (sig !== expectedSig) return false;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as { payload_hash?: string };
  const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
  return !claims.payload_hash || claims.payload_hash === createHash("sha256").update(raw).digest("hex");
}

// ------------------------------------------------------------------ inbound
interface VonageInbound {
  channel?: string;
  message_uuid: string;
  from: string;
  to?: string;
  timestamp?: string;
  message_type: string;
  text?: string;
  image?: { url: string; caption?: string };
  file?: { url: string; caption?: string; name?: string };
  reply?: { id: string; title: string };
  button?: { payload?: string; text?: string };
  profile?: { name?: string };
}

async function downloadMedia(url: string): Promise<{ data: Buffer; mime: string }> {
  let r = await fetch(url);
  if (r.status === 401 || r.status === 403) r = await fetch(url, { headers: basicAuth() });
  if (!r.ok) throw new Error(`media download ${r.status}`);
  return { data: Buffer.from(await r.arrayBuffer()), mime: (r.headers.get("content-type") ?? "image/jpeg").split(";")[0] };
}

export function receiveVonage(db: Db, agent: Agent, kick: () => void) {
  return (req: Request, res: Response) => {
    if (!authorized(req)) {
      console.warn("Vonage webhook refused: wrong or missing ?k= key (re-copy the Inbound URL from the server log)");
      return res.sendStatus(401);
    }
    res.sendStatus(200); // any non-200 makes Vonage retry
    void processVonage(db, agent, req.body as VonageInbound).then(kick).catch((e) => console.error("Vonage webhook:", e));
  };
}

export async function processVonage(db: Db, agent: Agent, m: VonageInbound) {
  if (m.channel && m.channel !== "whatsapp") return;
  const phone = m.from.replace(/^\+/, "");
  const midwifeId = midwifeIdForVonage(phone);
  if (!process.env.VITEST) console.log(`Vonage webhook: ${m.message_type}`);
  db.prepare("INSERT OR IGNORE INTO midwives (id, name, lang, created_at, channel, phone) VALUES (?, ?, 'fr', ?, 'vonage', ?)").run(
    midwifeId, m.profile?.name ?? phone, now(), phone,
  );
  db.prepare("UPDATE midwives SET channel = 'vonage', phone = ? WHERE id = ?").run(phone, midwifeId);
  const base = { id: m.message_uuid, midwifeId, capturedAt: m.timestamp ? new Date(m.timestamp).toISOString() : now() };

  const media = m.image ?? (m.file && /\.(jpe?g|png|webp)$/i.test(m.file.name ?? m.file.url) ? m.file : undefined);
  if (media) {
    try {
      const { data, mime } = await downloadMedia(media.url);
      agent.handle({ ...base, kind: "image", image: { data: data.toString("base64"), mime: (mime.startsWith("image/") ? mime : "image/jpeg") as "image/jpeg" } });
    } catch (e) {
      console.error("Vonage media:", (e as Error).message);
      agent.send(midwifeId, "⚠️ Je n'ai pas pu récupérer cette photo. Pouvez-vous la renvoyer ? / I couldn't fetch this photo. Please send it again.");
    }
    return;
  }
  const replyId = m.reply?.id ?? m.button?.payload;
  if (replyId) return void agent.handle({ ...base, kind: "button", buttonId: replyId });
  const text = (m.text ?? m.reply?.title ?? m.button?.text ?? "").trim();
  if (!text) {
    agent.send(midwifeId, "Je lis les photos et les messages texte. / I read photos and text messages.");
    return;
  }
  const choice = resolveChoice(db, midwifeId, text);
  const msg: InboundMessage = choice ? { ...base, kind: "button", buttonId: choice } : { ...base, kind: "text", text };
  agent.handle(msg);
}

export function vonageStatus(db: Db) {
  return (req: Request, res: Response) => {
    if (!authorized(req)) return res.sendStatus(401);
    res.sendStatus(200);
    const s = req.body as { message_uuid: string; status: string; error?: { title?: string; detail?: string } };
    if (!process.env.VITEST) console.log(`Vonage status: ${s.status}${s.error ? ` (${s.error.title ?? ""} ${s.error.detail ?? ""})` : ""}`);
    if (["delivered", "read"].includes(s.status)) onDelivered(db, s.message_uuid);
    if (["rejected", "undeliverable", "failed"].includes(s.status)) onFailed(db, s.message_uuid, `Vonage ${s.error?.title ?? s.status}`);
  };
}

// ------------------------------------------------------------------ outbound
export function vonageSender(db: Db): ChannelSender {
  return {
    channel: "vonage",
    enabled: vonageEnabled,
    maxText: 1400,
    async send(msg, phone, lang) {
      const r = await fetch(ENDPOINT(), {
        method: "POST",
        headers: { ...basicAuth(), "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ from: FROM(), to: phone.replace(/^\+/, ""), channel: "whatsapp", message_type: "text", text: numberedText(msg, lang) }),
      });
      const json = (await r.json().catch(() => ({}))) as { message_uuid?: string; title?: string; detail?: string };
      if (!r.ok) throw Object.assign(new Error(`${r.status} ${json.title ?? ""} ${json.detail ?? ""}`.trim()), { permanent: r.status >= 400 && r.status < 500 && r.status !== 429 });
      rememberChoices(db, midwifeIdForVonage(phone), msg); // so "2" maps back to a choice
      return json.message_uuid ?? null;
    },
  };
}
