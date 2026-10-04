// Vonage WhatsApp sandbox adapter, against a stubbed Vonage API.

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../server/agent.ts";
import { OutboundDispatcher } from "../server/channels.ts";
import { openDb, type Db } from "../server/db.ts";
import { MockExtractor } from "../server/extraction/mock.ts";
import { Pipeline } from "../server/pipeline.ts";
import { processVonage, vonageSender, vonageWebhookUrls, webhookKey } from "../server/vonage.ts";

const PHONE = "15146911029";
const PAGE = "dayone-participants/data/Paper Registry/dossiers_specimen_10_patientes-01.png";
let db: Db;
let agent: Agent;
let pipeline: Pipeline;
let sent: any[];

beforeEach(() => {
  db = openDb(":memory:");
  agent = new Agent(db, () => pipeline.kick());
  pipeline = new Pipeline(db, new MockExtractor(0), agent);
  sent = [];
  let n = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://media.example/")) return new Response(fs.readFileSync(PAGE), { headers: { "content-type": "image/png" } });
    if (u === "https://messages-sandbox.nexmo.com/v1/messages") {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ message_uuid: `uuid-${++n}` }, { status: 202 });
    }
    return new Response("not found", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const inbound = (uuid: string, extra: object): any => ({ channel: "whatsapp", message_uuid: uuid, from: PHONE, to: "14157386102", timestamp: new Date().toISOString(), profile: { name: "ya nan" }, ...extra });

describe("Vonage adapter", () => {
  it("puts a secret key in the webhook URLs", () => {
    expect(vonageWebhookUrls().inbound).toContain(`/webhook/vonage/${webhookKey()}/inbound`);
    expect(webhookKey()).toHaveLength(24);
  });

  it("runs a registry through the sandbox with numbered choices", async () => {
    const dispatcher = new OutboundDispatcher(db, [vonageSender(db)], 0);
    await processVonage(db, agent, inbound("u1", { message_type: "image", image: { url: "https://media.example/1.png" } }));
    await processVonage(db, agent, inbound("u2", { message_type: "text", text: "terminé" }));
    await pipeline.drain();
    await dispatcher.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: "14157386102", to: PHONE, channel: "whatsapp", message_type: "text" });
    expect(sent[0].text).toMatch(/Page 1 reçue[\s\S]*regroupée[\s\S]*1️⃣/);

    await processVonage(db, agent, inbound("u3", { message_type: "text", text: "1" }));
    expect(db.prepare("SELECT kind FROM inbound WHERE id = 'u3'").get()).toMatchObject({ kind: "button" });
    // Vonage retries webhooks: the same message is processed once.
    await processVonage(db, agent, inbound("u3", { message_type: "text", text: "1" }));
    expect((db.prepare("SELECT COUNT(*) AS n FROM inbound WHERE id = 'u3'").get() as { n: number }).n).toBe(1);
  });
});
