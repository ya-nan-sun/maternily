// The simulated midwife phone: a WhatsApp-style chat on top of an encrypted
// offline outbox. Toggle "offline" at any time, including mid-upload.

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { STATE_LABELS } from "../../shared/lifecycle.ts";
import type { Button, CaptureStatus, DocumentReport, InboundMessage, PollResponse } from "../../shared/messages.ts";
import { Outbox, type LocalState, type OutboxItem } from "./device/outbox.ts";
import { blobToBase64, checkQuality, prepareImage } from "./device/quality.ts";
import { createReportPdf, downloadReport, reportMessage, whatsappReportMessage } from "./device/report.ts";
import { Vault, deriveKey, indexedDbBackend } from "./device/vault.ts";
import { t, type UiLang } from "./i18n.ts";

const MIDWIVES = [
  { id: "sf-001", name: "Khadija — SF-001" },
  { id: "sf-002", name: "Fatima — SF-002" },
];

interface ChatEntry {
  id: string;
  from: "me" | "bot";
  text?: string;
  thumb?: string;
  buttons?: Button[];
  used?: boolean;
  at: string;
}
interface ChatState {
  entries: ChatEntry[];
  lastSeq: number;
  acked: string[];
}

interface Session {
  mid: string;
  vault: Vault;
  outbox: Outbox;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });

export function Phone({ lang }: { lang: UiLang }) {
  const [session, setSession] = useState<Session | null>(null);
  if (!session) return <Unlock lang={lang} onUnlock={setSession} />;
  return <PhoneApp key={session.mid} lang={lang} session={session} onLock={() => setSession(null)} />;
}

function Unlock({ lang, onUnlock }: { lang: UiLang; onUnlock: (s: Session) => void }) {
  const [mid, setMid] = useState(MIDWIVES[0].id);
  const [pin, setPin] = useState("1234");
  const [error, setError] = useState("");

  async function unlock() {
    setError("");
    const vault = new Vault(await deriveKey(pin, mid), indexedDbBackend(mid));
    try {
      const check = await vault.get<string>("check");
      if (!check) await vault.put("check", "ok");
    } catch {
      return setError(t(lang, "wrongPin"));
    }
    const transport = async (msg: InboundMessage, signal: AbortSignal) => {
      if ((window as unknown as { __slow?: boolean }).__slow) await sleep(3000, signal);
      const r = await fetch("/api/sim/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg), signal });
      if (!r.ok) throw new Error(`server ${r.status}`);
    };
    const outbox = new Outbox(vault, transport);
    await outbox.load();
    onUnlock({ mid, vault, outbox });
  }

  return (
    <div className="phone-layout">
      <div className="panel stack">
        <h2>🔐 {t(lang, "unlock")}</h2>
        <label className="stack small">
          {t(lang, "midwife")}
          <select value={mid} onChange={(e) => setMid(e.target.value)}>
            {MIDWIVES.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label className="stack small">
          {t(lang, "pin")}
          <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void unlock()} />
        </label>
        <p className="small muted">{t(lang, "pinHint")}</p>
        {error && <p className="small" style={{ color: "var(--bad)" }}>{error}</p>}
        <button className="btn primary" onClick={() => void unlock()}>{t(lang, "unlock")}</button>
      </div>
    </div>
  );
}

function PhoneApp({ lang, session, onLock }: { lang: UiLang; session: Session; onLock: () => void }) {
  const { mid, vault, outbox } = session;
  const [online, setOnline] = useState(true);
  const [slow, setSlow] = useState(false);
  const [chat, setChat] = useState<ChatState>({ entries: [], lastSeq: 0, acked: [] });
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [captures, setCaptures] = useState<Map<string, CaptureStatus>>(new Map());
  const [text, setText] = useState("");
  const [gallery, setGallery] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [report, setReport] = useState<DocumentReport | null>(null);
  const [reportFile, setReportFile] = useState<File | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState("");
  const [shareNotice, setShareNotice] = useState("");
  const [photoCheck, setPhotoCheck] = useState<{ blob: Blob; mime: string; label: string; thumb: string; issues: string[] } | null>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const chatState = useRef(chat);
  const loaded = useRef(false);

  // Load the encrypted chat history once.
  useEffect(() => {
    void vault.get<ChatState>("chat").then((c) => {
      if (c) setChat(c);
      loaded.current = true;
    });
  }, [vault]);
  useEffect(() => {
    chatState.current = chat;
    if (loaded.current) void vault.put("chat", chat);
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [chat, vault]);

  useEffect(() => {
    const refresh = () => {
      setItems(outbox.list());
      setUploading(outbox.uploadingId);
    };
    refresh();
    const unsubscribe = outbox.subscribe(refresh);
    return () => void unsubscribe();
  }, [outbox]);

  useEffect(() => outbox.setOnline(online), [online, outbox]);
  useEffect(() => {
    (window as unknown as { __slow?: boolean }).__slow = slow;
  }, [slow]);

  // Poll the server for replies while online.
  useEffect(() => {
    if (!online) return;
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch(`/api/sim/${mid}/poll?since=${chatState.current.lastSeq}`);
        const body = (await r.json()) as PollResponse;
        if (stop) return;
        if (body.messages.length) {
          setChat((c) => ({
            ...c,
            lastSeq: body.lastSeq,
            entries: [...c.entries, ...body.messages.map((m): ChatEntry => ({ id: m.id, from: "bot", text: m.text, buttons: m.buttons, at: m.createdAt }))],
          }));
        }
        const map = new Map(body.captures.map((c) => [c.captureId, c]));
        setCaptures(map);
        // Registered records: confirm to the server, then drop local photos.
        const registered = new Map<string, string[]>();
        for (const c of body.captures) {
          if (c.docState === "REGISTERED" || c.docState === "SYNCED") registered.set(c.docId, [...(registered.get(c.docId) ?? []), c.captureId]);
        }
        for (const [docId, ids] of registered) {
          if (!chatState.current.acked.includes(docId)) {
            const ack = await fetch(`/api/sim/${mid}/ack`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ docId }) });
            if (ack.ok) setChat((c) => ({ ...c, acked: [...c.acked, docId] }));
          }
          await outbox.markSynced(ids);
        }
      } catch {
        /* network error: try again next tick */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [online, mid, outbox]);

  const pushMine = (entry: Omit<ChatEntry, "from" | "at">) =>
    setChat((c) => ({ ...c, entries: [...c.entries, { ...entry, from: "me", at: new Date().toISOString() }] }));

  const sendText = useCallback(async (value: string) => {
    if (!value.trim()) return;
    const msg: InboundMessage = { id: crypto.randomUUID(), midwifeId: mid, kind: "text", text: value.trim(), capturedAt: new Date().toISOString() };
    pushMine({ id: msg.id, text: msg.text });
    await outbox.add(msg, `💬 ${value.trim().slice(0, 40)}`);
  }, [mid, outbox]);

  async function tapButton(entry: ChatEntry, b: Button) {
    if (b.id.startsWith("report:")) {
      setReport(null);
      setReportFile(null);
      setReportError("");
      setShareNotice("");
      setReportLoading(true);
      try {
        const docId = b.id.slice("report:".length);
        const response = await fetch(`/api/sim/${encodeURIComponent(mid)}/documents/${encodeURIComponent(docId)}/report?lang=${lang}`);
        if (!response.ok) throw new Error(`report request failed (${response.status})`);
        const data = await response.json() as DocumentReport;
        const file = await createReportPdf(data, lang);
        setReport(data);
        setReportFile(file);
      } catch (error) {
        console.error("Could not load registry report", error);
        setReportError(t(lang, "reportError"));
      } finally {
        setReportLoading(false);
      }
      return;
    }
    setChat((c) => ({ ...c, entries: c.entries.map((e) => (e.id === entry.id ? { ...e, used: true } : e)) }));
    const msg: InboundMessage = { id: crypto.randomUUID(), midwifeId: mid, kind: "button", buttonId: b.id, capturedAt: new Date().toISOString() };
    pushMine({ id: msg.id, text: b.title });
    await outbox.add(msg, `🔘 ${b.title}`);
  }

  async function sendImage(file: Blob, label: string, askOnIssues = true) {
    const { blob, mime } = await prepareImage(file);
    const q = await checkQuality(blob);
    if (askOnIssues && q.issues.length) {
      setPhotoCheck({ blob, mime, label, thumb: await thumbnail(blob), issues: q.issues });
      return;
    }
    await queuePhoto(blob, mime, label);
  }

  async function queuePhoto(blob: Blob, mime: string, label: string, preview?: string) {
    const msg: InboundMessage = {
      id: crypto.randomUUID(), midwifeId: mid, kind: "image",
      image: { data: await blobToBase64(blob), mime }, capturedAt: new Date().toISOString(),
    };
    pushMine({ id: msg.id, thumb: preview ?? await thumbnail(blob) });
    await outbox.add(msg, `📷 ${label}`);
  }

  function saveReport() {
    if (!reportFile) return;
    downloadReport(reportFile);
  }

  function shareReport(event: MouseEvent<HTMLAnchorElement>) {
    if (!report || !reportFile) return;
    const file = reportFile;
    const text = reportMessage(report, lang);
    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      event.preventDefault();
      void nav.share({ files: [file], text, title: t(lang, "reportTitle") }).then(() => {
        setShareNotice("");
      }).catch((error: unknown) => {
        if (error instanceof Error && error.name !== "AbortError") {
          console.error("Could not share registry report", error);
          setReportError(t(lang, "reportError"));
        }
      });
      return;
    }
    downloadReport(file);
    setShareNotice(t(lang, "reportAttach"));
  }

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const whatsappHref = report ? `https://wa.me/?text=${encodeURIComponent(whatsappReportMessage(report, lang))}` : undefined;
  // Only the latest prompt is answerable; duplicate-photo questions stay open until answered.
  const lastPrompt = chat.entries.reduce((last, e, i) => (e.from === "bot" && e.buttons?.length ? i : last), -1);
  const stale = (e: ChatEntry, i: number) => i < lastPrompt && !e.buttons?.some((b) => b.id.startsWith("dup:"));
  const pendingCount = items.filter((i) => ["CAPTURED", "PENDING_AI", "SYNC_FAILED"].includes(i.state)).length;

  return (
    <div className="phone-layout">
      <div className="phone">
        <div className="phone-header">
          <div className="avatar">D1</div>
          <div style={{ flex: 1 }}>
            <strong>DayOne Registre</strong>
            <small>{online ? t(lang, "online") : `${t(lang, "offline")} · ${pendingCount} ⏳`}</small>
          </div>
          <button className="icon-btn secondary" title="Lock" onClick={onLock}>🔒</button>
        </div>
        <div className="chat" ref={chatRef}>
          {chat.entries.length === 0 && (
            <div className="bubble bot welcome">
              <strong>{t(lang, "welcomeTitle")}</strong>
              <p>{t(lang, "welcomeText")}</p>
              <span className="small muted">{t(lang, "firstSteps")}</span>
            </div>
          )}
          {chat.entries.map((e, idx) => (
            <div key={e.id} className={`bubble ${e.from}`}>
              {e.thumb && <img src={e.thumb} alt="" />}
              {e.text}
              {e.buttons && (
                <div className="buttons">
                  {e.buttons.map((b) => (
                    <button key={b.id} disabled={e.used || stale(e, idx)} onClick={() => void tapButton(e, b)}>{b.title}</button>
                  ))}
                </div>
              )}
              <div className="meta">
                {new Date(e.at).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })}
                {e.from === "me" && <> {tick(byId.get(e.id)?.state, uploading === e.id)}</>}
              </div>
            </div>
          ))}
        </div>
        <form className="composer" onSubmit={(ev) => { ev.preventDefault(); void sendText(text); setText(""); }}>
          <label className="icon-btn secondary" title={t(lang, "camera")}>
            📷
            <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(ev) => {
              const f = ev.target.files?.[0];
              if (f) void sendImage(f, f.name);
              ev.target.value = "";
            }} />
          </label>
          <button type="button" className="icon-btn secondary" title={t(lang, "gallery")} onClick={() => setGallery(true)}>🗂️</button>
          <input type="text" value={text} placeholder={t(lang, "typeMessage")} onChange={(e) => setText(e.target.value)} />
          <button className="icon-btn" type="submit" title={t(lang, "send")}>➤</button>
        </form>
      </div>

      <div className="stack">
        <div className="panel">
          <h2>📤 {t(lang, "queue")}</h2>
          {items.length === 0 ? <p className="muted small">{t(lang, "queueEmpty")}</p> : (
            <ul className="queue">
              {[...items].reverse().map((i) => {
                const server = captures.get(i.id);
                return (
                  <li key={i.id}>
                    <span>{i.label}{server && !/p\.\d/.test(i.label) ? <span className="muted"> · page {server.pageNo}</span> : null}</span>
                    <span className="row">
                      <StateChip state={uploading === i.id ? "UPLOADING" : i.state} lang={lang} />
                      {server && i.state === "DELIVERED" && <StateChip state={server.docState === "REGISTERED" || server.docState === "SYNCED" ? server.docState : server.pageState} lang={lang} />}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <details className="panel device-settings">
          <summary>⚙️ {t(lang, "device")}</summary>
          <div className="stack device-settings-content">
          <label className="switch">
            <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} />
            <span className={`conn ${online ? "on" : "off"}`}>{online ? `📶 ${t(lang, "online")}` : `✈️ ${t(lang, "offline")}`}</span>
          </label>
          <label className="switch small">
            <input type="checkbox" checked={slow} onChange={(e) => setSlow(e.target.checked)} />
            {t(lang, "slowNetwork")}
          </label>
          <div className="row small">
            {t(lang, "botLanguage")} :
            <button className="btn" onClick={() => void tapButton({ id: "lang", from: "me", at: "" }, { id: "lang:fr", title: "Français" })}>FR</button>
            <button className="btn" onClick={() => void tapButton({ id: "lang", from: "me", at: "" }, { id: "lang:en", title: "English" })}>EN</button>
          </div>
          <p className="small muted">🔒 {t(lang, "encrypted")}</p>
          </div>
        </details>
      </div>
      {gallery && <Gallery lang={lang} onClose={() => setGallery(false)} onSend={async (files) => {
        setGallery(false);
        for (const f of files) {
          const blob = await (await fetch(`/api/samples/${encodeURIComponent(f.file)}`)).blob();
          await sendImage(blob, f.label, false);
        }
      }} />}
      {photoCheck && (
        <div className="modal-back" onClick={() => setPhotoCheck(null)}>
          <section className="modal photo-check stack" role="alertdialog" aria-modal="true" aria-labelledby="photo-check-title" onClick={(e) => e.stopPropagation()}>
            <div>
              <h2 id="photo-check-title">{t(lang, "photoCheckTitle")}</h2>
              <p>{t(lang, "photoCheckHelp")}</p>
            </div>
            <img className="photo-check-preview" src={photoCheck.thumb} alt={lang === "fr" ? "Aperçu de la page photographiée" : "Preview of the photographed page"} />
            <div>
              <strong className="small">{t(lang, "photoIssues")}</strong>
              <ul className="photo-check-issues">
                {photoCheck.issues.map((issue) => <li key={issue}>{t(lang, issue as "blurry" | "too_dark" | "too_bright")}</li>)}
              </ul>
            </div>
            <div className="row photo-check-actions">
              <button className="btn" onClick={() => { setPhotoCheck(null); cameraInput.current?.click(); }}>📷 {t(lang, "photoRetake")}</button>
              <button className="btn primary" onClick={() => {
                const pending = photoCheck;
                setPhotoCheck(null);
                void queuePhoto(pending.blob, pending.mime, pending.label, pending.thumb);
              }}>{t(lang, "photoSendAnyway")}</button>
            </div>
          </section>
        </div>
      )}
      {(reportLoading || reportError || report) && (
        <div className="modal-back" onClick={() => { setReport(null); setReportError(""); }}>
          <section className="modal report-modal stack" role="dialog" aria-modal="true" aria-labelledby="report-title" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h2 id="report-title">{t(lang, "reportTitle")}</h2>
              <span className="spacer" />
              <button className="btn" onClick={() => { setReport(null); setReportError(""); }}>{t(lang, "reportClose")}</button>
            </div>
            {reportLoading && <p role="status">{t(lang, "reportLoading")}</p>}
            {reportError && <p role="alert" className="report-error">{reportError}</p>}
            {report && (
              <>
                <p className="small muted">{t(lang, "reportMeta", { pages: report.pageCount, fields: report.fields.length })}</p>
                <p className="small">{t(lang, "reportPrivacy")}</p>
                <div className="report-pages">
                  <h3>{t(lang, "reportPages")}</h3>
                  {report.pages.map((page) => (
                    <div className="report-page" key={`${page.number}-${page.section}`}>
                      <strong>{page.number}. {page.section}</strong><span className="chip ok">{page.state}</span>
                      {page.issues.map((issue) => <p className="report-issue" key={issue}>⚠ {issue}</p>)}
                    </div>
                  ))}
                </div>
                <div className="report-fields">
                  {report.fields.map((field, index) => (
                    <div className="report-field" key={`${field.label}-${index}`}>
                      <strong>{field.label}</strong>
                      <span>{field.value || (lang === "fr" ? "Non renseigné" : "Not provided")}</span>
                      <span className="small muted">{field.status} · {t(lang, "reportConfidence")} {Math.round(field.confidence * 100)}%{field.pageNo === null ? "" : ` · p. ${field.pageNo}`}</span>
                      {field.reasons.length > 0 && <span className="small report-issue">{t(lang, "reportReason")}: {field.reasons.join(", ")}</span>}
                    </div>
                  ))}
                </div>
                <div className="row report-actions">
                  <button className="btn" disabled={!reportFile} onClick={saveReport}>📄 {t(lang, "reportDownload")}</button>
                  {whatsappHref && (
                    <a className={`btn primary ${!reportFile ? "disabled" : ""}`} href={reportFile ? whatsappHref : undefined} target="_blank" rel="noopener noreferrer" onClick={shareReport}>
                      🟢 {t(lang, "reportWhatsApp")}
                    </a>
                  )}
                </div>
                {shareNotice && <p className="small report-notice" role="status">{shareNotice}</p>}
                <p className="small muted">{lang === "fr" ? "Sur un téléphone compatible, le menu de partage permet de joindre directement le PDF. Sinon, le PDF est téléchargé et le message WhatsApp est prérempli." : "On a compatible phone, the share menu can attach the PDF directly. Otherwise, the PDF is downloaded and the WhatsApp message is prefilled."}</p>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function tick(state: LocalState | undefined, uploading: boolean) {
  if (uploading) return "⬆️";
  if (!state || state === "CAPTURED" || state === "PENDING_AI") return "🕓";
  if (state === "SYNC_FAILED") return "⚠️";
  return "✓✓";
}

function StateChip({ state, lang }: { state: string; lang: UiLang }) {
  const cls = state === "SYNC_FAILED" || state === "PROCESSING_FAILED" ? "bad"
    : ["PENDING_AI", "CAPTURED", "UPLOADING", "NEEDS_REVIEW", "DUPLICATE_SUSPECTED", "MANUAL_REVIEW_REQUIRED"].includes(state) ? "warn"
    : "ok";
  const label = state === "UPLOADING" ? (lang === "fr" ? "ENVOI…" : "UPLOADING…")
    : state === "DELIVERED" ? (lang === "fr" ? "REÇU" : "DELIVERED")
    : STATE_LABELS[state as keyof typeof STATE_LABELS]?.[lang] ?? state;
  return <span className={`chip ${cls}`}>{label}</span>;
}

async function thumbnail(blob: Blob): Promise<string> {
  const bmp = await createImageBitmap(blob);
  const w = 180;
  const h = Math.round((bmp.height / bmp.width) * w);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.6);
}

interface Sample { file: string; pdfPage: number | null; patient: number | null; duplicateOf: string | null; realPhoto: boolean }

function Gallery({ lang, onClose, onSend }: { lang: UiLang; onClose: () => void; onSend: (files: { file: string; label: string }[]) => void }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [picked, setPicked] = useState<{ file: string; label: string }[]>([]);
  useEffect(() => {
    void fetch("/api/samples").then((r) => r.json()).then(setSamples);
  }, []);
  const groups = useMemo(() => {
    const out: { title: string; items: { file: string; label: string }[] }[] = [];
    for (let p = 1; p <= 10; p++) {
      const items = samples.filter((s) => s.patient === p && !s.duplicateOf).sort((a, b) => a.pdfPage! - b.pdfPage!)
        .map((s) => ({ file: s.file, label: `P${p} p.${((s.pdfPage! - 1) % 8) + 1}` }));
      if (items.length) out.push({ title: t(lang, "patientSet", { n: p, split: p <= 5 ? "dev" : "test" }), items });
    }
    const real = samples.filter((s) => s.realPhoto).map((s) => ({ file: s.file, label: s.file }));
    if (real.length) out.push({ title: t(lang, "realPhotos"), items: real });
    return out;
  }, [samples, lang]);
  const toggle = (it: { file: string; label: string }) =>
    setPicked((p) => (p.some((x) => x.file === it.file) ? p.filter((x) => x.file !== it.file) : [...p, it]));

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal stack" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <strong>{t(lang, "pickPages")}</strong>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>{t(lang, "cancel")}</button>
          <button className="btn primary" disabled={!picked.length} onClick={() => onSend(picked)}>{t(lang, "sendSelected", { n: picked.length })}</button>
        </div>
        {groups.map((g) => (
          <div key={g.title}>
            <div className="row small" style={{ margin: "8px 0 6px" }}>
              <strong>{g.title}</strong>
              <button className="btn small" onClick={() => setPicked((p) => [...p, ...g.items.filter((i) => !p.some((x) => x.file === i.file))])}>+ {lang === "fr" ? "tout" : "all"}</button>
            </div>
            <div className="thumbs">
              {g.items.map((it) => {
                const n = picked.findIndex((x) => x.file === it.file);
                return (
                  <button key={it.file} className={`thumb ${n >= 0 ? "sel" : ""}`} onClick={() => toggle(it)}>
                    <img src={`/api/samples/${encodeURIComponent(it.file)}`} alt={it.label} loading="lazy" />
                    {n >= 0 && <span className="badge">{n + 1}</span>}
                    <div className="cap">{it.label}</div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
