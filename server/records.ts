import { FIELD_BY_KEY, VISIT_SLOTS, VISIT_SLOT_LABELS, fieldLabel } from "../shared/catalog.ts";
import { formatValue, valuesEqual } from "../shared/normalize.ts";
import type { FieldValue } from "../shared/status.ts";
import { now, type Db } from "./db.ts";

export type Lang = "fr" | "en";
export const L = (lang: Lang, fr: string, en: string) => (lang === "fr" ? fr : en);

interface FieldRow {
  key: string; value: string | null; raw: string | null; status: string; confidence: number; reasons: string;
  source_capture_id: string | null; confirmed_by: string;
}

const rowToField = (r: FieldRow): FieldValue => ({
  key: r.key,
  value: r.value === null ? null : JSON.parse(r.value),
  raw: r.raw,
  status: r.status as FieldValue["status"],
  confidence: r.confidence,
  reasons: JSON.parse(r.reasons),
  sourceCaptureId: r.source_capture_id,
  confirmedBy: r.confirmed_by as FieldValue["confirmedBy"],
});

export function patientValues(db: Db, patientId: string): Map<string, FieldValue> {
  const rows = db.prepare("SELECT * FROM field_values WHERE patient_id = ?").all(patientId) as unknown as FieldRow[];
  return new Map(rows.map((r) => [r.key, rowToField(r)]));
}

/** Values carried by a document: confirmed pages, in page order, later pages win. */
export function documentValues(db: Db, docId: string, onlyConfirmed = true): Map<string, FieldValue> {
  const pages = db
    .prepare(`SELECT fields FROM pages WHERE doc_id = ? AND replaced_by IS NULL AND fields IS NOT NULL ${onlyConfirmed ? "AND confirmed = 1" : ""} ORDER BY page_no`)
    .all(docId) as { fields: string }[];
  const out = new Map<string, FieldValue>();
  for (const p of pages) {
    for (const f of Object.values(JSON.parse(p.fields) as Record<string, FieldValue>)) {
      if (f.status === "NOT_PROVIDED" && out.has(f.key)) continue;
      out.set(f.key, f);
    }
  }
  return out;
}

const hasValue = (f: FieldValue | undefined) => !!f && f.status !== "NOT_PROVIDED";

export interface Diff {
  key: string;
  before: FieldValue | undefined;
  after: FieldValue;
  kind: "added" | "changed";
}

/** What a re-digitized registry would add or change in an existing record. */
export function diffAgainstPatient(existing: Map<string, FieldValue>, incoming: Map<string, FieldValue>): Diff[] {
  const out: Diff[] = [];
  for (const [key, after] of incoming) {
    if (!hasValue(after)) continue;
    const before = existing.get(key);
    if (!hasValue(before)) out.push({ key, before, after, kind: "added" });
    else if (before!.status !== after.status || !valuesEqual(key, before!.value, after.value)) out.push({ key, before, after, kind: "changed" });
  }
  return out;
}

export function writeField(db: Db, patientId: string, f: FieldValue, docId: string | null, by: string) {
  const prev = db.prepare("SELECT value, status FROM field_values WHERE patient_id = ? AND key = ?").get(patientId, f.key) as
    | { value: string | null; status: string }
    | undefined;
  const value = f.value === null || f.value === undefined ? null : JSON.stringify(f.value);
  db.prepare(
    `INSERT INTO field_values (patient_id, key, value, raw, status, confidence, reasons, source_capture_id, confirmed_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(patient_id, key) DO UPDATE SET value=excluded.value, raw=excluded.raw, status=excluded.status,
       confidence=excluded.confidence, reasons=excluded.reasons, source_capture_id=excluded.source_capture_id,
       confirmed_by=excluded.confirmed_by, updated_at=excluded.updated_at`,
  ).run(patientId, f.key, value, f.raw, f.status, f.confidence, JSON.stringify(f.reasons), f.sourceCaptureId, f.confirmedBy, now());
  db.prepare("INSERT INTO field_history (patient_id, key, old_value, new_value, doc_id, at, by) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    patientId, f.key, prev ? JSON.stringify({ value: prev.value && JSON.parse(prev.value), status: prev.status }) : null,
    JSON.stringify({ value: f.value, status: f.status }), docId, now(), by,
  );
}

const show = (vals: Map<string, FieldValue>, key: string, lang: Lang) => {
  const f = vals.get(key);
  return f && f.value !== null && f.value !== undefined ? formatValue(key, f.value, lang) : undefined;
};

function lastVisit(vals: Map<string, FieldValue>) {
  for (const slot of [...VISIT_SLOTS].reverse()) {
    if (hasValue(vals.get(`anc.${slot}.visitDate`)) || hasValue(vals.get(`anc.${slot}.bp`))) return slot;
  }
  return undefined;
}

/** One line to recognize a patient without any identifier. */
export function descriptor(vals: Map<string, FieldValue>, lang: Lang): string {
  const parts: string[] = [];
  const age = show(vals, "id.age", lang);
  if (age) parts.push(L(lang, `${vals.get("id.age")!.value} ans`, `age ${vals.get("id.age")!.value}`));
  const g = vals.get("id.gravidity")?.value;
  const p = vals.get("id.parity")?.value;
  if (g !== undefined && g !== null) parts.push(`G${g}${p !== undefined && p !== null ? ` P${p}` : ""}`);
  const prov = show(vals, "cover.province", lang);
  if (prov) parts.push(prov);
  const lmp = show(vals, "preg.lmp", lang);
  if (lmp) parts.push(`${L(lang, "DDR", "LMP")} ${lmp}`);
  const slot = lastVisit(vals);
  const lv = slot && show(vals, `anc.${slot}.visitDate`, lang);
  if (lv) parts.push(`${L(lang, "dernière visite", "last visit")} ${lv}`);
  const del = show(vals, "del.date", lang);
  if (del) parts.push(`${L(lang, "accouchée le", "delivered")} ${del}`);
  return parts.join(", ") || L(lang, "peu d'informations", "little information");
}

/**
 * Factual summary for a midwife who asks for a patient's file before a visit.
 * Values only, with dates and sources; no interpretation, no risk wording.
 */
export function patientSummary(db: Db, patientId: string, lang: Lang): string {
  const vals = patientValues(db, patientId);
  const p = db.prepare("SELECT code FROM patients WHERE id = ?").get(patientId) as { code: string | null };
  const lines: string[] = [];
  lines.push(`📁 ${L(lang, "Dossier", "Record")} ${p.code ?? L(lang, "(sans N° de fiche)", "(no form number)")}`);
  lines.push(descriptor(vals, lang));
  const line = (key: string, label?: string) => {
    const v = show(vals, key, lang);
    if (v) lines.push(`• ${label ?? fieldLabel(key, lang)} : ${v}${vals.get(key)!.status === "NEEDS_REVIEW" ? L(lang, " (à vérifier)", " (to check)") : ""}`);
  };
  line("id.livingChildren");
  line("preg.edd");
  line("preg.bloodGroup");
  line("preg.rhesus");
  const visits = VISIT_SLOTS.filter((s) => hasValue(vals.get(`anc.${s}.visitDate`)) || hasValue(vals.get(`anc.${s}.bp`)));
  if (visits.length) {
    lines.push(L(lang, `Visites prénatales enregistrées : ${visits.length}`, `Antenatal visits recorded: ${visits.length}`));
    for (const s of visits.slice(-3)) {
      const bits = [show(vals, `anc.${s}.visitDate`, lang), show(vals, `anc.${s}.ga`, lang), show(vals, `anc.${s}.weight`, lang) && `${show(vals, `anc.${s}.weight`, lang)}`, show(vals, `anc.${s}.bp`, lang) && `TA ${show(vals, `anc.${s}.bp`, lang)}`]
        .filter(Boolean)
        .join(" · ");
      lines.push(`  – ${VISIT_SLOT_LABELS[s][lang]} : ${bits}`);
    }
  }
  for (const test of ["hiv", "syphilis", "hbsag"] as const) {
    const slot = [...VISIT_SLOTS].reverse().find((s) => hasValue(vals.get(`anc.${s}.${test}`)));
    if (slot) lines.push(`• ${fieldLabel(`anc.${slot}.${test}`, lang)} : ${show(vals, `anc.${slot}.${test}`, lang) ?? "—"}`);
  }
  line("del.date");
  line("del.mode");
  line("del.birthWeight");
  line("ppm.early.consultDate");
  line("ppm.late.consultDate");
  const toCheck = [...vals.values()].filter((f) => f.status === "NEEDS_REVIEW" || f.status === "ILLEGIBLE").length;
  if (toCheck) lines.push(L(lang, `⚠️ ${toCheck} valeur(s) encore à vérifier dans ce dossier.`, `⚠️ ${toCheck} value(s) in this record still need checking.`));
  return lines.join("\n");
}

export function knownFieldCount(vals: Map<string, FieldValue>) {
  return [...vals.values()].filter((f) => hasValue(f) && FIELD_BY_KEY.has(f.key)).length;
}
