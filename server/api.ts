import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FIELD_BY_KEY, SECTION_LABELS } from "../shared/catalog.ts";
import type { CaptureStatus, OutboundMessage, PollResponse } from "../shared/messages.ts";
import type { Bp } from "../shared/normalize.ts";
import { formatValue } from "../shared/normalize.ts";
import { Agent, linkDocument, registerDocument } from "./agent.ts";
import { config } from "./config.ts";
import { now, setState, type Db } from "./db.ts";
import { readImage } from "./images.ts";
import { descriptor, documentValues, patientValues } from "./records.ts";

const SAMPLES_DIR = "dayone-participants/data/Paper Registry";
const CSV = "dayone-participants/data/maternal_registry_synthetic.csv";

const Inbound = z.object({
  id: z.string().min(8).max(80),
  midwifeId: z.string().min(1).max(40),
  kind: z.enum(["image", "text", "button"]),
  text: z.string().max(2000).optional(),
  buttonId: z.string().max(200).optional(),
  image: z.object({ data: z.string(), mime: z.enum(["image/jpeg", "image/png", "image/webp"]) }).optional(),
  capturedAt: z.string(),
});

type Role = "supervisor" | "analyst";
function role(req: Request): Role | null {
  const token = req.header("x-role-token");
  if (token === config.roles.supervisor) return "supervisor";
  if (token === config.roles.analyst) return "analyst";
  return null;
}
const requireRole = (...allowed: Role[]) => (req: Request, res: Response, next: NextFunction) => {
  const r = role(req);
  if (!r || !allowed.includes(r)) return res.status(403).json({ error: "forbidden" });
  res.locals.role = r;
  next();
};

export function createApi(db: Db, agent: Agent, kick: () => void) {
  const app = express();
  app.use(express.json({ limit: "25mb" }));

  app.get("/api/health", (_req, res) => {
    const model = config.extractor === "claude"
      ? config.model
      : config.extractor === "template"
        ? `PaddleOCR PP-OCRv6_${process.env.OCR_MODEL_SIZE ?? "medium"} + form templates`
        : "mock-ground-truth";
    res.json({ ok: true, extractor: config.extractor, model, effort: config.effort, aiFallback: config.extractor === "template" ? config.aiFallback : "none" });
  });

  // ---------------------------------------------------------------- simulated phone
  app.post("/api/sim/messages", (req, res) => {
    const parsed = Inbound.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
    const fresh = agent.handle(parsed.data);
    kick();
    res.json({ accepted: true, duplicate: !fresh });
  });

  app.get("/api/sim/:mid/poll", (req, res) => {
    const mid = String(req.params.mid);
    const since = Number(req.query.since ?? 0);
    const rows = db.prepare("SELECT seq, payload FROM outbound WHERE midwife_id = ? AND seq > ? ORDER BY seq LIMIT 200").all(mid, since) as { seq: number; payload: string }[];
    const captures = db
      .prepare(
        `SELECT p.capture_id, p.doc_id, p.page_no, p.state AS page_state, d.state AS doc_state FROM pages p JOIN documents d ON d.id = p.doc_id
         WHERE p.midwife_id = ? ORDER BY p.received_at DESC LIMIT 100`,
      )
      .all(mid) as { capture_id: string; doc_id: string; page_no: number; page_state: string; doc_state: string }[];
    const body: PollResponse = {
      messages: rows.map((r) => JSON.parse(r.payload) as OutboundMessage),
      captures: captures.map(
        (c): CaptureStatus => ({ captureId: c.capture_id, docId: c.doc_id, pageNo: c.page_no, pageState: c.page_state as CaptureStatus["pageState"], docState: c.doc_state as CaptureStatus["docState"] }),
      ),
      lastSeq: rows.length ? rows[rows.length - 1].seq : since,
    };
    res.json(body);
  });

  app.get("/api/sim/:mid/documents/:id/report", (req, res) => {
    const mid = String(req.params.mid);
    const docId = String(req.params.id);
    const doc = db.prepare("SELECT midwife_id, state, opened_at FROM documents WHERE id = ?").get(docId) as
      | { midwife_id: string; state: string; opened_at: string }
      | undefined;
    if (!doc || doc.midwife_id !== mid) return res.status(404).json({ error: "unknown document" });
    if (doc.state !== "REGISTERED" && doc.state !== "SYNCED") {
      return res.status(409).json({ error: "document is not registered yet" });
    }

    const lang = req.query.lang === "en" ? "en" : "fr";
    const pages = db.prepare(
      "SELECT capture_id, page_no, section, state, quality FROM pages WHERE doc_id = ? AND replaced_by IS NULL ORDER BY page_no",
    ).all(docId) as { capture_id: string; page_no: number; section: string | null; state: string; quality: string | null }[];
    const pagesByCapture = new Map(pages.map((page) => [page.capture_id, page]));
    const fields = [...documentValues(db, docId, false).values()].flatMap((field) => {
      const def = FIELD_BY_KEY.get(field.key);
      if (!def) return [];
      const page = field.sourceCaptureId ? pagesByCapture.get(field.sourceCaptureId) : undefined;
      return [{
        label: def[lang],
        value: field.value === null ? "" : formatValue(field.key, field.value, lang),
        status: field.status,
        confidence: field.confidence,
        reasons: field.reasons,
        pageNo: page?.page_no ?? null,
      }];
    });

    res.json({
      documentId: docId,
      createdAt: doc.opened_at,
      pageCount: pages.length,
      pages: pages.map((page) => {
        const section = page.section as keyof typeof SECTION_LABELS | null;
        const quality = page.quality ? JSON.parse(page.quality) as { issues?: string[] } : null;
        return {
          number: page.page_no,
          section: section ? SECTION_LABELS[section][lang] : (lang === "fr" ? "Page non classée" : "Unclassified page"),
          state: page.state,
          issues: (quality?.issues ?? []).map((issue) => ({
            blurry: lang === "fr" ? "Photo floue" : "Blurry photo",
            too_dark: lang === "fr" ? "Photo trop sombre" : "Photo too dark",
            too_bright: lang === "fr" ? "Photo surexposée" : "Photo overexposed",
          }[issue] ?? issue)),
        };
      }),
      fields,
    });
  });

  /** The device confirms it received the "registered" message and dropped its local copy. */
  app.post("/api/sim/:mid/ack", (req, res) => {
    const docId = String(req.body?.docId ?? "");
    const doc = db.prepare("SELECT state FROM documents WHERE id = ? AND midwife_id = ?").get(docId, String(req.params.mid)) as { state: string } | undefined;
    if (!doc) return res.status(404).json({ error: "unknown document" });
    if (doc.state === "REGISTERED") setState(db, "document", docId, "SYNCED", "device confirmed and removed its local copy");
    res.json({ ok: true });
  });

  app.get("/api/samples", (_req, res) => {
    const indexFile = "eval/ground_truth/index.json";
    const index = fs.existsSync(indexFile)
      ? (JSON.parse(fs.readFileSync(indexFile, "utf8")) as { images: { file: string; pdfPage: number | null; patient: number | null; duplicateOf: string | null; realPhoto: boolean }[] }).images
      : [];
    res.json(index);
  });
  app.get("/api/samples/:file", (req, res) => {
    const file = path.basename(String(req.params.file));
    const full = path.join(SAMPLES_DIR, file);
    if (!fs.existsSync(full)) return res.status(404).end();
    res.sendFile(path.resolve(full));
  });

  // ---------------------------------------------------------------- office console
  app.get("/api/office/whoami", (req, res) => res.json({ role: role(req) }));

  app.get("/api/office/overview", requireRole("supervisor", "analyst"), (_req, res) => {
    const docStates = db.prepare("SELECT state, COUNT(*) AS n FROM documents GROUP BY state").all();
    const pageStates = db.prepare("SELECT state, COUNT(*) AS n FROM pages WHERE replaced_by IS NULL GROUP BY state").all();
    const patients = (db.prepare("SELECT COUNT(*) AS n FROM patients").get() as { n: number }).n;
    const ai = db
      .prepare("SELECT COUNT(*) AS calls, SUM(cached) AS cached, SUM(1 - ok) AS failed, SUM(cost_usd) AS cost, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cacheRead FROM ai_calls")
      .get();
    res.json({ docStates, pageStates, patients, ai, extractor: config.extractor });
  });

  app.get("/api/office/patients", requireRole("supervisor"), (_req, res) => {
    const patients = db.prepare("SELECT id, code, created_at FROM patients ORDER BY created_at DESC").all() as { id: string; code: string | null; created_at: string }[];
    res.json(
      patients.map((p) => {
        const vals = patientValues(db, p.id);
        const all = [...vals.values()];
        return {
          ...p,
          descriptor: descriptor(vals, "fr"),
          fields: all.length,
          toReview: all.filter((f) => f.status === "NEEDS_REVIEW" || f.status === "ILLEGIBLE").length,
          documents: (db.prepare("SELECT COUNT(*) AS n FROM documents WHERE patient_id = ?").get(p.id) as { n: number }).n,
        };
      }),
    );
  });

  app.get("/api/office/patients/:id", requireRole("supervisor"), (req, res) => {
    const p = db.prepare("SELECT id, code, created_at FROM patients WHERE id = ?").get(String(req.params.id));
    if (!p) return res.status(404).end();
    const vals = [...patientValues(db, String(req.params.id)).values()];
    const documents = db.prepare("SELECT id, state, opened_at, midwife_id FROM documents WHERE patient_id = ? ORDER BY opened_at").all(String(req.params.id));
    const history = db.prepare("SELECT key, old_value, new_value, doc_id, at, by FROM field_history WHERE patient_id = ? ORDER BY id DESC LIMIT 200").all(String(req.params.id));
    db.prepare("INSERT INTO access_log (role, action, subject, at) VALUES (?, 'view_record', ?, ?)").run(res.locals.role, String(req.params.id), now());
    res.json({ patient: p, fields: vals, documents, history });
  });

  app.get("/api/office/documents", requireRole("supervisor"), (_req, res) => {
    const docs = db
      .prepare(
        `SELECT d.id, d.midwife_id, d.state, d.opened_at, d.closed_at, d.code, d.note, d.patient_id, p.code AS patient_code,
           (SELECT COUNT(*) FROM pages WHERE doc_id = d.id AND replaced_by IS NULL) AS pages
         FROM documents d LEFT JOIN patients p ON p.id = d.patient_id ORDER BY d.opened_at DESC LIMIT 200`,
      )
      .all();
    res.json(docs);
  });

  app.get("/api/office/documents/:id", requireRole("supervisor"), (req, res) => {
    const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(String(req.params.id));
    if (!doc) return res.status(404).end();
    const pages = (
      db.prepare("SELECT pages.capture_id, page_no, state, section, section_confidence, quality, fields, confirmed, replaced_by, duplicate_of, entry, captured_at, received_at, error, attempts, (SELECT model FROM ai_calls WHERE capture_id = pages.capture_id ORDER BY id DESC LIMIT 1) AS reader FROM pages WHERE doc_id = ? ORDER BY page_no, received_at").all(String(req.params.id)) as Record<string, unknown>[]
    ).map((p) => ({ ...p, fields: p.fields ? JSON.parse(String(p.fields)) : null, quality: p.quality ? JSON.parse(String(p.quality)) : null }) as Record<string, unknown>);
    const ids = [String(req.params.id), ...pages.map((p) => String(p.capture_id))];
    const transitions = db
      .prepare(`SELECT subject_type, subject_id, from_state, to_state, at, reason FROM transitions WHERE subject_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
      .all(...ids);
    res.json({ doc, pages, transitions });
  });

  /** Original photos: supervisor role only, every access logged. */
  app.get("/api/office/pages/:cid/image", requireRole("supervisor"), (req, res) => {
    const page = db.prepare("SELECT image_path, mime FROM pages WHERE capture_id = ?").get(String(req.params.cid)) as { image_path: string; mime: string } | undefined;
    if (!page) return res.status(404).end();
    db.prepare("INSERT INTO access_log (role, action, subject, at) VALUES (?, 'view_image', ?, ?)").run(res.locals.role, String(req.params.cid), now());
    res.type(page.mime).set("Cache-Control", "no-store").send(readImage(page.image_path));
  });

  /** Office resolves a match the midwife was unsure about. */
  app.post("/api/office/documents/:id/link", requireRole("supervisor"), (req, res) => {
    const doc = db.prepare("SELECT state, midwife_id FROM documents WHERE id = ?").get(String(req.params.id)) as { state: string; midwife_id: string } | undefined;
    if (!doc || doc.state !== "MANUAL_REVIEW_REQUIRED") return res.status(409).json({ error: "document is not waiting for a manual match" });
    const patientId = req.body?.patientId ? String(req.body.patientId) : null;
    if (patientId && !db.prepare("SELECT 1 FROM patients WHERE id = ?").get(patientId)) return res.status(404).json({ error: "unknown patient" });
    db.exec("BEGIN");
    try {
      const { diffs } = linkDocument(db, String(req.params.id), patientId, "office");
      const code = registerDocument(db, String(req.params.id), diffs, "office");
      agent.send(doc.midwife_id, `✅ Le bureau a rattaché votre registre${code ? ` (fiche ${code})` : ""}. / The office linked your registry.`, undefined, { docId: String(req.params.id) });
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    res.json({ ok: true });
  });

  app.get("/api/office/ai-calls", requireRole("supervisor", "analyst"), (_req, res) => {
    res.json(db.prepare("SELECT * FROM ai_calls ORDER BY id DESC LIMIT 200").all());
  });

  app.get("/api/office/candidates", requireRole("supervisor"), (_req, res) => {
    const patients = db.prepare("SELECT id, code FROM patients").all() as { id: string; code: string | null }[];
    res.json(patients.map((p) => ({ ...p, descriptor: descriptor(patientValues(db, p.id), "fr") })));
  });

  // ---------------------------------------------------------------- anonymized dashboard
  const csvStats = loadCsvStats();
  app.get("/api/office/dashboard", requireRole("supervisor", "analyst"), (_req, res) => {
    const rows = db.prepare("SELECT key, value, status FROM field_values").all() as { key: string; value: string | null; status: string }[];
    const bps: Bp[] = [];
    const temps: number[] = [];
    const labs: Record<string, Record<string, number>> = { hiv: {}, syphilis: {}, hbsag: {} };
    for (const r of rows) {
      if (r.value === null || !["KNOWN", "NEEDS_REVIEW"].includes(r.status)) continue;
      const v = JSON.parse(r.value);
      const m = r.key.match(/^anc\.\w+\.(\w+)$/);
      if (r.key.endsWith(".bp")) bps.push(v);
      else if (/^pp[mn]\.\w+\.temp$/.test(r.key)) temps.push(v);
      if (m && m[1] in labs) labs[m[1]][v] = (labs[m[1]][v] ?? 0) + 1;
    }
    res.json({ registry: { bps, temps, labs, patients: (db.prepare("SELECT COUNT(*) AS n FROM patients").get() as { n: number }).n }, csv: csvStats });
  });

  // ---------------------------------------------------------------- static web app (production)
  const dist = path.resolve("web/dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

  return app;
}

/** Aggregates from the organizers' synthetic CSV (200 rows), shown next to registry data. */
function loadCsvStats() {
  if (!fs.existsSync(CSV)) return null;
  const [header, ...lines] = fs.readFileSync(CSV, "utf8").trim().split("\n");
  const cols = header.match(/("[^"]*"|[^,]+)/g)!.map((c) => c.replace(/"/g, ""));
  const idx = (name: string) => cols.findIndex((c) => c.startsWith(name));
  const rows = lines.map((l) => l.split(","));
  const num = (r: string[], i: number) => (r[i] === "" || r[i] === undefined ? null : Number(r[i]));
  const sys = idx("mean systolic"), dia = idx("mean diastolic");
  const count = (name: string) => {
    const i = idx(name);
    const out = { positive: 0, negative: 0, missing: 0 };
    for (const r of rows) {
      const v = num(r, i);
      if (v === null) out.missing++;
      else if (v === 1) out.positive++;
      else out.negative++;
    }
    return out;
  };
  return {
    rows: rows.length,
    bps: rows.map((r) => ({ systolic: num(r, sys)!, diastolic: num(r, dia)! })).filter((b) => b.systolic !== null),
    hiv: count("hiv"),
    syphilis: count("syphilis"),
    hepatitisC: count("hepatitis c"),
  };
}
