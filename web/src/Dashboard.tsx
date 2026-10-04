// Anonymized aggregates illustrating epidemiological use. Counts only: no
// patient-level rows, no clinical thresholds, no risk colouring.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Bp } from "../../shared/normalize.ts";
import type { UiLang } from "./i18n.ts";
import { useApi } from "./Office.tsx";

interface Counts { positive: number; negative: number; missing: number }
interface DashboardData {
  registry: { bps: Bp[]; temps: number[]; labs: Record<string, Record<string, number>>; patients: number };
  csv: { rows: number; bps: Bp[]; hiv: Counts; syphilis: Counts; hepatitisC: Counts } | null;
}

export function Dashboard({ role, lang }: { role: "supervisor" | "analyst"; lang: UiLang }) {
  const api = useApi(role);
  const [data, setData] = useState<DashboardData | null>(null);
  useEffect(() => {
    void api<DashboardData>("/api/office/dashboard").then(setData);
  }, [api]);
  if (!data) return null;
  const L = (fr: string, en: string) => (lang === "fr" ? fr : en);
  const reg = data.registry;
  const labRow = (key: string, label: string) => {
    const c = reg.labs[key] ?? {};
    return { label, negative: c.NEGATIVE ?? 0, positive: c.POSITIVE ?? 0, missing: (c.NOT_DONE ?? 0) + (c.IMMUNE ?? 0) + (c.NOT_IMMUNE ?? 0) };
  };

  return (
    <div className="stack">
      <p className="small muted">
        {L(
          "Agrégats anonymisés : aucun identifiant, aucune ligne individuelle. Les données du registre viennent des dossiers validés par les sages-femmes ; le CSV synthétique fourni (200 femmes) sert de comparaison.",
          "Anonymized aggregates: no identifiers, no individual rows. Registry data comes from midwife-validated records; the provided synthetic CSV (200 women) is shown for comparison.",
        )}
      </p>
      <div className="charts">
        <Histogram
          title={L("Tension systolique — visites du registre", "Systolic BP — registry visits")}
          subtitle={L(`${reg.bps.length} mesure(s) · ${reg.patients} patiente(s) · mmHg`, `${reg.bps.length} reading(s) · ${reg.patients} patient(s) · mmHg`)}
          values={reg.bps.map((b) => b.systolic)} start={80} width={10} bins={9} lang={lang} unit="mmHg"
        />
        {data.csv && (
          <Histogram
            title={L("Tension systolique moyenne — CSV synthétique", "Mean systolic BP — synthetic CSV")}
            subtitle={L(`${data.csv.rows} femmes · mmHg`, `${data.csv.rows} women · mmHg`)}
            values={data.csv.bps.map((b) => b.systolic)} start={70} width={10} bins={7} lang={lang} unit="mmHg"
          />
        )}
        <Histogram
          title={L("Température maternelle et néonatale — post-partum", "Maternal and newborn temperature — postpartum")}
          subtitle={L(`${reg.temps.length} mesures · °C`, `${reg.temps.length} readings · °C`)}
          values={reg.temps} start={35.5} width={0.5} bins={8} lang={lang} unit="°C"
        />
        <StackedBars
          title={L("Tests infectieux — registre", "Infection tests — registry")}
          subtitle={L("Nombre de résultats enregistrés", "Number of recorded results")}
          rows={[labRow("hiv", L("VIH", "HIV")), labRow("syphilis", "Syphilis"), labRow("hbsag", L("Hépatite B", "Hepatitis B"))]}
          lang={lang}
        />
        {data.csv && (
          <StackedBars
            title={L("Tests infectieux — CSV synthétique", "Infection tests — synthetic CSV")}
            subtitle={L("Nombre de femmes", "Number of women")}
            rows={[
              { label: L("VIH", "HIV"), ...data.csv.hiv },
              { label: "Syphilis", ...data.csv.syphilis },
              { label: L("Hépatite C", "Hepatitis C"), ...data.csv.hepatitisC },
            ]}
            lang={lang}
          />
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ chart parts

function useTooltip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const show = (e: React.MouseEvent, content: ReactNode) => {
    const box = ref.current!.getBoundingClientRect();
    setTip({ x: Math.min(e.clientX - box.left + 12, box.width - 150), y: e.clientY - box.top - 40, content });
  };
  const node = tip ? <div className="tooltip" style={{ left: tip.x, top: tip.y }}>{tip.content}</div> : null;
  return { ref, show, hide: () => setTip(null), node };
}

function Histogram({ title, subtitle, values, start, width, bins, lang, unit }: {
  title: string; subtitle: string; values: number[]; start: number; width: number; bins: number; lang: UiLang; unit: string;
}) {
  const tt = useTooltip();
  const counts = Array.from({ length: bins }, (_, i) => {
    const lo = start + i * width;
    const hi = lo + width;
    const last = i === bins - 1;
    const first = i === 0;
    return { lo, hi, n: values.filter((v) => (first ? v < hi : v >= lo) && (last || v < hi)).length };
  });
  const max = Math.max(1, ...counts.map((c) => c.n));
  const W = 360, H = 170, padL = 30, padB = 22, padT = 8;
  const plotW = W - padL - 6, plotH = H - padB - padT;
  const slot = plotW / bins;
  const barW = Math.min(24, slot - 2);
  const yTicks = niceTicks(max);
  const fmt = (v: number) => (width < 1 ? v.toFixed(1) : String(v));
  const rangeLabel = (c: (typeof counts)[number], i: number) =>
    i === 0 ? `< ${fmt(c.hi)}` : i === bins - 1 ? `≥ ${fmt(c.lo)}` : `${fmt(c.lo)}–${fmt(c.hi)}`;

  return (
    <div className="chart" ref={tt.ref}>
      <h3>{title}</h3>
      <div className="subtitle">{subtitle}</div>
      {values.length === 0 ? (
        <p className="small muted">{lang === "fr" ? "Pas encore de données." : "No data yet."}</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
          {yTicks.map((t) => {
            const y = padT + plotH - (t / yTicks[yTicks.length - 1]) * plotH;
            return (
              <g key={t}>
                <line className="gridline" x1={padL} x2={W - 6} y1={y} y2={y} />
                <text className="axis" x={padL - 6} y={y + 4} textAnchor="end">{t}</text>
              </g>
            );
          })}
          {counts.map((c, i) => {
            const h = (c.n / yTicks[yTicks.length - 1]) * plotH;
            const x = padL + i * slot + (slot - barW) / 2;
            const y = padT + plotH - h;
            return (
              <g key={i} onMouseMove={(e) => tt.show(e, <><strong>{rangeLabel(c, i)} {unit}</strong><br />{c.n} {lang === "fr" ? "mesures" : "readings"}</>)} onMouseLeave={tt.hide}>
                <rect x={padL + i * slot} y={padT} width={slot} height={plotH} fill="transparent" />
                {c.n > 0 && <path d={roundedTop(x, y, barW, h, 4)} fill="var(--series-1)" />}
              </g>
            );
          })}
          {counts.map((c, i) => (i % 2 === 0 || bins <= 7 ? (
            <text key={i} className="axis" x={padL + i * slot} y={H - 6} textAnchor="middle">{fmt(c.lo)}</text>
          ) : null))}
        </svg>
      )}
      {tt.node}
      <details className="table-view">
        <summary>{lang === "fr" ? "Voir le tableau" : "Show table"}</summary>
        <table><tbody>{counts.map((c, i) => <tr key={i}><td>{rangeLabel(c, i)} {unit}</td><td className="num">{c.n}</td></tr>)}</tbody></table>
      </details>
    </div>
  );
}

interface StackRow { label: string; negative: number; positive: number; missing: number }

function StackedBars({ title, subtitle, rows, lang }: { title: string; subtitle: string; rows: StackRow[]; lang: UiLang }) {
  const tt = useTooltip();
  const parts = [
    { key: "negative" as const, label: lang === "fr" ? "Négatif" : "Negative", color: "var(--series-1)" },
    { key: "positive" as const, label: lang === "fr" ? "Positif" : "Positive", color: "var(--series-2)" },
    { key: "missing" as const, label: lang === "fr" ? "Non fait / autre" : "Not done / other", color: "var(--series-none)" },
  ];
  const W = 360, rowH = 34, labelW = 112, barH = 18;
  const H = rows.length * rowH + 4;
  const total = (r: StackRow) => r.negative + r.positive + r.missing;
  const empty = rows.every((r) => total(r) === 0);
  return (
    <div className="chart" ref={tt.ref}>
      <h3>{title}</h3>
      <div className="subtitle">{subtitle}</div>
      <div className="legend">{parts.map((p) => <span key={p.key}><span className="sw" style={{ background: p.color }} />{p.label}</span>)}</div>
      {empty ? (
        <p className="small muted">{lang === "fr" ? "Pas encore de données." : "No data yet."}</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
          {rows.map((r, ri) => {
            const n = total(r) || 1;
            const plotW = W - labelW - 44;
            let x = labelW;
            const y = ri * rowH + (rowH - barH) / 2;
            const segs = parts.filter((p) => r[p.key] > 0);
            return (
              <g key={r.label}>
                <text x={0} y={y + barH / 2 + 4} fontSize="12" fill="var(--text-2)">{r.label}</text>
                {segs.map((p, si) => {
                  const w = Math.max(2, (r[p.key] / n) * plotW - (si < segs.length - 1 ? 2 : 0));
                  const node = (
                    <rect key={p.key} x={x} y={y} width={w} height={barH} rx={si === segs.length - 1 ? 4 : 0} fill={p.color}
                      onMouseMove={(e) => tt.show(e, <><strong>{r.label}</strong><br />{p.label} : {r[p.key]} ({Math.round((100 * r[p.key]) / n)} %)</>)}
                      onMouseLeave={tt.hide} />
                  );
                  x += w + 2;
                  return node;
                })}
                <text x={W - 2} y={y + barH / 2 + 4} fontSize="12" textAnchor="end" fill="var(--text)">{total(r)}</text>
              </g>
            );
          })}
        </svg>
      )}
      {tt.node}
      <details className="table-view">
        <summary>{lang === "fr" ? "Voir le tableau" : "Show table"}</summary>
        <table>
          <thead><tr><th></th>{parts.map((p) => <th key={p.key} className="num">{p.label}</th>)}</tr></thead>
          <tbody>{rows.map((r) => <tr key={r.label}><td>{r.label}</td>{parts.map((p) => <td key={p.key} className="num">{r[p.key]}</td>)}</tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

function niceTicks(max: number): number[] {
  const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 5 / 10) * 10;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top; v += step) out.push(v);
  return out;
}
