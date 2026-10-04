// The internal message format. Each channel adapter (Vonage, Meta, Twilio, Telegram)
// translates its webhooks into InboundMessage and OutboundMessage into buttons, lists
// or numbered choices.

import type { RecordState } from "./lifecycle.ts";

export interface Button {
  id: string;
  title: string;
}

export interface InboundMessage {
  /** Generated on the device when the message is created; makes retries idempotent. */
  id: string;
  midwifeId: string;
  kind: "image" | "text" | "button";
  text?: string;
  buttonId?: string;
  image?: { data: string; mime: string };
  /** Device clock at capture time (messages can arrive hours later). */
  capturedAt: string;
}

export interface OutboundMessage {
  id: string;
  midwifeId: string;
  text: string;
  buttons?: Button[];
  createdAt: string;
  refs?: { docId?: string; captureId?: string };
  /**
   * Set when the midwife may type a value instead of choosing. On numbered channels a number
   * typed for a numeric field is the value, so that message's choices are lettered (A, B, …).
   */
  answer?: "number" | "text";
}

/** Server-side lifecycle of each photo, mirrored on the device queue. */
export interface CaptureStatus {
  captureId: string;
  docId: string;
  pageNo: number;
  pageState: RecordState;
  docState: RecordState;
}

export interface PollResponse {
  messages: OutboundMessage[];
  captures: CaptureStatus[];
  lastSeq: number;
}

export interface DocumentReport {
  documentId: string;
  createdAt: string;
  pageCount: number;
  pages: {
    number: number;
    section: string;
    state: string;
    issues: string[];
  }[];
  fields: {
    label: string;
    value: string;
    status: string;
    confidence: number;
    reasons: string[];
    pageNo: number | null;
  }[];
}
