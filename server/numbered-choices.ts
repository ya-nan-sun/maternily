// Text-only WhatsApp channels (Twilio sandbox, Vonage sandbox): the agent's choices
// become a numbered list, and a reply like "2" or "Corriger" maps back to the choice.
// When the agent is waiting for a typed value (e.g. "3" for gravidity), a number is
// the value, not a choice.

import type { OutboundMessage } from "../shared/messages.ts";
import { fold } from "../shared/normalize.ts";
import { now, type Db } from "./db.ts";

const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
/** Steps where the midwife types a value: digits are answers, not choice numbers. */
const VALUE_STEPS = new Set(["question", "edit_value", "edit_search", "manual_value", "ask_code", "redigitize_choose"]);

/** Text of an agent message on a text-only channel: choices become a numbered list. */
export function numberedText(msg: OutboundMessage, lang: "fr" | "en"): string {
  if (!msg.buttons?.length) return msg.text;
  const lines = msg.buttons.slice(0, KEYCAPS.length).map((b, i) => `${KEYCAPS[i]} ${b.title}`);
  return `${msg.text}\n\n${lines.join("\n")}\n${lang === "fr" ? "👉 Répondez avec le numéro." : "👉 Reply with the number."}`;
}

/** Remember the choices just offered to a midwife. */
export function rememberChoices(db: Db, midwifeId: string, msg: OutboundMessage) {
  if (!msg.buttons?.length) return;
  db.prepare("INSERT INTO channel_prompts (midwife_id, buttons, at) VALUES (?, ?, ?) ON CONFLICT(midwife_id) DO UPDATE SET buttons = excluded.buttons, at = excluded.at").run(
    midwifeId, JSON.stringify(msg.buttons), now(),
  );
}

/** Map "2" or "Corriger" to the button id of the last choices sent, unless a typed value is expected. */
export function resolveChoice(db: Db, midwifeId: string, text: string): string | null {
  const row = db.prepare("SELECT buttons FROM channel_prompts WHERE midwife_id = ?").get(midwifeId) as { buttons: string } | undefined;
  if (!row) return null;
  const buttons = JSON.parse(row.buttons) as { id: string; title: string }[];
  const t = fold(text).replace(/[^\p{L}\p{N} ]/gu, "").trim();
  const byTitle = buttons.find((b) => fold(b.title).replace(/[^\p{L}\p{N} ]/gu, "").trim() === t);
  if (byTitle) return byTitle.id;
  const conv = db.prepare("SELECT state FROM conversations WHERE midwife_id = ?").get(midwifeId) as { state: string } | undefined;
  const step = conv ? (JSON.parse(conv.state) as { active?: { step?: string } }).active?.step : undefined;
  const n = /^\d{1,2}$/.test(t) ? Number(t) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= buttons.length && !(step && VALUE_STEPS.has(step))) return buttons[n - 1].id;
  return null;
}
