import { ChevronDown, Cpu, Sparkles, Image, Palette, Star, Eye, Lightbulb, Server } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

// Available text models (matches server/lib/textModels.js)
export const TEXT_MODELS = {
  'claude-sonnet': {
    provider: 'anthropic',
    description: 'Claude Sonnet 4.6 - Best narrative quality',
    descriptionDe: 'Claude Sonnet 4.6 - Beste Erzählqualität',
    descriptionFr: 'Claude Sonnet 4.6 - Meilleure qualité narrative'
  },
  'claude-haiku': {
    provider: 'anthropic',
    description: 'Claude Haiku 4.5 - Fast and affordable',
    descriptionDe: 'Claude Haiku 4.5 - Schnell und günstig',
    descriptionFr: 'Claude Haiku 4.5 - Rapide et économique'
  },
  'gemini-2.5-pro': {
    provider: 'google',
    description: 'Gemini 2.5 Pro - High quality, large output',
    descriptionDe: 'Gemini 2.5 Pro - Hohe Qualität, grosse Ausgabe',
    descriptionFr: 'Gemini 2.5 Pro - Haute qualité, grande sortie'
  },
  'gemini-2.5-flash': {
    provider: 'google',
    description: 'Gemini 2.5 Flash - Fast with large output',
    descriptionDe: 'Gemini 2.5 Flash - Schnell mit grosser Ausgabe',
    descriptionFr: 'Gemini 2.5 Flash - Rapide avec grande sortie'
  },
  'gemini-2.0-flash': {
    provider: 'google',
    description: 'Gemini 2.0 Flash - Very fast',
    descriptionDe: 'Gemini 2.0 Flash - Sehr schnell',
    descriptionFr: 'Gemini 2.0 Flash - Très rapide'
  }
} as const;

// Available image models
export const IMAGE_MODELS = {
  'gemini-2.5-flash-image': {
    description: 'Gemini 2.5 Flash Image - Fast scene generation',
    descriptionDe: 'Gemini 2.5 Flash Image - Schnelle Szenengenerierung',
    descriptionFr: 'Gemini 2.5 Flash Image - Génération rapide de scènes'
  },
  'gemini-3-pro-image-preview': {
    description: 'Gemini 3 Pro Image - Higher quality (preview)',
    descriptionDe: 'Gemini 3 Pro Image - Höhere Qualität (Vorschau)',
    descriptionFr: 'Gemini 3 Pro Image - Qualité supérieure (aperçu)'
  },
  'flux-schnell': {
    description: 'FLUX Schnell (Runware) - Ultra cheap ($0.0006/image)',
    descriptionDe: 'FLUX Schnell (Runware) - Ultra günstig ($0.0006/Bild)',
    descriptionFr: 'FLUX Schnell (Runware) - Ultra économique ($0.0006/image)'
  },
  'flux-dev': {
    description: 'FLUX Dev (Runware) - Better quality ($0.004/image)',
    descriptionDe: 'FLUX Dev (Runware) - Bessere Qualität ($0.004/Bild)',
    descriptionFr: 'FLUX Dev (Runware) - Meilleure qualité ($0.004/image)'
  }
} as const;

// Available quality evaluation models
export const QUALITY_MODELS = {
  'gemini-2.0-flash': {
    description: 'Gemini 2.0 Flash - Fast evaluation',
    descriptionDe: 'Gemini 2.0 Flash - Schnelle Bewertung',
    descriptionFr: 'Gemini 2.0 Flash - Évaluation rapide'
  },
  'gemini-2.5-flash': {
    description: 'Gemini 2.5 Flash - More thorough',
    descriptionDe: 'Gemini 2.5 Flash - Gründlicher',
    descriptionFr: 'Gemini 2.5 Flash - Plus approfondi'
  }
} as const;

// Available image generation backends
export const IMAGE_BACKENDS = {
  'gemini': {
    description: 'Google Gemini - Best quality (~$0.035/image)',
    descriptionDe: 'Google Gemini - Beste Qualität (~$0.035/Bild)',
    descriptionFr: 'Google Gemini - Meilleure qualité (~$0.035/image)'
  },
  'runware': {
    description: 'FLUX Schnell - Ultra cheap for testing ($0.0006/image)',
    descriptionDe: 'FLUX Schnell - Ultra günstig zum Testen ($0.0006/Bild)',
    descriptionFr: 'FLUX Schnell - Ultra économique pour tests ($0.0006/image)'
  }
} as const;

export type TextModelKey = keyof typeof TEXT_MODELS;
export type ImageModelKey = keyof typeof IMAGE_MODELS;
export type QualityModelKey = keyof typeof QUALITY_MODELS;
export type ImageBackendKey = keyof typeof IMAGE_BACKENDS;

// Available avatar models
export const AVATAR_MODELS = {
  'gemini-2.5-flash-image': {
    description: 'Gemini 2.5 Flash Image - Fast avatar generation',
    descriptionDe: 'Gemini 2.5 Flash Image - Schnelle Avatar-Generierung',
    descriptionFr: 'Gemini 2.5 Flash Image - Génération rapide d\'avatars'
  },
  'gemini-3-pro-image-preview': {
    description: 'Gemini 3 Pro Image - Higher quality (preview)',
    descriptionDe: 'Gemini 3 Pro Image - Höhere Qualität (Vorschau)',
    descriptionFr: 'Gemini 3 Pro Image - Qualité supérieure (aperçu)'
  },
  'ace-plus-plus': {
    description: 'ACE++ (Runware) - Cheap face-consistent avatars (~$0.005)',
    descriptionDe: 'ACE++ (Runware) - Günstige gesichtskonsistente Avatare (~$0.005)',
    descriptionFr: 'ACE++ (Runware) - Avatars économiques avec visage cohérent (~$0.005)'
  }
} as const;

export type AvatarModelKey = keyof typeof AVATAR_MODELS;

export interface ModelSelections {
  ideaModel: TextModelKey | null;  // null = use server default
  outlineModel: TextModelKey | null;
  textModel: TextModelKey | null;
  sceneDescriptionModel: TextModelKey | null;
  imageModel: ImageModelKey | null;
  coverImageModel: ImageModelKey | null;
  qualityModel: QualityModelKey | null;
  imageBackend: ImageBackendKey | null;  // gemini or runware
  avatarModel: AvatarModelKey | null;  // Avatar generation model
}

interface ModelSelectorProps {
  selections: ModelSelections;
  onChange: (selections: ModelSelections) => void;
}

interface ModelDropdownProps {
  label: string;
  icon: React.ReactNode;
  value: string | null;
  options: Record<string, { description: string; descriptionDe?: string; descriptionFr?: string; provider?: string }>;
  onChange: (value: string | null) => void;
  language: string;
}

function ModelDropdown({ label, icon, value, options, onChange, language }: ModelDropdownProps) {
  const getDescription = (opt: { description: string; descriptionDe?: string; descriptionFr?: string }) => {
    if (language === 'de' && opt.descriptionDe) return opt.descriptionDe;
    if (language === 'fr' && opt.descriptionFr) return opt.descriptionFr;
    return opt.description;
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-gray-600 flex items-center gap-1">
        {icon}
        {label}
      </label>
      <div className="relative">
        <select
          value={value || ''}
          onChange={(e) => onChange(e.target.value || null)}
          className="w-full appearance-none bg-white border border-gray-300 rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:border-transparent"
        >
          <option value="">
            {language === 'de' ? 'Server-Standard' : language === 'fr' ? 'Par défaut serveur' : 'Server Default'}
          </option>
          {Object.entries(options).map(([key, opt]) => (
            <option key={key} value={key}>
              {key} {opt.provider ? `(${opt.provider})` : ''}
            </option>
          ))}
        </select>
        <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
      </div>
      {value && options[value] && (
        <p className="text-[10px] text-gray-500 italic">
          {getDescription(options[value])}
        </p>
      )}
    </div>
  );
}

export function ModelSelector({ selections, onChange }: ModelSelectorProps) {
  const { language } = useLanguage();

  const updateSelection = (key: keyof ModelSelections, value: string | null) => {
    onChange({ ...selections, [key]: value });
  };

  return (
    <div className="bg-yellow-50 border-2 border-yellow-400 rounded-xl p-4">
      <h3 className="text-sm font-bold text-yellow-800 mb-3 flex items-center gap-2">
        <Cpu size={16} />
        {language === 'de' ? 'AI-Modell Auswahl (Dev)' : language === 'fr' ? 'Sélection de modèle IA (Dev)' : 'AI Model Selection (Dev)'}
      </h3>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Text Generation Models */}
        <ModelDropdown
          label={language === 'de' ? 'Ideen-Modell' : language === 'fr' ? 'Modèle d\'idées' : 'Idea Model'}
          icon={<Lightbulb size={12} />}
          value={selections.ideaModel}
          options={TEXT_MODELS}
          onChange={(v) => updateSelection('ideaModel', v)}
          language={language}
        />

        <ModelDropdown
          label={language === 'de' ? 'Geschichte (Kombiniert)' : language === 'fr' ? 'Histoire (Combiné)' : 'Story (Combined)'}
          icon={<Sparkles size={12} />}
          value={selections.outlineModel}
          options={TEXT_MODELS}
          onChange={(v) => updateSelection('outlineModel', v)}
          language={language}
        />

        <ModelDropdown
          label={language === 'de' ? 'Text-Modell' : language === 'fr' ? 'Modèle de texte' : 'Text Model'}
          icon={<Sparkles size={12} />}
          value={selections.textModel}
          options={TEXT_MODELS}
          onChange={(v) => updateSelection('textModel', v)}
          language={language}
        />

        <ModelDropdown
          label={language === 'de' ? 'Szenen-Modell' : language === 'fr' ? 'Modèle de scène' : 'Scene Description Model'}
          icon={<Palette size={12} />}
          value={selections.sceneDescriptionModel}
          options={TEXT_MODELS}
          onChange={(v) => updateSelection('sceneDescriptionModel', v)}
          language={language}
        />

        {/* Image Generation Models */}
        <ModelDropdown
          label={language === 'de' ? 'Bild-Modell' : language === 'fr' ? 'Modèle d\'image' : 'Image Model'}
          icon={<Image size={12} />}
          value={selections.imageModel}
          options={IMAGE_MODELS}
          onChange={(v) => updateSelection('imageModel', v)}
          language={language}
        />

        <ModelDropdown
          label={language === 'de' ? 'Cover-Modell' : language === 'fr' ? 'Modèle de couverture' : 'Cover Image Model'}
          icon={<Star size={12} />}
          value={selections.coverImageModel}
          options={IMAGE_MODELS}
          onChange={(v) => updateSelection('coverImageModel', v)}
          language={language}
        />

        {/* Quality Evaluation Model */}
        <ModelDropdown
          label={language === 'de' ? 'Bewertungs-Modell' : language === 'fr' ? 'Modèle d\'évaluation' : 'Quality Eval Model'}
          icon={<Eye size={12} />}
          value={selections.qualityModel}
          options={QUALITY_MODELS}
          onChange={(v) => updateSelection('qualityModel', v)}
          language={language}
        />

        {/* Image Repair Backend (inpainting) */}
        <ModelDropdown
          label={language === 'de' ? 'Bild-Reparatur' : language === 'fr' ? 'Réparation d\'image' : 'Image Repair'}
          icon={<Server size={12} />}
          value={selections.imageBackend}
          options={IMAGE_BACKENDS}
          onChange={(v) => updateSelection('imageBackend', v)}
          language={language}
        />

        {/* Avatar Generation Model */}
        <ModelDropdown
          label={language === 'de' ? 'Avatar-Modell' : language === 'fr' ? 'Modèle d\'avatar' : 'Avatar Model'}
          icon={<Image size={12} />}
          value={selections.avatarModel}
          options={AVATAR_MODELS}
          onChange={(v) => updateSelection('avatarModel', v)}
          language={language}
        />
      </div>

      <p className="text-[10px] text-yellow-700 mt-3 italic">
        {language === 'de'
          ? 'Hinweis: Nur sichtbar für Admin-Benutzer im Entwicklermodus. "Server-Standard" verwendet die Umgebungsvariablen-Konfiguration.'
          : language === 'fr'
          ? 'Note: Visible uniquement pour les utilisateurs admin en mode développeur. "Par défaut serveur" utilise la configuration des variables d\'environnement.'
          : 'Note: Only visible to admin users in developer mode. "Server Default" uses the environment variable configuration.'}
      </p>
    </div>
  );
}

export default ModelSelector;
