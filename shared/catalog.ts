// Field catalog: the single source of truth for what the registry contains.
// Every extracted value is stored under one of these keys. Direct identifiers
// (name, husband's name, CIN, phone, address) are deliberately absent, so the
// pipeline has nowhere to put them.

export type Section =
  | "COVER"
  | "IDENTIFICATION_HISTORY"
  | "CURRENT_PREGNANCY"
  | "DELIVERY"
  | "PP_EARLY_MOTHER"
  | "PP_EARLY_NEWBORN"
  | "PP_LATE_MOTHER"
  | "PP_LATE_NEWBORN";

export const SECTIONS: Section[] = [
  "COVER",
  "IDENTIFICATION_HISTORY",
  "CURRENT_PREGNANCY",
  "DELIVERY",
  "PP_EARLY_MOTHER",
  "PP_EARLY_NEWBORN",
  "PP_LATE_MOTHER",
  "PP_LATE_NEWBORN",
];

export const SECTION_LABELS: Record<Section, { fr: string; en: string; printedTitle: string }> = {
  COVER: { fr: "Couverture (fiche)", en: "Cover page", printedTitle: "FICHE DE SURVEILLANCE DE LA GROSSESSE ET DU POST-PARTUM" },
  IDENTIFICATION_HISTORY: { fr: "Identification et antécédents", en: "Identification and history", printedTitle: "IDENTIFICATION ET ANTÉCÉDENTS" },
  CURRENT_PREGNANCY: { fr: "Grossesse actuelle", en: "Current pregnancy", printedTitle: "GROSSESSE ACTUELLE" },
  DELIVERY: { fr: "Accouchement", en: "Delivery", printedTitle: "DÉROULEMENT DE L'ACCOUCHEMENT" },
  PP_EARLY_MOTHER: { fr: "Post-partum précoce — mère", en: "Early postpartum — mother", printedTitle: "CONSULTATION DU POST-PARTUM PRÉCOCE — MÈRE" },
  PP_EARLY_NEWBORN: { fr: "Post-partum précoce — nouveau-né", en: "Early postpartum — newborn", printedTitle: "CONSULTATION DU POST-PARTUM PRÉCOCE — NOUVEAU-NÉ" },
  PP_LATE_MOTHER: { fr: "Post-partum tardif — mère", en: "Late postpartum — mother", printedTitle: "CONSULTATION DU POST-PARTUM TARDIF — MÈRE" },
  PP_LATE_NEWBORN: { fr: "Post-partum tardif — nouveau-né", en: "Late postpartum — newborn", printedTitle: "CONSULTATION DU POST-PARTUM TARDIF — NOUVEAU-NÉ" },
};

export type FieldType =
  | "text" // free text
  | "int"
  | "number"
  | "date"
  | "bp" // systolic/diastolic, stored in mmHg
  | "ga" // gestational age, weeks + days
  | "bool" // checkbox or Oui/Non
  | "choice" // exactly one option
  | "multi" // any number of options
  | "lab" // NEGATIVE / POSITIVE / IMMUNE / NOT_IMMUNE / NOT_DONE
  | "role"; // examiner role (we never store staff names)

export interface FieldOption {
  value: string;
  fr: string; // as printed on the form
  en: string;
}

export interface FieldDef {
  key: string;
  section: Section;
  type: FieldType;
  fr: string;
  en: string;
  /** "checkbox" fields are read from marks, "written" from handwriting. */
  input: "checkbox" | "written";
  unit?: string;
  options?: FieldOption[];
  /** Plausible range (data-quality check only, never a clinical judgement). */
  range?: [number, number];
  /** Asked for during manual entry when the AI is unavailable. */
  essential?: boolean;
  /** Candidate patient code. */
  patientCode?: boolean;
  /** Used by the anonymized dashboard. */
  dashboard?: boolean;
  /** Antenatal visit slot, for longitudinal fields. */
  visitSlot?: VisitSlot;
}

const opt = (value: string, fr: string, en: string = fr): FieldOption => ({ value, fr, en });

const BOOL_OPTS = undefined;

export const LAB_VALUES = ["NEGATIVE", "POSITIVE", "IMMUNE", "NOT_IMMUNE", "NOT_DONE"] as const;
export const ROLE_VALUES = ["DOCTOR", "MIDWIFE", "NURSE", "OTHER"] as const;

export const VISIT_SLOTS = ["T1V1", "T1V2", "T1V3", "T2V1", "T2V2", "T2V3", "M7", "M8", "M9"] as const;
export type VisitSlot = (typeof VISIT_SLOTS)[number];
export const VISIT_SLOT_LABELS: Record<VisitSlot, { fr: string; en: string }> = {
  T1V1: { fr: "1er trim. visite 1", en: "1st trim. visit 1" },
  T1V2: { fr: "1er trim. visite 2", en: "1st trim. visit 2" },
  T1V3: { fr: "1er trim. visite 3", en: "1st trim. visit 3" },
  T2V1: { fr: "2e trim. visite 1", en: "2nd trim. visit 1" },
  T2V2: { fr: "2e trim. visite 2", en: "2nd trim. visit 2" },
  T2V3: { fr: "2e trim. visite 3", en: "2nd trim. visit 3" },
  M7: { fr: "7e mois", en: "7th month" },
  M8: { fr: "8e mois", en: "8th month" },
  M9: { fr: "9e mois", en: "9th month" },
};

const fields: FieldDef[] = [];
function add(section: Section, key: string, type: FieldType, fr: string, en: string, extra: Partial<FieldDef> = {}) {
  const input = extra.input ?? (type === "multi" || type === "choice" ? "checkbox" : "written");
  fields.push({ key, section, type, fr, en, input, ...extra });
}

// ---------------------------------------------------------------- P1 cover
add("COVER", "cover.ficheNumber", "text", "N° de la fiche", "Form number", { patientCode: true, essential: true });
add("COVER", "cover.region", "text", "Région", "Region", { essential: true });
add("COVER", "cover.province", "text", "Province", "Province", { essential: true, dashboard: true });
add("COVER", "cover.facilityName", "text", "Nom de l'établissement sanitaire", "Health facility name");
add("COVER", "cover.facilityType", "choice", "Type de l'établissement", "Facility type", {
  options: ["DR", "CSC", "CSU", "CSCA", "CSUA"].map((v) => opt(v, v)),
});
add("COVER", "cover.coverageMode", "choice", "Mode de couverture", "Coverage mode", {
  options: [opt("FIXE", "Fixe", "Fixed"), opt("MOBILE", "Mobile")],
});
add("COVER", "cover.riskPregnancy", "bool", "Grossesse classée à risque", "Pregnancy classified at risk", { input: "checkbox" });
add("COVER", "cover.riskTypes", "multi", "Type de risque", "Risk type", {
  options: [
    opt("ANEMIA", "Anémie", "Anemia"),
    opt("HTA", "H.T.A", "Hypertension"),
    opt("DIABETES", "Diabète", "Diabetes"),
    opt("CARDIOPATHY", "Cardiopathie", "Heart disease"),
    opt("METRORRHAGIA", "Métrorragie", "Metrorrhagia"),
    opt("INFECTION", "Infection"),
    opt("PREECLAMPSIA", "Pré-éclampsie", "Pre-eclampsia"),
    opt("ECLAMPSIA", "Eclampsie", "Eclampsia"),
  ],
});
add("COVER", "cover.riskOther", "text", "Autre risque (à préciser)", "Other risk");

// ---------------------------------------------------------------- P2 identification & history
const S2: Section = "IDENTIFICATION_HISTORY";
add(S2, "id.age", "int", "Âge", "Age", { unit: "years", range: [12, 55], essential: true, dashboard: true });
add(S2, "id.education", "text", "Niveau d'instruction", "Education level", { essential: true });
add(S2, "id.occupation", "text", "Profession", "Occupation");
add(S2, "id.husbandOccupation", "text", "Profession du mari", "Husband's occupation");
add(S2, "id.consanguinity", "bool", "Consanguinité", "Consanguinity", { input: "checkbox", essential: true });
add(S2, "id.desiredPregnancy", "bool", "Grossesse désirée", "Desired pregnancy", { input: "checkbox", essential: true });
const FAMILY_ROWS = [
  ["hta", "HTA", "Hypertension"],
  ["diabetes", "Diabète", "Diabetes"],
  ["hereditary", "Maladies héréditaires", "Hereditary diseases"],
  ["malformations", "Malformations", "Malformations"],
  ["allergies", "Allergie(s)", "Allergies"],
] as const;
for (const [k, fr, en] of FAMILY_ROWS) {
  add(S2, `fam.${k}.wife`, "text", `${fr} — famille de la femme`, `${en} — woman's family`);
  add(S2, `fam.${k}.husband`, "text", `${fr} — mari/famille`, `${en} — husband's family`);
}
add(S2, "hist.medical", "text", "Antécédents médicaux", "Medical history", { essential: true });
add(S2, "hist.surgical", "text", "Antécédents chirurgicaux", "Surgical history", { essential: true });
add(S2, "hist.gyneco", "text", "Antécédents gynécologiques", "Gynecological history");
const ANOMALY_ROWS = [
  ["abortion", "Avortement", "Abortion"],
  ["preterm", "Accouchement prématuré", "Preterm delivery"],
  ["fetalDeath", "Mort fœtale in utéro", "Fetal death in utero"],
  ["other", "Autre anomalie", "Other anomaly"],
] as const;
for (const [k, fr, en] of ANOMALY_ROWS) {
  add(S2, `obs.${k}.count`, "int", `${fr} — nombre`, `${en} — count`, { range: [0, 15] });
  add(S2, `obs.${k}.date`, "date", `${fr} — date`, `${en} — date`);
  add(S2, `obs.${k}.place`, "text", `${fr} — lieu`, `${en} — place`);
  add(S2, `obs.${k}.ga`, "int", `${fr} — âge gestationnel (SA)`, `${en} — gestational age (weeks)`, { range: [4, 44] });
}
for (let n = 1; n <= 5; n++) {
  add(S2, `prev.${n}.date`, "date", `Accouchement ${n} — date`, `Delivery ${n} — date`);
  add(S2, `prev.${n}.mode`, "text", `Accouchement ${n} — modalité`, `Delivery ${n} — mode`);
  add(S2, `prev.${n}.csIndication`, "text", `Accouchement ${n} — indication césarienne`, `Delivery ${n} — cesarean indication`);
  add(S2, `prev.${n}.complication`, "text", `Accouchement ${n} — complication`, `Delivery ${n} — complication`);
  add(S2, `prev.${n}.weight`, "int", `Accouchement ${n} — poids nouveau-né`, `Delivery ${n} — newborn weight`, { unit: "g", range: [400, 6500] });
  add(S2, `prev.${n}.nbComplication`, "text", `Accouchement ${n} — complication nouveau-né`, `Delivery ${n} — newborn complication`);
}
add(S2, "id.gravidity", "int", "Gestation", "Gravidity", { range: [1, 20], essential: true, dashboard: true });
add(S2, "id.parity", "int", "Parité", "Parity", { range: [0, 20], essential: true, dashboard: true });
add(S2, "id.livingChildren", "int", "Nombre d'enfants vivants", "Living children", { range: [0, 20], essential: true });
add(S2, "id.tetanusDoses", "multi", "VAT (doses)", "Tetanus vaccine (doses)", {
  options: ["1", "2", "3", "4", "5"].map((v) => opt(v, v)),
});
add(S2, "id.rubellaVaccinated", "bool", "Vaccinée contre la rubéole", "Vaccinated against rubella", { input: "checkbox" });
add(S2, "id.rubellaDate", "date", "Date vaccin rubéole", "Rubella vaccine date");
add(S2, "id.hepBVaccinated", "bool", "Vaccinée contre l'hépatite B", "Vaccinated against hepatitis B", { input: "checkbox" });
add(S2, "id.hepBDate", "date", "Date vaccin hépatite B", "Hepatitis B vaccine date");
add(S2, "id.papSmear", "text", "Frottis cervical / IVA", "Pap smear / VIA");

// ---------------------------------------------------------------- P3 current pregnancy
const S3: Section = "CURRENT_PREGNANCY";
add(S3, "preg.lmp", "date", "DDR", "Last menstrual period", { essential: true });
add(S3, "preg.height", "number", "Taille", "Height", { unit: "cm", range: [120, 200] });
add(S3, "preg.bloodGroup", "choice", "Groupage", "Blood group", {
  options: ["A", "B", "O", "AB"].map((v) => opt(v, v)),
});
add(S3, "preg.rhesus", "choice", "Rhésus", "Rhesus", { options: [opt("NEG", "Rh-"), opt("POS", "Rh+")] });
add(S3, "preg.edd", "date", "Date prévue d'accouchement", "Expected delivery date", { essential: true });
add(S3, "preg.postTerm", "date", "Date de dépassement de terme", "Post-term date");

export interface VisitRow {
  row: string;
  type: FieldType;
  fr: string;
  en: string;
  unit?: string;
  range?: [number, number];
  essential?: boolean;
  dashboard?: boolean;
}
export const VISIT_ROWS: VisitRow[] = [
  { row: "appointment", type: "date", fr: "Rendez-vous", en: "Appointment" },
  { row: "visitDate", type: "date", fr: "Venue le", en: "Attended on", essential: true },
  { row: "followUp", type: "bool", fr: "Visite de relance", en: "Follow-up visit" },
  { row: "ga", type: "ga", fr: "Âge probable", en: "Gestational age", essential: true },
  { row: "weight", type: "number", fr: "Poids", en: "Weight", unit: "kg", range: [30, 160], essential: true },
  { row: "bp", type: "bp", fr: "TA", en: "Blood pressure", unit: "mmHg", essential: true, dashboard: true },
  { row: "skeletal", type: "text", fr: "Anomalies squelette", en: "Skeletal anomalies" },
  { row: "conjunctivae", type: "text", fr: "État des conjonctives", en: "Conjunctivae" },
  { row: "breasts", type: "text", fr: "Examen des seins", en: "Breast exam" },
  { row: "edema", type: "bool", fr: "Œdèmes", en: "Edema" },
  { row: "fetalMovements", type: "bool", fr: "Mouvements actifs", en: "Fetal movements" },
  { row: "fundalHeight", type: "number", fr: "HU", en: "Fundal height", unit: "cm", range: [5, 45] },
  { row: "fhr", type: "int", fr: "BCF", en: "Fetal heart rate", unit: "bpm", range: [60, 220] },
  { row: "speculum", type: "text", fr: "Examen au spéculum", en: "Speculum exam" },
  { row: "cervix", type: "text", fr: "TV : état du col", en: "Cervix" },
  { row: "presentation", type: "text", fr: "TV : présentation", en: "Presentation" },
  { row: "pelvis", type: "text", fr: "TV : bassin", en: "Pelvis" },
  { row: "glycosuria", type: "lab", fr: "Glucosurie", en: "Glycosuria" },
  { row: "albuminuria", type: "lab", fr: "Albuminurie", en: "Albuminuria" },
  { row: "rubella", type: "lab", fr: "Rubéole", en: "Rubella serology" },
  { row: "toxo", type: "lab", fr: "Toxoplasmose", en: "Toxoplasmosis" },
  { row: "syphilis", type: "lab", fr: "Syphilis (TPHA/VDRL)", en: "Syphilis", dashboard: true },
  { row: "hbsag", type: "lab", fr: "Ag HBs", en: "HBs antigen", dashboard: true },
  { row: "hiv", type: "lab", fr: "Sérologie VIH", en: "HIV serology", dashboard: true },
  { row: "hb", type: "number", fr: "Hémoglobine", en: "Hemoglobin", unit: "g/dL", range: [4, 20] },
  { row: "platelets", type: "int", fr: "Plaquettes", en: "Platelets", unit: "/mm3", range: [10000, 1000000] },
  { row: "glycemia", type: "number", fr: "Bilan glycémique", en: "Blood glucose", unit: "g/L", range: [0.3, 4] },
  { row: "rai", type: "lab", fr: "RAI", en: "Irregular antibodies (RAI)" },
  { row: "iron", type: "bool", fr: "Fer", en: "Iron" },
  { row: "examiner", type: "role", fr: "Examen fait par", en: "Examined by" },
];
for (const slot of VISIT_SLOTS) {
  for (const r of VISIT_ROWS) {
    const s = VISIT_SLOT_LABELS[slot];
    add(S3, `anc.${slot}.${r.row}`, r.type, `${r.fr} (${s.fr})`, `${r.en} (${s.en})`, {
      unit: r.unit,
      range: r.range,
      essential: r.essential,
      dashboard: r.dashboard,
      visitSlot: slot,
    });
  }
}

// ---------------------------------------------------------------- P4 delivery
const S4: Section = "DELIVERY";
add(S4, "del.placeSetting", "choice", "Lieu", "Place", {
  options: [opt("SUPERVISED", "En milieu surveillé", "Supervised facility"), opt("HOME", "A domicile", "At home")],
  essential: true,
});
add(S4, "del.placeType", "choice", "Type de lieu surveillé", "Supervised place type", {
  options: [
    opt("BIRTH_HOME", "Maison d'accouchement", "Birth home"),
    opt("MATERNITY", "Maternité", "Maternity"),
    opt("PRIVATE_CLINIC", "Clinique privée", "Private clinic"),
  ],
});
add(S4, "del.homeAssisted", "bool", "Assisté par un personnel qualifié", "Assisted by qualified staff", { input: "checkbox" });
add(S4, "del.date", "date", "Date de l'accouchement", "Delivery date", { essential: true });
add(S4, "del.mode", "choice", "Mode de l'accouchement", "Delivery mode", {
  options: [
    opt("VAGINAL", "Voie basse non instrumentale", "Vaginal, non-instrumental"),
    opt("VAGINAL_INSTRUMENTAL", "Voie basse instrumentale", "Vaginal, instrumental"),
    opt("CESAREAN_PLANNED", "Césarienne programmée", "Planned cesarean"),
    opt("CESAREAN_EMERGENCY", "Césarienne en urgence", "Emergency cesarean"),
  ],
  essential: true,
  dashboard: true,
});
add(S4, "del.instrument", "choice", "Instrument", "Instrument", {
  options: [opt("FORCEPS", "Forceps"), opt("VACUUM", "Ventouse", "Vacuum")],
});
add(S4, "del.episiotomy", "bool", "Avec épisiotomie", "With episiotomy", { input: "checkbox" });
add(S4, "del.csIndication", "text", "Indication de la césarienne", "Cesarean indication");
add(S4, "del.complicationsPresent", "bool", "Présence de complications", "Complications present", { input: "checkbox" });
add(S4, "del.complicationTiming", "multi", "Moment des complications", "Complication timing", {
  options: [opt("AT_DELIVERY", "Au moment de l'accouchement", "At delivery"), opt("POSTPARTUM", "Suites de couches", "Postpartum")],
});
add(S4, "del.complications", "multi", "Type de complications", "Complication types", {
  options: [
    opt("PREECLAMPSIA", "Pré-éclampsie", "Pre-eclampsia"),
    opt("ECLAMPSIA", "Eclampsie", "Eclampsia"),
    opt("HEMORRHAGE", "Hémorragie", "Hemorrhage"),
    opt("INFECTION", "Infection"),
    opt("OTHER", "Autres", "Other"),
  ],
});
add(S4, "del.complicationOther", "text", "Autre complication", "Other complication");
add(S4, "del.newbornStatus", "choice", "État du nouveau-né", "Newborn status", {
  options: [opt("ALIVE", "Vivant", "Alive"), opt("STILLBORN", "Mort-né", "Stillborn"), opt("DEATH_24H", "Décès < 24 heures", "Death < 24 h")],
  essential: true,
  dashboard: true,
});
add(S4, "del.sex", "choice", "Sexe", "Sex", { input: "written", options: [opt("F", "F"), opt("M", "M")], essential: true });
add(S4, "del.birthWeight", "int", "Poids à la naissance", "Birth weight", { unit: "g", range: [300, 6500], essential: true, dashboard: true });
add(S4, "del.headCirc", "number", "Périmètre crânien", "Head circumference", { unit: "cm", range: [20, 45] });
add(S4, "del.anomaly", "text", "Anomalie", "Anomaly");
add(S4, "del.gaAtBirth", "ga", "Âge gestationnel", "Gestational age at birth", { essential: true });

// ---------------------------------------------------------------- P5/P7 postpartum mother
for (const phase of ["early", "late"] as const) {
  const S: Section = phase === "early" ? "PP_EARLY_MOTHER" : "PP_LATE_MOTHER";
  const p = `ppm.${phase}`;
  add(S, `${p}.consultDate`, "date", "Date de la consultation", "Consultation date", { essential: true });
  add(S, `${p}.timing`, "choice", "Moment de la consultation", "Consultation timing", {
    options:
      phase === "early"
        ? [opt("IN_WINDOW", "Entre le 7e et 8e jour", "Day 7–8"), opt("AFTER_WINDOW", "Après le 8e jour", "After day 8")]
        : [opt("IN_WINDOW", "Entre le 40e et 50e jour", "Day 40–50"), opt("AFTER_WINDOW", "Après le 50e jour", "After day 50")],
  });
  add(S, `${p}.temp`, "number", "Température", "Temperature", { unit: "°C", range: [34, 42.5], essential: true, dashboard: true });
  add(S, `${p}.bp`, "bp", "TA", "Blood pressure", { unit: "mmHg", essential: true, dashboard: true });
  add(S, `${p}.pulse`, "int", "Pouls", "Pulse", { unit: "bpm", range: [35, 200] });
  add(S, `${p}.weight`, "number", "Poids", "Weight", { unit: "kg", range: [30, 160] });
  add(S, `${p}.conjunctivae`, "choice", "État des conjonctives", "Conjunctivae", {
    options: [opt("NORMAL", "Normales", "Normal"), opt("PALE", "Décolorées", "Pale")],
  });
  add(S, `${p}.uterineGlobe`, "bool", "Présence du globe utérin", "Uterine globe present", { input: "checkbox" });
  add(S, `${p}.lochia`, "multi", "État des lochies", "Lochia", {
    options: [
      opt("FADE", "Fade", "Odourless"),
      opt("FETID", "fétide", "Foul-smelling"),
      opt("CLEAR", "claires", "Clear"),
      opt("BLOODY", "sanglantes", "Bloody"),
      opt("YELLOWISH", "Jaunâtres", "Yellowish"),
    ],
  });
  add(S, `${p}.perineum`, "multi", "État du périnée", "Perineum", {
    options: [opt("NORMAL", "Normal"), opt("EPISIOTOMY", "Épisiotomie", "Episiotomy"), opt("TEAR", "Déchirure", "Tear"), opt("REPAIRED", "Réparée", "Repaired")],
  });
  add(S, `${p}.sphincters`, "choice", "État des sphincters", "Sphincters", {
    options: [opt("NORMAL", "Normal"), opt("ABNORMAL", "Anormal", "Abnormal")],
  });
  add(S, `${p}.cesarean`, "bool", "Césarienne", "Cesarean", { input: "checkbox" });
  add(S, `${p}.scar`, "text", "État de la cicatrice", "Scar condition");
  add(S, `${p}.breasts`, "choice", "État des seins", "Breasts", {
    options: [opt("NORMAL", "Normal"), opt("LYMPHANGITIS", "lymphangite", "Lymphangitis"), opt("MASTITIS", "mastite et abcès", "Mastitis/abscess")],
  });
  add(S, `${p}.calves`, "multi", "État des mollets", "Calves", {
    options: [opt("NORMAL", "Normal"), opt("RED", "Rouges", "Red"), opt("WARM", "Chauds", "Warm"), opt("PAINFUL", "Douloureux à la dorsiflexion", "Painful on dorsiflexion")],
  });
  add(S, `${p}.complicationsPresent`, "bool", "Présence de complication", "Complication present", { input: "checkbox" });
  add(S, `${p}.complications`, "multi", "Complications", "Complications", {
    options: [
      opt("HEMORRHAGE", "Hémorragie", "Hemorrhage"),
      opt("INFECTION", "Infection"),
      opt("ECLAMPSIA", "Eclampsie", "Eclampsia"),
      opt("PHLEBITIS", "Phlébite", "Phlebitis"),
      opt("BREAST", "Complications mammaires", "Breast complications"),
      opt("ANEMIA", "Anémie", "Anemia"),
      opt("OTHER", "Autres", "Other"),
    ],
  });
  add(S, `${p}.medication`, "bool", "Notion de prise de médicaments", "Taking medication", { input: "checkbox" });
  add(S, `${p}.medicationDetail`, "text", "Médicaments pris", "Medication taken");
  add(S, `${p}.treatment`, "multi", "Traitement prescrit", "Treatment prescribed", {
    options: [opt("IRON", "Fer", "Iron"), opt("VITAMIN_A", "Vitamine A", "Vitamin A")],
  });
  add(S, `${p}.treatmentOther`, "text", "Autre traitement", "Other treatment");
  add(S, `${p}.nextAppointment`, "date", "Prochain rendez-vous", "Next appointment");
  add(S, `${p}.fpDesired`, "bool", "Désire une méthode contraceptive", "Wants a contraceptive method", { input: "checkbox" });
  add(S, `${p}.fpMethod`, "choice", "Méthode", "Method", { options: [opt("PILL", "pilule", "Pill"), opt("IUD", "DIU", "IUD")] });
  add(S, `${p}.fpMethodOther`, "text", "Autre méthode", "Other method");
  add(S, `${p}.fpPrescribed`, "bool", "Prescription faite", "Prescription made", { input: "checkbox" });
  add(S, `${p}.fpReferred`, "bool", "Référée", "Referred", { input: "checkbox" });
  add(S, `${p}.fpReason`, "text", "Raison si pas de méthode", "Reason if no method");
}

// ---------------------------------------------------------------- P6/P8 postpartum newborn
for (const phase of ["early", "late"] as const) {
  const S: Section = phase === "early" ? "PP_EARLY_NEWBORN" : "PP_LATE_NEWBORN";
  const p = `ppn.${phase}`;
  add(S, `${p}.consultDate`, "date", "Date de la consultation", "Consultation date", { essential: true });
  add(S, `${p}.ageDays`, "int", "Âge", "Age", { unit: "days", range: [0, 120] });
  add(S, `${p}.temp`, "number", "Température", "Temperature", { unit: "°C", range: [33, 42.5], essential: true, dashboard: true });
  add(S, `${p}.weight`, "int", "Poids", "Weight", { unit: "g", range: [500, 9000], essential: true });
  add(S, `${p}.length`, "number", "Taille", "Length", { unit: "cm", range: [30, 75] });
  add(S, `${p}.headCirc`, "number", "Périmètre crânien", "Head circumference", { unit: "cm", range: [20, 50] });
  add(S, `${p}.premature`, "bool", "Nouveau-né prématuré", "Premature newborn", { input: "checkbox" });
  add(S, `${p}.hypotrophic`, "bool", "Nouveau-né hypotrophe", "Small for gestational age", { input: "checkbox" });
  add(S, `${p}.feeding`, "choice", "Allaitement", "Feeding", {
    options: [opt("EXCLUSIVE", "exclusivement au sein", "Exclusive breastfeeding"), opt("ARTIFICIAL", "Artificiel", "Formula"), opt("MIXED", "mixte", "Mixed")],
    essential: true,
  });
  add(S, `${p}.dangerSigns`, "multi", "Signes d'une affection grave", "Danger signs", {
    options: [
      opt("CONVULSIONS", "Convulsions"),
      opt("NOT_FEEDING", "Refus de téter", "Not feeding"),
      opt("HEMATEMESIS", "Hématémèses", "Hematemesis"),
      opt("MELENA", "Mélaenas", "Melena"),
      opt("DIARRHEA", "Diarrhée", "Diarrhea"),
      opt("JAUNDICE", "Ictère", "Jaundice"),
      opt("CHEST_INDRAWING", "Tirage sous costal", "Chest indrawing"),
      opt("COUGH", "Toux", "Cough"),
      opt("ABNORMAL_BREATHING", "Rythme respiratoire anormal", "Abnormal breathing"),
      opt("FEVER", "Fièvre", "Fever"),
      opt("HYPOTHERMIA", "Hypothermie", "Hypothermia"),
    ],
  });
  add(S, `${p}.dangerOther`, "text", "Autre signe", "Other sign");
  add(S, `${p}.trauma`, "multi", "Contusions, lésions, malformations", "Trauma / malformations", {
    options: [
      opt("CEPHALHEMATOMA", "Bosse sérosanguine ou céphalohématome", "Cephalhematoma"),
      opt("HIP_DISLOCATION", "Luxation congénitale de la hanche", "Congenital hip dislocation"),
      opt("LIMB_MOBILITY", "Diminution de la mobilité d'un membre", "Reduced limb mobility"),
    ],
  });
  add(S, `${p}.traumaOther`, "text", "Autre lésion", "Other lesion");
  add(S, `${p}.bfEval`, "choice", "Évaluation de l'allaitement", "Breastfeeding assessment", {
    options: [opt("NORMAL", "Normal"), opt("PROBLEMS", "A problèmes", "Problems")],
  });
  add(S, `${p}.vaccines`, "multi", "Vaccins administrés ce jour", "Vaccines given today", { options: [opt("BCG", "BCG"), opt("HB", "HB")] });
  add(S, `${p}.vitaminD`, "bool", "Supplémentation en vitamine D", "Vitamin D supplement", { input: "checkbox" });
  add(S, `${p}.complications`, "multi", "Complications et malformations", "Complications and malformations", {
    options: [
      opt("JAUNDICE", "Ictère", "Jaundice"),
      opt("INFECTION", "Infection"),
      opt("CONJUNCTIVITIS", "Conjonctivite", "Conjunctivitis"),
      opt("TRAUMA", "Traumatisme", "Trauma"),
      opt("MALFORMATION", "Malformation"),
      opt("OTHER", "Autres", "Other"),
    ],
  });
  add(S, `${p}.seenBy`, "role", "Vu par", "Seen by");
  add(S, `${p}.decision`, "text", "Décision prise", "Decision");
  add(S, `${p}.treatment`, "text", "Traitement prescrit", "Treatment prescribed");
  add(S, `${p}.transfer`, "bool", "Transfert", "Transfer", { input: "checkbox" });
  add(S, `${p}.referralFacility`, "text", "Établissement de référence", "Referral facility");
  add(S, `${p}.nextVisit`, "date", "Prochaine visite", "Next visit");
}

void BOOL_OPTS;

export const FIELDS: readonly FieldDef[] = fields;
export const FIELD_BY_KEY: ReadonlyMap<string, FieldDef> = new Map(fields.map((f) => [f.key, f]));
export const fieldsOf = (section: Section) => fields.filter((f) => f.section === section);

export function fieldLabel(key: string, lang: "fr" | "en"): string {
  const f = FIELD_BY_KEY.get(key);
  return f ? f[lang] : key;
}
