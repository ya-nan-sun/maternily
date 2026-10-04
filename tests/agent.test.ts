// End-to-end conversation tests with the mock extractor: a simulated midwife
// sends registry photos, answers the agent's questions, and links patients.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { InboundMessage, OutboundMessage } from "../shared/messages.ts";
import { valuesEqual } from "../shared/normalize.ts";
import { Agent } from "../server/agent.ts";
import { openDb, type Db } from "../server/db.ts";
import { MockExtractor } from "../server/extraction/mock.ts";
import { Pipeline } from "../server/pipeline.ts";
import { patientValues } from "../server/records.ts";

const IMAGES = "dayone-participants/data/Paper Registry";
const index = JSON.parse(fs.readFileSync("eval/ground_truth/index.json", "utf8")) as {
  images: { file: string; pdfPage: number | null; patient: number | null; duplicateOf: string | null }[];
};
const pagesOf = (patient: number) => index.images.filter((i) => i.patient === patient && !i.duplicateOf).sort((a, b) => a.pdfPage! - b.pdfPage!);
const gt = (pdfPage: number) =>
  JSON.parse(fs.readFileSync(`eval/ground_truth/page-${String(pdfPage).padStart(2, "0")}.json`, "utf8")) as { fields: Record<string, { raw: string | null; value: unknown; status: string }> };

let db: Db;
let agent: Agent;
let pipeline: Pipeline;
let seq = 0;
const MID = "sf-001";

beforeEach(() => {
  db = openDb(":memory:");
  agent = new Agent(db, () => pipeline.kick());
  pipeline = new Pipeline(db, new MockExtractor(0), agent);
  seq = 0;
});

function inbound(kind: InboundMessage["kind"], extra: Partial<InboundMessage>, capturedAt = new Date().toISOString()): InboundMessage {
  return { id: randomUUID(), midwifeId: MID, kind, capturedAt, ...extra };
}
const photo = (file: string) => inbound("image", { image: { data: fs.readFileSync(path.join(IMAGES, file)).toString("base64"), mime: file.endsWith(".png") ? "image/png" : "image/jpeg" } });
const press = (buttonId: string) => agent.handle(inbound("button", { buttonId }));
const type = (text: string) => agent.handle(inbound("text", { text }));

function newMessages(): OutboundMessage[] {
  const rows = db.prepare("SELECT seq, payload FROM outbound WHERE midwife_id = ? AND seq > ? ORDER BY seq").all(MID, seq) as { seq: number; payload: string }[];
  if (rows.length) seq = rows[rows.length - 1].seq;
  return rows.map((r) => JSON.parse(r.payload));
}
const conv = () => JSON.parse((db.prepare("SELECT state FROM conversations WHERE midwife_id = ?").get(MID) as { state: string }).state);
const docState = (id: string) => (db.prepare("SELECT state FROM documents WHERE id = ?").get(id) as { state: string }).state;

/**
 * Play a careful midwife: confirm values that match the paper, correct the others
 * with the ground-truth value, and pick buttons according to `choose`.
 */
async function converse(choose: (ids: string[], msg: OutboundMessage) => string | undefined = () => undefined) {
  const transcript: OutboundMessage[] = [];
  const answered = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    await pipeline.drain();
    const msgs = newMessages();
    transcript.push(...msgs);
    // Duplicate-photo prompts are not part of the review queue: answer them as they come.
    const dupPrompt = transcript.find((m) => !answered.has(m.id) && m.buttons?.some((b) => b.id.startsWith("dup:")));
    if (dupPrompt) {
      answered.add(dupPrompt.id);
      const ids = dupPrompt.buttons!.map((b) => b.id);
      press(choose(ids, dupPrompt) ?? ids[0]);
      continue;
    }
    const c = conv();
    if (!c.active) return transcript;
    const last = [...transcript].reverse().find((m) => m.buttons?.length);
    if (!last) throw new Error("agent is waiting without a prompt");
    const ids = last.buttons!.map((b) => b.id);
    const custom = choose(ids, last);
    if (custom) {
      custom.startsWith("text:") ? type(custom.slice(5)) : press(custom);
      continue;
    }
    if (ids.includes("q:ok") || ids.includes("q:blank")) {
      const page = db.prepare("SELECT fields FROM pages WHERE capture_id = ?").get(c.active.captureId) as { fields: string };
      const f = JSON.parse(page.fields)[c.active.key];
      const truth = gt(pageNoOf(c.active.captureId)).fields[c.active.key];
      if (truth && truth.status === "KNOWN" && truth.raw && !valuesEqual(c.active.key, f.value, truth.value)) {
        press("q:edit");
        newMessages();
        type(truth.raw.replace(/\u0000/g, "e"));
      } else press(f.value === null ? "q:illegible" : "q:ok");
      continue;
    }
    const order = ["rv:start", "rv:confirm", "rv:useanyway", "code:none", "rd:all", "m:new"];
    const pick = order.find((o) => ids.includes(o));
    if (!pick) throw new Error(`no rule for buttons ${ids.join(", ")} after: ${last.text}`);
    press(pick);
  }
  throw new Error("conversation did not finish");
}

const hashToPdfPage = new Map<string, number>(
  (JSON.parse(fs.readFileSync("eval/ground_truth/index.json", "utf8")).images as { sha256: string; pdfPage: number | null }[])
    .filter((i) => i.pdfPage)
    .map((i) => [i.sha256, i.pdfPage!]),
);
function pageNoOf(captureId: string) {
  const { content_hash } = db.prepare("SELECT content_hash FROM pages WHERE capture_id = ?").get(captureId) as { content_hash: string };
  return hashToPdfPage.get(content_hash)!;
}

async function sendRegistry(patient: number) {
  for (const p of pagesOf(patient)) agent.handle(photo(p.file));
  press("done");
}

describe("multi-page registry, review and registration", () => {
  it("turns 8 photos into one validated patient record that matches the paper", async () => {
    await sendRegistry(1);
    const transcript = await converse();
    const docId = (db.prepare("SELECT id FROM documents").get() as { id: string }).id;
    expect(docState(docId)).toBe("REGISTERED");
    expect(transcript.some((m) => m.buttons?.some((b) => b.id === `report:${docId}`))).toBe(true);
    expect(transcript.some((m) => /pas sûr|not sure/.test(m.text))).toBe(true);

    const patients = db.prepare("SELECT id, code FROM patients").all() as { id: string; code: string }[];
    expect(patients).toHaveLength(1);
    expect(patients[0].code).toBe("2026-823-001");
    // The patient id is random, never derived from personal data.
    expect(patients[0].id).toMatch(/^[0-9a-f-]{36}$/);

    const values = patientValues(db, patients[0].id);
    let checked = 0;
    for (const p of pagesOf(1)) {
      for (const [key, truth] of Object.entries(gt(p.pdfPage!).fields)) {
        if (truth.status !== "KNOWN") continue;
        expect(values.get(key)?.value, key).toSatisfy((v: unknown) => valuesEqual(key, v, truth.value));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(250);

    // No direct identifier reaches the database.
    const dump = JSON.stringify(db.prepare("SELECT * FROM field_values").all()) + JSON.stringify(db.prepare("SELECT fields FROM pages").all());
    for (const banned of ["Tazi", "CB609814", "06 00 76 13 48", "Rue Al Qods", "Meryem"]) expect(dump).not.toContain(banned);
  });

  it("is idempotent when the device retries the same message", () => {
    const msg = photo(pagesOf(2)[0].file);
    expect(agent.handle(msg)).toBe(true);
    expect(agent.handle(msg)).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM pages").get() as { n: number }).n).toBe(1);
  });

  it("re-digitizes: duplicate photos are flagged, then linked to the existing record by form number", async () => {
    await sendRegistry(1);
    await converse();
    await sendRegistry(1);
    const transcript = await converse((ids) => {
      const dup = ids.find((i) => i.startsWith("dup:use:"));
      if (dup) return dup;
      return ids.find((i) => i.startsWith("m:") && !["m:new", "m:unsure"].includes(i));
    });
    expect(transcript.some((m) => /identique|identical/.test(m.text))).toBe(true);
    expect(transcript.some((m) => /même N° de fiche|same form number|same form/.test(m.text) || /correspond/.test(m.text))).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM patients").get() as { n: number }).n).toBe(1);
    const states = (db.prepare("SELECT state FROM documents ORDER BY opened_at").all() as { state: string }[]).map((d) => d.state);
    expect(states).toEqual(["REGISTERED", "REGISTERED"]);
    // Duplicates reuse the cached extraction: no second AI call for the same image.
    const calls = db.prepare("SELECT cached, COUNT(*) AS n FROM ai_calls GROUP BY cached").all() as { cached: number; n: number }[];
    expect(calls.find((c) => c.cached === 0)?.n).toBe(8);
  });

  it("sends 'I'm not sure' matches to the office instead of guessing", async () => {
    await sendRegistry(1);
    await converse();
    await sendRegistry(1);
    await converse((ids) => ids.find((i) => i.startsWith("dup:use:")) ?? (ids.includes("m:unsure") ? "m:unsure" : undefined));
    const states = (db.prepare("SELECT state FROM documents ORDER BY opened_at").all() as { state: string }[]).map((d) => d.state);
    expect(states).toEqual(["REGISTERED", "MANUAL_REVIEW_REQUIRED"]);
  });

  it("offers manual entry when the AI cannot read a photo", async () => {
    agent.handle(inbound("image", { image: { data: Buffer.from("synthetic unknown image for manual-entry test").toString("base64"), mime: "image/jpeg" } }));
    press("done");
    const transcript = await converse((ids, msg) => {
      if (ids.includes("fail:manual")) return "fail:manual";
      if (ids.includes("ms:COVER")) return "ms:COVER";
      if (/N° de la fiche/.test(msg.text)) return "text:2026-555-001";
      if (ids.includes("mv:stop")) return "mv:stop";
      return undefined;
    });
    expect(transcript.some((m) => /IA indisponible|AI unavailable/.test(m.text))).toBe(true);
    const p = db.prepare("SELECT code FROM patients").get() as { code: string };
    expect(p.code).toBe("2026-555-001");
    const page = db.prepare("SELECT state, entry FROM pages").get() as { state: string; entry: string };
    expect(page).toEqual({ state: "VALIDATED", entry: "manual" });
  });

  it("answers a file request with facts only", async () => {
    await sendRegistry(1);
    await converse();
    newMessages();
    type("dossier 2026-823-001");
    const [reply] = newMessages();
    expect(reply.text).toContain("2026-823-001");
    expect(reply.text).toMatch(/Visites prénatales enregistrées : 6/);
    expect(reply.text).not.toMatch(/risque|hypertension|danger/i);
  });

  it("logs every lifecycle transition through the state machine", async () => {
    await sendRegistry(1);
    await converse();
    const docId = (db.prepare("SELECT id FROM documents").get() as { id: string }).id;
    const path = (db.prepare("SELECT to_state FROM transitions WHERE subject_id = ? ORDER BY id").all(docId) as { to_state: string }[]).map((t) => t.to_state);
    expect(path).toEqual(["PENDING_AI", "AI_PROCESSED", "NEEDS_REVIEW", "VALIDATED", "PATIENT_MATCHED", "REGISTERED"]);
  });
});
