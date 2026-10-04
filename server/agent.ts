// The conversational agent. It is deterministic: the AI is only used to read
// photos (pipeline.ts). Every message here is a bounded, button-driven step,
// which keeps costs predictable and the flow identical on WhatsApp.

import { createHash, randomUUID } from "node:crypto";
import {
  FIELD_BY_KEY, SECTIONS, SECTION_LABELS, VISIT_SLOTS, VISIT_SLOT_LABELS, fieldLabel, fieldsOf,
  type FieldDef, type Section, type VisitSlot,
} from "../shared/catalog.ts";
import type { Button, InboundMessage, OutboundMessage } from "../shared/messages.ts";
import { fold, formatValue, parseField } from "../shared/normalize.ts";
import { needsAttention, type FieldValue } from "../shared/status.ts";
import { consistencyIssues } from "../shared/validate.ts";
import { config } from "./config.ts";
import { logInitialState, now, setState, tx, type Db } from "./db.ts";
import { storeImage } from "./images.ts";
import { findCandidates, normalizeCode } from "./linking.ts";
import { L, descriptor, diffAgainstPatient, documentValues, patientSummary, patientValues, writeField, type Diff, type Lang } from "./records.ts";

type Step =
  | "review_page" | "question" | "edit_value" | "edit_search" | "retake" | "waiting"
  | "failed_page" | "manual_section" | "manual_slot" | "manual_value"
  | "ask_code" | "match" | "redigitize" | "redigitize_choose";

interface Active {
  docId: string;
  step: Step;
  captureId?: string;
  queue?: string[];
  key?: string;
  from?: "queue" | "edit";
  candidates?: string[];
  diffs?: Diff[];
  manualSection?: Section;
}

interface Conv {
  lang: Lang;
  collectingDocId: string | null;
  active: Active | null;
}

interface PageRow {
  capture_id: string; doc_id: string; page_no: number; state: string; section: string | null; fields: string | null;
  quality: string | null; confirmed: number; error: string | null; captured_at: string; content_hash: string;
}

const MAX_TEXT = 3500;

export class Agent {
  constructor(private db: Db, private onNewWork: () => void = () => {}) {}

  // ------------------------------------------------------------------ plumbing
  private conv(mid: string): Conv {
    const row = this.db.prepare("SELECT state FROM conversations WHERE midwife_id = ?").get(mid) as { state: string } | undefined;
    if (row) return JSON.parse(row.state);
    const lang = ((this.db.prepare("SELECT lang FROM midwives WHERE id = ?").get(mid) as { lang: Lang } | undefined)?.lang ?? "fr") as Lang;
    return { lang, collectingDocId: null, active: null };
  }
  private save(mid: string, c: Conv) {
    this.db.prepare("INSERT INTO conversations (midwife_id, state) VALUES (?, ?) ON CONFLICT(midwife_id) DO UPDATE SET state = excluded.state").run(mid, JSON.stringify(c));
  }
  send(mid: string, text: string, buttons?: Button[], refs?: OutboundMessage["refs"]) {
    const msg: OutboundMessage = { id: randomUUID(), midwifeId: mid, text: text.slice(0, MAX_TEXT), buttons, createdAt: now(), refs };
    this.db.prepare("INSERT INTO outbound (id, midwife_id, payload, created_at) VALUES (?, ?, ?, ?)").run(msg.id, mid, JSON.stringify(msg), msg.createdAt);
  }
  private page(cid: string): PageRow {
    return this.db.prepare("SELECT * FROM pages WHERE capture_id = ?").get(cid) as unknown as PageRow;
  }
  private pageFields(p: PageRow): Record<string, FieldValue> {
    return p.fields ? JSON.parse(p.fields) : {};
  }
  private setPageFields(cid: string, fields: Record<string, FieldValue>) {
    this.db.prepare("UPDATE pages SET fields = ? WHERE capture_id = ?").run(JSON.stringify(fields), cid);
  }
  private docPages(docId: string): PageRow[] {
    return this.db
      .prepare("SELECT * FROM pages WHERE doc_id = ? AND replaced_by IS NULL ORDER BY page_no")
      .all(docId) as unknown as PageRow[];
  }

  ensureMidwife(mid: string, name = mid, lang: Lang = "fr") {
    this.db.prepare("INSERT OR IGNORE INTO midwives (id, name, lang, created_at) VALUES (?, ?, ?, ?)").run(mid, name, lang, now());
  }

  // ------------------------------------------------------------------ inbound
  /** Returns false when the message id was already received (device retry). */
  handle(msg: InboundMessage): boolean {
    const fresh = tx(this.db, () => {
      const exists = this.db.prepare("SELECT 1 FROM inbound WHERE id = ?").get(msg.id);
      if (exists) return false;
      this.db.prepare("INSERT INTO inbound (id, midwife_id, kind, body, received_at) VALUES (?, ?, ?, ?, ?)").run(
        msg.id, msg.midwifeId, msg.kind, msg.kind === "image" ? null : msg.text ?? msg.buttonId ?? null, now(),
      );
      this.ensureMidwife(msg.midwifeId);
      if (msg.kind === "image") this.onImage(msg);
      else if (msg.kind === "button") this.onButton(msg.midwifeId, msg.buttonId ?? "");
      else this.onText(msg.midwifeId, (msg.text ?? "").trim());
      return true;
    });
    if (fresh) this.onNewWork();
    return fresh;
  }

  private onImage(msg: InboundMessage): void {
    const mid = msg.midwifeId;
    const c = this.conv(mid);
    const bytes = Buffer.from(msg.image!.data, "base64");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const captureId = msg.id;
    const lang = c.lang;

    let docId: string;
    let pageNo: number;
    let replaces: string | undefined;
    if (c.active?.step === "retake" && c.active.captureId) {
      docId = c.active.docId;
      replaces = c.active.captureId;
      pageNo = this.page(replaces).page_no;
    } else {
      docId = this.collectingDoc(mid, c, msg.capturedAt);
      pageNo = ((this.db.prepare("SELECT MAX(page_no) AS n FROM pages WHERE doc_id = ?").get(docId) as { n: number | null }).n ?? 0) + 1;
    }

    const dup = this.db
      .prepare("SELECT capture_id, doc_id FROM pages WHERE content_hash = ? AND replaced_by IS NULL AND state != 'DUPLICATE_SUSPECTED' LIMIT 1")
      .get(hash) as { capture_id: string; doc_id: string } | undefined;
    const imagePath = storeImage(captureId, bytes);
    this.db.prepare(
      `INSERT INTO pages (capture_id, doc_id, midwife_id, page_no, content_hash, mime, image_path, captured_at, received_at, state, duplicate_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(captureId, docId, mid, pageNo, hash, msg.image!.mime, imagePath, msg.capturedAt, now(), dup ? "DUPLICATE_SUSPECTED" : "PENDING_AI", dup?.capture_id ?? null);
    logInitialState(this.db, "page", captureId, "CAPTURED", "photo taken on device");
    this.db.prepare("INSERT INTO transitions (subject_type, subject_id, from_state, to_state, at, reason) VALUES ('page', ?, 'CAPTURED', ?, ?, ?)").run(
      captureId, dup ? "DUPLICATE_SUSPECTED" : "PENDING_AI", now(), dup ? `same image as ${dup.capture_id}` : "received by server, queued for AI",
    );
    this.db.prepare("UPDATE documents SET last_activity_at = ? WHERE id = ?").run(now(), docId);

    if (replaces) {
      this.db.prepare("UPDATE pages SET replaced_by = ? WHERE capture_id = ?").run(captureId, replaces);
      c.active = { docId, step: "waiting", captureId };
      this.save(mid, c);
      this.send(mid, L(lang, "📸 Nouvelle photo reçue. Je la lis…", "📸 New photo received. Reading it…"), undefined, { docId, captureId });
    } else if (dup) {
      this.send(
        mid,
        L(lang, `⚠️ Cette photo est identique à une photo déjà reçue (page ${this.page(dup.capture_id).page_no}). Que faire ?`,
          `⚠️ This photo is identical to one already received (page ${this.page(dup.capture_id).page_no}). What should I do?`),
        [
          { id: `dup:ignore:${captureId}`, title: L(lang, "Ignorer", "Ignore it") },
          { id: `dup:use:${captureId}`, title: L(lang, "L'utiliser quand même", "Use it anyway") },
        ],
        { docId, captureId },
      );
    } else {
      this.send(
        mid,
        L(lang, `📄 Page ${pageNo} reçue. Envoyez les pages suivantes, puis appuyez sur « Terminé ».`, `📄 Page ${pageNo} received. Send the next pages, then tap "Done".`),
        [{ id: "done", title: L(lang, "Terminé", "Done") }],
        { docId, captureId },
      );
    }
  }

  /** The open multi-page document, or a new one if none is open or the last photo is too old. */
  private collectingDoc(mid: string, c: Conv, capturedAt: string): string {
    if (c.collectingDocId) {
      const last = this.db.prepare("SELECT MAX(captured_at) AS t FROM pages WHERE doc_id = ?").get(c.collectingDocId) as { t: string | null };
      const gapMin = last.t ? (Date.parse(capturedAt) - Date.parse(last.t)) / 60_000 : 0;
      if (gapMin <= config.sessionIdleMinutes) return c.collectingDocId;
      this.closeDoc(mid, c, "more than 10 minutes between photos");
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO documents (id, midwife_id, state, opened_at, last_activity_at) VALUES (?, ?, 'PENDING_AI', ?, ?)").run(id, mid, now(), now());
    logInitialState(this.db, "document", id, "PENDING_AI", "first page received");
    c.collectingDocId = id;
    this.save(mid, c);
    return id;
  }

  private closeDoc(mid: string, c: Conv, reason: string): void {
    const docId = c.collectingDocId;
    if (!docId) return;
    this.db.prepare("UPDATE documents SET closed_at = ? WHERE id = ?").run(now(), docId);
    const n = this.docPages(docId).length;
    c.collectingDocId = null;
    this.save(mid, c);
    this.send(
      mid,
      L(c.lang, `🗂️ ${n} page(s) regroupée(s) en un seul registre. Je les lis et je reviens vers vous.`, `🗂️ ${n} page(s) grouped as one registry. I'm reading them and will come back to you.`),
      undefined,
      { docId },
    );
    void reason;
  }

  // ------------------------------------------------------------------ text
  private onText(mid: string, text: string): void {
    const c = this.conv(mid);
    const f = fold(text);
    const lang = c.lang;
    const fileReq = text.match(/^(?:dossier|file|record|fiche)\s+(.+)$/i);
    if (["aide", "help", "menu", "?"].includes(f)) return this.help(mid, lang);
    if (["fin", "termine", "done", "finish", "fini"].includes(f)) return this.onButton(mid, "done");
    if (["langue", "language", "english", "francais", "anglais"].includes(f)) return this.onButton(mid, f === "english" || f === "anglais" ? "lang:en" : f === "francais" ? "lang:fr" : lang === "fr" ? "lang:en" : "lang:fr");
    if (["statut", "status", "etat"].includes(f)) return this.status(mid, lang);
    if (fileReq) return this.fileRequest(mid, lang, fileReq[1]);
    if (["manuel", "manual", "saisie manuelle"].includes(f) && c.active?.captureId) return this.onButton(mid, "fail:manual");

    const a = c.active;
    if (a?.step === "edit_value" || a?.step === "question") return this.applyTypedValue(mid, c, text);
    if (a?.step === "edit_search") return this.searchField(mid, c, text);
    if (a?.step === "manual_value") return this.applyManualValue(mid, c, text);
    if (a?.step === "ask_code") {
      this.db.prepare("UPDATE documents SET code = ? WHERE id = ?").run(normalizeCode(text), a.docId);
      return this.startLinking(mid, c);
    }
    if (a?.step === "redigitize_choose") return this.applyChosenDiffs(mid, c, text);
    if (a) return this.reprompt(mid, c, L(lang, "Je n'ai pas compris. ", "I didn't understand. "));
    this.send(
      mid,
      L(lang, "Bonjour 👋 Envoyez les photos des pages du registre, puis appuyez sur « Terminé ». Tapez « aide » pour l'aide.",
        'Hello 👋 Send photos of the registry pages, then tap "Done". Type "help" for help.'),
    );
  }

  private help(mid: string, lang: Lang): void {
    this.send(
      mid,
      L(
        lang,
        "ℹ️ Comment ça marche :\n1. Photographiez chaque page du registre et envoyez-les ici (même sans réseau : elles partiront plus tard).\n2. Appuyez sur « Terminé ».\n3. Je lis les pages et je vous pose des questions sur ce dont je ne suis pas sûr.\n\nCommandes :\n• dossier <N° de fiche> — recevoir le dossier d'une patiente\n• statut — registres en cours\n• manuel — saisir la page à la main\n• langue — English",
        "ℹ️ How it works:\n1. Photograph each registry page and send them here (even offline: they will be sent later).\n2. Tap \"Done\".\n3. I read the pages and ask you about anything I'm not sure of.\n\nCommands:\n• file <form number> — get a patient's record\n• status — registries in progress\n• manual — enter the page by hand\n• language — Français",
      ),
    );
  }

  private status(mid: string, lang: Lang): void {
    const docs = this.db
      .prepare("SELECT d.id, d.state, d.opened_at, p.code FROM documents d LEFT JOIN patients p ON p.id = d.patient_id WHERE d.midwife_id = ? ORDER BY d.opened_at DESC LIMIT 5")
      .all(mid) as { id: string; state: string; opened_at: string; code: string | null }[];
    if (!docs.length) return this.send(mid, L(lang, "Aucun registre envoyé pour l'instant.", "No registry sent yet."));
    const lines = docs.map((d) => `• ${d.opened_at.slice(0, 16).replace("T", " ")} — ${d.state}${d.code ? ` (${d.code})` : ""} — ${this.docPages(d.id).length} p.`);
    this.send(mid, L(lang, "📋 Vos derniers registres :\n", "📋 Your latest registries:\n") + lines.join("\n"));
  }

  private fileRequest(mid: string, lang: Lang, rawCode: string): void {
    const code = normalizeCode(rawCode);
    const p = this.db.prepare("SELECT id FROM patients WHERE code = ?").get(code) as { id: string } | undefined;
    if (!p) {
      return this.send(mid, L(lang, `Aucun dossier avec le N° de fiche ${code}. Vérifiez le numéro écrit sur la couverture.`, `No record with form number ${code}. Check the number written on the cover.`));
    }
    this.db.prepare("INSERT INTO access_log (role, action, subject, at) VALUES ('midwife', 'file_request', ?, ?)").run(p.id, now());
    this.send(mid, patientSummary(this.db, p.id, lang));
  }

  // ------------------------------------------------------------------ buttons
  private onButton(mid: string, id: string): void {
    const c = this.conv(mid);
    const lang = c.lang;
    const a = c.active;
    const [kind, arg, arg2] = id.split(":");

    switch (kind) {
      case "lang": {
        c.lang = arg === "en" ? "en" : "fr";
        this.db.prepare("UPDATE midwives SET lang = ? WHERE id = ?").run(c.lang, mid);
        this.save(mid, c);
        return this.send(mid, L(c.lang, "Langue : français 🇫🇷", "Language: English 🇬🇧"));
      }
      case "done": {
        if (!c.collectingDocId) {
          if (a) return this.reprompt(mid, c);
          return this.send(mid, L(lang, "Aucune page en cours. Envoyez d'abord les photos du registre.", "No pages in progress. Send the registry photos first."));
        }
        this.closeDoc(mid, c, "midwife tapped done");
        return this.maybeStartReview(mid);
      }
      case "dup": {
        const p = this.page(arg2);
        if (!p || p.state !== "DUPLICATE_SUSPECTED") return;
        if (arg === "ignore") {
          this.db.prepare("UPDATE pages SET replaced_by = 'ignored-duplicate' WHERE capture_id = ?").run(arg2);
          this.send(mid, L(lang, "👍 Photo en double ignorée.", "👍 Duplicate photo ignored."), undefined, { docId: p.doc_id, captureId: arg2 });
        } else {
          setState(this.db, "page", arg2, "PENDING_AI", "midwife chose to use the duplicate");
          this.send(mid, L(lang, "👍 Je la traite comme une nouvelle page (sans nouvel appel IA).", "👍 I'll treat it as a new page (no new AI call)."));
        }
        return this.maybeStartReview(mid);
      }
    }

    if (!a) {
      return this.send(mid, L(lang, "Cette question n'est plus en attente.", "This question is no longer pending."));
    }

    switch (kind) {
      case "rv": {
        if (!a.captureId) return this.reprompt(mid, c);
        if (arg === "start") return this.askNext(mid, c);
        if (arg === "confirm") return a.queue?.length ? this.askNext(mid, c) : this.confirmPage(mid, c);
        if (arg === "retake") {
          c.active = { ...a, step: "retake" };
          this.save(mid, c);
          return this.send(mid, L(lang, "📸 Envoyez une nouvelle photo de cette page (bien à plat, avec une bonne lumière).", "📸 Send a new photo of this page (flat, with good light)."), [
            { id: "cancel", title: L(lang, "Annuler", "Cancel") },
          ]);
        }
        if (arg === "show") return this.showValues(mid, c);
        if (arg === "edit") {
          c.active = { ...a, step: "edit_search" };
          this.save(mid, c);
          return this.send(mid, L(lang, "✏️ Quel champ voulez-vous corriger ? Tapez son nom (ex. « poids 8e mois », « DDR »).", '✏️ Which field do you want to fix? Type its name (e.g. "weight 8th month", "LMP").'), [
            { id: "cancel", title: L(lang, "Annuler", "Cancel") },
          ]);
        }
        if (arg === "useanyway") return this.presentPage(mid, c, a.captureId, true);
        return;
      }
      case "q":
        return this.answerQuestion(mid, c, arg);
      case "v":
        return this.applyTypedValue(mid, c, id.slice(2));
      case "f": {
        const key = id.slice(2);
        c.active = { ...a, step: "edit_value", key, from: "edit" };
        this.save(mid, c);
        return this.askValue(mid, c, key);
      }
      case "cancel":
        if (a.captureId && ["retake", "edit_search", "edit_value"].includes(a.step)) return this.presentPage(mid, c, a.captureId);
        return this.reprompt(mid, c);
      case "fail": {
        if (!a.captureId) return this.reprompt(mid, c);
        if (arg === "retry") {
          this.db.prepare("UPDATE pages SET attempts = 0, next_attempt_at = NULL, error = NULL WHERE capture_id = ?").run(a.captureId!);
          setState(this.db, "page", a.captureId, "PENDING_AI", "midwife asked to retry AI");
          c.active = { ...a, step: "waiting" };
          this.save(mid, c);
          return this.send(mid, L(lang, "🔄 Je réessaie de lire cette page. Je vous recontacte dès que c'est fait.", "🔄 Retrying this page. I'll come back to you when it's done."));
        }
        if (arg === "retake") return this.onButton(mid, "rv:retake");
        if (arg === "manual") return this.startManual(mid, c);
        return;
      }
      case "ms":
        return this.chooseManualSection(mid, c, arg as Section);
      case "mslot":
        return this.chooseManualSlot(mid, c, arg as VisitSlot);
      case "mv":
        return this.manualButton(mid, c, arg);
      case "code":
        this.db.prepare("UPDATE documents SET note = COALESCE(note, '') || 'no_code;' WHERE id = ?").run(a.docId);
        return this.startLinking(mid, c);
      case "m":
        return this.chooseMatch(mid, c, arg);
      case "rd":
        return this.redigitizeButton(mid, c, arg);
    }
    return this.reprompt(mid, c);
  }

  // ------------------------------------------------------------------ review
  /** Called by the pipeline when a page finished processing, and by the idle timer. */
  onPageProcessed(mid: string, captureId?: string) {
    tx(this.db, () => {
      const c = this.conv(mid);
      if (c.active?.step === "waiting" && (!captureId || this.page(captureId)?.doc_id === c.active.docId)) {
        return this.nextPage(mid, c);
      }
      this.maybeStartReview(mid);
    });
  }

  tick() {
    const idle = this.db
      .prepare(
        `SELECT d.id, d.midwife_id FROM documents d
         WHERE d.closed_at IS NULL AND d.last_activity_at < ?`,
      )
      .all(new Date(Date.now() - config.sessionIdleMinutes * 60_000).toISOString()) as { id: string; midwife_id: string }[];
    for (const d of idle) {
      tx(this.db, () => {
        const c = this.conv(d.midwife_id);
        if (c.collectingDocId === d.id) this.closeDoc(d.midwife_id, c, "10 minutes without new pages");
        else this.db.prepare("UPDATE documents SET closed_at = ? WHERE id = ?").run(now(), d.id);
        this.maybeStartReview(d.midwife_id);
      });
    }
  }

  private pagesFinished(docId: string) {
    return this.docPages(docId).every((p) => !["PENDING_AI", "DUPLICATE_SUSPECTED"].includes(p.state) || p.confirmed);
  }

  private maybeStartReview(mid: string): void {
    const c = this.conv(mid);
    if (c.active) return;
    const docs = this.db
      .prepare("SELECT id, state FROM documents WHERE midwife_id = ? AND closed_at IS NOT NULL AND state IN ('PENDING_AI', 'AI_PROCESSED', 'NEEDS_REVIEW') ORDER BY opened_at")
      .all(mid) as { id: string; state: string }[];
    for (const d of docs) {
      if (!this.pagesFinished(d.id)) continue;
      if (!this.docPages(d.id).length) continue;
      if (d.state === "PENDING_AI") setState(this.db, "document", d.id, "AI_PROCESSED", "all pages processed");
      setState(this.db, "document", d.id, "NEEDS_REVIEW", "review started with the midwife");
      this.flagInconsistencies(d.id);
      c.active = { docId: d.id, step: "review_page" };
      this.save(mid, c);
      return this.nextPage(mid, c);
    }
  }

  /** Cross-page checks (e.g. EDD vs LMP) mark the fields involved for review. */
  private flagInconsistencies(docId: string) {
    const pages = this.docPages(docId).filter((p) => p.fields);
    const values = new Map<string, unknown>();
    for (const p of pages) for (const f of Object.values(this.pageFields(p))) if (f.value !== null) values.set(f.key, f.value);
    const issues = consistencyIssues(values);
    if (!issues.length) return;
    for (const p of pages) {
      const fields = this.pageFields(p);
      let changed = false;
      for (const issue of issues) {
        for (const k of issue.keys) {
          const f = fields[k];
          if (f && f.status === "KNOWN" && f.confirmedBy === "AI") {
            fields[k] = { ...f, status: "NEEDS_REVIEW", confidence: Math.min(f.confidence, 0.5), reasons: [...f.reasons, `${issue.fr} / ${issue.en}`] };
            changed = true;
          }
        }
      }
      if (changed) this.setPageFields(p.capture_id, fields);
    }
  }

  private nextPage(mid: string, c: Conv): void {
    const a = c.active!;
    const pages = this.docPages(a.docId);
    const next = pages.find((p) => !p.confirmed);
    if (!next) return this.finishReview(mid, c);
    if (next.state === "PENDING_AI" || next.state === "DUPLICATE_SUSPECTED") {
      c.active = { docId: a.docId, step: "waiting", captureId: next.capture_id };
      this.save(mid, c);
      return;
    }
    if (next.state === "PROCESSING_FAILED") {
      c.active = { docId: a.docId, step: "failed_page", captureId: next.capture_id };
      this.save(mid, c);
      const unavailable = /unavailable|no transcription|credentials|unreachable/i.test(next.error ?? "");
      return this.send(
        mid,
        L(c.lang, `⚠️ Page ${next.page_no} : je n'ai pas pu la lire automatiquement${unavailable ? " (IA indisponible)" : ""}. Que voulez-vous faire ?`,
          `⚠️ Page ${next.page_no}: I could not read it automatically${unavailable ? " (AI unavailable)" : ""}. What would you like to do?`),
        [
          { id: "fail:manual", title: L(c.lang, "Saisie manuelle", "Enter manually") },
          { id: "fail:retry", title: L(c.lang, "Réessayer", "Retry") },
          { id: "fail:retake", title: L(c.lang, "Reprendre la photo", "Retake photo") },
        ],
        { docId: a.docId, captureId: next.capture_id },
      );
    }
    if (next.state === "MANUAL_REVIEW_REQUIRED") {
      c.active = { docId: a.docId, step: "failed_page", captureId: next.capture_id };
      return this.startManual(mid, c);
    }
    if (next.state === "AI_PROCESSED") setState(this.db, "page", next.capture_id, "NEEDS_REVIEW", "shown to the midwife");
    return this.presentPage(mid, c, next.capture_id);
  }

  private presentPage(mid: string, c: Conv, cid: string, ignoreQuality = false): void {
    const p = this.page(cid);
    const lang = c.lang;
    const total = this.docPages(p.doc_id).length;
    const quality = p.quality ? (JSON.parse(p.quality) as { usable: boolean; issues: string[] }) : { usable: true, issues: [] };
    const fields = this.pageFields(p);
    const section = p.section as Section | "UNKNOWN" | null;
    const head = `📄 Page ${p.page_no}/${total}`;

    if (!section || section === "UNKNOWN") {
      c.active = { docId: p.doc_id, step: "failed_page", captureId: cid };
      this.save(mid, c);
      return this.send(mid, L(lang, `${head} — je ne reconnais pas cette page du registre.`, `${head} — I don't recognize this registry page.`), [
        { id: "fail:retake", title: L(lang, "Reprendre la photo", "Retake photo") },
        { id: "fail:manual", title: L(lang, "Saisie manuelle", "Enter manually") },
      ], { docId: p.doc_id, captureId: cid });
    }
    if (!quality.usable && !ignoreQuality) {
      c.active = { docId: p.doc_id, step: "review_page", captureId: cid, queue: [] };
      this.save(mid, c);
      return this.send(
        mid,
        L(lang, `${head} — ${SECTION_LABELS[section].fr}\n⚠️ La photo est difficile à lire (${quality.issues.join(", ") || "qualité"}). Je conseille de la reprendre.`,
          `${head} — ${SECTION_LABELS[section].en}\n⚠️ The photo is hard to read (${quality.issues.join(", ") || "quality"}). I suggest retaking it.`),
        [
          { id: "rv:retake", title: L(lang, "Reprendre la photo", "Retake photo") },
          { id: "rv:useanyway", title: L(lang, "Continuer", "Continue anyway") },
        ],
        { docId: p.doc_id, captureId: cid },
      );
    }

    const all = Object.values(fields);
    const filled = all.filter((f) => f.status !== "NOT_PROVIDED");
    const queue = fieldsOf(section).map((d) => d.key).filter((k) => fields[k] && needsAttention(fields[k].status) && fields[k].confirmedBy === "AI");
    c.active = { docId: p.doc_id, step: "review_page", captureId: cid, queue };
    this.save(mid, c);
    const sure = filled.length - queue.length;
    const secLabel = SECTION_LABELS[section][lang];
    if (queue.length) {
      return this.send(
        mid,
        L(lang, `${head} — ${secLabel}\n✅ ${sure} valeur(s) lue(s) avec confiance\n⚠️ ${queue.length} valeur(s) dont je ne suis pas sûr : je vais vous les montrer une par une.`,
          `${head} — ${secLabel}\n✅ ${sure} value(s) read with confidence\n⚠️ ${queue.length} value(s) I'm not sure about: I'll show them one by one.`),
        [
          { id: "rv:start", title: L(lang, `Vérifier (${queue.length})`, `Check (${queue.length})`) },
          { id: "rv:show", title: L(lang, "Voir les valeurs", "Show values") },
          { id: "rv:retake", title: L(lang, "Reprendre la photo", "Retake photo") },
        ],
        { docId: p.doc_id, captureId: cid },
      );
    }
    return this.send(
      mid,
      L(lang, `${head} — ${secLabel}\n✅ ${filled.length} valeur(s), aucune incertitude restante. Confirmez-vous ?`, `${head} — ${secLabel}\n✅ ${filled.length} value(s), no remaining doubts. Do you confirm?`),
      [
        { id: "rv:confirm", title: L(lang, "Confirmer", "Confirm") },
        { id: "rv:edit", title: L(lang, "Corriger un champ", "Fix a field") },
        { id: "rv:show", title: L(lang, "Voir les valeurs", "Show values") },
        { id: "rv:retake", title: L(lang, "Reprendre la photo", "Retake photo") },
      ],
      { docId: p.doc_id, captureId: cid },
    );
  }

  private showValues(mid: string, c: Conv): void {
    const a = c.active!;
    const p = this.page(a.captureId!);
    const fields = this.pageFields(p);
    const lang = c.lang;
    const lines: string[] = [];
    for (const def of fieldsOf(p.section as Section)) {
      const f = fields[def.key];
      if (!f || f.status === "NOT_PROVIDED") continue;
      const v = f.value !== null ? formatValue(def.key, f.value, lang) : f.status === "NOT_APPLICABLE" ? "—" : `[${f.status}]`;
      lines.push(`${needsAttention(f.status) ? "⚠️" : "•"} ${def[lang]} : ${v}`);
    }
    let text = lines.join("\n");
    if (text.length > MAX_TEXT - 100) text = text.slice(0, MAX_TEXT - 100) + L(lang, "\n… (suite dans le tableau de bord)", "\n… (see the dashboard for the rest)");
    this.send(mid, text || L(lang, "Aucune valeur.", "No values."));
    this.presentPage(mid, c, a.captureId!, true);
  }

  private askNext(mid: string, c: Conv): void {
    const a = c.active!;
    const key = a.queue?.shift();
    if (!key) return this.presentPage(mid, c, a.captureId!, true);
    c.active = { ...a, step: "question", key, from: "queue" };
    this.save(mid, c);
    const p = this.page(a.captureId!);
    const f = this.pageFields(p)[key];
    const lang = c.lang;
    const total = (a.queue?.length ?? 0) + 1;
    const label = fieldLabel(key, lang);
    const reasons = f.reasons.map((r) => `ℹ️ ${r.split(" / ")[lang === "fr" ? 0 : 1] ?? r}`).join("\n");
    if (f.value === null || f.status === "ILLEGIBLE") {
      return this.send(
        mid,
        L(lang, `❓ ${label}\nJe n'arrive pas à lire cette case${f.raw ? ` (peut-être « ${f.raw} »)` : ""}. Tapez la valeur écrite sur le papier.${reasons ? "\n" + reasons : ""}\n(encore ${total})`,
          `❓ ${label}\nI can't read this box${f.raw ? ` (maybe "${f.raw}")` : ""}. Type the value written on the paper.${reasons ? "\n" + reasons : ""}\n(${total} left)`),
        [
          { id: "q:blank", title: L(lang, "Vide sur le papier", "Blank on paper") },
          { id: "q:illegible", title: L(lang, "Illisible aussi pour moi", "Illegible for me too") },
          { id: "q:unknown", title: L(lang, "Inconnu", "Unknown") },
        ],
        { docId: p.doc_id, captureId: p.capture_id },
      );
    }
    return this.send(
      mid,
      L(lang, `❓ ${label}\nJ'ai lu : « ${f.raw} » → ${formatValue(key, f.value, lang)}\nConfiance : ${Math.round(f.confidence * 100)} %${reasons ? "\n" + reasons : ""}\n(encore ${total})`,
        `❓ ${label}\nI read: "${f.raw}" → ${formatValue(key, f.value, lang)}\nConfidence: ${Math.round(f.confidence * 100)}%${reasons ? "\n" + reasons : ""}\n(${total} left)`),
      [
        { id: "q:ok", title: L(lang, "✅ C'est correct", "✅ Correct") },
        { id: "q:edit", title: L(lang, "✏️ Corriger", "✏️ Fix it") },
        { id: "q:illegible", title: L(lang, "Illisible sur papier", "Illegible on paper") },
      ],
      { docId: p.doc_id, captureId: p.capture_id },
    );
  }

  private updateField(cid: string, key: string, patch: Partial<FieldValue>) {
    const p = this.page(cid);
    const fields = this.pageFields(p);
    const prev = fields[key] ?? { key, value: null, raw: null, status: "NOT_PROVIDED", confidence: 1, reasons: [], sourceCaptureId: cid, confirmedBy: "MIDWIFE" };
    fields[key] = { ...prev, ...patch, confirmedBy: "MIDWIFE", confidence: 1 } as FieldValue;
    this.setPageFields(cid, fields);
  }

  private answerQuestion(mid: string, c: Conv, answer: string): void {
    const a = c.active!;
    if (!a.key || !a.captureId || !["question", "edit_value"].includes(a.step)) return this.reprompt(mid, c);
    const f = this.pageFields(this.page(a.captureId))[a.key];
    if (answer === "ok") {
      if (f?.value === null || f?.value === undefined) return this.reprompt(mid, c);
      this.updateField(a.captureId, a.key, { status: "KNOWN", reasons: [] });
    } else if (answer === "edit") {
      c.active = { ...a, step: "edit_value" };
      this.save(mid, c);
      return this.askValue(mid, c, a.key);
    } else if (answer === "illegible") {
      this.updateField(a.captureId, a.key, { status: "ILLEGIBLE", value: null, reasons: ["Confirmed illegible by the midwife"] });
    } else if (answer === "blank") {
      this.updateField(a.captureId, a.key, { status: "NOT_PROVIDED", value: null, raw: null, reasons: [] });
    } else if (answer === "unknown") {
      this.updateField(a.captureId, a.key, { status: "UNKNOWN", value: null, reasons: [] });
    }
    return this.afterAnswer(mid, c);
  }

  private afterAnswer(mid: string, c: Conv): void {
    const a = c.active!;
    if (a.from === "edit") return this.presentPage(mid, c, a.captureId!, true);
    return this.askNext(mid, c);
  }

  private example(def: FieldDef, lang: Lang): string {
    switch (def.type) {
      case "date": return "26/04/2025";
      case "bp": return "110/70";
      case "ga": return "32 SA";
      case "int": return def.unit ? `3 (${def.unit})` : "3";
      case "number": return def.unit ? `62.5 (${def.unit})` : "62.5";
      case "bool": return L(lang, "oui / non", "yes / no");
      case "choice": case "multi": return (def.options ?? []).map((o) => o[lang]).join(" / ");
      case "lab": return "Neg / Pos / Immune / Non fait";
      case "role": return "Dr / Sage-femme / Inf.";
      default: return L(lang, "texte libre", "free text");
    }
  }

  private askValue(mid: string, c: Conv, key: string): void {
    const def = FIELD_BY_KEY.get(key)!;
    const lang = c.lang;
    const buttons: Button[] = [];
    if ((def.type === "choice" || def.type === "bool") && (def.options?.length ?? 2) <= 3) {
      const opts = def.type === "bool" ? [{ value: "oui", fr: "Oui", en: "Yes" }, { value: "non", fr: "Non", en: "No" }] : def.options!;
      for (const o of opts) buttons.push({ id: `v:${o.value}`, title: o[lang] });
    }
    buttons.push({ id: "cancel", title: L(lang, "Annuler", "Cancel") });
    this.send(
      mid,
      L(lang, `✏️ Tapez la bonne valeur pour « ${def.fr} ».\nExemple : ${this.example(def, lang)}\n(« vide » si rien n'est écrit, « ? » si inconnu)`,
        `✏️ Type the correct value for "${def.en}".\nExample: ${this.example(def, lang)}\n("blank" if nothing is written, "?" if unknown)`),
      buttons,
    );
  }

  private applyTypedValue(mid: string, c: Conv, text: string): void {
    const a = c.active!;
    if (!a.key || !a.captureId) return this.reprompt(mid, c);
    const f = fold(text);
    if (["vide", "rien", "blank", "empty", "nothing"].includes(f)) {
      this.updateField(a.captureId, a.key, { status: "NOT_PROVIDED", value: null, raw: null, reasons: [] });
      return this.afterAnswer(mid, c);
    }
    if (["illisible", "illegible"].includes(f)) return this.answerQuestion(mid, c, "illegible");
    const parsed = parseField(a.key, text);
    if (parsed.status && parsed.status !== "KNOWN") {
      this.updateField(a.captureId, a.key, { status: parsed.status, value: null, raw: text, reasons: [] });
      return this.afterAnswer(mid, c);
    }
    if (!parsed.ok) {
      const def = FIELD_BY_KEY.get(a.key)!;
      return this.send(mid, L(c.lang, `Je n'ai pas compris « ${text} ». Exemple : ${this.example(def, c.lang)}`, `I didn't understand "${text}". Example: ${this.example(def, c.lang)}`), [
        { id: "cancel", title: L(c.lang, "Annuler", "Cancel") },
      ]);
    }
    this.updateField(a.captureId, a.key, { status: "KNOWN", value: parsed.value ?? null, raw: text, reasons: [] });
    this.send(mid, L(c.lang, `👍 ${fieldLabel(a.key, "fr")} = ${formatValue(a.key, parsed.value, "fr")}`, `👍 ${fieldLabel(a.key, "en")} = ${formatValue(a.key, parsed.value, "en")}`));
    return this.afterAnswer(mid, c);
  }

  private searchField(mid: string, c: Conv, text: string): void {
    const a = c.active!;
    const section = this.page(a.captureId!).section as Section;
    const words = fold(text).split(" ").filter(Boolean);
    const scored = fieldsOf(section)
      .map((d) => {
        const hay = fold(`${d.fr} ${d.en} ${d.key}`);
        return { d, score: words.filter((w) => hay.includes(w)).length };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score);
    const best = scored.filter((x) => x.score === scored[0]?.score).slice(0, 6);
    if (!best.length) {
      return this.send(mid, L(c.lang, "Je ne trouve pas ce champ sur cette page. Réessayez avec un autre mot.", "I can't find that field on this page. Try another word."), [
        { id: "cancel", title: L(c.lang, "Annuler", "Cancel") },
      ]);
    }
    if (best.length === 1) return this.onButton(mid, `f:${best[0].d.key}`);
    this.send(mid, L(c.lang, "Lequel ?", "Which one?"), best.map((x) => ({ id: `f:${x.d.key}`, title: x.d[c.lang].slice(0, 60) })));
  }

  private confirmPage(mid: string, c: Conv): void {
    const a = c.active!;
    this.db.prepare("UPDATE pages SET confirmed = 1 WHERE capture_id = ?").run(a.captureId!);
    const state = this.page(a.captureId!).state;
    if (state === "AI_PROCESSED") setState(this.db, "page", a.captureId!, "NEEDS_REVIEW", "shown to the midwife");
    setState(this.db, "page", a.captureId!, "VALIDATED", "midwife confirmed the page");
    this.send(mid, L(c.lang, "👍 Page confirmée.", "👍 Page confirmed."));
    c.active = { docId: a.docId, step: "review_page" };
    this.save(mid, c);
    return this.nextPage(mid, c);
  }

  // ------------------------------------------------------------------ manual entry
  private startManual(mid: string, c: Conv): void {
    const a = c.active!;
    const p = this.page(a.captureId!);
    if (p.state !== "MANUAL_REVIEW_REQUIRED") {
      if (p.state === "AI_PROCESSED") setState(this.db, "page", p.capture_id, "NEEDS_REVIEW", "shown to the midwife");
      setState(this.db, "page", p.capture_id, "MANUAL_REVIEW_REQUIRED", "manual entry");
      this.db.prepare("UPDATE pages SET entry = 'manual' WHERE capture_id = ?").run(p.capture_id);
    }
    c.active = { ...a, step: "manual_section" };
    this.save(mid, c);
    this.send(
      mid,
      L(c.lang, "✍️ Saisie manuelle. Quelle page du registre est-ce ?", "✍️ Manual entry. Which registry page is this?"),
      SECTIONS.map((s) => ({ id: `ms:${s}`, title: SECTION_LABELS[s][c.lang] })),
    );
  }

  private chooseManualSection(mid: string, c: Conv, section: Section): void {
    const a = c.active!;
    if (a.step !== "manual_section" || !SECTIONS.includes(section)) return this.reprompt(mid, c);
    this.db.prepare("UPDATE pages SET section = ? WHERE capture_id = ?").run(section, a.captureId!);
    if (section === "CURRENT_PREGNANCY") {
      c.active = { ...a, step: "manual_slot", manualSection: section };
      this.save(mid, c);
      return this.send(mid, L(c.lang, "Quelle colonne de visite voulez-vous saisir ?", "Which visit column do you want to enter?"),
        VISIT_SLOTS.map((s) => ({ id: `mslot:${s}`, title: VISIT_SLOT_LABELS[s][c.lang] })));
    }
    const queue = fieldsOf(section).filter((d) => d.essential).map((d) => d.key);
    c.active = { ...a, step: "manual_value", manualSection: section, queue };
    this.save(mid, c);
    return this.askManual(mid, c);
  }

  private chooseManualSlot(mid: string, c: Conv, slot: VisitSlot): void {
    const a = c.active!;
    if (a.step !== "manual_slot") return this.reprompt(mid, c);
    const queue = fieldsOf("CURRENT_PREGNANCY").filter((d) => d.essential && (!d.visitSlot || d.visitSlot === slot)).map((d) => d.key);
    c.active = { ...a, step: "manual_value", queue };
    this.save(mid, c);
    return this.askManual(mid, c);
  }

  private askManual(mid: string, c: Conv): void {
    const a = c.active!;
    const key = a.queue?.shift();
    if (!key) return this.finishManual(mid, c);
    c.active = { ...a, key };
    this.save(mid, c);
    const def = FIELD_BY_KEY.get(key)!;
    this.send(
      mid,
      L(c.lang, `✍️ ${def.fr}${def.unit ? ` (${def.unit})` : ""} ?\nExemple : ${this.example(def, "fr")}`, `✍️ ${def.en}${def.unit ? ` (${def.unit})` : ""}?\nExample: ${this.example(def, "en")}`),
      [
        { id: "mv:blank", title: L(c.lang, "Pas écrit", "Not written") },
        { id: "mv:skip", title: L(c.lang, "Passer", "Skip") },
        { id: "mv:stop", title: L(c.lang, "Terminer la saisie", "Finish entry") },
      ],
    );
  }

  private applyManualValue(mid: string, c: Conv, text: string): void {
    const a = c.active!;
    const parsed = parseField(a.key!, text);
    if (!parsed.ok && !parsed.status) {
      return this.send(mid, L(c.lang, `Je n'ai pas compris « ${text} ». Exemple : ${this.example(FIELD_BY_KEY.get(a.key!)!, c.lang)}`, `I didn't understand "${text}". Example: ${this.example(FIELD_BY_KEY.get(a.key!)!, c.lang)}`));
    }
    this.updateField(a.captureId!, a.key!, {
      key: a.key!, status: parsed.status && parsed.status !== "KNOWN" ? parsed.status : "KNOWN", value: parsed.value ?? null, raw: text, reasons: [], sourceCaptureId: a.captureId!,
    });
    return this.askManual(mid, c);
  }

  private manualButton(mid: string, c: Conv, arg: string): void {
    const a = c.active!;
    if (a.step !== "manual_value") return this.reprompt(mid, c);
    if (arg === "blank") this.updateField(a.captureId!, a.key!, { key: a.key!, status: "NOT_PROVIDED", value: null, raw: null, reasons: [], sourceCaptureId: a.captureId! });
    if (arg === "stop") return this.finishManual(mid, c);
    return this.askManual(mid, c);
  }

  private finishManual(mid: string, c: Conv): void {
    const a = c.active!;
    this.db.prepare("UPDATE pages SET confirmed = 1 WHERE capture_id = ?").run(a.captureId!);
    setState(this.db, "page", a.captureId!, "VALIDATED", "manual entry finished");
    this.send(mid, L(c.lang, "👍 Saisie manuelle enregistrée pour cette page. La photo reste jointe au dossier.", "👍 Manual entry saved for this page. The photo stays attached to the record."));
    c.active = { docId: a.docId, step: "review_page" };
    this.save(mid, c);
    return this.nextPage(mid, c);
  }

  // ------------------------------------------------------------------ linking
  private finishReview(mid: string, c: Conv): void {
    setState(this.db, "document", c.active!.docId, "VALIDATED", "every page confirmed by the midwife");
    return this.startLinking(mid, c);
  }

  private docCode(docId: string): string | null {
    const doc = this.db.prepare("SELECT code FROM documents WHERE id = ?").get(docId) as { code: string | null };
    if (doc.code) return doc.code;
    const f = documentValues(this.db, docId).get("cover.ficheNumber");
    return f && typeof f.value === "string" && f.value.trim() ? normalizeCode(f.value) : null;
  }

  private startLinking(mid: string, c: Conv): void {
    const a = c.active!;
    const lang = c.lang;
    const doc = this.db.prepare("SELECT code, note FROM documents WHERE id = ?").get(a.docId) as { code: string | null; note: string | null };
    const code = this.docCode(a.docId);
    if (code && !doc.code) this.db.prepare("UPDATE documents SET code = ? WHERE id = ?").run(code, a.docId);
    if (!code && !(doc.note ?? "").includes("no_code")) {
      c.active = { ...a, step: "ask_code" };
      this.save(mid, c);
      return this.send(
        mid,
        L(lang, "🔎 Je n'ai pas trouvé de N° de fiche sur ces pages. Tapez le N° écrit sur la couverture du registre.", "🔎 I didn't find a form number on these pages. Type the number written on the registry cover."),
        [{ id: "code:none", title: L(lang, "Pas de numéro", "No number") }],
      );
    }
    const incoming = documentValues(this.db, a.docId);
    const candidates = findCandidates(this.db, code, incoming);
    if (!candidates.length) return this.linkTo(mid, c, null);
    c.active = { ...a, step: "match", candidates: candidates.map((x) => x.patientId) };
    this.save(mid, c);
    const lines = candidates.map((cand, i) => {
      const why = cand.reasons.slice(0, 3).join(", ");
      return `${i + 1}) ${L(lang, "Fiche", "Form")} ${cand.code ?? "—"} — ${descriptor(patientValues(this.db, cand.patientId), lang)}\n   (${L(lang, "concordance", "match")} : ${why})`;
    });
    return this.send(
      mid,
      L(lang, `🔗 Ce registre correspond peut-être à une patiente existante :\n${lines.join("\n")}\nC'est la même femme ?`,
        `🔗 This registry may belong to an existing patient:\n${lines.join("\n")}\nIs it the same woman?`),
      [
        ...candidates.map((cand, i) => ({ id: `m:${cand.patientId}`, title: L(lang, `Patiente ${i + 1}`, `Patient ${i + 1}`) })),
        { id: "m:new", title: L(lang, "Aucune, créer", "None, create new") },
        { id: "m:unsure", title: L(lang, "Je ne sais pas", "I'm not sure") },
      ],
    );
  }

  private chooseMatch(mid: string, c: Conv, choice: string): void {
    const a = c.active!;
    if (a.step !== "match") return this.reprompt(mid, c);
    if (choice === "unsure") {
      setState(this.db, "document", a.docId, "MANUAL_REVIEW_REQUIRED", "midwife unsure about the patient match");
      c.active = null;
      this.save(mid, c);
      this.send(mid, L(c.lang, "👌 D'accord. Le registre est conservé et l'équipe du bureau décidera du rattachement. Rien n'est perdu.", "👌 OK. The registry is kept safely and the office team will decide the match. Nothing is lost."), undefined, { docId: a.docId });
      return this.maybeStartReview(mid);
    }
    if (choice === "new") return this.linkTo(mid, c, null);
    if (!a.candidates?.includes(choice)) return this.reprompt(mid, c);
    return this.linkTo(mid, c, choice);
  }

  /** Attach the document to a patient (existing, or a new one when patientId is null). */
  private linkTo(mid: string, c: Conv, patientId: string | null): void {
    const a = c.active!;
    const isNew = !patientId;
    const result = linkDocument(this.db, a.docId, patientId, `midwife:${mid}`);
    if (isNew) {
      this.send(mid, L(c.lang, `🆕 Nouvelle patiente créée${result.code ? ` (fiche ${result.code})` : ""}.`, `🆕 New patient created${result.code ? ` (form ${result.code})` : ""}.`));
      return this.register(mid, c, result.diffs);
    }
    const changed = result.diffs.filter((d) => d.kind === "changed");
    if (!changed.length) return this.register(mid, c, result.diffs);
    c.active = { ...a, step: "redigitize", diffs: result.diffs };
    this.save(mid, c);
    const added = result.diffs.length - changed.length;
    const lines = changed.slice(0, 12).map((d, i) => {
      const before = d.before?.value !== null && d.before?.value !== undefined ? formatValue(d.key, d.before.value, c.lang) : `[${d.before?.status}]`;
      const after = d.after.value !== null ? formatValue(d.key, d.after.value, c.lang) : `[${d.after.status}]`;
      return `${i + 1}) ${fieldLabel(d.key, c.lang)} : ${L(c.lang, "dossier", "on file")} ${before} → ${L(c.lang, "photo", "photo")} ${after}`;
    });
    if (changed.length > 12) lines.push(L(c.lang, `… et ${changed.length - 12} autre(s)`, `… and ${changed.length - 12} more`));
    return this.send(
      mid,
      L(c.lang, `📂 Cette patiente a déjà un dossier.\n➕ ${added} nouvelle(s) valeur(s) seront ajoutées.\n✏️ ${changed.length} valeur(s) diffèrent du dossier :\n${lines.join("\n")}\nQue faire des différences ?`,
        `📂 This patient already has a record.\n➕ ${added} new value(s) will be added.\n✏️ ${changed.length} value(s) differ from the record:\n${lines.join("\n")}\nWhat should I do with the differences?`),
      [
        { id: "rd:all", title: L(c.lang, "Tout mettre à jour", "Update all") },
        { id: "rd:keep", title: L(c.lang, "Garder le dossier", "Keep record") },
        { id: "rd:choose", title: L(c.lang, "Choisir", "Choose") },
      ],
    );
  }

  private redigitizeButton(mid: string, c: Conv, arg: string): void {
    const a = c.active!;
    if (a.step !== "redigitize" || !a.diffs) return this.reprompt(mid, c);
    if (arg === "all") return this.register(mid, c, a.diffs);
    if (arg === "keep") return this.register(mid, c, a.diffs.filter((d) => d.kind === "added"));
    c.active = { ...a, step: "redigitize_choose" };
    this.save(mid, c);
    return this.send(mid, L(c.lang, "Tapez les numéros des valeurs à mettre à jour, ex. 1,3", "Type the numbers of the values to update, e.g. 1,3"));
  }

  private applyChosenDiffs(mid: string, c: Conv, text: string): void {
    const a = c.active!;
    const changed = a.diffs!.filter((d) => d.kind === "changed");
    const picks = new Set(text.split(/[^\d]+/).filter(Boolean).map(Number));
    const chosen = changed.filter((_, i) => picks.has(i + 1));
    return this.register(mid, c, [...a.diffs!.filter((d) => d.kind === "added"), ...chosen]);
  }

  private register(mid: string, c: Conv, diffs: Diff[]): void {
    const a = c.active!;
    const code = registerDocument(this.db, a.docId, diffs, `midwife:${mid}`);
    c.active = null;
    this.save(mid, c);
    this.send(
      mid,
      L(c.lang, `✅ Enregistré dans le dossier${code ? ` (fiche ${code})` : ""} : ${diffs.length} valeur(s) mises à jour. Merci !`, `✅ Saved to the record${code ? ` (form ${code})` : ""}: ${diffs.length} value(s) updated. Thank you!`),
      [{ id: `report:${a.docId}`, title: L(c.lang, "📄 Voir et partager le rapport", "📄 View and share report") }],
      { docId: a.docId },
    );
    return this.maybeStartReview(mid);
  }

  /** Resend the prompt of the current step. */
  reprompt(mid: string, c: Conv, prefix = ""): void {
    const a = c.active;
    if (prefix) this.send(mid, prefix + L(c.lang, "Voici la question en cours :", "Here is the current question:"));
    if (!a) return;
    if (a.step === "question" && a.key) {
      a.queue = [a.key, ...(a.queue ?? [])];
      return this.askNext(mid, c);
    }
    if (a.step === "edit_value" && a.key) return this.askValue(mid, c, a.key);
    if (a.step === "manual_value" && a.key) {
      a.queue = [a.key, ...(a.queue ?? [])];
      return this.askManual(mid, c);
    }
    if (a.step === "ask_code" || a.step === "match") return this.startLinking(mid, c);
    if (a.step === "redigitize" || a.step === "redigitize_choose") return this.linkToRepeat(mid, c);
    if (a.step === "waiting") return this.send(mid, L(c.lang, "⏳ Je lis encore une page, un instant…", "⏳ Still reading a page, one moment…"));
    if (a.captureId) return this.presentPage(mid, c, a.captureId, true);
  }

  private linkToRepeat(mid: string, c: Conv): void {
    const a = c.active!;
    const pid = (this.db.prepare("SELECT patient_id FROM documents WHERE id = ?").get(a.docId) as { patient_id: string }).patient_id;
    c.active = { ...a, step: "redigitize" };
    const changed = (a.diffs ?? []).filter((d) => d.kind === "changed").length;
    this.save(mid, c);
    this.send(mid, L(c.lang, `${changed} valeur(s) diffèrent du dossier existant. Que faire ?`, `${changed} value(s) differ from the existing record. What should I do?`), [
      { id: "rd:all", title: L(c.lang, "Tout mettre à jour", "Update all") },
      { id: "rd:keep", title: L(c.lang, "Garder le dossier", "Keep record") },
      { id: "rd:choose", title: L(c.lang, "Choisir", "Choose") },
    ]);
    void pid;
  }
}

// ---------------------------------------------------------------------------
// Shared with the office console, which resolves "I'm not sure" matches.

export function linkDocument(db: Db, docId: string, patientId: string | null, by: string): { patientId: string; code: string | null; diffs: Diff[] } {
  const doc = db.prepare("SELECT code FROM documents WHERE id = ?").get(docId) as { code: string | null };
  let pid = patientId;
  let code: string | null = null;
  if (!pid) {
    pid = randomUUID();
    const taken = doc.code && db.prepare("SELECT 1 FROM patients WHERE code = ?").get(doc.code);
    code = doc.code && !taken ? doc.code : null;
    db.prepare("INSERT INTO patients (id, code, created_at, created_by) VALUES (?, ?, ?, ?)").run(pid, code, now(), by);
    if (taken) db.prepare("UPDATE documents SET note = COALESCE(note, '') || 'code_conflict;' WHERE id = ?").run(docId);
  } else {
    code = (db.prepare("SELECT code FROM patients WHERE id = ?").get(pid) as { code: string | null }).code;
  }
  db.prepare("UPDATE documents SET patient_id = ? WHERE id = ?").run(pid, docId);
  setState(db, "document", docId, "PATIENT_MATCHED", patientId ? `linked to existing patient by ${by}` : `new patient created by ${by}`);
  return { patientId: pid, code, diffs: diffAgainstPatient(patientValues(db, pid), documentValues(db, docId)) };
}

export function registerDocument(db: Db, docId: string, diffs: Diff[], by: string): string | null {
  const doc = db.prepare("SELECT patient_id FROM documents WHERE id = ?").get(docId) as { patient_id: string };
  for (const d of diffs) writeField(db, doc.patient_id, d.after, docId, by);
  setState(db, "document", docId, "REGISTERED", `${diffs.length} values written to the patient record`);
  return (db.prepare("SELECT code FROM patients WHERE id = ?").get(doc.patient_id) as { code: string | null }).code;
}
