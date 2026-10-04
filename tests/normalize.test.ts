import { describe, expect, it } from "vitest";
import { fold, parseBp, parseDate, parseField, parseGa, textSimilar } from "../shared/normalize.ts";
import { canTransition, transition, TransitionError } from "../shared/lifecycle.ts";
import { consistencyIssues, rangeIssue } from "../shared/validate.ts";

describe("parsing what is written on paper", () => {
  it("reads dates in the formats seen in the data", () => {
    expect(parseDate("26/04/2025").value).toBe("2025-04-26");
    expect(parseDate("20/1/26").value).toBe("2026-01-20");
    expect(parseDate("03-09-2021").value).toBe("2021-09-03");
    expect(parseDate("2023").value).toBe("2023");
    expect(parseDate("05/2023").value).toBe("2023-05");
    expect(parseDate("31/02/2025").ok).toBe(false);
  });

  it("converts blood pressure written in cmHg", () => {
    expect(parseBp("104/74").value).toEqual({ systolic: 104, diastolic: 74 });
    const cm = parseBp("11/7");
    expect(cm.value).toEqual({ systolic: 110, diastolic: 70 });
    expect(cm.note).toBe("converted_cmhg");
    expect(parseBp("12,5/8").value).toEqual({ systolic: 125, diastolic: 80 });
  });

  it("reads gestational age with or without days", () => {
    expect(parseGa("31 SA").value).toEqual({ weeks: 31, days: 0 });
    expect(parseGa("16SA+3j").value).toEqual({ weeks: 16, days: 3 });
    expect(parseGa("35SA+1j").value).toEqual({ weeks: 35, days: 1 });
  });

  it("handles units, decimal commas and Eastern Arabic digits", () => {
    expect(parseField("del.birthWeight", "3587 g").value).toBe(3587);
    expect(parseField("del.birthWeight", "3,5 kg").value).toBe(3500);
    expect(parseField("anc.T1V1.glycemia", "0,76g/L").value).toBe(0.76);
    expect(parseField("anc.T1V1.platelets", "186k").value).toBe(186000);
    expect(parseField("anc.T1V1.platelets", "233000/mm3").value).toBe(233000);
    expect(parseField("id.age", "٣١").value).toBe(31);
    expect(parseField("id.age", "21ans").value).toBe(21);
  });

  it("keeps missing information as its own status", () => {
    expect(parseField("anc.T1V1.fhr", "—").status).toBe("NOT_APPLICABLE");
    expect(parseField("anc.T1V1.fhr", "?").status).toBe("UNKNOWN");
    expect(parseField("anc.T1V1.fhr", "").status).toBe("NOT_PROVIDED");
  });

  it("reads lab results, roles and options in French and English", () => {
    expect(parseField("anc.T1V1.hiv", "nég").value).toBe("NEGATIVE");
    expect(parseField("anc.T1V1.rubella", "Immune").value).toBe("IMMUNE");
    expect(parseField("anc.T1V1.examiner", "Dr Benjelloun").value).toBe("DOCTOR");
    expect(parseField("anc.T1V1.examiner", "Sage-femme").value).toBe("MIDWIFE");
    expect(parseField("del.sex", "fille").value).toBe("F");
    expect(parseField("del.placeType", "MATERNITY").value).toBe("MATERNITY");
    expect(parseField("id.tetanusDoses", "1, 2").value).toEqual(["1", "2"]);
  });

  it("compares text without accents and tolerates glyph gaps", () => {
    expect(fold("Collège  Élevé")).toBe("college eleve");
    expect(textSimilar("coll ge", "Collège")).toBe(true);
    expect(textSimilar("Couturi re", "Couturière")).toBe(true);
    expect(textSimilar("RAS", "Aucun")).toBe(false);
  });
});

describe("data-quality checks", () => {
  it("flags values outside the plausible range without clinical wording", () => {
    const issue = rangeIssue("anc.T1V1.weight", 580);
    expect(issue?.code).toBe("out_of_range");
    expect(issue?.en).not.toMatch(/risk|hypertens|danger/i);
    expect(rangeIssue("anc.T1V1.weight", 58)).toBeUndefined();
  });

  it("finds contradictions between fields", () => {
    const codes = consistencyIssues(new Map<string, unknown>([["id.gravidity", 1], ["id.parity", 2], ["preg.lmp", "2025-04-26"], ["preg.edd", "2025-06-01"]])).map((i) => i.code);
    expect(codes).toContain("gravidity_parity");
    expect(codes).toContain("lmp_edd");
  });
});

describe("record lifecycle", () => {
  it("allows the happy path and failure recovery", () => {
    const path = ["CAPTURED", "PENDING_AI", "AI_PROCESSED", "NEEDS_REVIEW", "VALIDATED", "PATIENT_MATCHED", "REGISTERED", "SYNCED"] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true);
    expect(canTransition("PENDING_AI", "SYNC_FAILED")).toBe(true);
    expect(canTransition("SYNC_FAILED", "PENDING_AI")).toBe(true);
    expect(canTransition("PROCESSING_FAILED", "MANUAL_REVIEW_REQUIRED")).toBe(true);
  });

  it("rejects skipping review", () => {
    expect(() => transition("doc:1", "AI_PROCESSED", "REGISTERED", "test")).toThrow(TransitionError);
    expect(() => transition("doc:1", "SYNCED", "PENDING_AI", "test")).toThrow(TransitionError);
  });
});
