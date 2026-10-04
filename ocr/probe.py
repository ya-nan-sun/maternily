"""Feasibility probe: what does PaddleOCR see on a registry page?

Runs PaddleOCR on one image and prints every detected text line with its
position and confidence, split into printed (form) text and handwriting, so we
can judge (1) template detection from printed labels and (2) handwriting reading.

    ocr/.venv/bin/python ocr/probe.py "dayone-participants/data/Paper Registry/dossiers_specimen_10_patientes-02.png"
"""
import json
import sys
import time

from paddleocr import PaddleOCR

path = sys.argv[1]
lang = sys.argv[2] if len(sys.argv) > 2 else "fr"
started = time.time()
ocr = PaddleOCR(lang=lang, use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)
loaded = time.time()
result = ocr.predict(path)
done = time.time()

lines = []
for res in result:
    data = res.json.get("res", res.json)
    for text, score, poly in zip(data["rec_texts"], data["rec_scores"], data["rec_polys"]):
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        lines.append({"text": text, "score": round(float(score), 3), "box": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]})

print(json.dumps({"model_load_s": round(loaded - started, 1), "predict_s": round(done - loaded, 1), "lines": len(lines)}))
for line in sorted(lines, key=lambda l: (l["box"][1] // 12, l["box"][0])):
    print(f'{line["score"]:.2f}  {str(line["box"]):24}  {line["text"]}')
