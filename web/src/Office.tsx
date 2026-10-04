import { useCallback, useEffect, useState } from "react";
import { FIELD_BY_KEY, SECTIONS, SECTION_LABELS, fieldLabel } from "../../shared/catalog.ts";
import { STATE_LABELS } from "../../shared/lifecycle.ts";
import { formatValue } from "../../shared/normalize.ts";
import { FIELD_STATUS_LABELS, type FieldValue } from "../../shared/status.ts";
import { localStorageGet, localStorageSet } from "./App.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { t, type UiLang } from "./i18n.ts";

const TOKENS = { supervisor: "supervisor-demo", analyst: "analyst-demo" } as const;
type Role = keyof typeof TOKENS;
type Tab = "overview" | "patients" | "registries" | "dashboard" | "ai";

export function useApi(role: Role) {
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const r = await fetch(path, { ...init, headers: { "Content-Type": "application/json", "x-role-token": TOKENS[role], ...(init?.headers ?? {}) } });
      if (r.status === 403) throw new Error("forbidden");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<T>;
    },
    [role],
  );
}

export function Office({ lang }: { lang: UiLang }) {
  const [role, setRole] = useState<Role>(() => (localStorageGet("office-role") as Role) || "supervisor");
  const [tab, setTab] = useState<Tab>("overview");
  const [patientId, setPatientId] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  useEffect(() => localStorageSet("office-role", role), [role]);

  const tabs: [Tab, string][] = [["overview", t(lang, "overview")], ["patients", t(lang, "patients")], ["registries", t(lang, "registries")], ["dashboard", t(lang, "dashboard")], ["ai", t(lang, "aiUsage")]];
  return (
    <div className="office">
      <div className="row">
        <nav className="tabs">
          {tabs.map(([k, label]) => (
            <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => { setTab(k); setPatientId(null); setDocId(null); }}>{label}</button>
          ))}
        </nav>
        <span className="spacer" />
        <label className="row small">
          {t(lang, "role")}
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="supervisor">{t(lang, "supervisor")}</option>
            <option value="analyst">{t(lang, "analyst")}</option>
          </select>
        </label>
      </div>
      <div key={`${role}-${tab}-${patientId}-${docId}`}>
        {tab === "overview" && <Overview role={role} lang={lang} />}
        {tab === "patients" && (patientId ? <PatientView role={role} lang={lang} id={patientId} onBack={() => setPatientId(null)} openDoc={(d) => { setTab("registries"); setDocId(d); }} /> : <Patients role={role} lang={lang} open={setPatientId} />)}
        {tab === "registries" && (docId ? <DocumentView role={role} lang={lang} id={docId} onBack={() => setDocId(null)} /> : <Documents role={role} lang={lang} open={setDocId} />)}
        {tab === "dashboard" && <Dashboard role={role} lang={lang} />}
        {tab === "ai" && <AiUsage role={role} lang={lang} />}
      </div>
    </div>
  );
}

function useLoad<T>(role: Role, path: string, deps: unknown[] = []) {
  const api = useApi(role);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api<T>(path).then(setData).catch((e: Error) => setError(e.message));
  }, [api, path]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps]);
  return { data, error, reload };
}

function Forbidden({ lang }: { lang: UiLang }) {
  return <div className="locked">🔒 {t(lang, "forbidden")}</div>;
}

function StateBadge({ state, lang }: { state: string; lang: UiLang }) {
  const bad = ["PROCESSING_FAILED", "SYNC_FAILED"].includes(state);
  const warn = ["NEEDS_REVIEW", "DUPLICATE_SUSPECTED", "MANUAL_REVIEW_REQUIRED", "PENDING_AI"].includes(state);
  return <span className={`chip ${bad ? "bad" : warn ? "warn" : "ok"}`}>{STATE_LABELS[state as keyof typeof STATE_LABELS]?.[lang] ?? state}</span>;
}

// ------------------------------------------------------------------ overview
interface OverviewData {
  docStates: { state: string; n: number }[];
  pageStates: { state: string; n: number }[];
  patients: number;
  ai: { calls: number; cached: number; failed: number; cost: number; input: number; output: number; cacheRead: number };
  extractor: string;
}
function Overview({ role, lang }: { role: Role; lang: UiLang }) {
  const { data, error } = useLoad<OverviewData>(role, "/api/office/overview");
  if (error === "forbidden") return <Forbidden lang={lang} />;
  if (!data) return null;
  const docs = Object.fromEntries(data.docStates.map((d) => [d.state, d.n]));
  const total = data.docStates.reduce((s, d) => s + d.n, 0);
  const done = (docs.REGISTERED ?? 0) + (docs.SYNCED ?? 0);
  const waiting = (docs.NEEDS_REVIEW ?? 0) + (docs.AI_PROCESSED ?? 0) + (docs.PENDING_AI ?? 0) + (docs.VALIDATED ?? 0);
  const L = (fr: string, en: string) => (lang === "fr" ? fr : en);
  return (
    <div className="stack">
      <div className="tiles">
        <Tile label={L("Patientes", "Patients")} value={data.patients} />
        <Tile label={L("Registres enregistrés", "Registries registered")} value={done} sub={`${total} ${L("reçus", "received")}`} />
        <Tile label={L("En cours de vérification", "Being reviewed")} value={waiting} />
        <Tile label={L("À rattacher par le bureau", "Waiting for office match")} value={docs.MANUAL_REVIEW_REQUIRED ?? 0} />
        <Tile label={L("Appels IA", "AI calls")} value={data.ai.calls ?? 0} sub={`${data.ai.cached ?? 0} ${L("depuis le cache", "from cache")} · ${data.ai.failed ?? 0} ${L("échecs", "failed")}`} />
        <Tile label={L("Coût IA estimé", "Estimated AI cost")} value={`$${(data.ai.cost ?? 0).toFixed(2)}`} sub={data.extractor === "mock" ? "mock" : `${Math.round((data.ai.cacheRead ?? 0) / 1000)}k ${L("jetons en cache", "cached tokens")}`} />
      </div>
      <div className="panel">
        <h2>{L("Cycle de vie des registres", "Registry lifecycle")}</h2>
        <div className="row">
          {data.docStates.map((d) => <span key={d.state} className="row small"><StateBadge state={d.state} lang={lang} /> {d.n}</span>)}
          {!data.docStates.length && <span className="muted small">{L("Aucun registre reçu.", "No registry received yet.")}</span>}
        </div>
        <h3>{L("Pages", "Pages")}</h3>
        <div className="row">
          {data.pageStates.map((d) => <span key={d.state} className="row small"><StateBadge state={d.state} lang={lang} /> {d.n}</span>)}
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ patients
interface PatientRow { id: string; code: string | null; created_at: string; descriptor: string; fields: number; toReview: number; documents: number }
function Patients({ role, lang, open }: { role: Role; lang: UiLang; open: (id: string) => void }) {
  const { data, error } = useLoad<PatientRow[]>(role, "/api/office/patients");
  if (error === "forbidden") return <Forbidden lang={lang} />;
  if (!data) return null;
  const L = (fr: string, en: string) => (lang === "fr" ? fr : en);
  return (
    <div className="panel table-wrap">
      <table>
        <thead><tr><th>{L("N° de fiche", "Form number")}</th><th>{L("Résumé (sans identifiant)", "Summary (no identifiers)")}</th><th className="num">{L("Valeurs", "Values")}</th><th className="num">{L("À vérifier", "To check")}</th><th className="num">{L("Registres", "Registries")}</th><th>{L("Créée", "Created")}</th></tr></thead>
        <tbody>
          {data.map((p) => (
            <tr key={p.id} className="click" onClick={() => open(p.id)}>
              <td><strong>{p.code ?? "—"}</strong></td><td>{p.descriptor}</td><td className="num">{p.fields}</td><td className="num">{p.toReview}</td><td className="num">{p.documents}</td><td className="small muted">{p.created_at.slice(0, 16).replace("T", " ")}</td>
            </tr>
          ))}
          {!data.length && <tr><td colSpan={6} className="muted">{L("Aucune patiente pour l'instant.", "No patients yet.")}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

interface PatientDetail { patient: { id: string; code: string | null; created_at: string }; fields: FieldValue[]; documents: { id: string; state: string; opened_at: string; midwife_id: string }[] }
function PatientView({ role, lang, id, onBack, openDoc }: { role: Role; lang: UiLang; id: string; onBack: () => void; openDoc: (id: string) => void }) {
  const { data, error } = useLoad<PatientDetail>(role, `/api/office/patients/${id}`);
  if (error === "forbidden") return <Forbidden lang={lang} />;
  if (!data) return null;
  const L = (fr: string, en: string) => (lang === "fr" ? fr : en);
  const byKey = new Map(data.fields.map((f) => [f.key, f]));
  return (
    <div className="stack">
      <div className="row"><button className="btn" onClick={onBack}>← {L("Retour", "Back")}</button><h2 style={{ margin: 0 }}>{L("Fiche", "Form")} {data.patient.code ?? "—"}</h2><span className="muted small">ID {data.patient.id.slice(0, 8)}… ({L("aléatoire", "random")})</span></div>
      <div className="panel">
        <h3>{L("Registres sources", "Source registries")}</h3>
        <div className="row">{data.documents.map((d) => <button key={d.id} className="btn small" onClick={() => openDoc(d.id)}>{d.opened_at.slice(0, 10)} · {d.midwife_id} · <StateBadge state={d.state} lang={lang} /></button>)}</div>
      </div>
      {SECTIONS.map((s) => {
        const rows = [...FIELD_BY_KEY.values()].filter((f) => f.section === s && byKey.has(f.key));
        if (!rows.length) return null;
        return (
          <details key={s} className="panel" open={s !== "CURRENT_PREGNANCY"}>
            <summary><strong>{SECTION_LABELS[s][lang]}</strong> <span className="muted small">({rows.length})</span></summary>
            <div className="table-wrap">
              <table>
                <thead><tr><th>{L("Champ", "Field")}</th><th>{L("Valeur", "Value")}</th><th>{L("Écrit", "Written")}</th><th>{L("Statut", "Status")}</th><th className="num">{L("Confiance", "Confidence")}</th><th>{L("Validé par", "Confirmed by")}</th></tr></thead>
                <tbody>
                  {rows.map((def) => {
                    const f = byKey.get(def.key)!;
                    return (
                      <tr key={def.key}>
                        <td>{fieldLabel(def.key, lang)}</td>
                        <td>{f.value !== null ? formatValue(def.key, f.value, lang) : "—"}</td>
                        <td className="muted small">{f.raw ?? ""}</td>
                        <td><span className={`status ${f.status}`}>{FIELD_STATUS_LABELS[f.status][lang]}</span></td>
                        <td className="num">{Math.round(f.confidence * 100)}%</td>
                        <td className="small">{f.confirmedBy}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ registries (documents)
interface DocRow { id: string; midwife_id: string; state: string; opened_at: string; code: string | null; patient_code: string | null; pages: number; note: string | null }
function Documents({ role, lang, open }: { role: Role; lang: UiLang; open: (id: string) => void }) {
  const { data, error } = useLoad<DocRow[]>(role, "/api/office/documents");
  if (error === "forbidden") return <Forbidden lang={lang} />;
  if (!data) return null;
  const L = (fr: string, en: string) => (lang === "fr" ? fr : en);
  return (
    <div className="panel table-wrap">
      <table>
        <thead><tr><th>{L("Reçu", "Received")}</th><th>{L("Sage-femme", "Midwife")}</th><th className="num">Pages</th><th>{L("État", "State")}</th><th>{L("Patiente", "Patient")}</th></tr></thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.id} className="click" onClick={() => open(d.id)}>
              <td className="small">{d.opened_at.slice(0, 16).replace("T", " ")}</td><td>{d.midwife_id}</td><td className="num">{d.pages}</td><td><StateBadge state={d.state} lang={lang} /></td><td>{d.patient_code ?? d.code ?? "—"}</td>
            </tr>
          ))}
          {!data.length && <tr><td colSpan={5} className="muted">{L("Aucun registre reçu.", "No registry received yet.")}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

interface DocDetail {
  doc: { id: string; state: string; midwife_id: string; code: string | null; note: string | null; patient_id: string | null };
  pages: { capture_id: string; page_no: number; state: string; section: string | null; fields: Record<string, FieldValue> | null; quality: { usable: boolean; issues: string[] } | null; replaced_by: string | null; entry: string; captured_at: string; received_at: string; error: string | null }[];
  transitions: { subject_type: string; subject_id: string; from_state: string | null; to_state: string; at: string; reason: string }[];
}
function DocumentView({ role, lang, id, onBack }: { role: Role; lang: UiLang; id: string; onBack: () => void }) {
  const { data, error, reload } = useLoad<DocDetail>(role, `/api/office/documents/${id}`);
  const api = useApi(role);
  const [candidates, setCandidates] = useState<{ id: string; code: string | null; descriptor: string }[]>([]);
  useEffect(() => {
    if (data?.doc.state === "MANUAL_REVIEW_REQUIRED") void api<typeof candidates>("/api/office/candidates").then(setCandidates);
  }, [data?.doc.state, api]);
  if (error === "forbidden") return <Forbidden lang={lang} />;
  if (!data) return null;
  const L = (fr: string, en: string) => (lang === "fr" ? fr : en);
  const link = async (patientId: string | null) => {
    await api(`/api/office/documents/${id}/link`, { method: "POST", body: JSON.stringify({ patientId }) });
    reload();
  };
  return (
    <div className="stack">
      <div className="row"><button className="btn" onClick={onBack}>← {L("Retour", "Back")}</button><h2 style={{ margin: 0 }}>{L("Registre", "Registry")} {data.doc.code ?? ""}</h2><StateBadge state={data.doc.state} lang={lang} /></div>
      {data.doc.state === "MANUAL_REVIEW_REQUIRED" && (
        <div className="panel">
          <h2>🔗 {L("La sage-femme n'était pas sûre de la patiente. Rattacher à :", "The midwife was unsure of the patient. Link to:")}</h2>
          <div className="stack">
            {candidates.map((c) => <button key={c.id} className="btn" onClick={() => void link(c.id)}>{c.code ?? "—"} — {c.descriptor}</button>)}
            <button className="btn primary" onClick={() => void link(null)}>{L("Nouvelle patiente", "New patient")}</button>
          </div>
        </div>
      )}
      <div className="pages">
        {data.pages.map((p) => {
          const vals = p.fields ? Object.values(p.fields) : [];
          const doubt = vals.filter((f) => f.status === "NEEDS_REVIEW" || f.status === "ILLEGIBLE").length;
          return (
            <div key={p.capture_id} className="page-card small">
              <PageImage role={role} cid={p.capture_id} lang={lang} />
              <div className="row"><strong>Page {p.page_no}</strong><StateBadge state={p.state} lang={lang} />{p.replaced_by && <span className="chip">{L("remplacée", "replaced")}</span>}</div>
              <div>{p.section ? SECTION_LABELS[p.section as keyof typeof SECTION_LABELS]?.[lang] ?? p.section : "—"}</div>
              <div className="muted">{vals.filter((f) => f.status !== "NOT_PROVIDED").length} {L("valeurs", "values")} · {doubt} {L("à vérifier", "to check")} · {p.entry === "manual" ? L("saisie manuelle", "manual entry") : "IA"}</div>
              <div className="muted">{L("Capturée", "Captured")} {p.captured_at.slice(0, 16).replace("T", " ")} · {L("reçue", "received")} {p.received_at.slice(11, 16)}</div>
              {p.error && <div style={{ color: "var(--bad)" }}>{p.error}</div>}
            </div>
          );
        })}
      </div>
      <div className="panel">
        <h2>{L("Journal des transitions", "Transition log")}</h2>
        <ul className="timeline">
          {data.transitions.map((tr, i) => (
            <li key={i}>
              <span className="muted">{tr.at.slice(11, 19)}</span> · {tr.subject_type === "document" ? L("registre", "registry") : `page ${data.pages.find((p) => p.capture_id === tr.subject_id)?.page_no ?? "?"}`} : {tr.from_state ?? "∅"} → <strong>{tr.to_state}</strong> <span className="muted">({tr.reason})</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PageImage({ role, cid, lang }: { role: Role; cid: string; lang: UiLang }) {
  const [url, setUrl] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    let revoke: string | null = null;
    fetch(`/api/office/pages/${cid}/image`, { headers: { "x-role-token": TOKENS[role] } }).then(async (r) => {
      if (!r.ok) return setDenied(true);
      revoke = URL.createObjectURL(await r.blob());
      setUrl(revoke);
    });
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [cid, role]);
  if (denied) return <div className="locked small">🔒 {lang === "fr" ? "Photo réservée au superviseur" : "Photo restricted to supervisors"}</div>;
  return url ? <img src={url} alt="" /> : null;
}

// ------------------------------------------------------------------ AI usage
interface AiCall { id: number; capture_id: string | null; model: string; cached: number; ok: number; error: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cost_usd: number; latency_ms: number | null; at: string }
function AiUsage({ role, lang }: { role: Role; lang: UiLang }) {
  const { data, error } = useLoad<AiCall[]>(role, "/api/office/ai-calls");
  if (error === "forbidden") return <Forbidden lang={lang} />;
  if (!data) return null;
  const L = (fr: string, en: string) => (lang === "fr" ? fr : en);
  return (
    <div className="panel table-wrap">
      <p className="small muted">{L("Chaque photo est lue une seule fois : les doublons et reprises identiques sont servis depuis le cache.", "Each photo is read once: duplicates and identical retakes are served from the cache.")}</p>
      <table>
        <thead><tr><th>{L("Heure", "Time")}</th><th>{L("Modèle", "Model")}</th><th>Cache</th><th>OK</th><th className="num">{L("Entrée", "Input")}</th><th className="num">{L("Sortie", "Output")}</th><th className="num">{L("Lu en cache", "Cache read")}</th><th className="num">$</th><th className="num">ms</th></tr></thead>
        <tbody>
          {data.map((c) => (
            <tr key={c.id}>
              <td className="small">{c.at.slice(11, 19)}</td><td className="small">{c.model}</td><td>{c.cached ? "✓" : ""}</td><td>{c.ok ? "✓" : <span title={c.error ?? ""}>✗</span>}</td>
              <td className="num">{c.input_tokens ?? ""}</td><td className="num">{c.output_tokens ?? ""}</td><td className="num">{c.cache_read_tokens ?? ""}</td><td className="num">{c.cost_usd ? c.cost_usd.toFixed(4) : ""}</td><td className="num">{c.latency_ms ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
