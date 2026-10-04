"""Derive draft ground truth from the registry PDF's vector layer.

The 80 PNGs in `Paper Registry/` are renders of `dossiers_specimen_10_patientes.pdf`.
The PDF draws printed labels in Helvetica, "handwriting" one glyph at a time in a
per-patient handwriting font (with ToUnicode maps), and checkboxes as 8x8pt
rectangles with ink strokes on top. This script recovers, per page:

  - runs:  handwritten strings with their PDF position (x, y in pt, origin bottom-left)
  - boxes: every checkbox, whether it is marked, its label, and the mark style
  - printed: every printed label with position (to map runs to fields)

Direct identifiers (name, husband's name, CIN, phone, address) are replaced by
"[REDACTED]" before anything is written. Output is a raw draft: mapping runs to
schema fields is a separate step.

Usage: python3 tools/pdf_ground_truth.py <registry.pdf> <out.json>
Stdlib only.
"""
import base64
import json
import re
import sys
import zlib

FORM_INK = ".12 .08 .1"          # stroke colour of the printed form itself
PT_TO_PX = 1654 / 595.2756       # PNG renders are 1654x2339 px for an A4 page
PAGE_H = 841.8898

# Printed labels whose handwritten value on the same line is a direct identifier.
IDENTIFIER_LABELS = ("Nom/Prénom", "CIN", "Adresse", "Téléphone", "Nom du Mari", "Patiente :")
# Printed headers that embed the mother's name, e.g. "MÈRE — <name>".
NAME_IN_HEADER = re.compile(r"^(MÈRE — ).+$")

TOKEN = re.compile(
    rb"(?P<cm>[\d.\-]+ [\d.\-]+ [\d.\-]+ [\d.\-]+ (?P<cx>[\d.\-]+) (?P<cy>[\d.\-]+) cm)"
    rb"|/(?P<font>F\d+(?:\+0)?) [\d.]+ Tf"
    rb"|1 0 0 1 (?P<tx>[\d.\-]+) (?P<ty>[\d.\-]+) Tm"
    rb"|\((?P<str>(?:\\.|[^\\)])*)\)\s*Tj"
    rb"|(?P<rgb>[\d.]+ [\d.]+ [\d.]+) RG"
    rb"|n (?P<rx>[\d.]+) (?P<ry>[\d.]+) (?P<rw>[\d.]+) (?P<rh>[\d.]+) re S"
    rb"|(?:n )?(?P<path>[\d.\-]+ [\d.\-]+ m(?:\s+(?:[\d.\-]+ ){2,6}[lc])+)\s+S"
    rb"|(?P<restore>\bQ\b)"
)
MARK_STYLES = {"ml+ml": "X", "mll": "tick", "ml+ml+ml": "scribble"}


def read_objects(data):
    return {int(m.group(1)): m.group(2) for m in re.finditer(rb"(\d+) 0 obj\s*(.*?)endobj", data, re.S)}


def decode_stream(obj):
    i = obj.find(b"stream")
    header, body = obj[:i], obj[i + 6:].lstrip(b"\r\n")
    body = body[: body.rfind(b"endstream")].rstrip(b"\r\n")
    if b"ASCII85" in header:
        body = body.strip()
        body = base64.a85decode(body[:-2] if body.endswith(b"~>") else body)
    return zlib.decompress(body)


def load_fonts(objs):
    fonts = {}
    for name, ref in re.findall(rb"/(F\d+(?:\+0)?) (\d+) 0 R", objs[1]):
        fo = objs[int(ref)]
        base = re.search(rb"/BaseFont /(\S+)", fo).group(1).decode().split("+")[-1]
        cmap = {}
        tu = re.search(rb"/ToUnicode (\d+) 0 R", fo)
        if tu:
            cm = decode_stream(objs[int(tu.group(1))])
            for blk in re.findall(rb"beginbfchar(.*?)endbfchar", cm, re.S):
                for a, b in re.findall(rb"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>", blk):
                    cmap[int(a, 16)] = bytes.fromhex(b.decode()).decode("utf-16-be")
            for blk in re.findall(rb"beginbfrange(.*?)endbfrange", cm, re.S):
                for a, b, c in re.findall(rb"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>", blk):
                    for j, code in enumerate(range(int(a, 16), int(b, 16) + 1)):
                        cmap[code] = chr(int(c, 16) + j)
        fonts[name.decode()] = (base, cmap)
    return fonts


def unescape(s):
    out, i = bytearray(), 0
    while i < len(s):
        if s[i] == 92:  # backslash
            n = s[i + 1]
            if 48 <= n <= 55:
                j = i + 1
                while j < len(s) and j < i + 4 and 48 <= s[j] <= 55:
                    j += 1
                out.append(int(s[i + 1:j], 8))
                i = j
                continue
            out.append({110: 10, 114: 13, 116: 9, 98: 8, 102: 12}.get(n, n))
            i += 2
            continue
        out.append(s[i])
        i += 1
    return bytes(out)


def parse_page(content, fonts):
    font = cm = stroke = tx = ty = None
    printed, glyphs, boxes, ink_paths = [], [], [], []
    hand_font = ink = None
    for m in TOKEN.finditer(content):
        g = m.groupdict()
        if g["cm"]:
            cm = (float(g["cx"]), float(g["cy"]))
        elif g["restore"]:
            cm = None
        elif g["font"]:
            font = g["font"].decode()
        elif g["tx"]:
            tx, ty = float(g["tx"]), float(g["ty"])
        elif g["str"] is not None:
            raw = unescape(g["str"])
            base, cmap = fonts[font]
            if "+0" in font:  # embedded handwriting font
                hand_font = base
                # Glyphs missing from the font decode to "\x00" and render as a blank gap.
                glyphs.append((cm[0], cm[1], "".join(cmap.get(b, chr(b)) for b in raw)))
            else:
                printed.append({"x": tx, "y": ty, "t": raw.decode("cp1252")})
        elif g["rgb"]:
            stroke = g["rgb"].decode()
        elif g["rx"] and abs(float(g["rw"]) - 8) < 0.1 and abs(float(g["rh"]) - 8) < 0.1:
            boxes.append({"x": float(g["rx"]), "y": float(g["ry"]), "checked": False, "mark": None})
        elif g["path"] and stroke != FORM_INK:
            ink = stroke
            nums = [float(v) for v in re.findall(rb"[\d.\-]+", g["path"])]
            kinds = b"".join(re.findall(rb"[mlc]", g["path"])).decode()
            ink_paths.append((min(nums[0::2]), min(nums[1::2]), max(nums[0::2]), max(nums[1::2]), kinds))

    runs = []
    for x, y, ch in glyphs:
        if runs and abs(runs[-1]["y"] - y) < 4 and 0 < x - runs[-1]["_last_x"] < 13:
            runs[-1]["t"] += ch
            runs[-1]["_last_x"] = x
        else:
            runs.append({"x": round(x, 1), "y": round(y, 1), "t": ch, "_last_x": x})

    unmatched = set(range(len(ink_paths)))
    for b in boxes:
        for i, (x0, y0, x1, y1, kinds) in enumerate(ink_paths):
            if b["x"] - 4 <= x0 and x1 <= b["x"] + 12 and b["y"] - 4 <= y0 and y1 <= b["y"] + 12:
                b["checked"] = True
                b["mark"] = kinds if b["mark"] is None else b["mark"] + "+" + kinds
                unmatched.discard(i)
        if b["mark"]:
            b["mark"] = MARK_STYLES.get(b["mark"], b["mark"])
        right = [p for p in printed if abs(p["y"] - b["y"]) < 4 and 0 < p["x"] - b["x"] < 20]
        left = [p for p in printed if abs(p["y"] - b["y"]) < 4 and 0 < b["x"] - p["x"] < 60]
        label = right or sorted(left, key=lambda p: b["x"] - p["x"])
        b["label"] = label[0]["t"].strip() if label else None

    redact(runs, printed)
    for r in runs:
        r.pop("_last_x")
        r["missing_glyph"] = "\x00" in r["t"]
        r["px"] = [round(r["x"] * PT_TO_PX), round((PAGE_H - r["y"]) * PT_TO_PX)]
    return {
        "section": printed[0]["t"] if printed else None,
        "handwriting_font": hand_font,
        "ink_rgb": ink,
        "runs": runs,
        "boxes": boxes,
        "unmatched_ink_paths": len(unmatched),  # strokes outside boxes, e.g. cross-outs
        "printed": printed,
    }


def redact(runs, printed):
    for p in printed:
        if NAME_IN_HEADER.match(p["t"]):
            p["t"] = NAME_IN_HEADER.sub(r"\1[REDACTED]", p["t"])
        if p["t"].strip().startswith(IDENTIFIER_LABELS):
            for r in runs:
                if abs(r["y"] - p["y"]) < 5 and 0 < r["x"] - p["x"] < 240:
                    r["t"] = "[REDACTED]"
                    r["field_hint"] = p["t"].strip(" :")


def main(pdf_path, out_path):
    data = open(pdf_path, "rb").read()
    objs = read_objects(data)
    fonts = load_fonts(objs)
    pages = [o for _, o in sorted(objs.items()) if re.search(rb"/Type /Page\b(?!s)", o)]
    result = []
    for n, page in enumerate(pages, 1):
        content = decode_stream(objs[int(re.search(rb"/Contents (\d+)", page).group(1))])
        parsed = parse_page(content, fonts)
        parsed.update(pdf_page=n, patient_index=(n - 1) // 8 + 1, page_in_record=(n - 1) % 8 + 1)
        result.append(parsed)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f"{len(result)} pages, {sum(len(p['runs']) for p in result)} runs, "
          f"{sum(b['checked'] for p in result for b in p['boxes'])}/{sum(len(p['boxes']) for p in result)} boxes checked "
          f"-> {out_path}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
