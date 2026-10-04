# Maternily: a midwife, a phone and an AI

The midwife photographs the pages of a paper maternal registry and sends them on WhatsApp. Maternily reads them and asks her about any value it is unsure of. It saves a structured, verified record and links each visit to the woman's profile. Built for the DayOne challenge at CodeML.

The midwife keeps working on paper. She needs no app, no account and no signal while she works: photos sent offline go out when the phone reconnects. The agent reads, checks and asks. It never diagnoses or gives advice.

**State of the project (2026-10-04)**

- **Real WhatsApp, both directions, for free,** through the Vonage sandbox.
- **Page reading runs locally for free** (PaddleOCR + form templates). Claude is only an optional fallback for doubtful cells.
- **The full conversation, record lifecycle and patient linking work,** with 32 automated tests passing.
- **Held-out test pages: 98.1% field accuracy at $0, with no AI** (0.49% wrong values saved without asking).
- **Not done yet:** the demo video, Arabic, and the full photo flow over real WhatsApp. See [Status](#status).

```
 Midwife's phone                  DayOne laptop / server                                       Office (browser)
┌───────────────┐  WhatsApp   ┌──────────────────────────────────────────────────────────┐   ┌────────────────────┐
│ WhatsApp       │──(Vonage)──▶│ channel adapters ─▶ conversational agent (buttons/numbers)│   │ records, registries │
│ photos + text  │◀────────────│        │                    ▲                               │◀──│ lifecycle log,      │
│ (queued by     │             │        ▼                    │                               │   │ photos (role-gated) │
│  WhatsApp when │             │ processing queue ─▶ page reader:                             │   │ dashboard, AI usage │
│  offline)      │             │   1. PaddleOCR (local, free)  2. template: which page,       │   └────────────────────┘
└───────────────┘             │      which field  3. checkboxes by ink  4. parsing + checks   │
                               │   5. doubtful cells only ─▶ midwife │ Claude Code │ Claude API│
                               │ SQLite records · AES-256-GCM photo store · transition log    │
                               └──────────────────────────────────────────────────────────┘
```

## Status

| Area | State |
|---|---|
| Field schema (479 fields, 8 registry sections) and 6 field statuses | ✅ |
| Page reading: local OCR + template + checkbox ink + checks | ✅ measured on development pages (see [Evaluation](#evaluation)) |
| Fallback for doubtful cells: midwife / Claude Code / Claude API | ✅ midwife and Claude Code used and measured. The Claude API path is written but **has never run** (no API credit). |
| Review conversation: confirm / fix / retake, follow-up questions, manual entry, FR/EN | ✅ tested end to end |
| Multi-page sessions, duplicate photos, re-photographed registries | ✅ tested |
| Record lifecycle CAPTURED → … → SYNCED plus failure states, every transition logged | ✅ |
| Patient linking by form number, candidate matches, midwife decides | ✅ tested |
| Offline: encrypted device queue, connection drop mid-upload | ✅ in the phone simulator and tests. On real WhatsApp, WhatsApp's own queue does this. |
| Original photos: encrypted, linked to record / capture date / midwife / state, supervisor-only | ✅ |
| WhatsApp via **Vonage sandbox** | ✅ receive and send confirmed on a real phone. The full photo → review → save flow on real WhatsApp is **not tested yet**. |
| WhatsApp via **Meta Cloud API** (production path) | ✅ receiving works. ❌ Sending is blocked until the business is verified by Meta (DayOne can do this; we can't). |
| WhatsApp via **Twilio** | Built. ❌ The free trial rejects free-form messages, so it needs a paid account. |
| **Telegram** | Built (long polling, real buttons). Not tested live; no automated tests yet. |
| Office console, anonymized dashboard, AI usage log | ✅ |
| Held-out test-set evaluation (patients 6–10) | ✅ 98.1% field accuracy, local OCR only, $0 |
| Arabic handwriting | ❌ the provided data contains none |
| Demo video | ❌ |

## Quick start

Requirements:
- **Node ≥ 22.13** (the server uses the built-in `node:sqlite`);
- **Python 3.12** for the local OCR, installed here with [`uv`](https://docs.astral.sh/uv/).

```bash
npm install
cp .env.example .env                       # no keys needed to start

# Free local OCR (PaddleOCR, Apache-2.0). The models (~100 MB) download on first use.
uv venv --python 3.12 ocr/.venv
uv pip install --python ocr/.venv/bin/python paddlepaddle paddleocr

npm run build && npm start                 # http://localhost:8787
```

Open http://localhost:8787. **Midwife's phone** is a WhatsApp-style simulator, used to test and to demonstrate the offline queue (PIN `1234`). **DayOne office** is the console: role "Supervisor" sees records and photos; "Analyst" sees aggregates only.

What reads the pages depends on what's installed:

| Setting | Reader |
|---|---|
| `ocr/.venv` exists | **Local OCR + templates** (default). Doubtful cells → `AI_FALLBACK` |
| no OCR, Claude credentials set | Claude reads every page |
| neither | **Mock**: replays the dataset's answer key with simulated doubts, so the whole flow can be shown without OCR or keys |

`AI_FALLBACK` decides who resolves the cells local reading was unsure of:

| `AI_FALLBACK` | Who | Cost |
|---|---|---|
| `none` (default) | the midwife is asked in the chat | $0 |
| `claude-code` | headless Claude Code on this laptop (`claude -p`), using the logged-in plan. **For the team's own demos only**: a subscription isn't a way to run a product for others. | $0 per call |
| `claude` | Claude API key (`CLAUDE_MODEL`, default `claude-opus-5-5`). The production path for DayOne. | pay per page |

`npm run dev` runs the server with hot reload, plus Vite on :5173.

## Connecting a real phone

The server must be reachable from the internet. Run a tunnel next to it:

```bash
npm run tunnel
```

With `NGROK_AUTHTOKEN` and `NGROK_DOMAIN` in `.env` (free ngrok account), this opens a **permanent address**, so webhook URLs never change. Without them, it opens a temporary cloudflared address, which **expires and changes** on every start. The server finds the address itself; `PUBLIC_URL` overrides it.

### WhatsApp through the Vonage sandbox (used for the demo, free)

1. Create an account at dashboard.nexmo.com. Put the **API key** (8 characters) and **API secret** (16 characters) in `.env` as `VONAGE_API_KEY` / `VONAGE_API_SECRET`.
2. On **Developer Tools → Messages Sandbox → WhatsApp**, join from each demo phone: send the passphrase to **+1 415 738 6102**.
3. Start the server. It prints the **Inbound** and **Status** webhook URLs, which contain a secret key. Paste them into the sandbox page and click **Save webhooks**.
4. Send "bonjour" to +1 415 738 6102.

Limits: about **100 messages per month**. Choices are sent as a numbered list ("reply 1, 2 or 3"); a typed word also works, and a number counts as a value when the agent is asking for one. Bursts of agent messages are merged into one to save the quota.

### WhatsApp through Meta's Cloud API (production path for DayOne)

1. Put `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_WABA_ID` and `WHATSAPP_APP_SECRET` in `.env`.
2. Run `npm run whatsapp:setup`. It checks the token, connects the app to the WhatsApp Business Account, registers the webhook, subscribes to `messages`, and prints Meta's health status.

Messages use reply buttons (up to 3) or lists. Signatures are checked with the app secret. **Sending requires Meta business verification**, which needs a registered company: our hackathon account receives but cannot send.

### Telegram (free alternative)

Create a bot with @BotFather and set `TELEGRAM_BOT_TOKEN`. The server fetches updates itself (long polling), so no tunnel is needed. It uses real inline buttons.

### Twilio

`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`. The code is ready, but trial accounts reject free-form WhatsApp messages (error 21654), so it needs a paid account.

All channels share one dispatcher. It sends each midwife's messages in order and retries failures. On WhatsApp it never sends outside the free 24-hour window (anything late waits for her next message), so only free service messages are ever sent.

## How a registry is read

1. **Template.** Each paper form is registered once as a template ([templates/specimen-v1.json](templates/specimen-v1.json)): its printed labels and where each field sits. A new village's form is registered the same way.
2. **Local OCR** ([ocr/service.py](ocr/service.py)) runs PaddleOCR PP-OCRv6 on this machine. The photo never leaves it.
3. **Which page, and where.** Printed labels identify the template page, then a least-squares alignment maps the photo onto the template.
4. **Fields.** Handwriting is placed into fields by position ([shared/template.ts](shared/template.ts)). Each checkbox is read by measuring ink inside it, after snapping onto its printed border.
5. **Parsing and checks** ([shared/normalize.ts](shared/normalize.ts), [shared/validate.ts](shared/validate.ts)), all deterministic:
   - **Values:** dates in any format, blood pressure (`11/7` cmHg → 110/70 mmHg, confirmed once), gestational age (`16SA+3j`), units, decimal commas, Eastern Arabic digits.
   - **Plausibility:** values outside the plausible range of the field, and contradictions on the page (living children vs parity, gestational age vs visit date and LMP).

   They are worded as "please check the reading", never as clinical advice.
6. **Doubtful cells** (low OCR confidence, unparsable, out of range, inconsistent, or ink with no readable text) become `NEEDS_REVIEW` / `ILLEGIBLE`. With `AI_FALLBACK=claude-code` or `claude`, **one** targeted call per page asks only about those fields. Otherwise the midwife is asked.
7. **Unknown layouts** (a page that matches no template, such as the real booklet photos): whole-page Claude when a fallback is enabled, otherwise manual entry.

Results are cached per (image, pipeline version, model), and the raw OCR output per image, so a duplicate or identical retake never costs anything twice. Every AI call is logged with tokens and cost (office console → *AI usage*).

## The conversation

The agent ([server/agent.ts](server/agent.ts)) is a deterministic, button-driven state machine; the model is never used to chat.

- **Collecting pages:** photos from one midwife form one registry until she types *terminé* or 10 minutes pass. Identical photos get "Ignore / Use anyway", with no new AI call.
- **Per-page review:** each page gets a summary ("142 values read, 3 I'm not sure about"). For each doubt she sees what was read, the confidence and the reason, with **Correct / Fix it / Illegible on paper**. "Fix it" accepts typed values, which go through the same parsing and checks.
- **Other actions:** retake a photo, fix any field by name, and full **manual entry** when reading fails.
- **Linking:** by the form number (*N° de fiche*). Otherwise the agent proposes candidates from non-identifying fields (age ±1, gravidity/parity, LMP/EDD ±7 days, delivery date, birth weight): **[Patient 1] [Patient 2] [None, create new] [I'm not sure]**. "I'm not sure" goes to the office. The system never merges on its own.
- **Re-photographed registry:** new values are added; values that differ are listed as *on file → photo* for the midwife to accept, keep or pick.
- **Commands:** `dossier <N° de fiche>` returns the patient's file (facts only); `statut`, `aide`, `langue` (French ↔ English).

## Offline

**Real phone.** The midwife sends photos in WhatsApp with no signal. WhatsApp keeps them queued on the phone (🕓) and delivers them when it reconnects. Each page records when it was **captured** and when it was **received**. If the DayOne server itself is offline, Vonage retries delivering webhooks for up to 24 hours, and our processing queue lives in SQLite, so a restart loses nothing.

**Our own queue** ([web/src/device/](web/src/device/), shown in the phone simulator):
- Every photo, text and button tap is stored **AES-GCM encrypted** (key derived from the PIN, PBKDF2) before anything else.
- Items move through **CAPTURED → PENDING_AI**, then upload **in order** with idempotent IDs.
- A connection drop mid-upload gives **SYNC_FAILED**, then an automatic retry.
- After the server confirms registration, the photo is deleted from the device (**SYNCED**).

[tests/outbox.test.ts](tests/outbox.test.ts) cuts the connection mid-upload, then checks that nothing is lost, order is kept, the queue survives a restart, and a wrong PIN can't read it.

## Record lifecycle

One module, [shared/lifecycle.ts](shared/lifecycle.ts), defines the allowed transitions. Every transition is logged with a reason (office console → registry → *Transition log*).

| State | Meaning |
|---|---|
| CAPTURED | photo taken and stored on the device |
| PENDING_AI | queued: waiting for connectivity, then for reading |
| AI_PROCESSED | fields extracted |
| NEEDS_REVIEW | the midwife is checking |
| VALIDATED | every page confirmed |
| PATIENT_MATCHED | linked to an existing or new patient |
| REGISTERED | merged into the patient record |
| SYNCED | confirmation delivered to the phone (WhatsApp/Telegram receipt) or acknowledged by the device |
| SYNC_FAILED | upload or delivery failed; retried in order |
| PROCESSING_FAILED | reading failed or unavailable; the midwife gets manual entry / retry / retake |
| DUPLICATE_SUSPECTED | identical photo already received |
| MANUAL_REVIEW_REQUIRED | manual entry in progress, or match left to the office |

## Privacy and security

- **Identifiers can't be stored.** The schema has **no field** for the woman's name, husband's name, national ID, phone number or address. The OCR reader never assigns text near those labels, and a guard drops ID- or phone-looking text from free-text fields. Tests check that the names, ID and phone printed in the test registry never reach the database.
- **IDs and photos:**
  - Patient IDs are random UUIDs.
  - The midwife's own WhatsApp number (staff) is kept, because it's needed to reply.
  - Original photos are encrypted at rest (AES-256-GCM), stored apart from the records, and readable only by the supervisor role. Every view is logged.
- **Webhooks are authenticated:** Meta and Twilio signatures, and a secret key in the Vonage URLs.
- **Local processing:** the local OCR keeps photos in-house. With `AI_FALLBACK=none`, no registry content leaves the machine.
- **Out of scope by design:** risk scores, triage colours, diagnosis, treatment advice.

## Evaluation

**Answer key.** The organizers' 80 synthetic PNG pages are renders of `dossiers_specimen_10_patientes.pdf`, and the PDF's vector layer holds every handwritten value and checkbox mark.
- [tools/pdf_ground_truth.py](tools/pdf_ground_truth.py) extracts them (identifiers redacted), and [eval/build-ground-truth.ts](eval/build-ground-truth.ts) maps them onto fields.
- Result: **2,112 of 2,112 handwritten strings and 1,970 checkboxes**, in [eval/ground_truth/](eval/ground_truth/). See [DATA_NOTES.md](DATA_NOTES.md).

**Split.** By patient: **dev = patients 1–5, test = patients 6–10**, 40 unique pages each. 44 byte-identical duplicate files are excluded.

**Metrics** ([eval/evaluate.ts](eval/evaluate.ts)):
- field accuracy, by section, field type and handwriting font;
- status confusion (blank vs dash vs value);
- calibration, accuracy per confidence band;
- the share of mistakes turned into a question;
- silent errors (wrong and not asked about);
- cost.

Text comparison ignores accents and spacing.

**Measured results:**

| Configuration | Pages | Page type | Field accuracy | Mistakes asked about | Silent errors | Questions to midwife | Cost |
|---|---|---|---|---|---|---|---|
| **Local OCR only, held-out test** | **40 test pages (patients 6–10), never tuned on** | **100%** | **98.1%** of 1,230 values | 74% | 6 (0.49%) | 29 | **$0** |
| Local OCR only | 40 dev pages | 100% | 99.3% of 1,336 values | 78% | 2 (0.15%) | 17 | $0 |
| Local OCR + Claude Code | 8 dev pages (patient 1) | 100% | 99.6% of 259 values | — | 1 | 0 | $0 per call (plan) |

Notes:
- On the test pages, accuracy by handwriting font ranges from 96.0% to 99.6%.
- Calibration: values read with ≥ 80% confidence were right 99.6% of the time; 40–60% confidence, 33%.
- Local OCR takes about 30 s per page on this laptop's CPU (Apple M4).
- Remaining errors are mostly handwriting digits confused ("1" read as "7") and dropped digits. Most are caught by the checks and asked about.
- The 5 real booklet photos have no answer key and a different layout, and are excluded from git.

Reproduce:

```bash
npm run eval -- --split dev --extractor template --fallback none
npm run eval -- --split dev --extractor template --fallback claude-code --limit 8
npm run eval -- --split test --extractor template --fallback none     # the held-out number (98.1%)
npm run compare -- --extractor mock                                    # model comparison harness (dry run)
```

## Configuration

| Variable | Purpose |
|---|---|
| `EXTRACTOR` | `auto` (default), `template`, `claude`, `mock` |
| `AI_FALLBACK` | `none` (default), `claude-code`, `claude` |
| `OCR_MODEL_SIZE` | PaddleOCR PP-OCRv6 size: `medium` (default), `small`, `tiny` |
| `REVIEW_THRESHOLD` | confidence below which a value is asked about (default 0.8) |
| `SESSION_IDLE_MINUTES` | silence that closes a multi-page registry (default 10) |
| `CLAUDE_CODE_MODEL`, `CLAUDE_CODE_BIN` | model alias and binary for the Claude Code fallback |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID`, `CLAUDE_MODEL`, `EXTRACTION_EFFORT` | Claude API fallback |
| `NGROK_AUTHTOKEN`, `NGROK_DOMAIN` | permanent public address via `npm run tunnel` |
| `PUBLIC_URL` | overrides the public address (else `NGROK_DOMAIN`, else the cloudflared log) |
| `VONAGE_*`, `WHATSAPP_*`, `TWILIO_*`, `TELEGRAM_BOT_TOKEN` | messaging channels (see above) |
| `PORT`, `DATA_DIR`, `IMAGE_KEY`, `SUPERVISOR_TOKEN`, `ANALYST_TOKEN` | server, storage, demo roles |

## Repository layout

```
shared/        field catalog, statuses, parsing, checks, lifecycle, templates, message format
server/        agent (conversation), pipeline (queue + retries), channels (Vonage, Meta, Twilio, Telegram,
               shared dispatcher), extraction (OCR + template reader, Claude Code, Claude API, mock),
               linking, records, encrypted photo store, HTTP API
ocr/           local PaddleOCR service (Python)
templates/     registered paper forms
web/src/       office console + dashboard, phone simulator (device/: encrypted vault, offline outbox, photo check)
eval/          answer key (redacted), template geometry, evaluation and model comparison
tools/         PDF answer-key extractor, template builder, WhatsApp setup check
tests/         32 tests: parsing, lifecycle, offline queue, full conversations, Meta / Twilio / Vonage adapters
DATA_NOTES.md  dataset inspection        PROPOSAL.md  design decisions
```

## Known limitations and next steps

- **Not yet tested:** the full photo flow on real WhatsApp.
- **Real booklets:** only the synthetic form is registered as a template. The real booklet (different layout, cmHg blood pressure, circled options, cursive) goes to whole-page Claude or manual entry.
- **Arabic and English handwriting:** not covered by the provided data, so not measured.
- **Stored photos aren't pixel-redacted:** identifiers are never extracted, and photos are encrypted and supervisor-only.
- **One pregnancy per patient record** (one booklet = one record).
- **Demo-grade deployment:** a single laptop, temporary tunnel addresses, demo role tokens in the console. The Vonage sandbox allows ~100 messages per month.
- **Claude API path** written but not exercised; **Telegram** not tested live.
