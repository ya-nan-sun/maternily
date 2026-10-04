// Geometry of the synthetic registry template (dossiers_specimen_10_patientes.pdf),
// in PDF points with origin bottom-left. Only used to turn the PDF vector layer
// into ground truth; the extraction pipeline never sees this.

import { VISIT_ROWS, VISIT_SLOTS } from "../shared/catalog.ts";
import type { BoxMap, LineMap, Mapping } from "../shared/template.ts";

const line = (key: string, lx: number, ly: number, maxW?: number): LineMap => ({ kind: "line", key, lx, ly, maxW });
const box = (key: string, bx: number, by: number, option?: string): BoxMap => ({ kind: "box", key, bx, by, option });

/** Labels of direct identifiers: values next to them are never mapped. */
export const IDENTIFIER_LINES: Record<number, [number, number][]> = {
  1: [[50, 456.9]],
  2: [[300, 751.9], [48, 707.9], [300, 707.9], [48, 685.9]],
  4: [[40, 756.9]],
};

function cover(): Mapping[] {
  return [
    line("cover.ficheNumber", 50, 731.9),
    line("cover.region", 50, 696.9, 260),
    line("cover.province", 320, 696.9),
    line("cover.facilityName", 50, 661.9),
    line("cover.riskOther", 290, 273.9),
    box("cover.facilityType", 90, 595.9, "DR"),
    box("cover.facilityType", 230, 595.9, "CSC"),
    box("cover.facilityType", 350, 595.9, "CSU"),
    box("cover.facilityType", 90, 565.9, "CSCA"),
    box("cover.facilityType", 230, 565.9, "CSUA"),
    box("cover.coverageMode", 90, 510.9, "FIXE"),
    box("cover.coverageMode", 230, 510.9, "MOBILE"),
    box("cover.riskPregnancy", 60, 392.9),
    box("cover.riskTypes", 65, 345.9, "ANEMIA"),
    box("cover.riskTypes", 65, 327.9, "HTA"),
    box("cover.riskTypes", 65, 309.9, "DIABETES"),
    box("cover.riskTypes", 65, 291.9, "CARDIOPATHY"),
    box("cover.riskTypes", 290, 345.9, "METRORRHAGIA"),
    box("cover.riskTypes", 290, 327.9, "INFECTION"),
    box("cover.riskTypes", 290, 309.9, "PREECLAMPSIA"),
    box("cover.riskTypes", 290, 291.9, "ECLAMPSIA"),
  ];
}

function identification(): Mapping[] {
  const m: Mapping[] = [
    line("id.age", 48, 751.9, 240),
    line("id.education", 48, 729.9, 240),
    line("id.occupation", 300, 729.9),
    line("id.husbandOccupation", 300, 685.9),
    line("id.gravidity", 40, 116.9, 115),
    line("id.parity", 160, 116.9, 115),
    line("id.livingChildren", 280, 116.9),
    line("id.rubellaDate", 300, 73.9),
    line("id.hepBDate", 300, 57.9),
    line("id.papSmear", 40, 39.9),
    box("id.consanguinity", 48, 658.9),
    box("id.desiredPregnancy", 300, 658.9),
    box("id.rubellaVaccinated", 40, 72.9),
    box("id.hepBVaccinated", 40, 56.9),
  ];
  [75, 115, 155, 195, 235].forEach((x, i) => m.push(box("id.tetanusDoses", x, 92.9, String(i + 1))));
  const famRows: [string, number][] = [["hta", 594.9], ["diabetes", 574.9], ["hereditary", 554.9], ["malformations", 534.9], ["allergies", 514.9]];
  for (const [k, y] of famRows) {
    m.push({ kind: "cell", key: `fam.${k}.wife`, x0: 130, x1: 210, y });
    m.push({ kind: "cell", key: `fam.${k}.husband`, x0: 210, x1: 295, y });
  }
  for (const [k, x0, x1] of [["medical", 305, 375], ["surgical", 375, 455], ["gyneco", 455, 560]] as const) {
    m.push({ kind: "cell", key: `hist.${k}`, x0, x1, y: 593, yBand: [505, 612] });
  }
  const obsRows: [string, number][] = [["abortion", 450.9], ["preterm", 430.9], ["fetalDeath", 410.9], ["other", 390.9]];
  const obsCols: [string, number, number][] = [["count", 150, 220], ["date", 220, 330], ["place", 330, 420], ["ga", 420, 560]];
  for (const [r, y] of obsRows) for (const [c, x0, x1] of obsCols) m.push({ kind: "cell", key: `obs.${r}.${c}`, x0, x1, y });
  const prevRows: [string, number][] = [["date", 301.9], ["mode", 273.9], ["csIndication", 245.9], ["complication", 217.9], ["weight", 189.9], ["nbComplication", 161.9]];
  [153, 234, 315, 396, 477].forEach((x, i) => {
    for (const [r, y] of prevRows) m.push({ kind: "cell", key: `prev.${i + 1}.${r}`, x0: x - 3, x1: x + 78, y });
  });
  return m;
}

const VISIT_ROW_Y: Record<string, number> = {
  appointment: 691.9, visitDate: 674.1, followUp: 656.3, ga: 638.5, weight: 602.9, bp: 585.1, skeletal: 567.3,
  conjunctivae: 549.5, breasts: 531.7, edema: 513.9, fetalMovements: 496.1, fundalHeight: 478.3, fhr: 460.5,
  speculum: 442.7, cervix: 424.9, presentation: 407.1, pelvis: 389.3, glycosuria: 353.7, albuminuria: 335.9,
  rubella: 318.1, toxo: 300.3, syphilis: 282.5, hbsag: 264.7, hiv: 246.9, hb: 229.1, platelets: 211.3,
  glycemia: 193.5, rai: 175.7, iron: 140.1, examiner: 104.5,
};
const VISIT_COL_X = [154, 198.8, 243.6, 288.4, 333.2, 378, 422.9, 467.7, 512.5];

function currentPregnancy(): Mapping[] {
  const m: Mapping[] = [
    line("preg.lmp", 40, 763.9, 145),
    line("preg.height", 190, 763.9, 125),
    line("preg.edd", 40, 746.9, 225),
    line("preg.postTerm", 270, 746.9, 230),
    box("preg.bloodGroup", 375, 762.9, "A"),
    box("preg.bloodGroup", 407, 762.9, "B"),
    box("preg.bloodGroup", 439, 762.9, "O"),
    box("preg.bloodGroup", 471, 762.9, "AB"),
    box("preg.rhesus", 505, 762.9, "NEG"),
    box("preg.rhesus", 505, 748.9, "POS"),
  ];
  VISIT_SLOTS.forEach((slot, i) => {
    for (const r of VISIT_ROWS) {
      m.push({ kind: "cell", key: `anc.${slot}.${r.row}`, x0: VISIT_COL_X[i] - 3, x1: VISIT_COL_X[i] + 41.8, y: VISIT_ROW_Y[r.row] });
    }
  });
  return m;
}

function delivery(): Mapping[] {
  return [
    line("del.date", 40, 536.9),
    line("del.csIndication", 215, 385.9),
    line("del.complicationOther", 250, 201.9),
    line("del.sex", 215, 131.9),
    line("del.birthWeight", 215, 111.9),
    line("del.headCirc", 215, 91.9),
    line("del.anomaly", 215, 69.9),
    line("del.gaAtBirth", 215, 49.9),
    box("del.placeSetting", 40, 695.9, "SUPERVISED"),
    box("del.placeSetting", 40, 605.9, "HOME"),
    box("del.placeType", 215, 700.9, "BIRTH_HOME"),
    box("del.placeType", 215, 684.9, "MATERNITY"),
    box("del.placeType", 215, 668.9, "PRIVATE_CLINIC"),
    box("del.homeAssisted", 215, 605.9),
    box("del.mode", 215, 490.9, "VAGINAL"),
    box("del.mode", 215, 472.9, "VAGINAL_INSTRUMENTAL"),
    box("del.mode", 215, 404.9, "CESAREAN_PLANNED"),
    box("del.mode", 390, 404.9, "CESAREAN_EMERGENCY"),
    box("del.instrument", 250, 456.9, "FORCEPS"),
    box("del.instrument", 250, 440.9, "VACUUM"),
    box("del.episiotomy", 250, 424.9),
    box("del.complicationsPresent", 190, 335.9),
    box("del.complicationTiming", 215, 332.9, "AT_DELIVERY"),
    box("del.complicationTiming", 215, 316.9, "POSTPARTUM"),
    box("del.complications", 250, 280.9, "PREECLAMPSIA"),
    box("del.complications", 250, 265.9, "ECLAMPSIA"),
    box("del.complications", 250, 250.9, "HEMORRHAGE"),
    box("del.complications", 250, 235.9, "INFECTION"),
    box("del.complications", 250, 220.9, "OTHER"),
    box("del.newbornStatus", 215, 155.9, "ALIVE"),
    box("del.newbornStatus", 285, 155.9, "STILLBORN"),
    box("del.newbornStatus", 365, 155.9, "DEATH_24H"),
  ];
}

function ppMother(phase: "early" | "late"): Mapping[] {
  const p = `ppm.${phase}`;
  return [
    line(`${p}.consultDate`, 330, 761.9),
    line(`${p}.temp`, 46, 699.9, 100),
    line(`${p}.bp`, 150, 699.9, 105),
    line(`${p}.pulse`, 260, 699.9, 95),
    line(`${p}.weight`, 360, 699.9),
    line(`${p}.scar`, 180, 517.9),
    line(`${p}.treatmentOther`, 46, 281.9),
    line(`${p}.nextAppointment`, 46, 267.9),
    line(`${p}.fpMethodOther`, 280, 191.9),
    line(`${p}.medicationDetail`, 46, 353.9, 520),
    { kind: "cell", key: `${p}.fpReason`, x0: 40, x1: 560, y: 125, yBand: [105, 136] },
    box(`${p}.timing`, phase === "early" ? 250 : 270, 758.9, "IN_WINDOW"),
    box(`${p}.timing`, 250, 744.9, "AFTER_WINDOW"),
    box(`${p}.conjunctivae`, 160, 678.9, "NORMAL"),
    box(`${p}.conjunctivae`, 250, 678.9, "PALE"),
    box(`${p}.uterineGlobe`, 46, 660.9),
    box(`${p}.lochia`, 160, 642.9, "FADE"),
    box(`${p}.lochia`, 230, 642.9, "FETID"),
    box(`${p}.lochia`, 160, 626.9, "CLEAR"),
    box(`${p}.lochia`, 230, 626.9, "BLOODY"),
    box(`${p}.lochia`, 310, 626.9, "YELLOWISH"),
    box(`${p}.perineum`, 60, 590.9, "NORMAL"),
    box(`${p}.perineum`, 60, 574.9, "EPISIOTOMY"),
    box(`${p}.perineum`, 200, 574.9, "REPAIRED"),
    box(`${p}.perineum`, 60, 558.9, "TEAR"),
    box(`${p}.sphincters`, 230, 536.9, "NORMAL"),
    box(`${p}.sphincters`, 300, 536.9, "ABNORMAL"),
    box(`${p}.cesarean`, 46, 516.9),
    box(`${p}.breasts`, 130, 496.9, "NORMAL"),
    box(`${p}.breasts`, 200, 496.9, "LYMPHANGITIS"),
    box(`${p}.breasts`, 290, 496.9, "MASTITIS"),
    box(`${p}.calves`, 60, 460.9, "NORMAL"),
    box(`${p}.calves`, 130, 460.9, "RED"),
    box(`${p}.calves`, 200, 460.9, "WARM"),
    box(`${p}.calves`, 270, 460.9, "PAINFUL"),
    box(`${p}.complicationsPresent`, 190, 436.9),
    box(`${p}.complications`, 60, 418.9, "HEMORRHAGE"),
    box(`${p}.complications`, 220, 418.9, "BREAST"),
    box(`${p}.complications`, 60, 403.9, "INFECTION"),
    box(`${p}.complications`, 220, 403.9, "ANEMIA"),
    box(`${p}.complications`, 60, 388.9, "ECLAMPSIA"),
    box(`${p}.complications`, 220, 388.9, "OTHER"),
    box(`${p}.complications`, 60, 373.9, "PHLEBITIS"),
    box(`${p}.medication`, 190, 352.9),
    box(`${p}.treatment`, 60, 300.9, "IRON"),
    box(`${p}.treatment`, 140, 300.9, "VITAMIN_A"),
    box(`${p}.fpDesired`, 46, 208.9),
    box(`${p}.fpMethod`, 140, 190.9, "PILL"),
    box(`${p}.fpMethod`, 210, 190.9, "IUD"),
    box(`${p}.fpPrescribed`, 46, 172.9),
    box(`${p}.fpReferred`, 46, 156.9),
  ];
}

function ppNewborn(phase: "early" | "late"): Mapping[] {
  const p = `ppn.${phase}`;
  const m: Mapping[] = [
    line(`${p}.consultDate`, 330, 761.9),
    line(`${p}.ageDays`, 46, 725.9, 140),
    line(`${p}.temp`, 190, 725.9, 185),
    line(`${p}.weight`, 380, 725.9),
    line(`${p}.length`, 46, 703.9, 140),
    line(`${p}.headCirc`, 190, 703.9),
    line(`${p}.dangerOther`, 46, 556.9),
    line(`${p}.traumaOther`, 60, 453.9),
    line(`${p}.seenBy`, 46, 251.9),
    line(`${p}.decision`, 46, 221.9),
    line(`${p}.treatment`, 46, 191.9),
    line(`${p}.referralFacility`, 120, 156.9),
    line(`${p}.nextVisit`, 46, 71.9),
    box(`${p}.premature`, 46, 680.9),
    box(`${p}.hypotrophic`, 190, 680.9),
    box(`${p}.feeding`, 110, 658.9, "EXCLUSIVE"),
    box(`${p}.feeding`, 250, 658.9, "ARTIFICIAL"),
    box(`${p}.feeding`, 330, 658.9, "MIXED"),
    box(`${p}.trauma`, 60, 508.9, "CEPHALHEMATOMA"),
    box(`${p}.trauma`, 60, 492.9, "HIP_DISLOCATION"),
    box(`${p}.trauma`, 60, 476.9, "LIMB_MOBILITY"),
    box(`${p}.bfEval`, 250, 428.9, "NORMAL"),
    box(`${p}.bfEval`, 320, 428.9, "PROBLEMS"),
    box(`${p}.vaccines`, 190, 390.9, "BCG"),
    box(`${p}.vaccines`, 250, 390.9, "HB"),
    box(`${p}.vitaminD`, 46, 370.9),
    box(`${p}.complications`, 60, 326.9, "JAUNDICE"),
    box(`${p}.complications`, 140, 326.9, "INFECTION"),
    box(`${p}.complications`, 220, 326.9, "CONJUNCTIVITIS"),
    box(`${p}.complications`, 60, 308.9, "TRAUMA"),
    box(`${p}.complications`, 140, 308.9, "MALFORMATION"),
    box(`${p}.complications`, 60, 290.9, "OTHER"),
    box(`${p}.transfer`, 46, 155.9),
  ];
  const danger: [string, number, number][] = [
    ["CONVULSIONS", 50, 616.9], ["NOT_FEEDING", 175, 616.9], ["HEMATEMESIS", 300, 616.9], ["MELENA", 425, 616.9],
    ["DIARRHEA", 50, 598.9], ["JAUNDICE", 175, 598.9], ["CHEST_INDRAWING", 300, 598.9], ["COUGH", 425, 598.9],
    ["ABNORMAL_BREATHING", 50, 580.9], ["FEVER", 175, 580.9], ["HYPOTHERMIA", 300, 580.9],
  ];
  for (const [o, x, y] of danger) m.push(box(`${p}.dangerSigns`, x, y, o));
  return m;
}

/** Mappings by page-in-record (1..8). */
export const TEMPLATE: Record<number, Mapping[]> = {
  1: cover(),
  2: identification(),
  3: currentPregnancy(),
  4: delivery(),
  5: ppMother("early"),
  6: ppNewborn("early"),
  7: ppMother("late"),
  8: ppNewborn("late"),
};
