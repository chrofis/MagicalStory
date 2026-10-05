// Accessible names (aria-label / title / alt) for chrome controls shared across the app.
// Kept out of the page translation tables so a component can say uiLabel('close', language)
// without importing a page's strings. Screen-reader users hear these, so they follow the UI language.

type Lang = 'en' | 'de' | 'fr' | 'it';

const LABELS = {
  close: { en: 'Close', de: 'Schliessen', fr: 'Fermer', it: 'Chiudi' },
  dismiss: { en: 'Dismiss', de: 'Ausblenden', fr: 'Ignorer', it: 'Nascondi' },
  fullscreen: { en: 'Fullscreen', de: 'Vollbild', fr: 'Plein écran', it: 'Schermo intero' },
  zoomIn: { en: 'Zoom in', de: 'Vergrössern', fr: 'Agrandir', it: 'Ingrandisci' },
  zoomOut: { en: 'Zoom out', de: 'Verkleinern', fr: 'Réduire', it: 'Riduci' },
  resetZoom: { en: 'Reset zoom', de: 'Zoom zurücksetzen', fr: 'Réinitialiser le zoom', it: 'Reimposta zoom' },
  page: { en: 'Page', de: 'Seite', fr: 'Page', it: 'Pagina' },
  noImage: { en: 'No image', de: 'Kein Bild', fr: 'Aucune image', it: 'Nessuna immagine' },
  dedication: { en: 'Dedication', de: 'Widmung', fr: 'Dédicace', it: 'Dedica' },
  backCover: { en: 'Back cover', de: 'Rückseite', fr: 'Quatrième de couverture', it: 'Retro di copertina' },
  character: { en: 'Character', de: 'Charakter', fr: 'Personnage', it: 'Personaggio' },
  faceCrop: { en: 'Face crop', de: 'Gesichtsausschnitt', fr: 'Recadrage du visage', it: 'Ritaglio del viso' },
  exampleFullBody: { en: 'Full body example', de: 'Beispiel: ganzer Körper', fr: 'Exemple : corps entier', it: 'Esempio: corpo intero' },
  exampleUpperBody: { en: 'Upper body example', de: 'Beispiel: Oberkörper', fr: 'Exemple : haut du corps', it: 'Esempio: busto' },
  exampleTooClose: { en: 'Too close example', de: 'Beispiel: zu nah', fr: 'Exemple : trop près', it: 'Esempio: troppo vicino' },
  exampleNoAccessories: { en: 'No accessories example', de: 'Beispiel: ohne Accessoires', fr: 'Exemple : sans accessoires', it: 'Esempio: senza accessori' },
  exampleOnePerson: { en: 'One person only example', de: 'Beispiel: nur eine Person', fr: 'Exemple : une seule personne', it: 'Esempio: una sola persona' },
  menu: { en: 'Menu', de: 'Menü', fr: 'Menu', it: 'Menu' },
} as const;

export type UiLabelKey = keyof typeof LABELS;

export function uiLabel(key: UiLabelKey, language: string): string {
  const row = LABELS[key] as Record<Lang, string>;
  return row[language as Lang] || row.en;
}
