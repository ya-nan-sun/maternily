// A stand-in for the AI, used when no Claude credentials are configured and in
// tests. It replays the ground truth derived from the registry PDF for the
// dataset images it knows (matched by content hash), with deterministic noise
// so that the review flow has uncertain fields to ask about. Any other image
// is treated as "AI unavailable", which exercises the manual-entry path.
// It is NOT an extractor and never appears in accuracy numbers as one.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FIELD_BY_KEY } from "../../shared/catalog.ts";
import { AiUnavailableError, type Extractor, type RawExtraction } from "./types.ts";

const GT_DIR = "eval/ground_truth";

interface GtFile { section: string; fields: Record<string, { raw: string | null; status: string }> }

function loadIndex(): Map<string, string> {
  const file = path.join(GT_DIR, "index.json");
  if (!fs.existsSync(file)) return new Map();
  const index = JSON.parse(fs.readFileSync(file, "utf8")) as { images: { sha256: string; pdfPage: number | null }[] };
  const out = new Map<string, string>();
  for (const i of index.images) if (i.pdfPage) out.set(i.sha256, path.join(GT_DIR, `page-${String(i.pdfPage).padStart(2, "0")}.json`));
  return out;
}

/** Deterministic pseudo-random number in [0, 1) for a given seed string. */
function rand(seed: string): number {
  return createHash("sha256").update(seed).digest().readUInt32BE(0) / 2 ** 32;
}

function perturb(v: string, seed: string): string {
  const digits = [...v].map((ch, i) => (/\d/.test(ch) ? i : -1)).filter((i) => i >= 0);
  if (!digits.length) return v.length > 3 ? v.slice(0, -1) : v;
  const i = digits[Math.floor(rand(seed + "i") * digits.length)];
  const d = (Number(v[i]) + 1 + Math.floor(rand(seed + "d") * 8)) % 10;
  return v.slice(0, i) + d + v.slice(i + 1);
}

export class MockExtractor implements Extractor {
  name = "mock";
  model = "mock-ground-truth";
  private index = loadIndex();
  constructor(private latencyMs = 400) {}

  async extract(_image: Buffer, _mime: string, contentHash: string): Promise<{ raw: RawExtraction }> {
    await new Promise((r) => setTimeout(r, this.latencyMs));
    const file = this.index.get(contentHash);
    if (!file) throw new AiUnavailableError("Mock extractor: no transcription for this image (configure Claude to read new photos).");
    const gt = JSON.parse(fs.readFileSync(file, "utf8")) as GtFile;
    const fields: RawExtraction["fields"] = [];
    for (const [k, f] of Object.entries(gt.fields)) {
      const def = FIELD_BY_KEY.get(k);
      if (!def) continue;
      if (f.status === "NOT_PROVIDED") {
        if (def.input === "checkbox" && def.type !== "bool") fields.push({ k, v: "", s: "K", c: 0.95 });
        continue;
      }
      if (f.status === "NOT_APPLICABLE") {
        fields.push({ k, v: "—", s: "NA", c: 0.9 });
        continue;
      }
      let v = (f.raw ?? "").replace(/\u0000/g, "");
      let c = 0.97;
      let s: "K" | "I" = "K";
      const r = rand(contentHash + k);
      if (/\u0000/.test(f.raw ?? "")) c = 0.7; // a gap where a letter is missing
      else if (r < 0.01 && def.input === "written") {
        s = "I";
        c = 0.3;
      } else if (r < 0.04 && def.input === "written") {
        v = perturb(v, contentHash + k);
        c = 0.6;
      } else if (r < 0.1) c = 0.6;
      fields.push({ k, v, s, c });
    }
    return { raw: { section: gt.section, section_confidence: 0.98, page_usable: true, quality_issues: [], fields } };
  }
}
