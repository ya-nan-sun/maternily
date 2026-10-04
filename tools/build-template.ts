// Registers the synthetic specimen form as a template (templates/specimen-v1.json).
// Printed labels come from the blank form (here: the PDF's printed layer, identical
// for every patient); field positions come from eval/template-map.ts.
// A new village's form is registered the same way: blank pages -> labels (by OCR) + field positions.
//
//   npx tsx tools/build-template.ts

import fs from "node:fs";
import { SECTIONS } from "../shared/catalog.ts";
import type { Template, TemplatePage } from "../shared/template.ts";
import { IDENTIFIER_LINES, TEMPLATE } from "../eval/template-map.ts";

const raw = JSON.parse(fs.readFileSync("work/pdf_ground_truth_draft.json", "utf8")) as {
  page_in_record: number; patient_index: number; printed: { x: number; y: number; t: string }[];
}[];

// Not part of the form itself: the synthetic-data stamp and headers that embed a name.
const notForm = (t: string) => /SPÉCIMEN|Patiente fictive|\[REDACTED\]/.test(t) || !t.trim();

const pages: TemplatePage[] = raw
  .filter((p) => p.patient_index === 1)
  .map((p) => ({
    pageInRecord: p.page_in_record,
    section: SECTIONS[p.page_in_record - 1],
    title: p.printed[0].t,
    labels: p.printed.filter((l) => !notForm(l.t)).map((l) => ({ text: l.t.trim(), x: Math.round(l.x * 10) / 10, y: Math.round(l.y * 10) / 10 })),
    identifierLines: IDENTIFIER_LINES[p.page_in_record] ?? [],
    mappings: TEMPLATE[p.page_in_record],
  }));

const template: Template = {
  id: "specimen-v1",
  name: "Fiche de surveillance de la grossesse et du post-partum (spécimen synthétique)",
  pageSize: [595.2756, 841.8898],
  boxSize: 8,
  pages,
};
fs.mkdirSync("templates", { recursive: true });
fs.writeFileSync("templates/specimen-v1.json", JSON.stringify(template, null, 1));
console.log(`templates/specimen-v1.json: ${pages.length} pages, ${pages.reduce((s, p) => s + p.labels.length, 0)} labels, ${pages.reduce((s, p) => s + p.mappings.length, 0)} field positions`);
