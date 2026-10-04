import { describe, expect, it } from "vitest";
import type { DocumentReport } from "../shared/messages.ts";
import { Agent } from "../server/agent.ts";
import { createApi } from "../server/api.ts";
import { openDb } from "../server/db.ts";
import { createReportPdf, reportMessage, whatsappReportMessage } from "../web/src/device/report.ts";

const report: DocumentReport = {
  documentId: "report-test-1234",
  createdAt: "2026-10-03T12:00:00.000Z",
  pageCount: 1,
  pages: [{ number: 1, section: "Current pregnancy", state: "VALIDATED", issues: [] }],
  fields: [{
    label: "Blood pressure",
    value: "110/70",
    status: "NEEDS_REVIEW",
    confidence: 0.6,
    reasons: ["One digit unclear"],
    pageNo: 1,
  }],
};

describe("registry report", () => {
  it("creates a downloadable PDF", async () => {
    const file = await createReportPdf(report, "en");
    expect(file.name).toBe("maternily-report-report-t.pdf");
    expect(file.type).toBe("application/pdf");
    expect(new TextDecoder().decode(await file.slice(0, 5).arrayBuffer())).toBe("%PDF-");
  });

  it("includes extracted values and review context in a complete share message", () => {
    const message = reportMessage(report, "en");
    expect(message).toContain("Blood pressure: 110/70");
    expect(message).toContain("NEEDS_REVIEW");
    expect(message).toContain("One digit unclear");
  });

  it("keeps long WhatsApp redirects compact and tells the recipient to attach the PDF", () => {
    const longReport = { ...report, fields: Array.from({ length: 80 }, (_, i) => ({
      ...report.fields[0],
      label: `Field ${i}`,
      value: "a".repeat(80),
    })) };
    const message = whatsappReportMessage(longReport, "en");
    expect(encodeURIComponent(message).length).toBeLessThanOrEqual(1800);
    expect(message).toContain("complete report is attached");
  });

  it("serves the registered report only to the midwife who owns it", async () => {
    const db = openDb(":memory:");
    const midwifeId = "sf-report-test";
    const docId = "doc-report-test";
    const captureId = "capture-report-test";
    db.prepare("INSERT INTO patients (id, code, created_at) VALUES (?, NULL, ?)").run("patient-report-test", report.createdAt);
    db.prepare(
      "INSERT INTO documents (id, midwife_id, state, opened_at, last_activity_at, patient_id) VALUES (?, ?, 'REGISTERED', ?, ?, ?)",
    ).run(docId, midwifeId, report.createdAt, report.createdAt, "patient-report-test");
    db.prepare(
      `INSERT INTO pages (capture_id, doc_id, midwife_id, page_no, content_hash, mime, image_path, captured_at, received_at, state, section, quality, fields)
       VALUES (?, ?, ?, 1, 'hash', 'image/jpeg', 'unused', ?, ?, 'VALIDATED', 'COVER', ?, ?)`,
    ).run(captureId, docId, midwifeId, report.createdAt, report.createdAt, JSON.stringify({ issues: ["blurry"] }), JSON.stringify({
      "cover.province": {
        key: "cover.province",
        value: "Rabat",
        raw: "Rabat",
        status: "KNOWN",
        confidence: 0.95,
        reasons: [],
        sourceCaptureId: captureId,
        confirmedBy: "MIDWIFE",
      },
    }));

    const app = createApi(db, new Agent(db), () => {});
    const server = app.listen(0);
    try {
      const address = await new Promise<{ port: number }>((resolve, reject) => {
        server.once("error", reject);
        server.once("listening", () => resolve(server.address() as { port: number }));
      });
      const url = `http://127.0.0.1:${address.port}/api/sim/${midwifeId}/documents/${docId}/report?lang=en`;
      const response = await fetch(url);
      expect(response.status).toBe(200);
      const body = await response.json() as DocumentReport;
      expect(body.fields[0]).toMatchObject({ label: "Province", value: "Rabat", pageNo: 1 });
      expect(body.pages[0].issues).toEqual(["Blurry photo"]);
      expect((await fetch(url.replace(midwifeId, "another-midwife"))).status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
    }
  });
});
