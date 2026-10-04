// WhatsApp Cloud API adapter, against a stubbed Graph API.

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboundMessage } from "../shared/messages.ts";
import { Agent } from "../server/agent.ts";
import { openDb, type Db } from "../server/db.ts";
import { MockExtractor } from "../server/extraction/mock.ts";
import { Pipeline } from "../server/pipeline.ts";
import { WhatsAppDispatcher, processWebhook, toWhatsApp } from "../server/whatsapp.ts";

const PHONE = "212600000001";
const PAGE = "dayone-participants/data/Paper Registry/dossiers_specimen_10_patientes-01.png";

let db: Db;
let agent: Agent;
let pipeline: Pipeline;
let sent: Record<string, any>[];

function stubGraph() {
  sent = [];
  let n = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://lookaside.example/")) return new Response(fs.readFileSync(PAGE), { headers: { "content-type": "image/png" } });
    if (u.includes("/media-1")) return Response.json({ url: "https://lookaside.example/media-1", mime_type: "image/png" });
    if (u.endsWith("/messages")) {
      const body = JSON.parse(String(init?.body));
      if (body.status === "read") return Response.json({ success: true });
      sent.push(body);
      return Response.json({ messages: [{ id: `wamid.out.${++n}` }] });
    }
    return new Response("not found", { status: 404 });
  });
}

const webhook = (messages: any[]): any => ({
  entry: [{ changes: [{ value: { contacts: [{ wa_id: PHONE, profile: { name: "Khadija" } }], messages } }] }],
});
const ts = () => String(Math.floor(Date.now() / 1000));

beforeEach(() => {
  db = openDb(":memory:");
  agent = new Agent(db, () => pipeline.kick());
  pipeline = new Pipeline(db, new MockExtractor(0), agent);
  stubGraph();
});
afterEach(() => vi.unstubAllGlobals());

describe("WhatsApp payloads", () => {
  it("uses reply buttons for up to 3 short choices and a list otherwise", () => {
    const base: OutboundMessage = { id: "o1", midwifeId: "wa:1", text: "Question ?", createdAt: "" };
    const [buttons] = toWhatsApp({ ...base, buttons: [{ id: "q:ok", title: "C'est correct" }, { id: "q:edit", title: "Corriger" }] }, PHONE, "fr");
    expect(buttons.interactive).toMatchObject({ type: "button" });
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `ms:${i}`, title: `Post-partum précoce — nouveau-né ${i}` }));
    const [list] = toWhatsApp({ ...base, buttons: many }, PHONE, "fr") as any[];
    expect(list.interactive.type).toBe("list");
    for (const row of list.interactive.action.sections[0].rows) expect(row.title.length).toBeLessThanOrEqual(24);
  });

  it("splits long text and keeps the interactive body under 1024 characters", () => {
    const out = toWhatsApp({ id: "o", midwifeId: "wa:1", text: "x".repeat(5000), createdAt: "", buttons: [{ id: "a", title: "OK" }] }, PHONE, "en") as any[];
    expect(out.slice(0, -1).every((p) => p.type === "text" && p.text.body.length <= 4096)).toBe(true);
    expect(out.at(-1).interactive.body.text.length).toBeLessThanOrEqual(1024);
  });
});

describe("WhatsApp webhook and dispatcher", () => {
  it("downloads a photo, runs the conversation, and replies on WhatsApp in order", async () => {
    await processWebhook(db, agent, webhook([{ from: PHONE, id: "wamid.in.1", timestamp: ts(), type: "image", image: { id: "media-1", mime_type: "image/png" } }]));
    await processWebhook(db, agent, webhook([{ from: PHONE, id: "wamid.in.2", timestamp: ts(), type: "text", text: { body: "terminé" } }]));
    await pipeline.drain();
    expect(db.prepare("SELECT state FROM pages").get()).toMatchObject({ state: "NEEDS_REVIEW" });
    const dispatcher = new WhatsAppDispatcher(db);
    await dispatcher.tick();

    expect(db.prepare("SELECT channel, phone, name FROM midwives").get()).toMatchObject({ channel: "whatsapp", phone: PHONE, name: "Khadija" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM pages").get() as { n: number }).n).toBe(1);
    // Receipt, "grouped" notice and the first review prompt were written back to back: one message, not three.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(PHONE);
    expect(JSON.stringify(sent[0])).toContain("Page 1 reçue");
    expect(JSON.stringify(sent[0])).toMatch(/regroupée/);
    expect(JSON.stringify(sent[0])).toContain("Page 1/1");

    // Tapping a reply button arrives as an interactive message.
    const last = sent.at(-1)!;
    const buttonId = last.interactive.action.buttons?.[0]?.reply.id ?? last.interactive.action.sections[0].rows[0].id;
    await processWebhook(db, agent, webhook([{ from: PHONE, id: "wamid.in.3", timestamp: ts(), type: "interactive", interactive: { type: "button_reply", button_reply: { id: buttonId, title: "x" } } }]));
    const before = sent.length;
    await dispatcher.tick();
    expect(sent.length).toBeGreaterThan(before);

    // Meta retries webhooks: the same message id is processed once.
    await processWebhook(db, agent, webhook([{ from: PHONE, id: "wamid.in.2", timestamp: ts(), type: "text", text: { body: "terminé" } }]));
    expect((db.prepare("SELECT COUNT(*) AS n FROM inbound WHERE id = 'wamid.in.2'").get() as { n: number }).n).toBe(1);
  });

  it("holds messages outside the free 24-hour window until the midwife writes again", async () => {
    await processWebhook(db, agent, webhook([{ from: PHONE, id: "wamid.in.1", timestamp: ts(), type: "text", text: { body: "aide" } }]));
    db.prepare("UPDATE inbound SET received_at = ?").run(new Date(Date.now() - 25 * 3600 * 1000).toISOString());
    agent.send(`wa:${PHONE}`, "Le bureau a rattaché votre registre.");
    const dispatcher = new WhatsAppDispatcher(db);
    await dispatcher.tick();
    expect(sent).toHaveLength(0);

    await processWebhook(db, agent, webhook([{ from: PHONE, id: "wamid.in.2", timestamp: ts(), type: "text", text: { body: "statut" } }]));
    await dispatcher.tick();
    expect(JSON.stringify(sent)).toContain("Le bureau a rattaché votre registre.");
  });

  it("marks a registered record SYNCED when its confirmation is delivered", async () => {
    db.prepare("INSERT INTO midwives (id, name, lang, created_at, channel, phone) VALUES (?, 'K', 'fr', ?, 'whatsapp', ?)").run(`wa:${PHONE}`, new Date().toISOString(), PHONE);
    db.prepare("INSERT INTO inbound (id, midwife_id, kind, body, received_at) VALUES ('x', ?, 'text', 'hi', ?)").run(`wa:${PHONE}`, new Date().toISOString());
    db.prepare("INSERT INTO documents (id, midwife_id, state, opened_at, last_activity_at) VALUES ('d1', ?, 'REGISTERED', ?, ?)").run(`wa:${PHONE}`, "", "");
    agent.send(`wa:${PHONE}`, "✅ Enregistré", undefined, { docId: "d1" });
    await new WhatsAppDispatcher(db).tick();
    await processWebhook(db, agent, { entry: [{ changes: [{ value: { statuses: [{ id: "wamid.out.1", status: "delivered", recipient_id: PHONE }] } }] }] });
    expect((db.prepare("SELECT state FROM documents WHERE id = 'd1'").get() as { state: string }).state).toBe("SYNCED");
  });
});
