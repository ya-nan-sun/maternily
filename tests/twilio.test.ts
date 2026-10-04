// Twilio WhatsApp sandbox adapter, against a stubbed Twilio API.

import { createHmac } from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../server/agent.ts";
import { OutboundDispatcher } from "../server/channels.ts";
import { openDb, type Db } from "../server/db.ts";
import { MockExtractor } from "../server/extraction/mock.ts";
import { Pipeline } from "../server/pipeline.ts";
import { processTwilio, resolveChoice, toTwilioText, twilioSender, twilioSignatureValid } from "../server/twilio.ts";

const WA = "12633827036";
const PAGE = "dayone-participants/data/Paper Registry/dossiers_specimen_10_patientes-01.png";
let db: Db;
let agent: Agent;
let pipeline: Pipeline;
let sent: URLSearchParams[];

beforeEach(() => {
  db = openDb(":memory:");
  agent = new Agent(db, () => pipeline.kick());
  pipeline = new Pipeline(db, new MockExtractor(0), agent);
  sent = [];
  let n = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://api.twilio.com/2010-04-01/Accounts/ACtest/Media/")) return new Response(fs.readFileSync(PAGE), { headers: { "content-type": "image/png" } });
    if (u.endsWith("/Messages.json")) {
      sent.push(new URLSearchParams(String(init?.body)));
      return Response.json({ sid: `SM${++n}` }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const msg = (sid: string, extra: Record<string, string>) => ({ MessageSid: sid, From: `whatsapp:+${WA}`, WaId: WA, ProfileName: "Yannick", NumMedia: "0", ...extra });
const body = (i = -1) => sent.at(i)!.get("Body")!;

describe("Twilio adapter", () => {
  it("checks Twilio's signature", () => {
    const params = { Body: "bonjour", From: "whatsapp:+1" };
    const sig = createHmac("sha1", "twilio-test-token").update("https://demo.example/webhook/twilio" + "Bodybonjour" + "Fromwhatsapp:+1").digest("base64");
    expect(twilioSignatureValid("https://demo.example/webhook/twilio", params, sig)).toBe(true);
    expect(twilioSignatureValid("https://demo.example/webhook/twilio", { ...params, Body: "x" }, sig)).toBe(false);
  });

  it("turns choices into a numbered list", () => {
    const text = toTwilioText({ id: "1", midwifeId: "tw:1", text: "Question ?", createdAt: "", buttons: [{ id: "q:ok", title: "C'est correct" }, { id: "q:edit", title: "Corriger" }] }, "fr");
    expect(text).toContain("1️⃣ C'est correct");
    expect(text).toContain("2️⃣ Corriger");
    expect(text).toContain("Répondez avec le numéro");
  });

  it("runs a registry through the sandbox: photo in, numbered prompts out, '1' taps the first choice", async () => {
    const dispatcher = new OutboundDispatcher(db, [twilioSender(db)], 0);
    await processTwilio(db, agent, msg("SMin1", { NumMedia: "1", MediaUrl0: "https://api.twilio.com/2010-04-01/Accounts/ACtest/Media/ME1", MediaContentType0: "image/png" }));
    await processTwilio(db, agent, msg("SMin2", { Body: "terminé" }));
    await pipeline.drain();
    await dispatcher.tick();

    expect((db.prepare("SELECT COUNT(*) AS n FROM pages").get() as { n: number }).n).toBe(1);
    expect(sent).toHaveLength(1); // receipt + grouping + first prompt merged into one WhatsApp message
    expect(sent[0].get("To")).toBe(`whatsapp:+${WA}`);
    expect(sent[0].get("StatusCallback")).toBe("https://demo.example/webhook/twilio/status");
    expect(body(0)).toMatch(/Page 1 reçue[\s\S]*regroupée[\s\S]*1️⃣/);

    const firstChoice = (JSON.parse((db.prepare("SELECT buttons FROM channel_prompts").get() as { buttons: string }).buttons) as { id: string }[])[0].id;
    await processTwilio(db, agent, msg("SMin3", { Body: "1" }));
    expect(db.prepare("SELECT kind, body FROM inbound WHERE id = 'SMin3:t'").get()).toMatchObject({ kind: "button", body: firstChoice });
  });

  it("treats a number as a value when the agent is asking for one", async () => {
    db.prepare("INSERT INTO midwives (id, name, lang, created_at, channel, phone) VALUES (?, 'Y', 'fr', ?, 'twilio', ?)").run(`tw:${WA}`, "", WA);
    db.prepare("INSERT INTO channel_prompts (midwife_id, buttons, at) VALUES (?, ?, '')").run(`tw:${WA}`, JSON.stringify([{ id: "mv:blank", title: "Pas écrit" }, { id: "mv:skip", title: "Passer" }, { id: "mv:stop", title: "Terminer la saisie" }]));
    db.prepare("INSERT INTO conversations (midwife_id, state) VALUES (?, ?)").run(`tw:${WA}`, JSON.stringify({ lang: "fr", collectingDocId: null, active: { docId: "d", step: "manual_value", key: "id.gravidity" } }));
    expect(resolveChoice(db, `tw:${WA}`, "3")).toBeNull(); // gravidity = 3, not "Terminer la saisie"
    expect(resolveChoice(db, `tw:${WA}`, "passer")).toBe("mv:skip"); // the word still works
  });
});
