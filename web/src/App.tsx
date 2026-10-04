import { useEffect, useState } from "react";
import { t, type UiLang } from "./i18n.ts";
import { Office } from "./Office.tsx";
import { Phone } from "./Phone.tsx";

export interface Health {
  extractor: "claude" | "mock";
  model: string;
  effort: string;
}

export function App() {
  const [lang, setLang] = useState<UiLang>(() => (localStorageGet("ui-lang") as UiLang) || "fr");
  const [view, setView] = useState<"phone" | "office">(() => (location.hash === "#office" ? "office" : "phone"));
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
  }, []);
  useEffect(() => {
    localStorageSet("ui-lang", lang);
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(() => {
    location.hash = view === "office" ? "office" : "";
  }, [view]);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
              <circle cx="12" cy="12" r="10" fill="url(#brand-grad)" />
              <path d="M12 7c-2.2 0-4 1.8-4 4 0 2.5 4 6 4 6s4-3.5 4-6c0-2.2-1.8-4-4-4z" fill="#ffffff" opacity="0.9" />
              <circle cx="12" cy="10" r="1.5" fill="#f43f5e" />
              <defs>
                <linearGradient id="brand-grad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#f43f5e" />
                  <stop offset="1" stopColor="#e11d48" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <div className="brand-text">
            <h1>{t(lang, "appTitle")}</h1>
            <span className="brand-badge">DayOne 2026</span>
          </div>
        </div>

        <nav className="tabs">
          <button className={`tab ${view === "phone" ? "active" : ""}`} onClick={() => setView("phone")}>
            <span className="tab-icon">📱</span>
            <span>{t(lang, "tabPhone")}</span>
          </button>
          <button className={`tab ${view === "office" ? "active" : ""}`} onClick={() => setView("office")}>
            <span className="tab-icon">🏢</span>
            <span>{t(lang, "tabOffice")}</span>
          </button>
        </nav>

        <span className="spacer" />

        {health && (
          <div className={`health-pill ${health.extractor}`}>
            <span className="pulse-dot" />
            <span className="health-label">
              {health.extractor === "claude"
                ? `${health.model} · ${health.effort}`
                : (lang === "fr" ? "Vérité terrain (démo)" : "Ground truth (demo)")}
            </span>
          </div>
        )}

        <button className="btn lang-toggle" onClick={() => setLang(lang === "fr" ? "en" : "fr")}>
          <span className="globe-icon">🌐</span>
          <span>{lang === "fr" ? "EN" : "FR"}</span>
        </button>
      </header>

      {health?.extractor === "mock" && (
        <div className="banner">
          <span className="banner-icon">💡</span>
          <div className="banner-body">
            <strong>{lang === "fr" ? "Mode démonstration autonome" : "Standalone demo mode"}</strong>
            <span> — {t(lang, "mockBanner")}</span>
          </div>
        </div>
      )}

      <main className="app-main">
        {view === "phone" ? <Phone lang={lang} /> : <Office lang={lang} />}
      </main>
    </>
  );
}

// Per-viewer UI preferences only; never patient data.
export function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
export function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
}
