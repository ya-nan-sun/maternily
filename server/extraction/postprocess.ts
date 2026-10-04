// Turns raw transcriptions into stored field values with an explicit status
// and a confidence that combines the model's self-report with deterministic
// checks (parsing, ranges, identifier guard).

import { fieldsOf, type Section } from "../../shared/catalog.ts";
import { parseField } from "../../shared/normalize.ts";
import type { FieldValue } from "../../shared/status.ts";
import { consistencyIssues, rangeIssue } from "../../shared/validate.ts";
import type { PageExtraction, RawExtraction } from "./types.ts";

const PHONE = /(?:\+?212|\b0)[5-7](?:[\s.-]?\d){8}\b/;
const NATIONAL_ID = /\b[A-Z]{1,2}\s?\d{5,7}\b/;

const REASONS = {
  low_confidence: "Je ne suis pas sûr de ma lecture. / I am not sure of my reading.",
  illegible: "Je n'arrive pas à lire cette case. / I cannot read this box.",
  unparsable: "La valeur lue ne correspond pas au format attendu. / The value read does not match the expected format.",
  cmhg: "Écrit en cmHg, converti en mmHg. / Written in cmHg, converted to mmHg.",
  identifier: "Ressemblait à un identifiant personnel : supprimé. / Looked like a personal identifier: removed.",
};

export function postprocess(raw: RawExtraction, threshold: number, captureId: string | null): PageExtraction {
  const section = raw.section as Section | "UNKNOWN";
  const fields: Record<string, FieldValue> = {};
  const byKey = new Map(raw.fields.map((f) => [f.k, f]));

  if (section !== "UNKNOWN") {
    for (const def of fieldsOf(section)) {
      const f = byKey.get(def.key);
      const base = { key: def.key, sourceCaptureId: captureId, confirmedBy: "AI" as const };
      if (!f) {
        fields[def.key] = { ...base, value: null, raw: null, status: "NOT_PROVIDED", confidence: 0.9, reasons: [] };
        continue;
      }
      const c = Math.max(0, Math.min(1, f.c));
      if (f.s === "I") {
        fields[def.key] = { ...base, value: null, raw: f.v || null, status: "ILLEGIBLE", confidence: c, reasons: [REASONS.illegible] };
        continue;
      }
      if (f.s === "U") {
        fields[def.key] = { ...base, value: null, raw: f.v || "?", status: "UNKNOWN", confidence: c, reasons: [] };
        continue;
      }
      if (f.s === "NA") {
        fields[def.key] = { ...base, value: null, raw: f.v || "—", status: "NOT_APPLICABLE", confidence: c, reasons: [] };
        continue;
      }
      if (def.type === "text" && (PHONE.test(f.v) || NATIONAL_ID.test(f.v))) {
        fields[def.key] = { ...base, value: null, raw: "[removed]", status: "NEEDS_REVIEW", confidence: 0.3, reasons: [REASONS.identifier] };
        continue;
      }
      const raw = f.v;
      const isBox = def.input === "checkbox" && def.type === "bool";
      const parsed = parseField(def.key, isBox ? (/^check/i.test(raw) ? "checked" : "unchecked") : raw);
      if (parsed.status && parsed.status !== "KNOWN") {
        fields[def.key] = { ...base, value: null, raw, status: parsed.status, confidence: c, reasons: [] };
        continue;
      }
      if (!parsed.ok) {
        fields[def.key] = { ...base, value: null, raw, status: "NEEDS_REVIEW", confidence: Math.min(c, 0.4), reasons: [REASONS.unparsable] };
        continue;
      }
      let confidence = c;
      const reasons: string[] = [];
      if (parsed.note === "converted_cmhg") {
        reasons.push(REASONS.cmhg);
        confidence = Math.min(confidence, 0.75);
      }
      const issue = rangeIssue(def.key, parsed.value);
      if (issue) {
        reasons.push(`${issue.fr} / ${issue.en}`);
        confidence = Math.min(confidence, 0.5);
      }
      if (confidence < threshold && !reasons.length) reasons.push(REASONS.low_confidence);
      fields[def.key] = {
        ...base,
        value: parsed.value ?? null,
        raw,
        status: confidence < threshold ? "NEEDS_REVIEW" : "KNOWN",
        confidence,
        reasons,
      };
    }
  }
  // Keys the model invented, or keys of other sections, are ignored by construction:
  // only catalog fields of the detected section are read from the output.

  // Fields on this page that contradict each other (e.g. 7 living children with parity 1,
  // a gestational age that does not fit the visit date) are sent for review right away.
  const values = new Map(Object.values(fields).filter((f) => f.value !== null).map((f) => [f.key, f.value]));
  for (const issue of consistencyIssues(values)) {
    for (const k of issue.keys) {
      const f = fields[k];
      if (f && f.status === "KNOWN") {
        fields[k] = { ...f, status: "NEEDS_REVIEW", confidence: Math.min(f.confidence, 0.5), reasons: [...f.reasons, `${issue.fr} / ${issue.en}`] };
      }
    }
  }

  return {
    section,
    sectionConfidence: raw.section_confidence,
    quality: { usable: raw.page_usable, issues: raw.quality_issues },
    fields,
  };
}
