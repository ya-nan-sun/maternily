import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { config } from "./config.ts";
import { transition, type RecordState } from "../shared/lifecycle.ts";

export type Db = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS midwives (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'fr', created_at TEXT NOT NULL
);
-- Every inbound message id is remembered so retries from the device are idempotent.
CREATE TABLE IF NOT EXISTS inbound (
  id TEXT PRIMARY KEY, midwife_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT, received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbound (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, midwife_id TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,               -- random UUID, never derived from personal data
  code TEXT UNIQUE,                  -- the code written on the paper registry (N° de fiche)
  created_at TEXT NOT NULL, created_by TEXT
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, midwife_id TEXT NOT NULL, state TEXT NOT NULL,
  opened_at TEXT NOT NULL, closed_at TEXT, last_activity_at TEXT NOT NULL,
  code TEXT, patient_id TEXT REFERENCES patients(id), note TEXT
);
-- One row per photo. Images live encrypted on disk; this is their metadata.
CREATE TABLE IF NOT EXISTS pages (
  capture_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id), midwife_id TEXT NOT NULL,
  page_no INTEGER NOT NULL, content_hash TEXT NOT NULL, mime TEXT NOT NULL, image_path TEXT NOT NULL,
  captured_at TEXT NOT NULL, received_at TEXT NOT NULL,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, error TEXT,
  section TEXT, section_confidence REAL, quality TEXT, fields TEXT, confirmed INTEGER NOT NULL DEFAULT 0,
  replaced_by TEXT, duplicate_of TEXT, entry TEXT NOT NULL DEFAULT 'ai'
);
CREATE INDEX IF NOT EXISTS pages_doc ON pages(doc_id);
CREATE INDEX IF NOT EXISTS pages_hash ON pages(content_hash);
CREATE TABLE IF NOT EXISTS field_values (
  patient_id TEXT NOT NULL REFERENCES patients(id), key TEXT NOT NULL,
  value TEXT, raw TEXT, status TEXT NOT NULL, confidence REAL NOT NULL, reasons TEXT NOT NULL,
  source_capture_id TEXT, confirmed_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (patient_id, key)
);
CREATE TABLE IF NOT EXISTS field_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL, key TEXT NOT NULL,
  old_value TEXT, new_value TEXT, doc_id TEXT, at TEXT NOT NULL, by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
  from_state TEXT, to_state TEXT NOT NULL, at TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transitions_subject ON transitions(subject_id);
CREATE TABLE IF NOT EXISTS conversations (midwife_id TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_cache (
  content_hash TEXT NOT NULL, prompt_version TEXT NOT NULL, model TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (content_hash, prompt_version, model)
);
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, capture_id TEXT, content_hash TEXT NOT NULL, model TEXT NOT NULL,
  cached INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  cost_usd REAL, latency_ms INTEGER, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, action TEXT NOT NULL, subject TEXT, at TEXT NOT NULL
);
`;

// WhatsApp: one row per outbound message handed to the Cloud API.
const WHATSAPP_SCHEMA = `
CREATE TABLE IF NOT EXISTS wa_deliveries (
  outbound_id TEXT PRIMARY KEY, wamid TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT, error TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wa_deliveries_wamid ON wa_deliveries(wamid);
-- Text-only channels (Twilio): the last choices offered, so a reply "2" maps back to a button.
CREATE TABLE IF NOT EXISTS channel_prompts (midwife_id TEXT PRIMARY KEY, buttons TEXT NOT NULL, at TEXT NOT NULL);
`;

/** Columns added after the first release; ignored when they already exist. */
const MIGRATIONS = [
  "ALTER TABLE midwives ADD COLUMN channel TEXT NOT NULL DEFAULT 'simulator'",
  "ALTER TABLE midwives ADD COLUMN phone TEXT",
];

export function openDb(file = path.join(config.dataDir, "maternily.db")): Db {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.exec(WHATSAPP_SCHEMA);
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch {
      /* already applied */
    }
  }
  return db;
}

export const now = () => new Date().toISOString();

/** Run fn inside a transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Move a document or page to a new lifecycle state; the state machine validates it and we log it. */
export function setState(db: Db, subjectType: "document" | "page", id: string, to: RecordState, reason: string) {
  const table = subjectType === "document" ? "documents" : "pages";
  const col = subjectType === "document" ? "id" : "capture_id";
  const row = db.prepare(`SELECT state FROM ${table} WHERE ${col} = ?`).get(id) as { state: RecordState } | undefined;
  const from = row?.state ?? null;
  if (from === to) return;
  const entry = transition(`${subjectType}:${id}`, from, to, reason);
  db.prepare(`UPDATE ${table} SET state = ? WHERE ${col} = ?`).run(to, id);
  db.prepare("INSERT INTO transitions (subject_type, subject_id, from_state, to_state, at, reason) VALUES (?, ?, ?, ?, ?, ?)").run(
    subjectType, id, from, to, entry.at, reason,
  );
}

export function logInitialState(db: Db, subjectType: "document" | "page", id: string, state: RecordState, reason: string) {
  db.prepare("INSERT INTO transitions (subject_type, subject_id, from_state, to_state, at, reason) VALUES (?, ?, ?, ?, ?, ?)").run(
    subjectType, id, null, state, now(), reason,
  );
}
