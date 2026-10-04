import { useEffect, useState } from "react";
import { t, type UiLang } from "./i18n.ts";
import { Office } from "./Office.tsx";

export interface Health {
  extractor: "template" | "claude" | "mock";
  model: string;
  effort: string;
  aiFallback: "none" | "claude-code" | "claude";
}

export function App() {
  const [lang, setLang] = useState<UiLang>(() => (localStorageGet("ui-lang") as UiLang) || "fr");
  const [health, setHealth] = useState<Health | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorageGet("ui-theme") === "dark" ? "dark" : "light"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorageSet("ui-theme", theme);
  }, [theme]);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
  }, []);
  useEffect(() => {
    localStorageSet("ui-lang", lang);
    document.documentElement.lang = lang;
  }, [lang]);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src="/logo-mark.png" alt="" />
          <div className="brand-text">
            <h1>{t(lang, "appTitle")}</h1>
            <span className="brand-tagline">{lang === "fr" ? "Du registre papier au dossier qui suit chaque maman" : "From the paper registry to a record that follows every mother"}</span>
          </div>
        </div>

        <span className="spacer" />

        {health && (
          <div className={`health-pill ${health.extractor}`}>
            <span className="pulse-dot" />
            <span className="health-label">
              {health.extractor === "template"
                ? `PaddleOCR · ${health.aiFallback === "none" ? (lang === "fr" ? "sans IA" : "no AI") : health.aiFallback === "claude-code" ? (lang === "fr" ? "secours Claude Code" : "Claude Code fallback") : (lang === "fr" ? "secours Claude" : "Claude fallback")}`
                : health.extractor === "claude"
                  ? `Claude · ${health.model} · ${health.effort}`
                  : lang === "fr" ? "Vérité terrain (démo)" : "Ground truth (demo)"}
            </span>
          </div>
        )}

        <button
          className="theme-toggle"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          aria-label={theme === "light" ? (lang === "fr" ? "Mode sombre" : "Dark mode") : (lang === "fr" ? "Mode clair" : "Light mode")}
          title={theme === "light" ? (lang === "fr" ? "Mode sombre" : "Dark mode") : (lang === "fr" ? "Mode clair" : "Light mode")}
        >
          {theme === "light" ? "🌙" : "☀️"}
        </button>

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
        <Office lang={lang} />
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
