# Maternily: a midwife, a phone and an AI

An offline-first, WhatsApp-style agent that turns photos of a paper maternal registry into a structured record. The midwife verifies the record, and each visit is linked to the woman's profile. Built for the DayOne challenge (CodeML).

The midwife keeps working on paper. She photographs the pages, even with no network, and sends them to one number. The DayOne office reads them with Claude. The agent then asks her only about what it is unsure of. Nothing is diagnosed or interpreted: the agent transcribes, checks and asks.

```
 Midwife's phone (simulated)                    DayOne server                               Office console
┌──────────────────────────────┐   HTTPS   ┌──────────────────────────────────────────┐   ┌───────────────────────┐
│ chat UI (WhatsApp-style)     │ ───────▶  │ channel adapter → InboundMessage          │   │ records, registries,  │
│ encrypted vault (PIN→AES-GCM)│           │ agent (deterministic, button-driven)      │◀──│ lifecycle log, photos │
│ ordered offline outbox       │ ◀───────  │ pipeline → Claude (1 call/photo, cached)  │   │ (role-restricted),    │
│ photo quality check          │   poll    │ parsing + plausibility checks (no AI)     │   │ dashboard, AI costs   │
└──────────────────────────────┘           │ SQLite + AES-GCM image store              │   └───────────────────────┘
                                           └──────────────────────────────────────────┘
```

## Quick start

Requirements: Node ≥ 22.13 (uses the built-in `node:sqlite`). Python 3.12 is optional for PaddleOCR or regenerating the ground truth.

```bash
npm ci                              # install the exact cross-platform dependency versions
npm run dev                         # http://localhost:5173 (hot reload; API on :8787)
# or, for the production-style server:
npm run build
npm start                           # http://localhost:8787 (server + built web app)
```

- On macOS, install Node ≥ 22.13 first (for example, `brew install node`), clone the repository, then run the commands above from the project directory.
- Without Claude credentials, the server starts in demo mode; synthetic sample pages work, while arbitrary photos use manual entry. For AI extraction, set `ANTHROPIC_API_KEY` in your shell or in an uncommitted `.env` file.
- After a registry is reviewed and registered, choose **View and share report** in the chat. Download the complete PDF or share it through the phone's native share sheet. The WhatsApp redirect pre-fills a text report; web links cannot attach a PDF, so attach the downloaded PDF manually when using the redirect.

### Local PaddleOCR (no Claude/cloud fallback)

Install 64-bit Python 3.12, then create the local environment and install the CPU OCR packages:

```bash
python3.12 -m venv ocr/.venv        # Windows PowerShell: py -3.12 -m venv ocr/.venv
ocr/.venv/bin/python -m pip install -r ocr/requirements.txt
```

On Windows PowerShell, run `py -3.12 -m venv ocr\.venv` followed by `.\ocr\.venv\Scripts\python.exe -m pip install -r ocr\requirements.txt`. Set `EXTRACTOR=template` and `AI_FALLBACK=none` in `.env` to use local PaddleOCR + form templates and send unreadable values to midwife review, never Claude. Optionally set `OCR_PYTHON` to the absolute path of a different Python interpreter with these packages installed, `OCR_PORT` to change the local OCR service port, or `OCR_CACHE_DIR` to isolate local OCR results. PaddleOCR downloads its recognition models the first time it starts.

On Windows CPU, the service disables oneDNN because PaddlePaddle 3.3.x currently crashes during oneDNN inference; other platforms retain PaddleOCR's default.

For faster CPU-only previews, set `OCR_MODEL_SIZE=tiny`; the default is `medium`.

- **With Claude:** `export ANTHROPIC_API_KEY=...` (or put it in `.env`) before starting. The extractor is `claude-opus-5-5` by default.
- **Without a key** the app runs in **demo mode**. Dataset pages are answered from the PDF-derived ground truth, with simulated doubts so that the review flow has something to ask. Any other photo goes to manual entry, which is also the required "AI unavailable" path. A banner shows which mode is active.

| Script | What it does |
|---|---|
| `npm test` | Parsing, lifecycle, offline outbox, report generation and full conversations end to end |
| `npm run eval -- --split test` | Field-level accuracy, status and calibration report on the held-out patients |
| `npm run gt` | Rebuild `eval/ground_truth/` from the registry PDF |
| `npm run typecheck` | TypeScript, strict |

Configuration (env or `.env`): `CLAUDE_MODEL`, `EXTRACTION_EFFORT` (`low` / `medium` / `high`, default `medium`), `REVIEW_THRESHOLD` (default 0.8), `SESSION_IDLE_MINUTES` (default 10), `EXTRACTOR` (`auto` / `template` / `claude` / `mock`), `AI_FALLBACK`, `OCR_PYTHON`, `OCR_PORT`, `OCR_MODEL_SIZE`, `OCR_CACHE_DIR`, `PORT`, `WEB_PORT`, `DATA_DIR`.

## Demo script (the four required moments)

1. **Offline capture.** Open *Midwife's phone* and unlock with PIN `1234`. Untick **Online**. Tap 🗂️, pick *Synthetic patient 1 → + all*, send, then type `terminé`. Every item waits in the **encrypted device queue** as `EN_ATTENTE_IA`.
2. **Connectivity returns.** Tick **Online**. To show a drop mid-upload, first enable *Slow network* and toggle offline during an upload: the item goes to `SYNC_FAILED` and is retried, in order, when you come back online. The pages upload, are read, and the agent groups them into one registry.
3. **Review of an uncertain field.** The agent shows each page's summary, then asks only about doubtful values. For each one it shows what it read, its confidence and the reason, with *Correct / Fix it / Illegible on paper*. "Fix it" takes typed values such as `110/70` or `11/7`, and those are parsed and checked.
4. **Match decision.** Send patient 1's pages again. The agent flags the identical photos (*Ignore / Use anyway*; no second AI call). It then proposes the existing patient with the same form number: `[Patient 1] [None, create new] [I'm not sure]`. If values differ, it shows *on file → photo* and lets the midwife choose what to update. "I'm not sure" hands the registry to the office (*DayOne office → Registries received*).

Also try `dossier 2026-823-001` (the patient's file before a visit, facts only), `aide`, `statut`, `langue`, a camera photo (no ground truth, so it goes to manual entry in demo mode), and switching the office role to *Analyst*: the analyst sees aggregates but not records or photos.

## Design choices

**Schema first, not OCR.** [shared/catalog.ts](shared/catalog.ts) defines all 479 fields of the registry in 8 sections, mirroring the paper. Each field has a type (date, BP, GA, lab result, checkbox group, …), French and English labels, units, plausible ranges and options. The antenatal visit table is longitudinal: `anc.<slot>.<row>` over 9 visit columns. **Direct identifiers have no field**, so there is nowhere to store a name, husband's name, CIN, phone or address.

**The AI transcribes; code interprets.** Claude gets one call per photo, with a cached system prompt built from the catalog. It returns `{section, quality, fields: [{key, as-written text, status, confidence}]}` through structured JSON output. Deterministic code ([shared/normalize.ts](shared/normalize.ts)) then does the interpreting:
- parses dates (`20/1/26`, year only), BP (`11/7` cmHg → 110/70 mmHg, flagged once for confirmation), GA (`16SA+3j`), units and decimal commas (`0,76g/L`, `186k`), and Eastern Arabic digits;
- runs range and cross-field checks ([shared/validate.ts](shared/validate.ts)): gravidity ≥ parity + abortions, EDD ≈ LMP + 280 d, GA vs visit dates, visit order.

All of this is reproducible, testable and free.

**Uncertainty is never hidden.** Every field carries `status` (KNOWN, UNKNOWN, NOT_PROVIDED, ILLEGIBLE, NOT_APPLICABLE, NEEDS_REVIEW), `confidence`, the raw text and its reasons.
- **Confidence combines several signals:** the model's self-report, capped by any parse failure, out-of-range value, cmHg conversion or inconsistency.
- **What gets asked:** anything below `REVIEW_THRESHOLD`, and anything ILLEGIBLE, becomes a question to the midwife.
- **Blanks and dashes are distinct:** a blank box is NOT_PROVIDED and a dash `—` is NOT_APPLICABLE, so an "N/A" never hides which one it was.
- **The midwife can be unsure too:** she can answer "illegible on paper" or "unknown", and that status is kept honestly.

**A bounded conversation, not a chatbot.** The agent ([server/agent.ts](server/agent.ts)) is a deterministic state machine of button-driven steps:
- the review steps: page summary, questions, edit, retake;
- the fallback steps: manual entry, and asking for the code;
- the record steps: matching and re-digitization.

The midwife never chats with the model, so cost per registry is predictable: one AI call per photo and nothing else. A field-by-field manual entry path covers *AI unavailable*, unrecognized pages and rejected photos.

**Offline-first device** ([web/src/device/](web/src/device/)). Every photo, text and button tap is written to an **encrypted vault** before anything else. The vault uses AES-GCM with a key derived from the PIN by PBKDF2 and is stored in IndexedDB. The outbox then sends messages **strictly in order** with idempotent IDs, so a retry after a drop can never duplicate a page. Once the server confirms registration, the device deletes its local copy of the photo and keeps a receipt.

**Server robustness.**
- *Idempotent ingest:* every message ID is remembered.
- *Persistent queue:* the processing queue lives in SQLite with exponential-backoff retries, so a restart resumes it.
- *Result cache:* AI results are cached per (image hash, prompt version, model). Duplicates, identical retakes and evaluation re-runs never pay twice.
- *Call log:* every AI call is logged with tokens and estimated cost.

**Patient linking** ([server/linking.ts](server/linking.ts)). The link is the **form number (N° de fiche)** already written on the booklet's cover, so the midwife's workflow is unchanged. Patient IDs are random UUIDs.
- **Missing or misread code:** the agent asks for it. A code one character away from an existing one counts as a candidate.
- **No code at all:** non-identifying features are scored (age ±1, province, G/P/L, LMP/EDD ±7 d, delivery date, birth weight).
- **Who decides:** plausible candidates are always shown with [Patient 1] [Patient 2] [None, create new] [I'm not sure]. The system never merges on its own.

**Multi-page sessions and re-digitization.**
- **Grouping:** photos from one midwife form one registry until she taps *Done*, 10 minutes of silence pass, or more than 10 minutes separate two capture times. That last rule handles bursts of offline photos that arrive together.
- **Facing pages:** pages of the same section merge, which covers the real booklet, where the visit table spans two facing pages.
- **Re-digitization:** when a known patient's registry is re-photographed, new values are added and *changed* values are listed for the midwife to accept, reject or pick individually. Every write goes to `field_history`.

**Privacy.**
- **Identifiers:** no direct identifier is requested, parsed or stored. A guard drops phone/ID-looking strings from free text, and a test asserts that the names, CIN, phone and address in the test registry never reach the database.
- **Original photos:** they are encrypted at rest (AES-256-GCM), stored apart from the records with record ID, capture date, midwife ID and processing state, and served only to the **supervisor** role. Every view is written to `access_log`.
- **Scope:** out-of-scope features (risk scores, triage colours, diagnosis) are absent. Range checks are worded as "please check the reading".

**Cost.** Each page costs one call: an image (~1.6k input tokens), a 6.2k-token system prompt read from cache at $0.20/M, and the output. There are no AI calls in the conversation, and cached duplicates, retakes and re-runs are free. The device's quality check also stops blurry or dark photos before upload. Measured cost per page appears in the office *AI usage* tab and in the eval report. Levers: `EXTRACTION_EFFORT=low`, or a cheaper `CLAUDE_MODEL`. Measure either with `npm run eval` before switching.

## Record lifecycle

One module, [shared/lifecycle.ts](shared/lifecycle.ts), defines the transitions. Both the device and the server use it, and every transition is logged with its reason (see *Registries received → Transition log*).

| State | Where | Meaning |
|---|---|---|
| CAPTURED | device | photo stored encrypted on the phone |
| PENDING_AI | device → server | queued: waiting for connectivity, then for AI processing |
| AI_PROCESSED | server | fields extracted (or extraction finished for every page) |
| NEEDS_REVIEW | server | the midwife is checking the pages |
| VALIDATED | server | every page confirmed |
| PATIENT_MATCHED | server | linked to an existing or new patient |
| REGISTERED | server | merged into the patient record |
| SYNCED | device + server | the device received the confirmation and deleted its local photo |
| SYNC_FAILED | device | upload failed or the connection dropped; retried in order with backoff |
| PROCESSING_FAILED | server | AI failed after retries, or is unavailable; the midwife gets *manual entry / retry / retake* |
| DUPLICATE_SUSPECTED | server | identical image already received; the midwife gets *ignore / use anyway* |
| MANUAL_REVIEW_REQUIRED | server | manual entry in progress, or the midwife was unsure of the match (resolved in the office) |

## Evaluation

**Ground truth.** The organizers did not ship per-page reference values. The 80 PNGs, however, are renders of `dossiers_specimen_10_patientes.pdf`, whose vector layer holds every handwritten glyph (with ToUnicode maps) and every checkbox mark.

**How it is derived.**
- [tools/pdf_ground_truth.py](tools/pdf_ground_truth.py) extracts those glyphs and marks, redacting identifiers.
- [eval/build-ground-truth.ts](eval/build-ground-truth.ts) maps them onto catalog keys using the template geometry.
- Result: **2,112 of 2,112 handwritten strings mapped, 478 checked boxes, 0 warnings**, written to [eval/ground_truth/](eval/ground_truth/). See [DATA_NOTES.md](DATA_NOTES.md).

**Split.** Split by patient: dev = patients 1–5, test = patients 6–10 (40 unique pages each). The 44 byte-identical duplicate files are excluded.

**Metrics** ([eval/run.ts](eval/run.ts)):
- section accuracy and field accuracy on filled fields, broken down by section, type, input kind and handwriting font;
- status confusion (blank vs dash vs value);
- **calibration** (accuracy per confidence bucket);
- **share of errors caught by a question** vs **silent errors**;
- AI cost.

Text comparison ignores accents and spacing. Glyphs missing from two of the handwriting fonts (they render as gaps) are matched as wildcards.

**Results.** *Not run against Claude yet: no API key was available in the environment where this was built.* With the mock, the harness reports ~97% accuracy, which only checks the harness (the mock replays the ground truth with injected noise). To produce the real numbers:

```bash
ANTHROPIC_API_KEY=... npm run eval -- --split dev     # tune on dev
ANTHROPIC_API_KEY=... npm run eval -- --split test    # report on test
```

## Known limitations

- **Claude has not been run yet.** The Claude extraction path ([server/extraction/claude.ts](server/extraction/claude.ts)) is written against the SDK's types but has not been exercised against the live API in this environment. Run the eval on a few dev pages first.
- **Arabic:** the provided data contains no Arabic handwriting (only a printed letterhead), so Arabic accuracy is unmeasured. The prompt and parsers handle Arabic text and Eastern Arabic digits.
- **Synthetic pages are clean.** None of the provided PNGs are degraded. The 5 real booklet photos (`1-*.jpg`) have no ground truth, use a different layout, write BP in cmHg and mark options by circling them. They are excluded from git, and sending them to the API needs an explicit `--include-real-photos`, because they may be real patient data.
- **Stored photos keep identifiers on paper.** Identifiers are never extracted, and the original photo is encrypted and supervisor-only, but it is not pixel-redacted.
- **One pregnancy per patient record** (one booklet = one record).
- **WhatsApp:** the WhatsApp Cloud API adapter is not implemented. The internal message format ([shared/messages.ts](shared/messages.ts)) is the integration point: reply buttons map to ≤3 buttons, longer choices to list messages.
- **Demo-grade deployment:** role tokens are demo values, SQLite runs on a single node, and the phone is simulated in the browser.

## Repository layout

```
shared/        catalog (schema), statuses, parsing, validation, lifecycle, message format (used by server and phone)
server/        agent (conversation), pipeline (queue + retries), extraction (Claude, mock, prompt, postprocess),
               linking, records, encrypted image store, HTTP API
web/src/       React app: phone simulator (device/: vault, outbox, quality check) and office console + dashboard
eval/          ground truth (committed, redacted), template geometry, builder, evaluation runner
tools/         PDF vector-layer extractor
tests/         vitest suites
DATA_NOTES.md  dataset inspection;  PROPOSAL.md  design decisions
```
