// Clean-up of common OCR confusions, using what each field expects.

import { describe, expect, it } from "vitest";
import { FIELD_BY_KEY } from "../shared/catalog.ts";
import { parseField } from "../shared/normalize.ts";
import { cleanOcrText } from "../server/extraction/template-extractor.ts";

const clean = (key: string, text: string) => cleanOcrText(FIELD_BY_KEY.get(key)!, text);
const value = (key: string, text: string) => parseField(key, clean(key, text).text).value;

describe("OCR clean-up", () => {
  it("reads letters that look like digits in dates", () => {
    expect(value("del.date", "23/o1/2026")).toBe("2026-01-23");
    expect(value("ppm.early.consultDate", "16/os/2026")).toBe("2026-05-16");
    expect(value("ppm.early.nextAppointment", "zo/o6/2o26")).toBe("2026-06-20");
    expect(value("ppn.early.nextVisit", "O4/o 8/2026")).toBe("2026-08-04");
  });

  it("fixes the unit g read as 9", () => {
    expect(value("del.birthWeight", "3699 9")).toBe(3699);
    expect(value("anc.T1V1.hb", "13.2 9g/dL")).toBe(13.2);
    expect(value("anc.T1V1.glycemia", "L0.8 9/L")).toBe(0.8);
  });

  it("removes the writing-line underscore", () => {
    expect(value("preg.height", "158_cm")).toBe(158);
    expect(value("anc.T1V1.examiner", "Sage_femme")).toBe("MIDWIFE");
  });

  it("recovers a blood pressure whose slash was read as 1, but flags the guess", () => {
    expect(clean("anc.T2V1.bp", "118174")).toEqual({ text: "118/74", guessed: true });
    expect(clean("anc.T2V1.bp", "104/74").guessed).toBe(false);
  });

  it("completes cut-off yes/no answers and leaves real text alone", () => {
    expect(value("anc.T1V1.iron", "Ou")).toBe(true);
    expect(clean("hist.medical", "Asthme | ger").text).toBe("Asthme l ger");
    expect(clean("id.education", "Lycée").text).toBe("Lycée");
  });
});
