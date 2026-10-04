// The one place that defines how a record moves through its lifecycle.
// Both the device (simulated phone) and the server import this module, and
// every transition is checked here and logged by the caller.

export const RECORD_STATES = [
  "CAPTURED", // photo taken, stored encrypted on the device
  "PENDING_AI", // waiting in the device queue for connectivity / AI processing
  "AI_PROCESSED", // the server extracted structured fields
  "NEEDS_REVIEW", // waiting for the midwife to confirm / fix uncertain fields
  "VALIDATED", // midwife confirmed every page
  "PATIENT_MATCHED", // linked to an existing or new patient profile
  "REGISTERED", // merged into the patient's record
  "SYNCED", // device received the confirmation and dropped its local copy
  // failure states
  "PROCESSING_FAILED",
  "SYNC_FAILED",
  "DUPLICATE_SUSPECTED",
  "MANUAL_REVIEW_REQUIRED",
] as const;
export type RecordState = (typeof RECORD_STATES)[number];

export const STATE_LABELS: Record<RecordState, { fr: string; en: string }> = {
  CAPTURED: { fr: "CAPTURÉ", en: "CAPTURED" },
  PENDING_AI: { fr: "EN_ATTENTE_IA", en: "PENDING_AI" },
  AI_PROCESSED: { fr: "TRAITÉ_IA", en: "AI_PROCESSED" },
  NEEDS_REVIEW: { fr: "À_RÉVISER", en: "NEEDS_REVIEW" },
  VALIDATED: { fr: "VALIDÉ", en: "VALIDATED" },
  PATIENT_MATCHED: { fr: "PATIENTE_LIÉE", en: "PATIENT_MATCHED" },
  REGISTERED: { fr: "ENREGISTRÉ", en: "REGISTERED" },
  SYNCED: { fr: "SYNCHRONISÉ", en: "SYNCED" },
  PROCESSING_FAILED: { fr: "ÉCHEC_TRAITEMENT", en: "PROCESSING_FAILED" },
  SYNC_FAILED: { fr: "ÉCHEC_SYNCHRO", en: "SYNC_FAILED" },
  DUPLICATE_SUSPECTED: { fr: "DOUBLON_SUSPECTÉ", en: "DUPLICATE_SUSPECTED" },
  MANUAL_REVIEW_REQUIRED: { fr: "RÉVISION_MANUELLE", en: "MANUAL_REVIEW_REQUIRED" },
};

const T: Record<RecordState, RecordState[]> = {
  CAPTURED: ["PENDING_AI"],
  PENDING_AI: ["AI_PROCESSED", "PROCESSING_FAILED", "SYNC_FAILED", "DUPLICATE_SUSPECTED"],
  SYNC_FAILED: ["PENDING_AI"],
  PROCESSING_FAILED: ["PENDING_AI", "MANUAL_REVIEW_REQUIRED"],
  DUPLICATE_SUSPECTED: ["PENDING_AI", "AI_PROCESSED", "MANUAL_REVIEW_REQUIRED"],
  AI_PROCESSED: ["NEEDS_REVIEW", "PENDING_AI"],
  NEEDS_REVIEW: ["VALIDATED", "PENDING_AI", "MANUAL_REVIEW_REQUIRED"],
  MANUAL_REVIEW_REQUIRED: ["NEEDS_REVIEW", "VALIDATED", "PATIENT_MATCHED", "PENDING_AI"],
  VALIDATED: ["PATIENT_MATCHED", "MANUAL_REVIEW_REQUIRED", "NEEDS_REVIEW"],
  PATIENT_MATCHED: ["REGISTERED"],
  REGISTERED: ["SYNCED"],
  SYNCED: [],
};

export const FAILURE_STATES: ReadonlySet<RecordState> = new Set([
  "PROCESSING_FAILED",
  "SYNC_FAILED",
  "DUPLICATE_SUSPECTED",
  "MANUAL_REVIEW_REQUIRED",
]);

export function canTransition(from: RecordState, to: RecordState): boolean {
  return T[from].includes(to);
}

export class TransitionError extends Error {
  constructor(public from: RecordState, public to: RecordState, subject: string) {
    super(`Illegal transition ${from} -> ${to} for ${subject}`);
  }
}

export interface TransitionLogEntry {
  subject: string;
  from: RecordState | null;
  to: RecordState;
  at: string;
  reason: string;
}

/** Validate a transition and return the log entry the caller must persist. */
export function transition(subject: string, from: RecordState | null, to: RecordState, reason: string, at = new Date()): TransitionLogEntry {
  if (from !== null && from !== to && !canTransition(from, to)) throw new TransitionError(from, to, subject);
  return { subject, from, to, at: at.toISOString(), reason };
}
