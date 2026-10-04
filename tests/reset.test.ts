// The demo "erase everything" endpoint: off unless ALLOW_RESET=true, supervisor only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maternily-reset-"));
process.env.DATA_DIR = dataDir;
process.env.ALLOW_RESET = "true";
const { Agent } = await import("../server/agent.ts");
const { createApi } = await import("../server/api.ts");
const { openDb } = await import("../server/db.ts");
const { storeImage } = await import("../server/images.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("demo reset", () => {
  it("erases records, photos and messages but keeps midwives", async () => {
    const db = openDb(":memory:");
    const t = new Date().toISOString();
    db.prepare("INSERT INTO midwives (id, name, lang, created_at) VALUES ('m1', 'SF', 'fr', ?)").run(t);
    db.prepare("INSERT INTO patients (id, code, created_at) VALUES ('p1', '2026-1', ?)").run(t);
    db.prepare("INSERT INTO documents (id, midwife_id, state, opened_at, last_activity_at) VALUES ('d1', 'm1', 'NEEDS_REVIEW', ?, ?)").run(t, t);
    const img = storeImage("c1", Buffer.from("photo"));
    db.prepare(`INSERT INTO pages (capture_id, doc_id, midwife_id, page_no, content_hash, mime, image_path, captured_at, received_at, state)
      VALUES ('c1', 'd1', 'm1', 1, 'h', 'image/jpeg', ?, ?, ?, 'NEEDS_REVIEW')`).run(img, t, t);
    db.prepare("INSERT INTO outbound (id, midwife_id, payload, created_at) VALUES ('o1', 'm1', '{}', ?)").run(t);

    const server = createApi(db, new Agent(db), () => {}).listen(0);
    try {
      await new Promise((r) => server.once("listening", r));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/office/reset`;
      expect((await fetch(url, { method: "POST", headers: { "x-role-token": "analyst-demo" } })).status).toBe(403);
      expect((await fetch(url, { method: "POST", headers: { "x-role-token": "supervisor-demo" } })).status).toBe(200);
      for (const table of ["patients", "documents", "pages", "outbound"]) {
        expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0);
      }
      expect((db.prepare("SELECT COUNT(*) AS n FROM midwives").get() as { n: number }).n).toBe(1);
      expect(fs.readdirSync(path.join(dataDir, "images"))).toEqual([]);
      expect((db.prepare("SELECT action FROM access_log").all() as { action: string }[]).map((r) => r.action)).toEqual(["reset_all"]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
