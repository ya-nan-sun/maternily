// Export registered patients in the organizers' tabular format: the 31 columns of
// maternal_registry_synthetic.csv, one row per woman, coded 0/1/2. A cell stays empty when
// the registry doesn't hold the value (or only an unconfirmed one). The `id` column carries
// the registry's form number (else a row number), never a name.
//
// Some columns have no exact box on the paper form and are derived; README lists which.

import { VISIT_SLOTS } from "../shared/catalog.ts";
import type { Bp, Ga } from "../shared/normalize.ts";
import { fold } from "../shared/normalize.ts";
import type { FieldValue } from "../shared/status.ts";
import type { Db } from "./db.ts";
import { patientValues } from "./records.ts";

export const EXPORT_COLUMNS = [
  "id", "age (years)", "education level (0=none/primary,1=secondary,2=higher)", "consanguinity", "desired pregnancy",
  "hypertension history", "diabetes mellitus", "gravidity (number)", "parity (number)", "abortions (number)",
  "living children (number)", "previous cesarean", "bmi pregestational (kg/m2)", "mean systolic bp (mmhg)",
  "mean diastolic bp (mmhg)", "hemoglobin (g/dl)", "first fasting glucose (mg/dl)", "proteinuria", "hiv test result",
  "syphilis test result", "hepatitis c test result", "gestational age at enrollment (weeks)", "gestational dm",
  "gestational age at birth (weeks)", "preterm birth", "type of delivery (0=vaginal,1=cesarean)",
  "newborn sex (0=female,1=male)", "child birth weight (g)", "head circumference (cm)", "breastfeeding initiated",
  "referral to higher care",
] as const;

type Cell = number | string | null;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const bit = (b: boolean | null) => (b === null ? null : b ? 1 : 0);

/** Education is free text on the form ("Collège", "Universitaire", …). */
export function educationCode(text: string): number | null {
  const t = fold(text);
  if (/univ|superieur|faculte|licence|master|doctorat|bac ?\+/.test(t)) return 2;
  if (/college|lycee|secondaire|bac/.test(t)) return 1;
  if (/aucun|neant|analphab|illettre|primaire|coranique|msid|none|primary/.test(t)) return 0;
  return null;
}

export function exportRow(vals: Map<string, FieldValue>, id: Cell): Cell[] {
  const get = <T>(key: string): T | null => {
    const f = vals.get(key);
    return f && f.status === "KNOWN" && f.value !== null && f.value !== undefined ? (f.value as T) : null;
  };
  const visits = VISIT_SLOTS.map((s) => (k: string) => get(`anc.${s}.${k}`));
  const firstOf = <T>(k: string) => visits.map((v) => v(k) as T | null).find((x) => x !== null) ?? null;
  // A lab test is positive if any visit says so, negative if at least one says negative.
  const lab = (k: string) => {
    const r = visits.map((v) => v(k)).filter((x) => x !== null);
    return r.includes("POSITIVE") ? 1 : r.includes("NEGATIVE") ? 0 : null;
  };

  const risks = get<string[]>("cover.riskTypes");
  const parity = get<number>("id.parity");
  const prevModes = [1, 2, 3, 4, 5].map((n) => get<string>(`prev.${n}.mode`)).filter((m): m is string => m !== null);
  const previousCesarean = prevModes.some((m) => /cesar/.test(fold(m))) ? 1 : prevModes.length || parity === 0 ? 0 : null;

  // Pre-pregnancy weight isn't recorded; the first first-trimester weight is the usual proxy.
  const height = get<number>("preg.height");
  const t1Weight = (["T1V1", "T1V2", "T1V3"] as const).map((s) => get<number>(`anc.${s}.weight`)).find((x) => x !== null) ?? null;
  const bmi = height && t1Weight ? round(t1Weight / (height / 100) ** 2, 2) : null;

  const bps = visits.map((v) => v("bp") as Bp | null).filter((b): b is Bp => b !== null);
  const mean = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const glycemia = firstOf<number>("glycemia"); // g/L on the form
  const gaWeeks = (g: Ga | null) => (g ? round(g.weeks + (g.days ?? 0) / 7) : null);
  const gaBirth = gaWeeks(get<Ga>("del.gaAtBirth"));
  const mode = get<string>("del.mode");
  const sex = get<string>("del.sex");
  const feeding = [get<string>("ppn.early.feeding"), get<string>("ppn.late.feeding")].find((x) => x !== null) ?? null;
  const transfers = [get<boolean>("ppn.early.transfer"), get<boolean>("ppn.late.transfer")].filter((x) => x !== null);

  return [
    id,
    get<number>("id.age"),
    get<string>("id.education") === null ? null : educationCode(get<string>("id.education")!),
    bit(get<boolean>("id.consanguinity")),
    bit(get<boolean>("id.desiredPregnancy")),
    risks ? bit(risks.includes("HTA")) : null,
    risks ? bit(risks.includes("DIABETES")) : null,
    get<number>("id.gravidity"),
    parity,
    get<number>("obs.abortion.count"),
    get<number>("id.livingChildren"),
    previousCesarean,
    bmi,
    mean(bps.map((b) => b.systolic)),
    mean(bps.map((b) => b.diastolic)),
    firstOf<number>("hb"),
    glycemia === null ? null : round(glycemia * 100),
    lab("albuminuria"),
    lab("hiv"),
    lab("syphilis"),
    null, // hepatitis C is not on the paper form (it records HBs antigen)
    gaWeeks(firstOf<Ga>("ga")),
    null, // gestational diabetes has no box on the form
    gaBirth,
    gaBirth === null ? null : bit(gaBirth < 37),
    mode === null ? null : bit(mode.startsWith("CESAREAN")),
    sex === null ? null : bit(sex === "M"),
    get<number>("del.birthWeight"),
    get<number>("del.headCirc"),
    feeding === null ? null : bit(feeding !== "ARTIFICIAL"),
    transfers.length ? bit(transfers.includes(true)) : null,
  ];
}

const csvCell = (c: Cell) => (c === null ? "" : typeof c === "number" ? String(c) : /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);

/** Every registered patient as one CSV row, in the organizers' column order. */
export function exportCsv(db: Db): string {
  const patients = db.prepare("SELECT id, code FROM patients ORDER BY created_at").all() as { id: string; code: string | null }[];
  const lines = [EXPORT_COLUMNS.map((c) => csvCell(c)).join(",")];
  patients.forEach((p, i) => lines.push(exportRow(patientValues(db, p.id), p.code ?? i + 1).map(csvCell).join(",")));
  return lines.join("\r\n") + "\r\n"; // CRLF, like the organizers' file
}
