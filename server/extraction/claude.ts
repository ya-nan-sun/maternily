import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { OUTPUT_SCHEMA, SYSTEM_PROMPT } from "./prompt.ts";
import { AiUnavailableError, RawExtraction, type Extractor } from "./types.ts";

type ImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export class ClaudeExtractor implements Extractor {
  name = "claude";
  private client: Anthropic | null = null;

  constructor(public model = config.model, private effort = config.effort) {}

  /** Haiku 4.5 predates the effort control and server-side fallbacks; newer models take both. */
  private modelOptions() {
    if (this.model.startsWith("claude-haiku-4-5")) return { output_config: { format: { type: "json_schema" as const, schema: OUTPUT_SCHEMA } } };
    return {
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default" as const,
      output_config: { effort: this.effort, format: { type: "json_schema" as const, schema: OUTPUT_SCHEMA } },
    };
  }

  private getClient(): Anthropic {
    if (!this.client) {
      try {
        // Keys that are not scoped to a workspace must name one on every request.
        const workspace = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
        this.client = new Anthropic({ maxRetries: 2, ...(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}) });
      } catch (e) {
        throw new AiUnavailableError(`Claude client could not be created: ${(e as Error).message}`);
      }
    }
    return this.client;
  }

  /** Whole page: section detection plus every field. */
  extract(image: Buffer, mime: string) {
    return this.call(image, mime, "Transcribe this registry page.");
  }

  /**
   * Only the listed fields of a page whose section is already known. Used when the
   * free local OCR could not read a few cells: the output, which drives the cost,
   * stays a handful of fields instead of the whole page.
   */
  extractKeys(image: Buffer, mime: string, section: string, keys: string[]) {
    return this.call(
      image,
      mime,
      `This page is the ${section} section. Transcribe ONLY these fields and no others: ${keys.join(", ")}. ` +
        "Output each of them unless its box is completely blank. Use section " + section + ".",
    );
  }

  private async call(image: Buffer, mime: string, instruction: string) {
    const client = this.getClient();
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        ...this.modelOptions(),
        // Stable system prompt first, cached: only the image and a short line vary per request.
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mime as ImageMime, data: image.toString("base64") } },
              { type: "text", text: instruction },
            ],
          },
        ],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        throw new AiUnavailableError(`Claude API rejected the credentials: ${e.message}`);
      }
      if (e instanceof Anthropic.APIConnectionError) throw new AiUnavailableError(`Claude API unreachable: ${e.message}`);
      if (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message)) {
        throw new AiUnavailableError("The Anthropic account has no API credit (Console → Settings → Billing).");
      }
      if (e instanceof Anthropic.BadRequestError && /workspace/i.test(e.message)) {
        throw new AiUnavailableError("This API key is not scoped to a workspace: set ANTHROPIC_WORKSPACE_ID in .env, or create a workspace-scoped key.");
      }
      if (e instanceof Error && /authentication|api key/i.test(e.message) && !(e instanceof Anthropic.APIError)) {
        throw new AiUnavailableError(e.message);
      }
      throw e; // rate limits and 5xx are retried by the pipeline with backoff
    }

    if (response.stop_reason === "refusal") throw new Error(`Model declined: ${response.stop_details?.category ?? "unknown"}`);
    if (response.stop_reason === "max_tokens") throw new Error("Output truncated (max_tokens)");
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const raw = RawExtraction.parse(JSON.parse(text));
    const u = response.usage;
    return {
      raw,
      usage: {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
