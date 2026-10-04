import { z } from "zod";

export const FIELD_STATUSES = ["KNOWN", "UNKNOWN", "NOT_PROVIDED", "ILLEGIBLE", "NOT_APPLICABLE", "NEEDS_REVIEW"] as const;
export const FieldStatus = z.enum(FIELD_STATUSES);
export type FieldStatus = z.infer<typeof FieldStatus>;

export const FIELD_STATUS_LABELS: Record<FieldStatus, { fr: string; en: string }> = {
  KNOWN: { fr: "CONNU", en: "KNOWN" },
  UNKNOWN: { fr: "INCONNU", en: "UNKNOWN" },
  NOT_PROVIDED: { fr: "NON_FOURNI", en: "NOT_PROVIDED" },
  ILLEGIBLE: { fr: "ILLISIBLE", en: "ILLEGIBLE" },
  NOT_APPLICABLE: { fr: "NON_APPLICABLE", en: "NOT_APPLICABLE" },
  NEEDS_REVIEW: { fr: "À_RÉVISER", en: "NEEDS_REVIEW" },
};

/** One stored field. `value` is the parsed, normalized value; `raw` is what was written. */
export const FieldValue = z.object({
  key: z.string(),
  value: z.unknown().nullable(),
  raw: z.string().nullable(),
  status: FieldStatus,
  confidence: z.number().min(0).max(1),
  /** Why the agent is unsure, shown to the midwife. */
  reasons: z.array(z.string()).default([]),
  sourceCaptureId: z.string().nullable(),
  confirmedBy: z.enum(["AI", "MIDWIFE", "OFFICE"]),
});
export type FieldValue = z.infer<typeof FieldValue>;

/** Statuses that the midwife has to look at before a record can be validated. */
export const needsAttention = (s: FieldStatus) => s === "NEEDS_REVIEW" || s === "ILLEGIBLE";
