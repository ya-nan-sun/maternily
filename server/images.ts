// Original registry photos, encrypted at rest (AES-256-GCM) and stored apart
// from the records. Only the supervisor role can read them back.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

const dir = path.join(config.dataDir, "images");
fs.mkdirSync(dir, { recursive: true });

function loadKey(): Buffer {
  if (process.env.IMAGE_KEY) return Buffer.from(process.env.IMAGE_KEY, "base64");
  const keyFile = path.join(config.dataDir, ".image-key");
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(keyFile, "utf8"), "base64");
}
const KEY = loadKey();

export function storeImage(captureId: string, bytes: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const file = path.join(dir, `${captureId}.bin`);
  fs.writeFileSync(file, Buffer.concat([iv, cipher.getAuthTag(), body]));
  return path.relative(config.dataDir, file);
}

export function readImage(relPath: string): Buffer {
  const blob = fs.readFileSync(path.join(config.dataDir, relPath));
  const decipher = createDecipheriv("aes-256-gcm", KEY, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}
