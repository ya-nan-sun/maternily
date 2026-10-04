import fs from "node:fs";
import path from "node:path";

export function getOcrPythonPath(platform = process.platform, root = process.cwd(), override = process.env.OCR_PYTHON): string {
  if (override) return path.resolve(root, override);
  return path.join(root, "ocr", ".venv", platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python");
}

export function ocrInstalled(): boolean {
  return fs.existsSync(getOcrPythonPath());
}
