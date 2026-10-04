// Deterministic parsing of what was written on paper into typed values.
// The model only transcribes; everything here is reproducible and testable.

import { FIELD_BY_KEY, LAB_VALUES, ROLE_VALUES, type FieldDef } from "./catalog.ts";
import type { FieldStatus } from "./status.ts";

export type Bp = { systolic: number; diastolic: number };
export type Ga = { weeks: number; days: number };

export interface ParseResult {
  ok: boolean;
  value?: unknown;
  /** A status implied by the writing itself (a dash, a question mark). */
  status?: FieldStatus;
  /** Machine-readable reason when parsing failed or a conversion happened. */
  note?: string;
}

const EASTERN_DIGITS = /[٠-٩۰-۹]/g;

/** Fold text for comparison: Western digits, no accents, lowercase, single spaces. */
export function fold(s: string): string {
  return s
    .replace(EASTERN_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .replace(/\u0000/g, " ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[œ]/g, "oe")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Writing that means "does not apply here": a dash, a slash, a diagonal stroke. */
const NOT_APPLICABLE_MARKS = new Set(["—", "–", "-", "--", "/", "\\", "na", "n/a", "sans objet", "not applicable", "[stroke]"]);
const UNKNOWN_MARKS = new Set(["?", "??", "inconnu", "inconnue", "ne sait pas", "nsp", "unknown", "?/?"]);

export function markStatus(raw: string): FieldStatus | undefined {
  const f = fold(raw);
  if (NOT_APPLICABLE_MARKS.has(f) || NOT_APPLICABLE_MARKS.has(raw.trim())) return "NOT_APPLICABLE";
  if (UNKNOWN_MARKS.has(f)) return "UNKNOWN";
  return undefined;
}

const UNIT_FACTORS: Record<string, Record<string, number>> = {
  // target unit -> written unit -> factor
  g: { kg: 1000, g: 1 },
  kg: { kg: 1, g: 0.001 },
  "g/dL": { "g/dl": 1, "g/l": 0.1 },
  "g/L": { "g/l": 1, "mg/dl": 0.01, "mmol/l": 0.18 },
  "/mm3": { "/mm3": 1, "k": 1000, "g/l": 1000, "x10^9/l": 1000 },
};

function parseQuantity(raw: string, def: FieldDef): ParseResult {
  // "6 4.3" -> "64.3": a stray space inside a number (OCR, or a pen lift).
  const f = fold(raw).replace(/(\d),(\d)/g, "$1.$2").replace(/(\d) (?=[\d.])/g, "$1");
  const m = f.match(/^[^\d-]*(-?\d+(?:\.\d+)?)\s*([a-z/%°^0-9.]*)\s*([a-z/%°^0-9.]*)?$/);
  if (!m) return { ok: false, note: "not_a_number" };
  let n = Number(m[1]);
  let unit = (m[2] || "").replace(/^°?c$/, "c");
  let note: string | undefined;
  if (unit === "k") {
    n *= 1000;
    unit = "";
  } else if (unit && def.unit && UNIT_FACTORS[def.unit]) {
    const factor = UNIT_FACTORS[def.unit][unit];
    if (factor !== undefined && factor !== 1) {
      n *= factor;
      note = `converted_${unit}_to_${def.unit}`;
    }
  }
  if (def.type === "int") n = Math.round(n);
  else n = Math.round(n * 100) / 100;
  return { ok: true, value: n, note };
}

export function parseDate(raw: string, now = new Date()): ParseResult {
  const f = fold(raw);
  // History tables often hold only a year ("2023") or month/year ("05/2023").
  const year = f.match(/^(19|20)(\d{2})$/);
  if (year) return { ok: true, value: f, note: "partial_date" };
  const monthYear = f.match(/^(\d{1,2})\s*[/.\-]\s*((?:19|20)\d{2})$/);
  if (monthYear && Number(monthYear[1]) >= 1 && Number(monthYear[1]) <= 12) {
    return { ok: true, value: `${monthYear[2]}-${monthYear[1].padStart(2, "0")}`, note: "partial_date" };
  }
  const m = f.match(/^(\d{1,2})\s*[/.\-\s]\s*(\d{1,2})\s*[/.\-\s]\s*(\d{2}|\d{4})$/);
  if (!m) return { ok: false, note: "not_a_date" };
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = Number(m[3]);
  let note: string | undefined;
  if (m[3].length === 2) {
    const yy = now.getFullYear() % 100;
    y = y <= yy + 1 ? 2000 + y : 1900 + y;
    note = "two_digit_year";
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, note: "impossible_date" };
  }
  return { ok: true, value: dt.toISOString().slice(0, 10), note };
}

export function parseBp(raw: string): ParseResult {
  const f = fold(raw).replace(/(\d),(\d)/g, "$1.$2");
  const m = f.match(/^(\d{1,3}(?:\.\d)?)\s*[/\-]\s*(\d{1,3}(?:\.\d)?)(?:\s*(mmhg|cmhg))?$/);
  if (!m) return { ok: false, note: "not_a_bp" };
  let s = Number(m[1]);
  let d = Number(m[2]);
  let note: string | undefined;
  // In Morocco and France, BP is often written in cmHg: "11/7" means 110/70 mmHg.
  if (m[3] === "cmhg" || (s < 30 && d < 20)) {
    s = Math.round(s * 10);
    d = Math.round(d * 10);
    note = "converted_cmhg";
  }
  return { ok: true, value: { systolic: s, diastolic: d } satisfies Bp, note };
}

export function parseGa(raw: string): ParseResult {
  const f = fold(raw);
  const m =
    f.match(/^(\d{1,2})\s*(?:sa|s|sem|semaines?|weeks?|w)?\s*(?:\+|et)?\s*(?:(\d)\s*(?:j|jours?|d|days?))?$/) ??
    f.match(/^(\d{1,2})\s*\+\s*(\d)$/);
  if (!m) return { ok: false, note: "not_a_gestational_age" };
  const weeks = Number(m[1]);
  const days = m[2] ? Number(m[2]) : 0;
  if (days > 6) return { ok: false, note: "days_over_6" };
  return { ok: true, value: { weeks, days } satisfies Ga };
}

const TRUE_WORDS = new Set(["oui", "yes", "o", "y", "+", "x", "checked", "coche", "cochee", "true", "1", "present", "presente", "positif", "fait"]);
const FALSE_WORDS = new Set(["non", "no", "n", "unchecked", "vide", "false", "0", "absent", "absente", "aucun", "aucune", "neant", "ras"]);

export function parseBool(raw: string): ParseResult {
  const f = fold(raw);
  if (TRUE_WORDS.has(f)) return { ok: true, value: true };
  if (FALSE_WORDS.has(f)) return { ok: true, value: false };
  return { ok: false, note: "not_yes_no" };
}

function matchOption(def: FieldDef, token: string): string | undefined {
  const t = fold(token);
  if (!t) return undefined;
  for (const o of def.options ?? []) {
    if ([o.value, o.fr, o.en].some((x) => fold(x) === t)) return o.value;
  }
  // Written single letters and common synonyms.
  const synonyms: Record<string, string> = {
    fille: "F", feminin: "F", female: "F", girl: "F", garcon: "M", masculin: "M", male: "M", boy: "M",
    "rh+": "POS", "rh +": "POS", "rhesus +": "POS", positif: "POS", "rh-": "NEG", "rh -": "NEG", negatif: "NEG",
  };
  const syn = synonyms[t];
  if (syn && def.options?.some((o) => o.value === syn)) return syn;
  for (const o of def.options ?? []) {
    if (fold(o.fr).startsWith(t) || t.startsWith(fold(o.fr))) return o.value;
  }
  return undefined;
}

export function parseChoice(raw: string, def: FieldDef): ParseResult {
  const v = matchOption(def, raw);
  return v ? { ok: true, value: v } : { ok: false, note: "unknown_option" };
}

export function parseMulti(raw: string, def: FieldDef): ParseResult {
  const f = fold(raw);
  if (!f || f === "none" || f === "aucun" || f === "[]") return { ok: true, value: [] };
  const parts = raw.split(/[,;|]+/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const v = matchOption(def, p);
    if (!v) return { ok: false, note: "unknown_option" };
    if (!out.includes(v)) out.push(v);
  }
  return { ok: true, value: out };
}

export function parseLab(raw: string): ParseResult {
  const f = fold(raw);
  const table: [RegExp, (typeof LAB_VALUES)[number]][] = [
    [/^(non fait|nf|pas fait|not done)$/, "NOT_DONE"],
    [/^(non immun|non-immun|not immune|seronegati)/, "NOT_IMMUNE"],
    [/^(immun|immune|seropositi)/, "IMMUNE"],
    [/^(neg|negati|-$|0$|normal)/, "NEGATIVE"],
    [/^(pos|positi|\+$|1$)/, "POSITIVE"],
  ];
  for (const [re, v] of table) if (re.test(f)) return { ok: true, value: v };
  return { ok: false, note: "unknown_lab_result" };
}

export function parseRole(raw: string): ParseResult {
  const f = fold(raw);
  let v: (typeof ROLE_VALUES)[number] = "OTHER";
  if (/^(dr|docteur|medecin|doctor|pr)\b/.test(f)) v = "DOCTOR";
  else if (/^(sf|sage[- ]?femme|midwife)\b/.test(f)) v = "MIDWIFE";
  else if (/^(inf|infirmi|nurse)/.test(f)) v = "NURSE";
  return { ok: true, value: v };
}

/** Parse a transcription for a catalog field. */
export function parseField(key: string, raw: string): ParseResult {
  const def = FIELD_BY_KEY.get(key);
  if (!def) return { ok: false, note: "unknown_field" };
  const trimmed = raw.trim();
  // An empty checkbox group is a known answer: nothing was ticked.
  if (!trimmed && def.type === "multi" && def.input === "checkbox") return { ok: true, value: [] };
  if (!trimmed) return { ok: false, status: "NOT_PROVIDED" };
  const mark = def.input === "written" ? markStatus(trimmed) : undefined;
  if (mark) return { ok: true, value: null, status: mark };
  switch (def.type) {
    case "text":
      return { ok: true, value: trimmed.replace(/\u0000/g, "").replace(/\s+/g, " ") };
    case "int":
    case "number":
      return parseQuantity(trimmed, def);
    case "date":
      return parseDate(trimmed);
    case "bp":
      return parseBp(trimmed);
    case "ga":
      return parseGa(trimmed);
    case "bool":
      return parseBool(trimmed);
    case "choice":
      return parseChoice(trimmed, def);
    case "multi":
      return parseMulti(trimmed, def);
    case "lab":
      return parseLab(trimmed);
    case "role":
      return parseRole(trimmed);
  }
}

/** Human-readable rendering of a stored value. */
export function formatValue(key: string, value: unknown, lang: "fr" | "en"): string {
  const def = FIELD_BY_KEY.get(key);
  if (value === null || value === undefined) return "—";
  if (!def) return String(value);
  switch (def.type) {
    case "date":
      return String(value).split("-").reverse().join("/");
    case "bp": {
      const v = value as Bp;
      return `${v.systolic}/${v.diastolic} mmHg`;
    }
    case "ga": {
      const v = value as Ga;
      return v.days ? `${v.weeks} SA + ${v.days} j` : `${v.weeks} SA`;
    }
    case "bool":
      return value ? (lang === "fr" ? "Oui" : "Yes") : lang === "fr" ? "Non" : "No";
    case "choice": {
      const o = def.options?.find((x) => x.value === value);
      return o ? o[lang] : String(value);
    }
    case "multi": {
      const arr = value as string[];
      if (!arr.length) return lang === "fr" ? "Aucun" : "None";
      return arr.map((v) => def.options?.find((x) => x.value === v)?.[lang] ?? v).join(", ");
    }
    case "lab": {
      const labels: Record<string, [string, string]> = {
        NEGATIVE: ["Négatif", "Negative"], POSITIVE: ["Positif", "Positive"], IMMUNE: ["Immunisée", "Immune"],
        NOT_IMMUNE: ["Non immunisée", "Not immune"], NOT_DONE: ["Non fait", "Not done"],
      };
      const l = labels[String(value)];
      return l ? l[lang === "fr" ? 0 : 1] : String(value);
    }
    case "role": {
      const labels: Record<string, [string, string]> = {
        DOCTOR: ["Médecin", "Doctor"], MIDWIFE: ["Sage-femme", "Midwife"], NURSE: ["Infirmier·e", "Nurse"], OTHER: ["Autre", "Other"],
      };
      const l = labels[String(value)];
      return l ? l[lang === "fr" ? 0 : 1] : String(value);
    }
    default: {
      const unit = def.unit && lang === "fr" ? ({ years: "ans", days: "jours" } as Record<string, string>)[def.unit] ?? def.unit : def.unit;
      return unit && typeof value === "number" ? `${value} ${unit}` : String(value);
    }
  }
}

/** Equality used by the evaluation and by re-digitization diffs. */
export function valuesEqual(key: string, a: unknown, b: unknown): boolean {
  const def = FIELD_BY_KEY.get(key);
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (def?.type === "text") return textSimilar(String(a), String(b));
  if (def?.type === "multi") {
    const x = [...(a as string[])].sort();
    const y = [...(b as string[])].sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Accent/space-insensitive text equality with a small edit tolerance for longer strings. */
export function textSimilar(a: string, b: string): boolean {
  const x = fold(a).replace(/[^a-z0-9]/g, "");
  const y = fold(b).replace(/[^a-z0-9]/g, "");
  if (x === y) return true;
  const longest = Math.max(x.length, y.length);
  if (longest < 6) return false;
  return 1 - levenshtein(x, y) / longest >= 0.85;
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
