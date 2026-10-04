// One-command WhatsApp setup check, run after putting new Meta credentials in .env:
//
//   npm run whatsapp:setup                 # uses the cloudflared URL from work/tunnel.log
//   PUBLIC_URL=https://example.com npm run whatsapp:setup
//
// 1. checks the access token and phone number, 2. connects the app to the WhatsApp
// Business Account, 3. subscribes the app to the "messages" webhook field,
// 4. prints Meta's health status (what still blocks sending, if anything).
// Nothing is sent to any phone.

import fs from "node:fs";
import { config } from "../server/config.ts";

const V = config.whatsapp.apiVersion;
const TOKEN = config.whatsapp.accessToken;
const PHONE_ID = config.whatsapp.phoneNumberId;
const WABA = (process.env.WHATSAPP_WABA_ID ?? "").trim();
const SECRET = config.whatsapp.appSecret;
const VERIFY = config.whatsapp.verifyToken;
const tunnelLog = fs.existsSync("work/tunnel.log") ? fs.readFileSync("work/tunnel.log", "utf8") : "";
const PUBLIC_URL = (process.env.PUBLIC_URL ?? tunnelLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? "").replace(/\/$/, "");

const ok = (m: string) => console.log(`✅ ${m}`);
const bad = (m: string) => console.log(`❌ ${m}`);
const api = async (path: string, init: RequestInit = {}, bearer = true) => {
  const r = await fetch(`https://graph.facebook.com/${V}/${path}`, { ...init, headers: { ...(bearer ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(init.headers ?? {}) } });
  return { status: r.status, body: (await r.json()) as any };
};

const missing = Object.entries({ WHATSAPP_PHONE_NUMBER_ID: PHONE_ID, WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_VERIFY_TOKEN: VERIFY, WHATSAPP_WABA_ID: WABA, WHATSAPP_APP_SECRET: SECRET })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  bad(`Missing in .env: ${missing.join(", ")}`);
  process.exit(1);
}
if (!/^[0-9a-f]{32}$/.test(SECRET)) bad("WHATSAPP_APP_SECRET should be 32 characters (letters a–f and digits). Did you copy the App ID instead?");
if (!PUBLIC_URL) {
  bad("No public URL: start the tunnel (cloudflared) or set PUBLIC_URL.");
  process.exit(1);
}

// 1. Token and phone number
const dbg = await api(`debug_token?input_token=${TOKEN}`);
const tok = dbg.body.data ?? {};
if (!tok.is_valid) {
  bad(`Access token invalid: ${JSON.stringify(dbg.body).slice(0, 200)}`);
  process.exit(1);
}
const expires = tok.expires_at ? new Date(tok.expires_at * 1000) : null;
ok(`Access token valid for app "${tok.application}" (${tok.app_id}); ${expires && tok.expires_at > 0 ? `expires ${expires.toISOString()} ⚠️ temporary` : "never expires"}`);
const missingScopes = ["whatsapp_business_messaging", "whatsapp_business_management"].filter((s) => !(tok.scopes ?? []).includes(s));
if (missingScopes.length) bad(`Token lacks permissions: ${missingScopes.join(", ")}`);
const phone = await api(`${PHONE_ID}?fields=display_phone_number,verified_name`);
if (phone.status !== 200) {
  bad(`Phone number ID not accessible: ${JSON.stringify(phone.body).slice(0, 200)}`);
  process.exit(1);
}
ok(`Phone number ${phone.body.display_phone_number} ("${phone.body.verified_name}")`);

// 2. Connect the app to the WhatsApp Business Account
const sub = await api(`${WABA}/subscribed_apps`, { method: "POST" });
if (sub.body.success) ok("App connected to the WhatsApp Business Account");
else bad(`Could not connect app to WABA ${WABA}: ${JSON.stringify(sub.body).slice(0, 200)}`);

// 3. Subscribe to the "messages" webhook field (needs the app secret); Meta calls our verify endpoint now.
const appToken = `${tok.app_id}|${SECRET}`;
const form = new URLSearchParams({ object: "whatsapp_business_account", callback_url: `${PUBLIC_URL}/webhook/whatsapp`, verify_token: VERIFY, fields: "messages", include_values: "true", access_token: appToken });
const hook = await api(`${tok.app_id}/subscriptions`, { method: "POST", body: form }, false);
if (hook.body.success) ok(`Webhook ${PUBLIC_URL}/webhook/whatsapp verified and subscribed to "messages"`);
else bad(`Webhook subscription failed (is the server running and the tunnel up?): ${JSON.stringify(hook.body).slice(0, 250)}`);

// 4. Health: what still prevents sending
const health = await api(`${PHONE_ID}?fields=health_status`);
const entities = (health.body.health_status?.entities ?? []) as { entity_type: string; can_send_message: string; errors?: { error_code: number; error_description: string; possible_solution?: string }[] }[];
const blockers = entities.flatMap((e) => (e.errors ?? []).filter((x) => !String(x.error_code).startsWith("1380")).map((x) => ({ ...x, entity: e.entity_type })));
console.log(`\nMeta health: sending is ${health.body.health_status?.can_send_message ?? "unknown"}`);
if (!blockers.length) ok("No blockers reported");
for (const b of blockers) bad(`${b.entity}: ${b.error_code} ${b.error_description}${b.possible_solution ? `\n     → ${b.possible_solution}` : ""}`);
console.log("\nNext: restart the server so it uses the new .env, then send \"bonjour\" from an allowed phone to the number above.");
