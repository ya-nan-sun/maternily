export type UiLang = "fr" | "en";

const STRINGS = {
  appTitle: ["Maternily", "Maternily"],
  tabPhone: ["Téléphone de la sage-femme", "Midwife's phone"],
  tabOffice: ["Bureau DayOne", "DayOne office"],
  online: ["En ligne", "Online"],
  offline: ["Hors ligne", "Offline"],
  slowNetwork: ["Réseau lent (3 s par envoi)", "Slow network (3 s per upload)"],
  midwife: ["Sage-femme", "Midwife"],
  pin: ["Code PIN", "PIN"],
  unlock: ["Déverrouiller", "Unlock"],
  pinHint: ["Le PIN chiffre tout ce qui est stocké sur ce téléphone (démo : 1234).", "The PIN encrypts everything stored on this phone (demo: 1234)."],
  wrongPin: ["PIN incorrect pour les données de ce téléphone.", "Wrong PIN for this phone's data."],
  typeMessage: ["Message", "Message"],
  send: ["Envoyer", "Send"],
  camera: ["Photo", "Photo"],
  photoCheckTitle: ["Vérifiez la photo avant l'envoi", "Check this photo before sending"],
  photoCheckHelp: [
    "La page risque d'être difficile à lire. Reprenez la photo pour un meilleur résultat, ou envoyez-la quand même.",
    "This page may be difficult to read. Retake it for a clearer result, or send it anyway.",
  ],
  photoRetake: ["Reprendre la photo", "Retake photo"],
  photoSendAnyway: ["Envoyer quand même", "Send anyway"],
  photoIssues: ["À améliorer", "Could be improved"],
  welcomeTitle: ["Bonjour 👋", "Hello 👋"],
  welcomeText: [
    "Envoyez les pages de votre registre. Je les lis, puis je vous demande de vérifier uniquement les passages incertains.",
    "Send the pages of your registry. I’ll read them, then ask you to check only the parts I’m unsure about.",
  ],
  firstSteps: ["1. Photographier  ·  2. Vérifier  ·  3. Partager le rapport", "1. Photograph  ·  2. Review  ·  3. Share the report"],
  reportTitle: ["Rapport du registre", "Registry report"],
  reportMeta: ["{pages} page(s) · {fields} valeur(s) extraites", "{pages} page(s) · {fields} extracted value(s)"],
  reportDownload: ["Télécharger le PDF", "Download PDF"],
  reportWhatsApp: ["Partager sur WhatsApp", "Share on WhatsApp"],
  reportClose: ["Fermer", "Close"],
  reportLoading: ["Préparation du rapport…", "Preparing report…"],
  reportError: ["Impossible de préparer le rapport. Réessayez lorsque le réseau est disponible.", "Could not prepare the report. Try again when you have a connection."],
  reportPrivacy: [
    "Le rapport ne contient pas de nom. Vérifiez les valeurs avant de le partager.",
    "The report contains no name. Review the values before sharing.",
  ],
  reportAttach: [
    "Le PDF a été téléchargé. Joignez-le à la conversation WhatsApp avant l’envoi.",
    "The PDF has been downloaded. Attach it to the WhatsApp conversation before sending.",
  ],
  reportStatus: ["Statut", "Status"],
  reportConfidence: ["Confiance", "Confidence"],
  reportReason: ["À vérifier", "Needs review"],
  reportPages: ["Pages traitées", "Pages processed"],
  reportIssues: ["Qualité de la photo à vérifier", "Photo quality to check"],
  gallery: ["Pages d'exemple", "Sample pages"],
  queue: ["File d'attente chiffrée sur l'appareil", "Encrypted queue on the device"],
  queueEmpty: ["Rien en attente.", "Nothing queued."],
  encrypted: ["Stockage local chiffré (AES-GCM, clé dérivée du PIN)", "Local storage encrypted (AES-GCM, PIN-derived key)"],
  device: ["Appareil (simulation)", "Device (simulation)"],
  botLanguage: ["Langue de l'agent", "Agent language"],
  qualityWarn: ["Cette photo semble {issues}. L'envoyer quand même ?", "This photo looks {issues}. Send it anyway?"],
  blurry: ["floue", "blurry"],
  too_dark: ["trop sombre", "too dark"],
  too_bright: ["surexposée", "overexposed"],
  pickPages: ["Choisissez les pages dans l'ordre, puis envoyez", "Pick pages in order, then send"],
  sendSelected: ["Envoyer {n} photo(s)", "Send {n} photo(s)"],
  cancel: ["Annuler", "Cancel"],
  realPhotos: ["Photos réelles d'un livret (peuvent contenir des données réelles : ne pas utiliser en démo)", "Real booklet photos (may contain real data: do not use in demos)"],
  patientSet: ["Patiente fictive {n} ({split})", "Synthetic patient {n} ({split})"],
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
