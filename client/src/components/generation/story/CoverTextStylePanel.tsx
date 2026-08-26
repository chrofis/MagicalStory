import { useState } from 'react';
import { Loader2, Palette, RotateCcw } from 'lucide-react';

/** User typography override for cover text — subset semantics, missing field = automatic. */
export interface CoverTextStyle {
  fontId?: string;   // front title font id (server FONTS key)
  layout?: string;   // front title effect: arch | archdown | tilt | straight
  color?: string;    // #rrggbb face colour (title or dedication)
  font?: string;     // dedication font family name (server WFONTS)
  align?: string;    // dedication horizontal position: left | center | right
}

// Keep in sync with server/lib/coverTypography.js (FONTS / TITLE_LAYOUTS / WFONTS).
// css mirrors the server's family/weight/style/uppercase so the preview shows
// what the baked cover will actually look like.
interface FontOption { id: string; label: string; family: string; weight: number; italic?: boolean; upper?: boolean }
// Fredoka, Baloo 2 and Bungee were cut from the title pool (owner, 2026-08-18):
// on a painted cover they read as a UI typeface. The server drops any fontId it
// does not know, so an entry here that is missing there is a silently ignored
// pick — these two lists must stay identical.
const TITLE_FONTS: FontOption[] = [
  { id: 'caveat', label: 'Caveat', family: 'Caveat', weight: 600 },
  { id: 'kalam', label: 'Kalam', family: 'Kalam', weight: 400 },
  { id: 'patrick', label: 'Patrick Hand', family: 'Patrick Hand', weight: 400 },
  { id: 'gochi', label: 'Gochi Hand', family: 'Gochi Hand', weight: 400 },
  { id: 'pacifico', label: 'Pacifico', family: 'Pacifico', weight: 400 },
  { id: 'chewy', label: 'Chewy', family: 'Chewy', weight: 400 },
  { id: 'shrikhand', label: 'Shrikhand', family: 'Shrikhand', weight: 400 },
  { id: 'titan', label: 'Titan One', family: 'Titan One', weight: 400 },
  { id: 'lilita', label: 'Lilita One', family: 'Lilita One', weight: 400, upper: true },
  { id: 'luckiest', label: 'Luckiest Guy', family: 'Luckiest Guy', weight: 400, upper: true },
];
const DEDICATION_FONTS: FontOption[] = [
  { id: 'Caveat', label: 'Caveat', family: 'Caveat', weight: 600 },
  { id: 'Kalam', label: 'Kalam', family: 'Kalam', weight: 400 },
  { id: 'Patrick Hand', label: 'Patrick Hand', family: 'Patrick Hand', weight: 400 },
  { id: 'Gochi Hand', label: 'Gochi Hand', family: 'Gochi Hand', weight: 400 },
  { id: 'EB Garamond', label: 'EB Garamond', family: 'EB Garamond', weight: 400, italic: true },
];

// Loaded once, on first panel open — same Google Fonts host the site already uses.
const PREVIEW_CSS_ID = 'cover-font-preview-css';
const PREVIEW_CSS_URL = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@600&family=Baloo+2:wght@800&family=Luckiest+Guy&family=Bungee&family=Titan+One&family=Lilita+One&family=Chewy&family=Shrikhand&family=Pacifico&family=Caveat:wght@600&family=Kalam&family=Patrick+Hand&family=Gochi+Hand&family=EB+Garamond:ital@0;1&display=swap';
function ensurePreviewFonts() {
  if (document.getElementById(PREVIEW_CSS_ID)) return;
  const link = document.createElement('link');
  link.id = PREVIEW_CSS_ID;
  link.rel = 'stylesheet';
  link.href = PREVIEW_CSS_URL;
  document.head.appendChild(link);
}
const SWATCHES = ['#e63946', '#f77f00', '#ffd60a', '#2a9d8f', '#1e6fd9', '#7b2cbf', '#d81159', '#ffffff', '#14110d'];

interface CoverTextStylePanelProps {
  kind: 'front' | 'dedication';
  language: string;
  currentStyle?: CoverTextStyle | null;
  disabled?: boolean;
  onApply: (style: CoverTextStyle | null) => Promise<void>;
  /** The actual cover text (title / dedication) — each font option renders its first words. */
  previewText?: string;
}

/**
 * Cover text styling — font / effect / colour pickers for the front-cover title
 * and the dedication text. Each Apply re-composites the cover server-side from
 * the textless art (fast, no AI) — the updated cover IS the preview.
 */
export function CoverTextStylePanel({ kind, language, currentStyle, disabled, onApply, previewText }: CoverTextStylePanelProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fontSel, setFontSel] = useState<string>(currentStyle?.fontId || currentStyle?.font || 'auto');
  const [layoutSel, setLayoutSel] = useState<string>(currentStyle?.layout || 'auto');
  const [colorSel, setColorSel] = useState<string>(currentStyle?.color || 'auto');
  const [alignSel, setAlignSel] = useState<string>(currentStyle?.align || 'auto');

  const t = (de: string, fr: string, en: string) => (language === 'de' ? de : language === 'fr' ? fr : en);
  const LAYOUTS: Array<{ id: string; label: string }> = [
    { id: 'arch', label: t('Bogen', 'Arche', 'Arch') },
    { id: 'archdown', label: t('Bogen unten', 'Arche inversée', 'Arch down') },
    { id: 'tilt', label: t('Geneigt', 'Incliné', 'Tilted') },
    { id: 'straight', label: t('Gerade', 'Droit', 'Straight') },
  ];

  const buildStyle = (): CoverTextStyle | null => {
    const s: CoverTextStyle = {};
    if (fontSel !== 'auto') { if (kind === 'front') s.fontId = fontSel; else s.font = fontSel; }
    if (kind === 'front' && layoutSel !== 'auto') s.layout = layoutSel;
    if (colorSel !== 'auto') s.color = colorSel;
    if (kind === 'dedication' && alignSel !== 'auto') s.align = alignSel;
    return Object.keys(s).length ? s : null;
  };

  const apply = async (style: CoverTextStyle | null) => {
    setBusy(true);
    setError(null);
    try {
      await onApply(style);
      if (style === null) { setFontSel('auto'); setLayoutSel('auto'); setColorSel('auto'); setAlignSel('auto'); }
    } catch (e: any) {
      setError(e?.message || t('Fehler beim Anwenden', "Échec de l'application", 'Failed to apply'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2">
      <button
        onClick={() => { if (!open) ensurePreviewFonts(); setOpen(!open); }}
        disabled={disabled}
        className="w-full bg-indigo-500 text-white px-3 py-2 rounded-lg hover:bg-indigo-600 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
      >
        <Palette size={14} />
        {kind === 'front'
          ? t('Titel-Design', 'Style du titre', 'Title style')
          : t('Widmungs-Design', 'Style de la dédicace', 'Dedication style')}
      </button>

      {open && (
        <div className="mt-2 bg-white border border-indigo-200 rounded-lg p-3 space-y-3">
          {/* Font */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">
              {t('Schriftart', 'Police', 'Font')}
            </label>
            {(() => {
              const sample = (previewText || '').trim().split(/\s+/).filter(Boolean).slice(0, 10).join(' ');
              const fonts = kind === 'front' ? TITLE_FONTS : DEDICATION_FONTS;
              return (
                <div className="border border-gray-300 rounded-lg bg-white divide-y divide-gray-100 max-h-56 overflow-y-auto">
                  <button
                    onClick={() => setFontSel('auto')}
                    className={`w-full text-left px-3 py-2 text-sm ${fontSel === 'auto' ? 'bg-indigo-50 text-indigo-700 font-semibold' : 'text-gray-700 hover:bg-gray-50'}`}
                  >
                    {t('Automatisch', 'Automatique', 'Automatic')}
                  </button>
                  {fonts.map(f => (
                    <button
                      key={f.id}
                      onClick={() => setFontSel(f.id)}
                      className={`w-full text-left px-3 py-1.5 ${fontSel === f.id ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}
                    >
                      <span
                        className="block text-lg leading-snug truncate text-gray-800"
                        style={{
                          fontFamily: `'${f.family}', sans-serif`,
                          fontWeight: f.weight,
                          fontStyle: f.italic ? 'italic' : 'normal',
                          textTransform: f.upper ? 'uppercase' : 'none',
                        }}
                      >
                        {sample || f.label}
                      </span>
                      <span className={`block text-[11px] ${fontSel === f.id ? 'text-indigo-600 font-semibold' : 'text-gray-400'}`}>{f.label}</span>
                    </button>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* Effect — front title only */}
          {kind === 'front' && (
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">
                {t('Effekt', 'Effet', 'Effect')}
              </label>
              <select
                value={layoutSel}
                onChange={e => setLayoutSel(e.target.value)}
                className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white"
              >
                <option value="auto">{t('Automatisch', 'Automatique', 'Automatic')}</option>
                {LAYOUTS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </div>
          )}

          {/* Position — dedication only. Auto picks the clearest pocket around
              the detected figures; pinning it wins over the pocket search. */}
          {kind === 'dedication' && (
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">
                {t('Position', 'Position', 'Position')}
              </label>
              <select
                value={alignSel}
                onChange={e => setAlignSel(e.target.value)}
                className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white"
              >
                <option value="auto">{t('Automatisch', 'Automatique', 'Automatic')}</option>
                <option value="left">{t('Links', 'À gauche', 'Left')}</option>
                <option value="center">{t('Mitte', 'Centré', 'Center')}</option>
                <option value="right">{t('Rechts', 'À droite', 'Right')}</option>
              </select>
            </div>
          )}

          {/* Colour */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">
              {t('Farbe', 'Couleur', 'Colour')}
            </label>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => setColorSel('auto')}
                className={`px-2 py-1 rounded-md text-xs font-medium border ${colorSel === 'auto' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-300 text-gray-600 hover:border-indigo-300'}`}
              >
                {t('Auto', 'Auto', 'Auto')}
              </button>
              {SWATCHES.map(hex => (
                <button
                  key={hex}
                  onClick={() => setColorSel(hex)}
                  className={`w-7 h-7 rounded-full border-2 ${colorSel === hex ? 'border-indigo-500 ring-2 ring-indigo-200' : 'border-gray-200'}`}
                  style={{ backgroundColor: hex }}
                  aria-label={hex}
                />
              ))}
              <input
                type="color"
                value={colorSel !== 'auto' ? colorSel : '#e63946'}
                onChange={e => setColorSel(e.target.value)}
                className="w-9 h-8 p-0.5 border border-gray-300 rounded cursor-pointer"
                title={t('Eigene Farbe', 'Couleur personnalisée', 'Custom colour')}
              />
            </div>
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="flex gap-2">
            <button
              onClick={() => apply(buildStyle())}
              disabled={busy}
              className="flex-1 bg-indigo-500 text-white px-3 py-2 rounded-lg hover:bg-indigo-600 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Palette size={14} />}
              {t('Anwenden', 'Appliquer', 'Apply')}
            </button>
            <button
              onClick={() => apply(null)}
              disabled={busy}
              className="px-3 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-600 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
              title={t('Zurück zu Automatisch', 'Retour à automatique', 'Back to automatic')}
            >
              <RotateCcw size={13} />
              {t('Auto', 'Auto', 'Auto')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default CoverTextStylePanel;
