import { useState } from 'react';
import { Loader2, Palette, RotateCcw } from 'lucide-react';

/** User typography override for cover text — subset semantics, missing field = automatic. */
export interface CoverTextStyle {
  fontId?: string;   // front title font id (server FONTS key)
  layout?: string;   // front title effect: arch | archdown | tilt | straight
  color?: string;    // #rrggbb face colour (title or dedication)
  font?: string;     // dedication font family name (server WFONTS)
}

// Keep in sync with server/lib/coverTypography.js (FONTS / TITLE_LAYOUTS / WFONTS).
const TITLE_FONTS: Array<{ id: string; label: string }> = [
  { id: 'fredoka', label: 'Fredoka' },
  { id: 'baloo', label: 'Baloo' },
  { id: 'luckiest', label: 'Luckiest Guy' },
  { id: 'bungee', label: 'Bungee' },
  { id: 'titan', label: 'Titan One' },
  { id: 'lilita', label: 'Lilita One' },
  { id: 'chewy', label: 'Chewy' },
  { id: 'shrikhand', label: 'Shrikhand' },
  { id: 'pacifico', label: 'Pacifico' },
];
const DEDICATION_FONTS = ['Caveat', 'Kalam', 'Patrick Hand', 'Gochi Hand', 'EB Garamond'];
const SWATCHES = ['#e63946', '#f77f00', '#ffd60a', '#2a9d8f', '#1e6fd9', '#7b2cbf', '#d81159', '#ffffff', '#14110d'];

interface CoverTextStylePanelProps {
  kind: 'front' | 'dedication';
  language: string;
  currentStyle?: CoverTextStyle | null;
  disabled?: boolean;
  onApply: (style: CoverTextStyle | null) => Promise<void>;
}

/**
 * Cover text styling — font / effect / colour pickers for the front-cover title
 * and the dedication text. Each Apply re-composites the cover server-side from
 * the textless art (fast, no AI) — the updated cover IS the preview.
 */
export function CoverTextStylePanel({ kind, language, currentStyle, disabled, onApply }: CoverTextStylePanelProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fontSel, setFontSel] = useState<string>(currentStyle?.fontId || currentStyle?.font || 'auto');
  const [layoutSel, setLayoutSel] = useState<string>(currentStyle?.layout || 'auto');
  const [colorSel, setColorSel] = useState<string>(currentStyle?.color || 'auto');

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
    return Object.keys(s).length ? s : null;
  };

  const apply = async (style: CoverTextStyle | null) => {
    setBusy(true);
    setError(null);
    try {
      await onApply(style);
      if (style === null) { setFontSel('auto'); setLayoutSel('auto'); setColorSel('auto'); }
    } catch (e: any) {
      setError(e?.message || t('Fehler beim Anwenden', "Échec de l'application", 'Failed to apply'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(!open)}
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
            <select
              value={fontSel}
              onChange={e => setFontSel(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white"
            >
              <option value="auto">{t('Automatisch', 'Automatique', 'Automatic')}</option>
              {(kind === 'front' ? TITLE_FONTS : DEDICATION_FONTS.map(f => ({ id: f, label: f }))).map(f => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
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
