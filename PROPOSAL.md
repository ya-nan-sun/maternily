# PROPOSAL: decisions to approve before coding

Based on findings in `DATA_NOTES.md`. Each item ends with **Decide:** for the choice the team needs to make.

## Decisions taken (2026-10-03)

| Item | Decision |
|---|---|
| Stack | TypeScript end to end: Node + Express + built-in SQLite server, React + Vite phone and office, Zod, Anthropic SDK. One language lets the phone and server share the catalog, the parsers and the lifecycle module. |
| Schema (6.1) | Implemented as a **flat field catalog** ([shared/catalog.ts](shared/catalog.ts)): one entry per field with key, type, labels, unit, options and range, plus a Zod-validated `FieldValue`, instead of the nested Zod object below. Same fields; the generic form drives the prompt, review flow, ground truth and evaluation from one list. |
| `—` in visit cells | `NOT_APPLICABLE` |
| Split | dev = patients 1–5, test = patients 6–10 |
| Patient code (6.6) | Option 1, N° de fiche, for now; revisit later |
| Extra test sets | Degraded and Arabic sets later, once the app works |
| Real booklet photos | Kept out of git. Used for testing only on explicit opt-in (`--include-real-photos`). |

---

## 6.1 Field schema (Zod)

Principles:
- Every leaf is a `Field<T>` with `value`, `status`, `confidence`, `source` (image + section + bbox) and `raw` (the text as written).
- Direct identifiers are **absent from the schema**. The extractor is never asked for them, so they cannot be stored by accident.
- Patient and visit are separate. The `Patient` record holds only internal ID + code. Everything clinical hangs off pregnancy/visit records.

```ts
import { z } from "zod";

export const FieldStatus = z.enum([
  "KNOWN", "UNKNOWN", "NOT_PROVIDED", "ILLEGIBLE", "NOT_APPLICABLE", "NEEDS_REVIEW",
]);

const Source = z.object({
  imageId: z.string(),                 // capture ID, not filename
  section: z.string(),                 // PageSection below
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

const field = <T extends z.ZodTypeAny>(v: T) => z.object({
  value: v.nullable(),
  status: FieldStatus,
  confidence: z.number().min(0).max(1),
  raw: z.string().nullable(),           // as written: "11/7", "16SA+3j", "RAS", "—"
  source: Source.optional(),
  confirmedBy: z.enum(["AI", "MIDWIFE"]).default("AI"),
});

const Str = field(z.string());
const Int = field(z.number().int());
const Num = field(z.number());
const Bool = field(z.boolean());
const DateF = field(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));   // stored ISO, displayed DD/MM/YYYY
const Enum = <T extends [string, ...string[]]>(v: T) => field(z.enum(v));
const Multi = <T extends [string, ...string[]]>(v: T) => field(z.array(z.enum(v)));
const BP = field(z.object({ systolic: z.number(), diastolic: z.number() })); // mmHg always
const GA = field(z.object({ weeks: z.number().int(), days: z.number().int().min(0).max(6) }));
const LabResult = Enum(["NEGATIVE", "POSITIVE", "IMMUNE", "NOT_IMMUNE", "NOT_DONE"]);

export const PageSection = z.enum([
  "COVER", "IDENTIFICATION_HISTORY", "CURRENT_PREGNANCY", "DELIVERY",
  "PP_EARLY_MOTHER", "PP_EARLY_NEWBORN", "PP_LATE_MOTHER", "PP_LATE_NEWBORN", "UNKNOWN",
]);

// ---- P1 cover --------------------------------------------------------------
export const Cover = z.object({
  ficheNumber: Str,                     // candidate patient code (see 6.6)
  region: Str, province: Str, facilityName: Str,
  facilityType: Enum(["DR", "CSC", "CSU", "CSCA", "CSUA"]),
  coverageMode: Enum(["FIXE", "MOBILE"]),
  riskPregnancy: Bool,
  riskTypes: Multi(["ANEMIA", "HTA", "DIABETES", "CARDIOPATHY", "METRORRHAGIA",
                    "INFECTION", "PREECLAMPSIA", "ECLAMPSIA", "OTHER"]),
  riskOther: Str,
  // NOT EXTRACTED: woman's name
});

// ---- P2 identification & history ---------------------------------------------
const FamilyRow = z.object({ wifeFamily: Str, husbandFamily: Str });
const AnomalyRow = z.object({ count: Int, date: DateF, place: Str, gaWeeks: Int });
const PrevDelivery = z.object({
  date: DateF, mode: Str, cesareanIndication: Str, complication: Str,
  newbornWeightG: Int, newbornComplication: Str,
});
export const IdentificationHistory = z.object({
  ageYears: Int,
  educationRaw: Str,                    // "Lycée", "Collège"…
  educationLevel: Enum(["NONE_PRIMARY", "SECONDARY", "HIGHER"]), // CSV 0/1/2
  occupation: Str, husbandOccupation: Str,
  consanguinity: Bool, desiredPregnancy: Bool,
  familyHistory: z.object({
    hypertension: FamilyRow, diabetes: FamilyRow, hereditary: FamilyRow,
    malformations: FamilyRow, allergies: FamilyRow,
  }),
  personalHistory: z.object({ medical: Str, surgical: Str, gynecological: Str }),
  priorAnomalies: z.object({
    abortion: AnomalyRow, pretermDelivery: AnomalyRow, fetalDeath: AnomalyRow, other: AnomalyRow,
  }),
  previousDeliveries: z.array(PrevDelivery).max(5),
  gravidity: Int, parity: Int, livingChildren: Int,
  tetanusDoses: field(z.array(z.number().int().min(1).max(5))),
  rubellaVaccinated: Bool, rubellaDate: DateF,
  hepBVaccinated: Bool, hepBDate: DateF,
  papSmear: Str,
  // NOT EXTRACTED: CIN, address, phone, husband's name
});

// ---- P3 current pregnancy (longitudinal) --------------------------------------
export const VisitSlot = z.enum(["T1V1", "T1V2", "T1V3", "T2V1", "T2V2", "T2V3", "M7", "M8", "M9"]);
export const AntenatalVisit = z.object({
  slot: VisitSlot,
  appointmentDate: DateF, visitDate: DateF, followUpVisit: Bool, gestationalAge: GA,
  weightKg: Num, bp: BP, skeletalAnomalies: Str, conjunctivae: Str, breastExam: Str,
  edema: Bool, fetalMovements: Bool, fundalHeightCm: Num, fetalHeartRateBpm: Int,
  speculum: Str, cervix: Str, presentation: Str, pelvis: Str,
  glycosuria: LabResult, albuminuria: LabResult, rubella: LabResult, toxoplasmosis: LabResult,
  syphilis: LabResult, hbsAg: LabResult, hiv: LabResult,
  hemoglobinGdl: Num, plateletsPerMm3: Int, glycemiaGl: Num, rai: LabResult,
  iron: Bool, examinerRole: Enum(["DOCTOR", "MIDWIFE", "NURSE", "OTHER"]),
});
export const CurrentPregnancy = z.object({
  lmpDate: DateF, heightCm: Num,
  bloodGroup: Enum(["A", "B", "O", "AB"]), rhesus: Enum(["POS", "NEG"]),
  expectedDeliveryDate: DateF, postTermDate: DateF,
  visits: z.array(AntenatalVisit).max(9),
});

// ---- P4 delivery -----------------------------------------------------------------
export const Delivery = z.object({
  place: Enum(["BIRTH_HOME", "MATERNITY", "PRIVATE_CLINIC", "OTHER_FACILITY", "HOME_ASSISTED", "HOME_OTHER"]),
  date: DateF,
  mode: Enum(["VAGINAL_NON_INSTRUMENTAL", "VAGINAL_FORCEPS", "VAGINAL_VACUUM",
              "CESAREAN_PLANNED", "CESAREAN_EMERGENCY"]),
  episiotomy: Bool, cesareanIndication: Str,
  complicationTiming: Multi(["AT_DELIVERY", "POSTPARTUM"]),
  complications: Multi(["PREECLAMPSIA", "ECLAMPSIA", "HEMORRHAGE", "INFECTION", "OTHER"]),
  complicationOther: Str,
  newbornStatus: Enum(["ALIVE", "STILLBORN", "DEATH_UNDER_24H"]),
  newbornSex: Enum(["F", "M"]), birthWeightG: Int, headCircumferenceCm: Num,
  anomaly: Str, gaAtBirth: GA,
});

// ---- P5/P7 postpartum mother, P6/P8 postpartum newborn --------------------------------
export const PostpartumMother = z.object({
  phase: z.enum(["EARLY", "LATE"]),
  consultDate: DateF, timing: Enum(["IN_WINDOW", "AFTER_WINDOW"]),
  temperatureC: Num, bp: BP, pulseBpm: Int, weightKg: Num,
  conjunctivae: Enum(["NORMAL", "PALE"]), uterineGlobe: Bool,
  lochia: Multi(["FADE", "FETID", "CLEAR", "BLOODY", "YELLOWISH"]),
  perineum: Multi(["NORMAL", "EPISIOTOMY", "TEAR", "REPAIRED"]),
  sphincters: Enum(["NORMAL", "ABNORMAL"]), cesareanScar: Str,
  breasts: Enum(["NORMAL", "LYMPHANGITIS", "MASTITIS_ABSCESS"]),
  calves: Multi(["NORMAL", "RED", "WARM", "PAINFUL_DORSIFLEXION"]),
  complications: Multi(["HEMORRHAGE", "INFECTION", "ECLAMPSIA", "PHLEBITIS",
                        "BREAST", "ANEMIA", "OTHER"]),
  medication: Str,
  treatment: Multi(["IRON", "VITAMIN_A", "OTHER"]), treatmentOther: Str,
  nextAppointment: DateF,
  fpDesired: Bool, fpMethod: Enum(["PILL", "IUD", "OTHER"]), fpMethodOther: Str,
  fpPrescribed: Bool, fpReferred: Bool, fpNoMethodReason: Str,
});
export const PostpartumNewborn = z.object({
  phase: z.enum(["EARLY", "LATE"]),
  consultDate: DateF, ageDays: Int, temperatureC: Num, weightG: Int, lengthCm: Num,
  headCircumferenceCm: Num, premature: Bool, hypotrophic: Bool,
  feeding: Enum(["EXCLUSIVE_BREAST", "ARTIFICIAL", "MIXED"]),
  dangerSigns: Multi(["CONVULSIONS", "NOT_FEEDING", "HEMATEMESIS", "MELENA", "DIARRHEA",
                      "JAUNDICE", "CHEST_INDRAWING", "COUGH", "ABNORMAL_BREATHING",
                      "FEVER", "HYPOTHERMIA"]),
  dangerSignsOther: Str,
  trauma: Multi(["CEPHALHEMATOMA", "HIP_DISLOCATION", "REDUCED_LIMB_MOBILITY"]), traumaOther: Str,
  breastfeedingEval: Enum(["NORMAL", "PROBLEMS"]),
  vaccinesToday: Multi(["BCG", "HB"]), vitaminD: Bool,
  complications: Multi(["JAUNDICE", "INFECTION", "CONJUNCTIVITIS", "TRAUMA", "MALFORMATION", "OTHER"]),
  seenByRole: Enum(["DOCTOR", "MIDWIFE", "NURSE", "OTHER"]),
  decision: Str, treatment: Str, transferred: Bool, referralFacility: Str,
  nextVisitDate: DateF,
});

// ---- Records ---------------------------------------------------------------------
export const Patient = z.object({
  id: z.string().uuid(),               // random, never derived from PII
  code: z.string().nullable(),         // midwife-written code (6.6)
  createdAt: z.string(),
});
export const PregnancyRecord = z.object({
  id: z.string().uuid(), patientId: z.string().uuid().nullable(),
  cover: Cover.partial(), identification: IdentificationHistory.partial(),
  currentPregnancy: CurrentPregnancy.partial(), delivery: Delivery.partial(),
  postpartumMother: z.array(PostpartumMother.partial()).max(2),
  postpartumNewborn: z.array(PostpartumNewborn.partial()).max(2),
});
```

Notes:
- **Examiner / "vu par".** The value is a staff name, so we store only the role (Dr/Sage-femme/Inf.).
  Staff names are not patient identifiers, but storing them adds nothing.
- **Free-text fields.** Personal history, decision and treatment can hold names in theory. The redaction
  pass (6.7) runs on all `Str` fields.

**Decide:** TypeScript + Zod as the stack (the checklist assumed it), or Python + Pydantic? The schema above
ports 1:1.

---

## 6.2 Mapping source encodings to statuses

| Written on page / model output | value | status |
|---|---|---|
| Legible value | parsed | `KNOWN` |
| `RAS`, `Néant`, `Aucun(e)`, `Normal(e)(s)` | normalized "none"/"normal" | `KNOWN` |
| `Non fait`, `NF` | `NOT_DONE` (lab) or raw | `KNOWN` |
| Empty cell / empty line | null | `NOT_PROVIDED` |
| `—`, `/`, a diagonal stroke through empty cells (real JPGs) | null | `NOT_APPLICABLE` (raw kept) |
| Midwife wrote `?`, `inconnu`, `ne sait pas`, or answers "unknown" in chat | null | `UNKNOWN` |
| Something is written but cannot be read | null + best guess in `raw` | `ILLEGIBLE` |
| Model read it with confidence < threshold, or a plausibility rule fails | best guess | `NEEDS_REVIEW` |
| One diagonal `RAS` spanning several rows (1-2, 1-3) | each covered cell = RAS | `KNOWN`, but `NEEDS_REVIEW` the first time |

**Rules:**
- **Confidence comes from more than the model.** Combine the model's self-report with deterministic signals:
  - format/regex validity
  - range checks (CSV ranges, e.g. birth weight 2000–5000 g)
  - cross-field rules: gravidity ≥ parity + abortions; living children ≤ parity; GA consistent with LMP and visit date; preterm flag consistent with GA.

  A failing check caps confidence at 0.5, which gives `NEEDS_REVIEW`.
- **Confidence threshold for a follow-up question:** start at 0.8 and tune it on the dev set so that most actual errors land in `NEEDS_REVIEW`.
- **Field status vs record state.** `NEEDS_REVIEW` as a field status is separate from the record state `NEEDS_REVIEW`. The record enters that state when ≥1 field has status `NEEDS_REVIEW` or `ILLEGIBLE`.

**Decide:** is `—` `NOT_APPLICABLE`? The alternative is `KNOWN` with a "not done" value. I recommend
`NOT_APPLICABLE` because all 129 dashes are in visit cells that do not apply yet, such as fetal movements at 12 SA.

---

## 6.3 Normalization for comparison (eval) and storage

| Kind | Rule |
|---|---|
| Text | NFKD, strip accents, lowercase, collapse whitespace, drop `\x00` and the gaps caused by missing glyphs. Compare `"coll ge"` ≈ `"college"` with a character similarity ≥ 0.85, or exact match after the rules above |
| Digits | Eastern Arabic `٠–٩` and Persian `۰–۹` → `0–9` |
| Decimals | `,` → `.` |
| Dates | Accept `D/M/YY`, `DD/MM/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`. A 2-digit year maps to 20YY. Store ISO; display `DD/MM/YYYY` |
| GA | `NN SA`, `NNSA+Nj`, `NN SA N j` → `{weeks, days}`. "Age probable" is compared on weeks only |
| BP | `S/D`. **If S < 30, treat as cmHg and ×10** (`11/7` → 110/70). Raw is kept. The conversion sets `NEEDS_REVIEW` once per record, so the midwife confirms |
| Units | Strip and convert to the schema unit: `kg`, `g`, `cm`, `°C`, `g/dL`, `g/L`. `186k` → 186000. `233000/mm3` → 233000 |
| Booleans | Checked box, `Oui`, `+`, `positif` → true. `Non`, `–` (as a result), `nég`, `Neg` → false/NEGATIVE |
| Sex | `F`/`M`/`fille`/`garçon` → `F`/`M` |

**Eval metric:**
- **Accuracy:** exact match after normalization, per field, reported by section, by font and by data type.
- **Checkboxes:** scored separately; the ground truth for them is perfect.
- **Status accuracy:** checked separately. Did we predict `NOT_PROVIDED` where the page is blank, and `NOT_APPLICABLE` where it shows `—`?
- **Calibration:** reliability buckets of confidence vs correctness. This feeds the 20-point uncertainty criterion.

---

## 6.4 Classifying a photo into a section

1. Ask the vision model to return `sections: PageSection[]`, the title text it read, and a confidence.
   One photo can show **two facing pages** (as in 1-4 and 1-5), or only part of a section.
2. Deterministic check: fuzzy-match the read title against the 8 known printed titles.
   The real booklet's titles ("IDENTIFICATION", "GROSSESSE ACTUELLE", "ANTÉCÉDENTS OBSTÉTRICAUX") are close enough.
3. If they disagree or confidence is below 0.7, the agent asks the midwife: "This looks like *Grossesse actuelle*, is that right?" Quick replies: [Yes] [Other page…].
4. Extraction then runs with a **section-specific prompt and sub-schema**, not the whole schema. This means
   smaller prompts and better accuracy.

---

## 6.5 Dev / test split

There are only 10 patients and 5 fonts, each used by 2 patients.

**Proposal:**
- **Dev:** patients 1–5 (PDF pages 1–40). One patient per font.
- **Test:** patients 6–10 (pages 41–80). Every font appears again, with a different ink and checkbox style.
- The split is deterministic, so no seed is needed. It goes in `eval/split.json`.

Each unique page is counted once, and the duplicate `__<driveid>` files are excluded.

**Supplements:**
- **`test_degraded`:** the test PNGs run through fixed-seed degradations (seed 42): blur, perspective skew, shadow gradient, low light, JPEG compression, partial crop. The brief promises degraded photos, but the provided PNGs are clean. The field values survive the transforms, so the ground truth stays valid.
- **`real_photos`:** 1-1 … 1-5. There is no ground truth. We could hand-label them, **but only if they are confirmed synthetic** (see the open question below). For now they are qualitative only.
- **Arabic:** nothing to test with. Option: render a few extra pages with an Arabic handwriting font and Eastern Arabic digits, reusing the generator approach the organizers used. That gives us an Arabic test set for the bonus.

**Decide:** is a 5/5 split OK? Do we generate the degraded set and/or the Arabic set?

---

## 6.6 Patient code (affects linking)

The template has no patient-code box.

**Options:**
1. **(Recommended) Use `N° de la fiche` (P1).**
   - It is already on the booklet: zero workflow change, which the brief makes non-negotiable.
   - It is unique per record and is not personal information.
   - Store it as the `code`.
   - Pages photographed without the cover inherit the code from the multi-page session.
2. Have the midwife write a short random code (e.g. 6 characters, no 0/O/1/I) on each page's corner. This is more robust but changes the workflow.

**Fallback when the code is missing or misread:** candidate matching on non-identifying fields:
- age ±1
- province/region
- gravidity / parity / living children
- LMP and expected delivery date ±7 days
- facility

The agent then shows [Patient 1] [Patient 2] [None, create new] [I'm not sure] and never merges on its own.

**Decide:** option 1 or 2?

---

## 6.7 Design rules confirmed or adjusted by the data

These add to the checklist's §7 rules and do not replace them.

- **Redaction targets, with their known positions:**
  - P1: name.
  - P2: CIN, address, phone, husband's name (top box).
  - P4: name line.
  - **P5/P7: the printed "MÈRE — name" header.**

  Two layers:
  - *Schema* (identifiers are never requested).
  - *Image*: before an image is stored or sent to the model, the server black-boxes these regions in the
    stored copy. Locating them on synthetic pages uses the template positions; on real photos it uses the
    model's bounding boxes. The original stays in restricted storage.
- **Dedup by content hash (sha256)** at capture, in addition to capture IDs. The dataset itself has
  44 byte-identical duplicates, which shows this happens. For near-duplicates (retakes), use a perceptual hash
  → `DUPLICATE_SUSPECTED` and ask the midwife.
- **Never use the "Patiente fictive n°X/10" stamp or the filename** for linking or section detection.
  They do not exist in the field. The pipeline must work from the image alone.
- **The extractor must handle three checkbox mark styles plus circling:** X, tick, scribble, and circled printed options (real booklet).
- **CSV:** load it into a separate `seed` collection. It populates the dashboard and gives demo patients to match against. It is never used as extraction ground truth.

---

## Open question to resolve before sending anything to an AI API

⚠️ **`1-1.jpg` … `1-5.jpg` look like photos of a real, used Ministry of Health booklet.** The name is covered
with paper, but an ID-like number, an address, an age and clinical values are visible in handwriting.

The brief says the data is synthetic and forbids sending real patient data to third-party services. Until the
organizers or the team confirm these are synthetic or staged:
- treat them as real;
- do not send them to an external API;
- do not commit them to git;
- do not use them in the demo.
