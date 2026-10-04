// On-device photo checks, run before a capture is accepted. Rejecting an
// unreadable photo here saves an upload over a weak connection and an AI call.

export interface QualityReport {
  sharpness: number;
  brightness: number;
  issues: ("blurry" | "too_dark" | "too_bright")[];
}

export async function checkQuality(blob: Blob): Promise<QualityReport> {
  const bitmap = await createImageBitmap(blob);
  const w = 480;
  const h = Math.round((bitmap.height / bitmap.width) * w);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    sum += gray[i];
  }
  // Variance of the Laplacian: low means few sharp edges, i.e. blur.
  let lapSum = 0, lapSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      lapSum += lap;
      lapSq += lap * lap;
      n++;
    }
  }
  const sharpness = lapSq / n - (lapSum / n) ** 2;
  const brightness = sum / (w * h);
  const issues: QualityReport["issues"] = [];
  if (sharpness < 40) issues.push("blurry");
  if (brightness < 55) issues.push("too_dark");
  if (brightness > 245) issues.push("too_bright");
  return { sharpness, brightness, issues };
}

/** Phone photos can be several MB: shrink before storing and sending. Small images are kept byte-for-byte. */
export async function prepareImage(file: Blob): Promise<{ blob: Blob; mime: string }> {
  const bitmap = await createImageBitmap(file);
  const longest = Math.max(bitmap.width, bitmap.height);
  if (file.size < 1_500_000 && longest <= 2400) return { blob: file, mime: file.type || "image/jpeg" };
  const scale = Math.min(1, 2000 / longest);
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return { blob: await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 }), mime: "image/jpeg" };
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}
