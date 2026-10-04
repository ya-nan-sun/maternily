// Fallback reader that runs the locally installed Claude Code CLI in headless
// mode (`claude -p`), using whatever account is logged in on this machine.
//
// For live demos on the team's own laptop only: a Claude subscription is for the
// subscriber's own use and is not a way to run a product for other people. The
// production path is the API key (claude.ts); the free path is local OCR only.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OUTPUT_SCHEMA, SYSTEM_PROMPT } from "./prompt.ts";
import { AiUnavailableError, RawExtraction, type ExtractorUsage } from "./types.ts";

/** The `claude` binary: CLAUDE_CODE_BIN, then PATH, then the copy bundled with the VS Code extension. */
export function findClaudeCode(): string | null {
  if (process.env.CLAUDE_CODE_BIN && fs.existsSync(process.env.CLAUDE_CODE_BIN)) return process.env.CLAUDE_CODE_BIN;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "claude");
    if (fs.existsSync(candidate)) return candidate;
  }
  const extensions = path.join(os.homedir(), ".vscode", "extensions");
  if (fs.existsSync(extensions)) {
    const bundled = fs
      .readdirSync(extensions)
      .filter((d) => d.startsWith("anthropic.claude-code-"))
      .sort()
      .reverse()
      .map((d) => path.join(extensions, d, "resources", "native-binary", "claude"))
      .find((p) => fs.existsSync(p));
    if (bundled) return bundled;
  }
  return null;
}

interface CliResult {
  is_error: boolean;
  result?: string;
  structured_output?: unknown;
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
}

export class ClaudeCodeExtractor {
  name = "claude-code";
  model: string;

  constructor(private cliModel = process.env.CLAUDE_CODE_MODEL ?? "sonnet", private timeoutMs = 240_000) {
    this.model = `claude-code:${cliModel}`;
  }

  extract(image: Buffer, mime: string) {
    return this.call(image, mime, "Transcribe this registry page.");
  }

  extractKeys(image: Buffer, mime: string, section: string, keys: string[]) {
    return this.call(
      image,
      mime,
      `This page is the ${section} section. Transcribe ONLY these fields and no others: ${keys.join(", ")}. ` +
        `Output each of them unless its box is completely blank. Use section ${section}.`,
    );
  }

  private async call(image: Buffer, mime: string, instruction: string): Promise<{ raw: RawExtraction; usage?: ExtractorUsage }> {
    const bin = findClaudeCode();
    if (!bin) throw new AiUnavailableError("Claude Code CLI not found (set CLAUDE_CODE_BIN).");
    // The photo exists on disk only for the duration of the call.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maternily-"));
    const file = `page.${mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"}`;
    fs.writeFileSync(path.join(dir, file), image);
    try {
      const out = await run(bin, dir, this.timeoutMs, [
        "-p", `${instruction} The page image is the file ${file} in the current directory: open it with the Read tool.`,
        "--output-format", "json",
        "--json-schema", JSON.stringify(OUTPUT_SCHEMA),
        "--system-prompt", SYSTEM_PROMPT,
        "--tools", "Read",
        "--allowedTools", "Read",
        "--no-session-persistence",
        "--setting-sources", "",
        "--strict-mcp-config",
        "--model", this.cliModel,
      ]);
      let parsed: CliResult;
      try {
        parsed = JSON.parse(out) as CliResult;
      } catch {
        throw new AiUnavailableError(`Claude Code did not return JSON: ${out.slice(0, 200)}`);
      }
      if (parsed.is_error || !parsed.structured_output) {
        const msg = parsed.result ?? "no structured output";
        if (/log ?in|auth|credit|limit/i.test(msg)) throw new AiUnavailableError(`Claude Code: ${msg}`);
        throw new Error(`Claude Code: ${msg}`);
      }
      const u = parsed.usage;
      return {
        raw: RawExtraction.parse(parsed.structured_output),
        usage: u && { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens, cacheWriteTokens: u.cache_creation_input_tokens },
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function run(bin: string, cwd: string, timeoutMs: number, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Claude Code timed out"));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new AiUnavailableError(`Claude Code could not start: ${e.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (stdout.trim()) resolve(stdout);
      else reject(new AiUnavailableError(`Claude Code produced no output: ${stderr.slice(0, 300)}`));
    });
  });
}
