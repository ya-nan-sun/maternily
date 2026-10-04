// Patient linking. The code written on the registry (N° de fiche) is the link.
// When it is missing or misread, non-identifying fields are compared to propose
// candidates; the midwife always decides, the system never merges on its own.

import { levenshtein, type Ga } from "../shared/normalize.ts";
import type { FieldValue } from "../shared/status.ts";
import type { Db } from "./db.ts";
import { patientValues } from "./records.ts";

export function normalizeCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s_.]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/O(?=\d)|(?<=\d)O/g, "0");
}

export interface Candidate {
  patientId: string;
  code: string | null;
  score: number;
  reasons: string[];
}

const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const val = (m: Map<string, FieldValue>, k: string) => {
  const f = m.get(k);
  return f && f.status !== "NOT_PROVIDED" ? f.value : undefined;
};

/** Score how plausible it is that `incoming` belongs to the patient whose values are `existing`. */
export function featureScore(existing: Map<string, FieldValue>, incoming: Map<string, FieldValue>): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const cmp = (key: string, points: number, same: (a: unknown, b: unknown) => boolean, label: string) => {
    const a = val(existing, key);
    const b = val(incoming, key);
    if (a === undefined || a === null || b === undefined || b === null) return;
    if (same(a, b)) {
      score += points;
      reasons.push(label);
    } else score -= Math.ceil(points / 2);
  };
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  cmp("id.age", 2, (a, b) => Math.abs((a as number) - (b as number)) <= 1, "age");
  cmp("cover.province", 1, (a, b) => String(a).toLowerCase() === String(b).toLowerCase(), "province");
  cmp("id.gravidity", 2, eq, "gravidity");
  cmp("id.parity", 2, eq, "parity");
  cmp("id.livingChildren", 1, eq, "living children");
  cmp("preg.lmp", 3, (a, b) => days(a as string, b as string) <= 7, "LMP");
  cmp("preg.edd", 3, (a, b) => days(a as string, b as string) <= 7, "EDD");
  cmp("del.date", 3, (a, b) => days(a as string, b as string) <= 2, "delivery date");
  cmp("del.birthWeight", 2, (a, b) => Math.abs((a as number) - (b as number)) <= 50, "birth weight");
  cmp("del.gaAtBirth", 1, (a, b) => Math.abs((a as Ga).weeks - (b as Ga).weeks) <= 1, "GA at birth");
  return { score, reasons };
}

export const PLAUSIBLE_SCORE = 5;

export function findCandidates(db: Db, code: string | null, incoming: Map<string, FieldValue>): Candidate[] {
  const patients = db.prepare("SELECT id, code FROM patients").all() as { id: string; code: string | null }[];
  const out: Candidate[] = [];
  const norm = code ? normalizeCode(code) : null;
  for (const p of patients) {
    const { score, reasons } = featureScore(patientValues(db, p.id), incoming);
    if (norm && p.code && p.code === norm) {
      out.push({ patientId: p.id, code: p.code, score: 100 + score, reasons: ["same form number", ...reasons] });
    } else if (norm && p.code && levenshtein(norm, p.code) === 1) {
      out.push({ patientId: p.id, code: p.code, score: 10 + score, reasons: ["form number differs by one character", ...reasons] });
    } else if (score >= PLAUSIBLE_SCORE && reasons.length >= 2) {
      out.push({ patientId: p.id, code: p.code, score, reasons });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 2);
}
