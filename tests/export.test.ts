import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { FieldValue } from "../shared/status.ts";
import { EXPORT_COLUMNS, educationCode, exportRow } from "../server/export.ts";

const known = (key: string, value: unknown): [string, FieldValue] => [key, { key, value, raw: null, status: "KNOWN", confidence: 1, reasons: [], sourceCaptureId: "c", confirmedBy: "MIDWIFE" } as FieldValue];
const col = (row: unknown[], name: string) => row[EXPORT_COLUMNS.findIndex((c) => c.startsWith(name))];

describe("CSV export in the organizers' format", () => {
  it("uses exactly the header of maternal_registry_synthetic.csv", () => {
    const csv = "dayone-participants/data/maternal_registry_synthetic.csv";
    if (!fs.existsSync(csv)) return;
    const header = fs.readFileSync(csv, "utf8").split(/\r?\n/)[0];
    const theirs = header.match(/("[^"]*"|[^,]+)/g)!.map((c) => c.replace(/^"|"$/g, ""));
    expect([...EXPORT_COLUMNS]).toEqual(theirs);
  });

  it("codes and derives values like the organizers' CSV", () => {
    const row = exportRow(new Map([
      known("id.age", 29), known("id.education", "Lycée"), known("id.consanguinity", false), known("id.parity", 2),
      known("prev.1.mode", "Voie basse"), known("prev.2.mode", "Césarienne"),
      known("preg.height", 160), known("anc.T1V2.weight", 64),
      known("anc.T1V1.bp", { systolic: 110, diastolic: 70 }), known("anc.M8.bp", { systolic: 130, diastolic: 80 }),
      known("anc.T1V1.glycemia", 0.82), known("anc.T1V1.hiv", "NEGATIVE"), known("anc.T2V1.syphilis", "POSITIVE"),
      known("anc.T1V1.ga", { weeks: 10, days: 3 }), known("del.gaAtBirth", { weeks: 36, days: 5 }),
      known("del.mode", "CESAREAN_EMERGENCY"), known("del.sex", "F"), known("ppn.early.feeding", "MIXED"),
      ["id.gravidity", { ...known("id.gravidity", 3)[1], status: "NEEDS_REVIEW" }],
    ]), "2026-823-001");
    expect(row).toHaveLength(EXPORT_COLUMNS.length);
    expect(col(row, "id")).toBe("2026-823-001");
    expect(col(row, "age")).toBe(29);
    expect(col(row, "education")).toBe(1);
    expect(col(row, "consanguinity")).toBe(0);
    expect(col(row, "gravidity")).toBeNull(); // unconfirmed values are never exported
    expect(col(row, "previous cesarean")).toBe(1);
    expect(col(row, "bmi")).toBe(25);
    expect(col(row, "mean systolic")).toBe(120);
    expect(col(row, "mean diastolic")).toBe(75);
    expect(col(row, "first fasting glucose")).toBe(82);
    expect(col(row, "hiv")).toBe(0);
    expect(col(row, "syphilis")).toBe(1);
    expect(col(row, "hepatitis c")).toBeNull();
    expect(col(row, "gestational age at enrollment")).toBe(10.4);
    expect(col(row, "gestational age at birth")).toBe(36.7);
    expect(col(row, "preterm birth")).toBe(1);
    expect(col(row, "type of delivery")).toBe(1);
    expect(col(row, "newborn sex")).toBe(0);
    expect(col(row, "breastfeeding")).toBe(1);
  });

  it("maps free-text education levels", () => {
    expect(["Analphabète", "primaire", "Collège", "Universitaire", "???"].map(educationCode)).toEqual([0, 0, 1, 2, null]);
  });
});
