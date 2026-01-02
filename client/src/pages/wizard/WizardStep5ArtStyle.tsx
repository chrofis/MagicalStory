import { Palette } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { ArtStyleSelector } from '@/components/story/ArtStyleSelector';

interface WizardStep5Props {
  artStyle: string;
  onArtStyleChange: (style: string) => void;
}

/**
 * Step 5: Art Style Selection
 * Dedicated step for choosing the visual style of the story
 */
export function WizardStep5ArtStyle({
  artStyle,
  onArtStyleChange,
}: WizardStep5Props) {
  const { language } = useLanguage();

  const title = language === 'de'
    ? 'Kunststil'
    : language === 'fr'
    ? 'Style artistique'
    : 'Art Style';

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
        <Palette size={24} /> {title}
      </h2>
      <ArtStyleSelector
        selectedStyle={artStyle}
        onSelect={onArtStyleChange}
      />
    </div>
  );
}
