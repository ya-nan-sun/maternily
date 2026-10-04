import { z } from "zod";
import { SECTIONS, type Section } from "../../shared/catalog.ts";
import type { FieldValue } from "../../shared/status.ts";

/** What an extractor returns: transcriptions only. Parsing happens in postprocess.ts. */
export const RawExtraction = z.object({
  section: z.enum([...SECTIONS, "UNKNOWN"] as unknown as [string, ...string[]]),
  section_confidence: z.number(),
  page_usable: z.boolean(),
  quality_issues: z.array(z.string()),
  fields: z.array(
    z.object({
      k: z.string(),
      v: z.string(),
      s: z.enum(["K", "I", "U", "NA"]),
      c: z.number(),
    }),
  ),
});
export type RawExtraction = z.infer<typeof RawExtraction>;

export interface PageExtraction {
  section: Section | "UNKNOWN";
  sectionConfidence: number;
  quality: { usable: boolean; issues: string[] };
  fields: Record<string, FieldValue>;
}

export interface ExtractorUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Extractor {
  name: string;
  model: string;
  extract(image: Buffer, mime: string, contentHash: string): Promise<{ raw: RawExtraction; usage?: ExtractorUsage; costUsd?: number; claudeCalls?: number }>;
}

/** The AI cannot be reached or is not configured: the midwife is offered manual entry. */
export class AiUnavailableError extends Error {}

/** Something that can read a whole page, or only some fields of it (Claude API or Claude Code). */
export interface FallbackReader {
  model: string;
  extract(image: Buffer, mime: string): Promise<{ raw: RawExtraction; usage?: ExtractorUsage }>;
  extractKeys(image: Buffer, mime: string, section: string, keys: string[]): Promise<{ raw: RawExtraction; usage?: ExtractorUsage }>;
}
