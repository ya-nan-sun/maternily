// Text-only WhatsApp channels (Twilio sandbox, Vonage sandbox): the agent's choices
// become a numbered list, and a reply like "2" or "Corriger" maps back to the choice.
// When the agent is waiting for a typed value (e.g. "3" for gravidity), a number is
// the value, not a choice.

import { FIELD_BY_KEY } from "../shared/catalog.ts";
import type { OutboundMessage } from "../shared/messages.ts";
import { fold } from "../shared/normalize.ts";
import { now, type Db } from "./db.ts";

const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
/** Steps where the midwife types a value: digits are answers, not choice numbers. */
const VALUE_STEPS = new Set(["question", "edit_value", "edit_search", "manual_value", "ask_code", "redigitize_choose"]);
const LETTERS = "ABCDEFGHIJ";
const NUMERIC = new Set(["int", "number", "ga"]);

/** What a typed reply means at a value step: a number for numeric fields, else free text (null: not a value step). */
export function valueKind(step: string | undefined, key: string | undefined): "number" | "text" | null {
  if (!step || !VALUE_STEPS.has(step)) return null;
  const type = key ? FIELD_BY_KEY.get(key)?.type : undefined;
  if (!type || !["question", "edit_value", "manual_value"].includes(step)) return "number"; // searches, codes: digits are input
  return NUMERIC.has(type) ? "number" : "text";
}

/** Text of an agent message on a text-only channel: choices become a numbered list. */
export function numberedText(msg: OutboundMessage, lang: "fr" | "en"): string {
  if (!msg.buttons?.length) return msg.text;
  const lettered = msg.answer === "number";
  const lines = msg.buttons.slice(0, KEYCAPS.length).map((b, i) => `${lettered ? `${LETTERS[i]} ·` : KEYCAPS[i]} ${b.title}`);
  const hint = lettered
    ? (lang === "fr" ? "👉 Tapez la valeur, ou la lettre d'un choix." : "👉 Type the value, or the letter of a choice.")
    : msg.answer === "text"
      ? (lang === "fr" ? "👉 Tapez la valeur, ou le numéro d'un choix." : "👉 Type the value, or the number of a choice.")
      : (lang === "fr" ? "👉 Répondez avec le numéro." : "👉 Reply with the number.");
  return `${msg.text}\n\n${lines.join("\n")}\n${hint}`;
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
  const active = conv ? (JSON.parse(conv.state) as { active?: { step?: string; key?: string } }).active : undefined;
  // The reset confirmation interrupts any step, so its numbers are always choices.
  const kind = buttons.some((b) => b.id.startsWith("reset:")) ? null : valueKind(active?.step, active?.key);
  if (kind === "number") {
    const i = /^[a-j]$/.test(t) ? LETTERS.indexOf(t.toUpperCase()) : -1; // numeric field: letters pick, digits are the value
    return i >= 0 && i < buttons.length ? buttons[i].id : null;
  }
  const n = /^\d{1,2}$/.test(t) ? Number(t) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= buttons.length) return buttons[n - 1].id;
  return null;
}
