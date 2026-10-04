# Project journal: Maternily

What we built for the DayOne challenge (CodeML hackathon), the stack, and how we got here: the decisions, dead ends and measurements along the way. The [README](README.md) explains how to run the project; this file explains **why it looks the way it does**.

---

## 1. The challenge in one paragraph

In low-resource settings, midwives record prenatal, delivery and postpartum care in a multi-page **paper registry** (the Moroccan *Fiche de surveillance de la grossesse et du post-partum*). DayOne asked for a **WhatsApp agent** that turns photos of those pages into a structured record. The record must give every field a **status and confidence**, the **midwife verifies** it, and visits must be **linked** across time. It must work **offline-first**, store **no direct identifiers**, and keep the **original photo** under restricted access. Out of scope: risk prediction, triage, diagnosis, treatment advice.

Grading (100 points):
- extraction quality: 30
- uncertainty handling: 20
- review conversation: 20
- offline robustness: 15
- linking and privacy: 10
- code and docs: 5

Bonuses: a real WhatsApp sandbox, Arabic, an on-device photo check, an anonymized dashboard, a bilingual French/English interface.

---

## 2. The stack

| Layer | Technology | Why |
|---|---|---|
| Language | **TypeScript** end to end (Node 25, strict mode) | One language for the server, the web app and the shared logic. The field catalog, parsers and lifecycle state machine are written once and used everywhere. |
| Server | **Express 5**, Node's built-in **SQLite** (`node:sqlite`) | No native modules to compile, and a single file database. |
| Validation | **Zod** | Schemas for incoming messages and AI output |
| Web app | **React 19 + Vite** | Office console, dashboard, and a WhatsApp-style phone simulator |
| Page reading (free) | **PaddleOCR 3.7 / PP-OCRv6** (Apache 2.0) in a local Python service; form **templates**; checkbox reading by **ink measurement** | $0 per page; photos never leave the machine |
| AI fallback (optional) | **Headless Claude Code** (`claude -p`, the team's plan, demo only) or the **Claude API** (`@anthropic-ai/sdk`, default `claude-opus-5-5`, production path) | Only for cells the local reader is unsure of; one targeted call per page |
| Messaging | **Vonage WhatsApp sandbox** (demo), **Meta WhatsApp Cloud API** (production path), **Twilio**, **Telegram** | Channel adapters behind one dispatcher; the agent doesn't know which channel it's on |
| Public address | **ngrok** static domain (permanent); **cloudflared** quick tunnel (fallback) | Webhooks need a stable public HTTPS URL |
| Security | AES-256-GCM (photos at rest, server); AES-GCM + PBKDF2 (device vault); HMAC webhook signatures | The brief requires encryption and restricted access |
| Tests | **Vitest** (38 tests) | Parsing, lifecycle, offline queue, full conversations, channel adapters, OCR clean-up |
| Evaluation | Custom harness over an answer key extracted from the PDF | Field accuracy, calibration, silent errors, cost |
| Tooling | `uv` (Python env), Homebrew, `gh`, Playwright (UI checks, not in the repo) | |

---

## 3. Architecture

```
Midwife (WhatsApp) ──▶ Vonage / Meta / Twilio / Telegram adapter ──▶ Agent (deterministic, button-driven)
                                                                        │            ▲
                                                                        ▼            │
                                         Processing queue (SQLite, retries) ──▶ Page reader
                                             1. PaddleOCR reads lines (local)
                                             2. printed labels → which template page + alignment
                                             3. handwriting → fields by position; checkboxes by ink
                                             4. cleanup of OCR confusions, parsing, range/consistency checks
                                             5. doubtful cells → midwife | Claude Code | Claude API
                                                                        │
                       Records (patients, field values, history) · encrypted photo store · transition log
                                                                        │
                                              Office console: records, registries, photos (supervisor), dashboard, AI usage
```

Key files:

| Path | What it holds |
|---|---|
| [shared/catalog.ts](shared/catalog.ts) | The 479-field catalog |
| [shared/normalize.ts](shared/normalize.ts) | Parsing written values |
| [shared/validate.ts](shared/validate.ts) | Data-quality checks |
| [shared/lifecycle.ts](shared/lifecycle.ts) | The record state machine |
| [shared/template.ts](shared/template.ts) | Template geometry |
| [server/agent.ts](server/agent.ts) | The conversation |
| [server/extraction/template-extractor.ts](server/extraction/template-extractor.ts) | The page reader |
| [server/channels.ts](server/channels.ts) | The outbound dispatcher |
| [web/src/device/](web/src/device/) | The offline vault and outbox |

---

## 4. How we got here

### 4.1 Brainstorm: the idea before any code

The team's starting idea was **one phone number monitored by an AI on DayOne's side**. Midwives text photos when they have connectivity, WhatsApp queues them until then, and the AI fills a database. It isn't a chatbot: that keeps API costs under control, and nothing smart is needed on the midwife's phone.

The first review against the brief changed three things:
- **The "no conversation" idea would lose the 20-point review criterion.** We kept a *bounded* conversation instead: summaries, questions about doubtful fields, buttons. It's still not a chatbot.
- **Medical flags like "check her blood pressure" are out of scope.** We only flag *data quality* ("this value is outside the expected range, please check the reading") and return facts on request.
- **Names and patient phone numbers can't be used to link visits,** because the brief forbids storing identifiers. Linking uses a **code written on the registry**, with matching on non-identifying fields (age, gravidity/parity, dates) as a fallback, and **the midwife decides**. This also solves the "Anik / Yannick" spelling problem the team raised.

### 4.2 Looking at the data first ([DATA_NOTES.md](DATA_NOTES.md))

We inspected everything before writing code. What we found:
- **There was no answer key,** even though the brief promised reference values per page. The CSV (200 rows) doesn't match the images: we checked by matching birth weights.
- **Only 85 of the 129 images are unique.** 44 are byte-identical duplicates (Google Drive download artefacts).
- **The 80 PNGs are clean renders of a PDF.** That PDF's vector layer contains every handwritten value, written in five handwriting fonts, and every checkbox mark. We extracted it into an **exact answer key: 2,112 values and 1,970 checkboxes, with nothing unmatched**, and no manual labelling.
- **The 5 JPGs are photos of a real, used Ministry of Health booklet.** We kept them out of git and out of AI calls by default.
- **No Arabic handwriting anywhere,** only a printed letterhead.
- **Two handwriting fonts lack accented letters,** so "Collège" renders as "Coll ge". The evaluation tolerates these gaps.
- **The form has no patient-code box.** Decision: use the **N° de fiche** on the cover.

Decisions are recorded in [PROPOSAL.md](PROPOSAL.md):
- TypeScript
- a flat field catalog instead of a nested schema
- a dash `—` means NOT_APPLICABLE
- the split: patients 1–5 for development, 6–10 for testing

### 4.3 Building the core

- **Schema first:** 479 fields in 8 sections, 6 statuses (KNOWN, UNKNOWN, NOT_PROVIDED, ILLEGIBLE, NOT_APPLICABLE, NEEDS_REVIEW).
- **The AI transcribes, code interprets.** Deterministic parsers handle dates, blood pressure (with cmHg → mmHg, since Moroccan booklets write `11/7`), gestational age (`16SA+3j`), units, decimal commas and Arabic digits. Checks cover ranges, gravidity vs parity, due date vs last period, and gestational age vs visit dates.
- **The agent:**
  - multi-page sessions;
  - per-page summaries, then one question per doubtful field (Correct / Fix it / Illegible);
  - retakes, and manual entry when reading fails;
  - duplicate photos;
  - patient matching with [Patient 1] [Patient 2] [None, create new] [I'm not sure];
  - re-photographed registries (on file → photo differences);
  - `dossier <code>` file requests (facts only), in French and English.
- **Offline:** an encrypted device vault plus an ordered, idempotent outbox, tested with the connection cut mid-upload.
- **One lifecycle state machine,** shared by device and server, with every transition logged.
- **Office console** (roles: supervisor sees photos, analyst sees aggregates only) and an anonymized **dashboard**, whose palette was validated for colour blindness.
- **A mock reader** that replays the answer key with simulated doubts, so the whole flow could be built and tested before we had any AI access.

We checked it end to end: unit and conversation tests, an HTTP smoke test, and a headless-browser run of the full offline → review → registration flow, with screenshots reviewed and the issues they showed fixed.

### 4.4 The cost question

DayOne's priority is **minimal API cost**. Our first estimates:
- **Claude Opus** for every page: roughly **$0.25–0.40 per 8-page registry**.
- **A whole hackathon on Opus:** roughly $10–55, depending on effort.

We built a model comparison harness (`npm run compare`: Haiku vs Sonnet vs Opus against a fixed pass bar) and considered OpenAI and Gemini models. The conclusion: **make reading free first**, and use AI only as a fallback.

Getting API access hit three walls, in order:
1. the key required a workspace ID;
2. the account had **no API credit**;
3. the $100 credit turned out not to apply to the API.

So the Claude API path is written but has **never run**.

### 4.5 Free reading: PaddleOCR + templates

The approach came from the team: use OCR to understand the **form layout**, and register each village's form as a **template**.

- **First probe:** PaddleOCR found the printed labels almost perfectly, even on a skewed real photo. It read neat synthetic handwriting well, but real cursive poorly. Usefully, it showed low confidence on the cursive.
- **The pipeline:**
  1. Printed labels identify the template page, and a least-squares alignment maps the photo onto the template.
  2. Handwriting is assigned to fields by position. The ground-truth builder and the reader share this code, verified byte-identical.
  3. Checkboxes are read by ink inside each box, after snapping onto its printed border.
  4. Same-page consistency checks flag the "1 read as 7" cases.
- **Progress on development pages:** 78.8% → 97.7% → 98.1% (patient 1) → **96.2% on all 40 dev pages**. Then general clean-ups for OCR confusions (o/0, s/5, z/2, the unit "g" read as "9", underscores, a "/" read as "1" in blood pressure, plus a **re-read of cells with ink but no text**) brought it to **99.3% with 2 silent errors**, at $0.
- **Headless Claude Code as the fallback:** `claude -p` with a JSON schema and our own small system prompt, reading the photo. It correctly fixed the "1" that OCR misread as "7". The policy we documented: a Claude subscription is for the team's own demos, not for running a product for others, which needs an API key.
- **Three modes** (`AI_FALLBACK`):
  - `none` (the default): free, no keys, works for anyone who clones the repo;
  - `claude-code`: the live demo;
  - `claude`: production, for DayOne.

### 4.6 The WhatsApp saga

We wanted the demo on **real WhatsApp**, at zero cost.

| Attempt | Result |
|---|---|
| **Meta WhatsApp Cloud API** | Adapter built: webhook, signatures, photo download, buttons and lists, delivery receipts. Through the API we connected the app to the business account and subscribed to `messages` (the dashboard menus kept moving). **Receiving works.** Every reply failed with "Business Account locked". Meta's health API showed why: an incomplete profile (fixed), a payment method (fixed), then **business verification**, which needs a registered company. Dead end for a hackathon, but this stays the **production path for DayOne**. |
| **Twilio** | Adapter built. The trial's WhatsApp number rejects free-form messages (error 21654 "ContentSid Required"), and the template workaround is "not available on a Trial account". It would need a paid account (about $20), which we rejected to stay free. |
| **Telegram** | Adapter built (long polling, real buttons, no public URL needed). Kept as a backup; not tested live. |
| **Vonage sandbox** | ✅ **Works both ways, free.** Free-form text, about 100 messages per month, choices sent as numbers. A few hurdles: the key and secret had been swapped; the dashboard seemed to reject webhook URLs containing `?`, so the secret key moved into the path; and the webhooks only started arriving after a re-save. |

Infrastructure lessons:
- **Free cloudflared tunnels expire** ("Tunnel not found") and change address. We moved to a **permanent ngrok domain** (`npm run tunnel`).
- **To protect the Vonage quota,** the dispatcher merges bursts of agent messages into one. A "page received" message with only a "Done" button gets absorbed into the next message.
- **The free 24-hour window:** nothing is ever sent outside it, so only free service messages go out.

### 4.7 Hardening for the demo

- **Reconnection bursts:** when a phone comes back online, a photo can arrive after "terminé". Photos taken *before* "terminé" now stay in that registry.
- **OCR service restarts** are detected, and the service is restarted automatically.
- **The held-out test split** (patients 6–10) was run once, untuned. It scored **98.1% field accuracy**, with 6 silent errors (0.49%), 74% of mistakes turned into questions, and 100% of pages recognized, all at $0. By handwriting font: 96.0–99.6%. It passes the bar we set (≥ 95% accuracy, ≤ 1% silent errors, ≥ 70% of mistakes asked about).

### 4.8 Repository and team

- **GitHub:** `ya-nan-sun/maternily` (public). The `messaging-channels` work is merged into `main`. The README was rewritten to the current state.
- **Teammate branches:**
  - **Sahon, `feat/whatsapp-redirect`:** PDF registry report + sharing, Windows support for the OCR, pinned OCR versions, reader labels in the console, a photo-quality confirmation. Reviewed: good additions. To fix while merging: the report button doesn't work on real WhatsApp, the report endpoint has no login, and one conflict in `server/api.ts`.
  - **Ale, `AlesUI`:** a UI redesign. Not reviewed yet.

---

## 5. Measured results

| Configuration | Pages | Field accuracy | Silent errors | Questions to midwife | Cost |
|---|---|---|---|---|---|
| Local OCR only, before clean-ups | 40 dev | 96.2% | 6 (0.45%) | 54 | $0 |
| Local OCR only, after clean-ups | 40 dev | **99.3%** | 2 (0.15%) | 17 | $0 |
| Local OCR + Claude Code | 8 dev (patient 1) | 99.6% | 1 | 0 | $0 per call (team plan) |
| **Local OCR only, held-out test** | 40 test (patients 6–10), never tuned on | **98.1%** of 1,230 values | 6 (0.49%) | 29 | $0 |

Context:
- Page type is recognized on 100% of pages.
- Local OCR takes about 30 seconds per page on an Apple M4 CPU.
- None of the numbers above use the Claude API, which has never run.

---

## 6. Key decisions

| Decision | Reason |
|---|---|
| Schema first; the AI only transcribes | Testable, reproducible parsing and checks; smaller and cheaper AI output |
| A bounded, button-driven agent, never a chatbot | Predictable cost; it scores the review criterion |
| Data-quality flags only | Clinical advice is out of scope |
| No identifier fields at all | Privacy by construction; tests enforce it |
| Answer key taken from the PDF vector layer | Exact ground truth with zero manual labelling |
| Free local OCR first, AI as fallback | The sponsor's cost goal; data stays in-house |
| Form templates | Fixed paper forms make field positions known: no AI needed to locate fields |
| Vonage sandbox for the demo, Meta for production | Meta needs a verified company; Vonage is free and immediate |
| Merging outbound bursts, the 24-hour window | Quota and cost discipline |
| Stable ngrok address | Live demos can't depend on an expiring tunnel |

## 7. Gotchas worth remembering

- `.env` values: a space after `=`, the **App ID pasted as the App Secret** (Meta), the **API key and secret swapped** (Vonage). Validate shapes before blaming the code.
- **The Anthropic key needed a workspace ID**, and the API needs **API credit**: a Claude subscription doesn't pay for API calls.
- **Meta** test numbers still require business verification before *sending*. Check `health_status` through the Graph API, which is more reliable than the dashboard.
- **Twilio's trial** can't send free-form WhatsApp messages.
- **Free cloudflared quick tunnels expire.**
- **PaddleOCR on Windows** needs oneDNN disabled; Windows file names can't contain `:`.
- **Long-running child processes:** a spawned OCR service can keep Node alive (it needs `unref`), and it can die along with its parent (auto-restart was added).

## 8. Still to do

1. **Full photo flow on real WhatsApp** (Vonage): photos → "terminé" → questions → saved.
2. **Merge the teammates' branches** (Sahon reviewed, Ale pending), fixing the report button for WhatsApp.
3. **Demo video:** airplane-mode capture, reconnection, an uncertain field reviewed, a match decision.
4. **Optional:** a few Arabic test pages, a Vonage quota counter, moving the simulator out of the main screens, and a decision on the public repo containing the organizers' dataset.
