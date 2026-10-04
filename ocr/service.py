"""Local OCR service: PaddleOCR (Apache 2.0) running on the DayOne machine. No API, no cost.

Loads the models once and answers two requests over HTTP on localhost:
  POST /ocr  {"image": <base64>}                      -> {"width", "height", "lines": [{"text", "score", "box": [x0, y0, x1, y1]}]}
  POST /ink  {"image": <base64>, "rects": [[x0, y0, x1, y1], ...]} -> {"ratios": [...]}  (share of dark pixels inside each rect)
  GET  /health

Images are processed in memory and never written to disk.

    ocr/.venv/bin/python ocr/service.py            # OCR_PORT (8790), OCR_MODEL_SIZE (tiny|small|medium)
"""
import base64
import io
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("DISABLE_MODEL_SOURCE_CHECK", "True")

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from paddleocr import PaddleOCR  # noqa: E402

SIZE = os.environ.get("OCR_MODEL_SIZE", "medium")
PORT = int(os.environ.get("OCR_PORT", "8790"))

started = time.time()
OCR = PaddleOCR(
    text_detection_model_name=f"PP-OCRv6_{SIZE}_det",
    text_recognition_model_name=f"PP-OCRv6_{SIZE}_rec",
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
    # PaddlePaddle 3.3.x CPU inference crashes through oneDNN on Windows.
    enable_mkldnn=sys.platform != "win32",
)
print(f"PaddleOCR PP-OCRv6 {SIZE} ready in {time.time() - started:.1f}s on port {PORT}", flush=True)


def decode(b64: str) -> np.ndarray:
    return np.array(Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB"))


def read_lines(rgb: np.ndarray) -> list:
    lines = []
    for res in OCR.predict(rgb[:, :, ::-1].copy()):  # PaddleOCR expects BGR
        data = res.json.get("res", res.json)
        for text, score, poly in zip(data["rec_texts"], data["rec_scores"], data["rec_polys"]):
            xs = [float(p[0]) for p in poly]
            ys = [float(p[1]) for p in poly]
            lines.append({"text": text, "score": round(float(score), 4), "box": [min(xs), min(ys), max(xs), max(ys)]})
    return lines


def ink_ratios(rgb: np.ndarray, rects: list, snap: bool = True) -> list:
    """Share of dark pixels inside each rect, away from its printed border.

    With snap, each rect is first moved (up to ~1/3 of its size) to where its printed
    square border actually is, so small alignment errors don't count the border as ink.
    """
    dark = rgb.min(axis=2) < 110  # handwriting ink and printed text; paper is lighter on every channel
    h, w = dark.shape
    out = []
    for x0, y0, x1, y1 in rects:
        bw, bh = int(round(x1 - x0)), int(round(y1 - y0))
        x0, y0 = int(round(x0)), int(round(y0))
        if snap and 6 <= bw <= 80 and 6 <= bh <= 80:
            reach = max(3, bw // 3)
            best, best_score = (0, 0), -1.0
            for dy in range(-reach, reach + 1):
                for dx in range(-reach, reach + 1):
                    a, c = x0 + dx, y0 + dy
                    if a < 1 or c < 1 or a + bw >= w - 1 or c + bh >= h - 1:
                        continue
                    border = (dark[c, a:a + bw].mean() + dark[c + bh, a:a + bw].mean() + dark[c:c + bh, a].mean() + dark[c:c + bh, a + bw].mean()) / 4
                    if border > best_score:
                        best, best_score = (dx, dy), border
            x0, y0 = x0 + best[0], y0 + best[1]
        mx, my = max(2, int(bw * 0.22)), max(2, int(bh * 0.22))
        region = dark[max(0, y0 + my):min(h, y0 + bh - my), max(0, x0 + mx):min(w, x0 + bw - mx)]
        out.append(round(float(region.mean()), 4) if region.size else 0.0)
    return out


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "model": f"PP-OCRv6_{SIZE}"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            rgb = decode(body["image"])
            if self.path == "/ocr":
                t = time.time()
                lines = read_lines(rgb)
                return self._send(200, {"width": rgb.shape[1], "height": rgb.shape[0], "lines": lines, "seconds": round(time.time() - t, 2)})
            if self.path == "/ink":
                return self._send(200, {"ratios": ink_ratios(rgb, body["rects"], body.get("snap", True))})
            self._send(404, {"error": "not found"})
        except Exception as e:  # report, keep serving
            self._send(500, {"error": str(e)})

    def log_message(self, *args):  # no request logging: requests carry registry images
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
