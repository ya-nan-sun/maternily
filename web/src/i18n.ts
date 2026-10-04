export type UiLang = "fr" | "en";

const STRINGS = {
  appTitle: ["Maternily", "Maternily"],
  reportDownload: ["Télécharger le PDF", "Download PDF"],
  role: ["Rôle", "Role"],
  supervisor: ["Superviseur (accès aux photos)", "Supervisor (photo access)"],
  analyst: ["Analyste (agrégats seulement)", "Analyst (aggregates only)"],
  overview: ["Vue d'ensemble", "Overview"],
  patients: ["Patientes", "Patients"],
  registries: ["Registres reçus", "Registries received"],
  dashboard: ["Tableau de bord", "Dashboard"],
  aiUsage: ["Utilisation de l'IA", "AI usage"],
  forbidden: ["Ce rôle n'a pas accès à cette vue.", "This role cannot access this view."],
  mockBanner: [
    "Mode démo sans clé API : les pages du jeu de données sont lues depuis la vérité terrain du PDF (avec des doutes simulés). Toute autre photo passe en saisie manuelle.",
    "Demo mode without an API key: dataset pages are read from the PDF ground truth (with simulated doubts). Any other photo goes to manual entry.",
  ],
} as const;

export type StringKey = keyof typeof STRINGS;

export function t(lang: UiLang, key: StringKey, params: Record<string, string | number> = {}): string {
  let s: string = STRINGS[key][lang === "fr" ? 0 : 1];
  for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
  return s;
}
