// The simulated midwife phone: a WhatsApp-style chat on top of an encrypted
// offline outbox. Toggle "offline" at any time, including mid-upload.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STATE_LABELS } from "../../shared/lifecycle.ts";
import type { Button, CaptureStatus, InboundMessage, PollResponse } from "../../shared/messages.ts";
import { Outbox, type LocalState, type OutboxItem } from "./device/outbox.ts";
import { blobToBase64, checkQuality, prepareImage } from "./device/quality.ts";
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
    <div className="phone-layout unlock-layout">
      <div className="unlock-container">
        <div className="unlock-card panel stack">
          <div className="unlock-badge-wrap">
            <span className="unlock-badge-icon">🔐</span>
          </div>
          <h2>{t(lang, "unlock")}</h2>
          <p className="unlock-subtitle">{lang === "fr" ? "Portail sécurisé de saisie sage-femme" : "Secure midwife entry portal"}</p>
          <label className="stack small">
            <span className="label-text">{t(lang, "midwife")}</span>
            <select value={mid} onChange={(e) => setMid(e.target.value)}>
              {MIDWIVES.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label className="stack small">
            <span className="label-text">{t(lang, "pin")}</span>
            <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void unlock()} />
          </label>
          <div className="pin-hint-box">
            <span className="hint-bulb">💡</span>
            <p className="small muted">{t(lang, "pinHint")}</p>
          </div>
          {error && <p className="small error-text" style={{ color: "var(--bad)" }}>{error}</p>}
          <button className="btn primary unlock-btn" onClick={() => void unlock()}>{t(lang, "unlock")}</button>
        </div>
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
    setChat((c) => ({ ...c, entries: c.entries.map((e) => (e.id === entry.id ? { ...e, used: true } : e)) }));
    const msg: InboundMessage = { id: crypto.randomUUID(), midwifeId: mid, kind: "button", buttonId: b.id, capturedAt: new Date().toISOString() };
    pushMine({ id: msg.id, text: b.title });
    await outbox.add(msg, `🔘 ${b.title}`);
  }

  async function sendImage(file: Blob, label: string, askOnIssues = true) {
    const { blob, mime } = await prepareImage(file);
    const q = await checkQuality(blob);
    if (askOnIssues && q.issues.length) {
      const issues = q.issues.map((i) => t(lang, i)).join(", ");
      if (!confirm(t(lang, "qualityWarn", { issues }))) return;
    }
    const msg: InboundMessage = {
      id: crypto.randomUUID(), midwifeId: mid, kind: "image",
      image: { data: await blobToBase64(blob), mime: mime as "image/png" }, capturedAt: new Date().toISOString(),
    };
    pushMine({ id: msg.id, thumb: await thumbnail(blob) });
    await outbox.add(msg, `📷 ${label}`);
  }

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  // Only the latest prompt is answerable; duplicate-photo questions stay open until answered.
  const lastPrompt = chat.entries.reduce((last, e, i) => (e.from === "bot" && e.buttons?.length ? i : last), -1);
  const stale = (e: ChatEntry, i: number) => i < lastPrompt && !e.buttons?.some((b) => b.id.startsWith("dup:"));
  const pendingCount = items.filter((i) => ["CAPTURED", "PENDING_AI", "SYNC_FAILED"].includes(i.state)).length;

  return (
    <div className="phone-layout">
      <div className="phone-wrapper">
        <div className="phone">
          <div className="phone-statusbar">
            <span className="phone-time">09:41</span>
            <div className="phone-island">
              <span className="island-lens" />
              <span className="island-sensor" />
            </div>
            <div className="phone-status-icons">
              <span className="status-signal">5G</span>
              <span className="status-wifi">📶</span>
              <span className="status-battery">100% 🔋</span>
            </div>
          </div>

          <div className="phone-header">
            <div className="avatar">D1</div>
            <div className="phone-header-info" style={{ flex: 1 }}>
              <div className="phone-header-title">
                <strong>DayOne Registre</strong>
                <span className="verified-badge" title="Service certifié">✓</span>
              </div>
              <small>{online ? t(lang, "online") : `${t(lang, "offline")} · ${pendingCount} ⏳`}</small>
            </div>
            <button className="icon-btn secondary lock-btn" title="Lock" onClick={onLock}>🔒</button>
          </div>

          <div className="chat" ref={chatRef}>
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
            <label className="icon-btn secondary composer-action" title={t(lang, "camera")}>
              📷
              <input type="file" accept="image/*" capture="environment" hidden onChange={(ev) => {
                const f = ev.target.files?.[0];
                if (f) void sendImage(f, f.name);
                ev.target.value = "";
              }} />
            </label>
            <button type="button" className="icon-btn secondary composer-action" title={t(lang, "gallery")} onClick={() => setGallery(true)}>🗂️</button>
            <input type="text" value={text} placeholder={t(lang, "typeMessage")} onChange={(e) => setText(e.target.value)} />
            <button className="icon-btn send-btn" type="submit" title={t(lang, "send")}>➤</button>
          </form>

          <div className="phone-home-indicator" />
        </div>
      </div>

      <div className="stack device-sidebar">
        <div className="panel stack device-panel">
          <div className="panel-header-row">
            <h2>⚙️ {t(lang, "device")}</h2>
            <span className="sim-badge">Simulation</span>
          </div>

          <label className="switch-card">
            <div className="switch-text">
              <span className="switch-label">{online ? t(lang, "online") : t(lang, "offline")}</span>
              <span className="switch-sub">{online ? (lang === "fr" ? "Connexion active au serveur" : "Active server connection") : (lang === "fr" ? "Mode déconnecté autonome" : "Offline standalone mode")}</span>
            </div>
            <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} />
            <span className={`switch-pill ${online ? "on" : "off"}`}>
              <span className="switch-knob" />
            </span>
          </label>

          <label className="switch-card secondary">
            <div className="switch-text">
              <span className="switch-label">{t(lang, "slowNetwork")}</span>
            </div>
            <input type="checkbox" checked={slow} onChange={(e) => setSlow(e.target.checked)} />
            <span className={`switch-pill ${slow ? "on" : "off"}`}>
              <span className="switch-knob" />
            </span>
          </label>

          <div className="row small bot-lang-row">
            <span className="bot-lang-title">{t(lang, "botLanguage")} :</span>
            <div className="btn-group">
              <button className="btn small" onClick={() => void tapButton({ id: "lang", from: "me", at: "" }, { id: "lang:fr", title: "Français" })}>FR</button>
              <button className="btn small" onClick={() => void tapButton({ id: "lang", from: "me", at: "" }, { id: "lang:en", title: "English" })}>EN</button>
            </div>
          </div>

          <div className="vault-security-pill">
            <span className="vault-shield">🔒</span>
            <span className="vault-text">{t(lang, "encrypted")}</span>
          </div>
        </div>

        <div className="panel queue-panel">
          <div className="panel-header-row">
            <h2>📤 {t(lang, "queue")}</h2>
            <span className="queue-count-badge">{items.length}</span>
          </div>
          {items.length === 0 ? (
            <div className="queue-empty-box">
              <span className="empty-check">✨</span>
              <p className="muted small">{t(lang, "queueEmpty")}</p>
            </div>
          ) : (
            <ul className="queue">
              {[...items].reverse().map((i) => {
                const server = captures.get(i.id);
                return (
                  <li key={i.id} className="queue-item">
                    <span className="queue-item-name">
                      <span className="queue-icon">📄</span>
                      <span>{i.label}{server && !/p\.\d/.test(i.label) ? <span className="muted"> · page {server.pageNo}</span> : null}</span>
                    </span>
                    <span className="row queue-status-row">
                      <StateChip state={uploading === i.id ? "UPLOADING" : i.state} lang={lang} />
                      {server && i.state === "DELIVERED" && <StateChip state={server.docState === "REGISTERED" || server.docState === "SYNCED" ? server.docState : server.pageState} lang={lang} />}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      {gallery && <Gallery lang={lang} onClose={() => setGallery(false)} onSend={async (files) => {
        setGallery(false);
        for (const f of files) {
          const blob = await (await fetch(`/api/samples/${encodeURIComponent(f.file)}`)).blob();
          await sendImage(blob, f.label, false);
        }
      }} />}
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
  return (
    <span className={`chip ${cls}`}>
      <span className="chip-dot" />
      <span>{label}</span>
    </span>
  );
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
