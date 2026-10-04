import { useEffect, useState } from "react";
import { t, type UiLang } from "./i18n.ts";
import { Office } from "./Office.tsx";
import { Phone } from "./Phone.tsx";

export interface Health {
  extractor: "template" | "claude" | "mock";
  model: string;
  effort: string;
  aiFallback: "none" | "claude-code" | "claude";
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
        <h1>🤱 {t(lang, "appTitle")}</h1>
        <nav className="tabs">
          <button className={`tab ${view === "phone" ? "active" : ""}`} onClick={() => setView("phone")}>📱 {t(lang, "tabPhone")}</button>
          <button className={`tab ${view === "office" ? "active" : ""}`} onClick={() => setView("office")}>🏢 {t(lang, "tabOffice")}</button>
        </nav>
        <span className="spacer" />
        {health && (
          <span className="small muted">
            {health.extractor === "template"
              ? `${lang === "fr" ? "Local" : "Local"} : ${health.model} · Claude ${lang === "fr" ? "secours" : "fallback"} : ${health.aiFallback}`
              : health.extractor === "claude"
                ? `Claude · ${health.model} · effort ${health.effort}`
                : `${lang === "fr" ? "Mode démo" : "Demo mode"} · ${health.model}`}
          </span>
        )}
        <button className="btn" onClick={() => setLang(lang === "fr" ? "en" : "fr")}>{lang === "fr" ? "English" : "Français"}</button>
      </header>
      {health?.extractor === "mock" && <div className="banner">⚠️ {t(lang, "mockBanner")}</div>}
      {view === "phone" ? <Phone lang={lang} /> : <Office lang={lang} />}
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
