// Data-quality checks. These never interpret a value clinically: they only ask
// "was this read correctly?" when a value is outside what can physically be
// written in that box, or when two fields contradict each other.

import { FIELD_BY_KEY, VISIT_SLOTS } from "./catalog.ts";
import type { Bp, Ga } from "./normalize.ts";

export interface Issue {
  keys: string[];
  code: string;
  fr: string;
  en: string;
}

type Values = ReadonlyMap<string, unknown>;

export function rangeIssue(key: string, value: unknown): Issue | undefined {
  const def = FIELD_BY_KEY.get(key);
  if (!def || value === null || value === undefined) return undefined;
  if (def.type === "bp") {
    const { systolic: s, diastolic: d } = value as Bp;
    if (s < 60 || s > 260 || d < 30 || d > 160 || s <= d) {
      return {
        keys: [key],
        code: "bp_unusual",
        fr: `La tension ${s}/${d} est inhabituelle pour ce champ : merci de vérifier la lecture.`,
        en: `Blood pressure ${s}/${d} is unusual for this box: please check the reading.`,
      };
    }
  }
  if (def.type === "ga") {
    const { weeks } = value as Ga;
    if (weeks < 3 || weeks > 45) {
      return { keys: [key], code: "ga_unusual", fr: `${weeks} SA est hors de la plage attendue (3–45).`, en: `${weeks} weeks is outside the expected range (3–45).` };
    }
  }
  if (def.range && typeof value === "number") {
    const [lo, hi] = def.range;
    if (value < lo || value > hi) {
      const u = def.unit ? ` ${def.unit}` : "";
      return {
        keys: [key],
        code: "out_of_range",
        fr: `${value}${u} est hors de la plage attendue (${lo}–${hi}${u}) : merci de vérifier la lecture.`,
        en: `${value}${u} is outside the expected range (${lo}–${hi}${u}): please check the reading.`,
      };
    }
  }
  if (def.type === "date" && typeof value === "string") {
    const y = Number(value.slice(0, 4));
    if (y < 1980 || y > new Date().getFullYear() + 1) {
      return { keys: [key], code: "date_unusual", fr: `L'année ${y} semble inhabituelle.`, en: `The year ${y} looks unusual.` };
    }
  }
  return undefined;
}

const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

/** Cross-field consistency checks over a whole record (current + incoming values). */
export function consistencyIssues(v: Values): Issue[] {
  const out: Issue[] = [];
  const num = (k: string) => (typeof v.get(k) === "number" ? (v.get(k) as number) : undefined);

  const g = num("id.gravidity");
  const p = num("id.parity");
  const ab = num("obs.abortion.count");
  const living = num("id.livingChildren");
  if (g !== undefined && p !== undefined && p + (ab ?? 0) > g) {
    out.push({
      keys: ["id.gravidity", "id.parity", ...(ab !== undefined ? ["obs.abortion.count"] : [])],
      code: "gravidity_parity",
      fr: `Gestation (${g}) inférieure à parité + avortements (${p + (ab ?? 0)}).`,
      en: `Gravidity (${g}) is lower than parity + abortions (${p + (ab ?? 0)}).`,
    });
  }
  if (living !== undefined && p !== undefined && living > p + 1) {
    out.push({
      keys: ["id.livingChildren", "id.parity"],
      code: "living_parity",
      fr: `Enfants vivants (${living}) supérieur à la parité (${p}).`,
      en: `Living children (${living}) is higher than parity (${p}).`,
    });
  }

  const lmp = v.get("preg.lmp") as string | undefined;
  const edd = v.get("preg.edd") as string | undefined;
  if (lmp && edd) {
    const d = days(lmp, edd);
    if (Math.abs(d - 280) > 21) {
      out.push({
        keys: ["preg.lmp", "preg.edd"],
        code: "lmp_edd",
        fr: `La DPA est à ${Math.round(d)} jours de la DDR (attendu ≈ 280).`,
        en: `Expected delivery date is ${Math.round(d)} days after LMP (expected ≈ 280).`,
      });
    }
  }

  let prevDate: string | undefined;
  let prevSlot: string | undefined;
  for (const slot of VISIT_SLOTS) {
    const date = v.get(`anc.${slot}.visitDate`) as string | undefined;
    const ga = v.get(`anc.${slot}.ga`) as Ga | undefined;
    if (date && prevDate && date < prevDate) {
      out.push({
        keys: [`anc.${slot}.visitDate`, `anc.${prevSlot}.visitDate`],
        code: "visit_order",
        fr: `La visite « ${slot} » est datée avant la visite précédente.`,
        en: `Visit ${slot} is dated before the previous visit.`,
      });
    }
    if (date && ga && lmp) {
      const expected = days(lmp, date) / 7;
      if (Math.abs(expected - (ga.weeks + ga.days / 7)) > 3) {
        out.push({
          keys: [`anc.${slot}.ga`, `anc.${slot}.visitDate`],
          code: "ga_vs_dates",
          fr: `Âge gestationnel ${ga.weeks} SA, mais la date de visite et la DDR donnent ≈ ${Math.round(expected)} SA.`,
          en: `Gestational age ${ga.weeks} weeks, but visit date and LMP give ≈ ${Math.round(expected)} weeks.`,
        });
      }
    }
    if (date) {
      prevDate = date;
      prevSlot = slot;
    }
  }

  const delDate = v.get("del.date") as string | undefined;
  const gaBirth = v.get("del.gaAtBirth") as Ga | undefined;
  if (lmp && delDate && gaBirth) {
    const expected = days(lmp, delDate) / 7;
    if (Math.abs(expected - gaBirth.weeks) > 3) {
      out.push({
        keys: ["del.gaAtBirth", "del.date"],
        code: "ga_birth_vs_dates",
        fr: `Âge gestationnel à la naissance ${gaBirth.weeks} SA, mais les dates donnent ≈ ${Math.round(expected)} SA.`,
        en: `Gestational age at birth ${gaBirth.weeks} weeks, but the dates give ≈ ${Math.round(expected)} weeks.`,
      });
    }
  }
  for (const phase of ["early", "late"] as const) {
    const c = v.get(`ppm.${phase}.consultDate`) as string | undefined;
    if (c && delDate && c < delDate) {
      out.push({
        keys: [`ppm.${phase}.consultDate`, "del.date"],
        code: "pp_before_delivery",
        fr: "La consultation post-partum est datée avant l'accouchement.",
        en: "The postpartum consultation is dated before the delivery.",
      });
    }
  }
  return out;
}
