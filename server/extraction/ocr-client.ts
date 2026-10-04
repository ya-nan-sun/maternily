// Talks to the local PaddleOCR service (ocr/service.py), starting it if needed.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { getOcrPythonPath } from "../ocr-runtime.ts";
import { AiUnavailableError } from "./types.ts";

const PORT = Number(process.env.OCR_PORT ?? 8790);
const BASE = `http://127.0.0.1:${PORT}`;
const PYTHON = getOcrPythonPath();

export interface OcrLine { text: string; score: number; box: [number, number, number, number] }
export interface OcrPage { width: number; height: number; lines: OcrLine[]; seconds: number }

let child: ChildProcess | null = null;
let starting: Promise<void> | null = null;

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** Start the OCR service once per process; the first start downloads the models (~100 MB). */
export function ensureOcrService(): Promise<void> {
  if (starting) return starting;
  starting = (async () => {
    if (await healthy()) return;
    if (!fs.existsSync(PYTHON)) throw new AiUnavailableError(`Local OCR is not installed at ${PYTHON} (see README: ocr/.venv).`);
    fs.mkdirSync("work", { recursive: true });
    const log = fs.openSync("work/ocr.log", "a");
    child = spawn(PYTHON, ["ocr/service.py"], { stdio: ["ignore", log, log], env: { ...process.env, OCR_PORT: String(PORT) } });
    child.unref(); // do not keep Node alive just for the OCR service
    process.once("exit", () => child?.kill());
    for (let i = 0; i < 600; i++) {
      if (await healthy()) return;
      if (child.exitCode !== null) throw new AiUnavailableError("Local OCR service failed to start (see work/ocr.log).");
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new AiUnavailableError("Local OCR service did not start in time (see work/ocr.log).");
  })();
  starting.catch(() => (starting = null));
  return starting;
}

async function post<T>(route: string, body: unknown, retried = false): Promise<T> {
  await ensureOcrService();
  let r: Response;
  try {
    r = await fetch(`${BASE}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    // The service went away (restarted, or its parent process exited): start it again once.
    if (retried) throw e;
    starting = null;
    return post<T>(route, body, true);
  }
  const json = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(`OCR service: ${json.error ?? r.status}`);
  return json;
}

export const ocrPage = (image: Buffer) => post<OcrPage>("/ocr", { image: image.toString("base64") });
/** Ink inside rects. snap: first move each rect onto the printed square border found nearby (checkboxes). */
export const inkRatios = (image: Buffer, rects: number[][], snap = true) =>
  post<{ ratios: number[] }>("/ink", { image: image.toString("base64"), rects, snap }).then((r) => r.ratios);

/** Re-read single cells (cropped and enlarged) where ink was seen but no text was detected. */
export const readCrops = (image: Buffer, rects: number[][]) =>
  rects.length ? post<{ results: { text: string; score: number }[] }>("/crops", { image: image.toString("base64"), rects }).then((r) => r.results) : Promise.resolve([]);
