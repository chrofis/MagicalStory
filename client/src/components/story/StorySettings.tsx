import { Wand2, Star } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { Character } from '@/types/character';
import type { LanguageLevel } from '@/types/story';

interface StorySettingsProps {
  characters: Character[];
  mainCharacters: number[];
  onToggleMainCharacter: (charId: number) => void;
  languageLevel: LanguageLevel;
  onLanguageLevelChange: (level: LanguageLevel) => void;
  pages: number;
  onPagesChange: (pages: number) => void;
  dedication: string;
  onDedicationChange: (dedication: string) => void;
  storyDetails: string;
  onStoryDetailsChange: (details: string) => void;
  developerMode?: boolean;
}

export function StorySettings({
  characters,
  mainCharacters,
  onToggleMainCharacter,
  languageLevel,
  onLanguageLevelChange,
  pages,
  onPagesChange,
  dedication,
  onDedicationChange,
  storyDetails,
  onStoryDetailsChange,
  developerMode = false,
}: StorySettingsProps) {
  const { t, language } = useLanguage();

  const readingLevels = [
    {
      value: '1st-grade' as LanguageLevel,
      label: t.firstGrade,
      desc: t.firstGradeDesc,
      image: '/images/text and image on each page.jpg',
    },
    {
      value: 'standard' as LanguageLevel,
      label: t.standard,
      desc: t.standardDesc,
      image: '/images/left page text, right page image.jpg',
    },
    {
      value: 'advanced' as LanguageLevel,
      label: t.advanced,
      desc: t.advancedDesc,
      image: '/images/dense text left.jpg',
    },
  ];

  // Generate page option label based on language level
  const getPageLabel = (pageCount: number, isTest = false) => {
    const testSuffix = isTest ? ' (Test)' : '';
    if (languageLevel === '1st-grade') {
      return `${pageCount} ${language === 'de' ? 'Seiten' : language === 'fr' ? 'pages' : 'pages'}${testSuffix}`;
    }
    const textPages = pageCount / 2;
    const imagePages = pageCount / 2;
    if (language === 'de') {
      return `${pageCount} Seiten (${textPages} Text + ${imagePages} Bilder)${testSuffix}`;
    } else if (language === 'fr') {
      return `${pageCount} pages (${textPages} texte + ${imagePages} images)${testSuffix}`;
    }
    return `${pageCount} pages (${textPages} text + ${imagePages} images)${testSuffix}`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
        <Wand2 size={24} /> {t.storySettings}
      </h2>

      <div className="space-y-6">
        {/* Main Character Selection */}
        <div>
          <label className="block text-xl font-semibold mb-3">{t.selectMainCharacters}</label>
          <div className="grid md:grid-cols-2 gap-3">
            {characters.map((char) => (
              <button
                key={char.id}
                onClick={() => onToggleMainCharacter(char.id)}
                className={`p-4 rounded-lg border-2 transition-all text-left ${
                  mainCharacters.includes(char.id)
                    ? 'border-indigo-600 bg-indigo-50'
                    : 'border-gray-200 hover:border-indigo-300'
                }`}
              >
                <div className="flex items-center gap-3">
                  {char.photoUrl && (
                    <img
                      src={char.photoUrl}
                      alt={char.name}
                      className="w-12 h-12 rounded-full object-cover"
                    />
                  )}
                  <div className="flex-1">
                    <div className="font-bold text-base flex items-center gap-2">
                      {char.name}
                      <span className={mainCharacters.includes(char.id) ? 'inline-block' : 'hidden'}>
                        <Star size={16} className="text-indigo-600" />
                      </span>
                    </div>
                    <div className="text-sm md:text-base text-gray-500">
                      {char.gender === 'male' ? t.male : char.gender === 'female' ? t.female : t.other}, {char.age}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Reading Level Selection */}
        <div>
          <label className="block text-xl font-semibold mb-3">{t.readingLevel}</label>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {readingLevels.map((level) => (
              <button
                key={level.value}
                onClick={() => onLanguageLevelChange(level.value)}
                className={`text-left rounded-lg border-2 transition-all overflow-hidden ${
                  languageLevel === level.value
                    ? 'border-indigo-600 ring-2 ring-indigo-200'
                    : 'border-gray-200 hover:border-indigo-300'
                }`}
              >
                <div className="w-full bg-gray-100 p-2">
                  <img
                    src={level.image}
                    alt={level.label}
                    className="w-full h-auto object-contain"
                  />
                </div>
                <div className="p-3">
                  <div className="font-semibold text-base">{level.label}</div>
                  <div className="text-sm text-gray-500">{level.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Number of Pages - shown after reading level is selected */}
        {languageLevel && (
          <div>
            <label className="block text-xl font-semibold mb-3">
              {t.numberOfPages}
            </label>
            <select
              value={pages}
              onChange={(e) => onPagesChange(parseInt(e.target.value))}
              className="w-full px-4 py-3 border-2 border-indigo-200 rounded-lg focus:border-indigo-600 focus:outline-none text-base md:text-lg font-semibold"
            >
              {/* Developer mode testing option */}
              {developerMode && (
                <option value="10">{getPageLabel(10, true)}</option>
              )}
              {/* Normal user options */}
              <option value="30">{getPageLabel(30)}</option>
              <option value="40">{getPageLabel(40)}</option>
              <option value="50">{getPageLabel(50)}</option>
            </select>
            <p className="text-sm text-gray-500 mt-2">
              {languageLevel === '1st-grade'
                ? (language === 'de' ? 'Jede Seite enthält ein Bild mit Text darunter' : language === 'fr' ? 'Chaque page contient une image avec du texte en dessous' : 'Each page contains an image with text below')
                : (language === 'de' ? 'Abwechselnd Textseite und Bildseite' : language === 'fr' ? 'Alternance de pages de texte et d\'images' : 'Alternating text page and image page')
              }
            </p>
          </div>
        )}

        {/* Additional Story Details */}
        <div>
          <label className="block text-base font-semibold text-gray-800 mb-2">{t.storyDetails}</label>
          <textarea
            value={storyDetails}
            onChange={(e) => onStoryDetailsChange(e.target.value)}
            placeholder={t.storyDetailsPlaceholder}
            className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-indigo-600 focus:outline-none text-base"
            rows={3}
          />
        </div>

        {/* Dedication (Widmung) - Optional */}
        <div>
          <label className="block text-base font-semibold text-gray-800 mb-2">
            {language === 'de' ? 'Widmung (Optional)' : language === 'fr' ? 'Dédicace (Facultatif)' : 'Dedication (Optional)'}
          </label>
          <textarea
            value={dedication}
            onChange={(e) => onDedicationChange(e.target.value)}
            placeholder={language === 'de'
              ? 'z.B. "Für meine liebe Tochter Emma zum 5. Geburtstag"'
              : language === 'fr'
              ? 'Par exemple "Pour ma chère fille Emma pour son 5ème anniversaire"'
              : 'e.g. "For my dear daughter Emma on her 5th birthday"'}
            className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-indigo-600 focus:outline-none text-base"
            rows={2}
            maxLength={200}
          />
          <p className="text-sm text-gray-500 mt-1">
            {language === 'de'
              ? 'Dieser Text wird auf Seite 0 Ihres Buches gedruckt. Wenn Sie nichts eingeben, wird Seite 0 nur eine Illustration ohne Text enthalten.'
              : language === 'fr'
              ? 'Ce texte sera imprimé sur la page 0 de votre livre. Si vous ne saisissez rien, la page 0 ne contiendra qu\'une illustration sans texte.'
              : 'This text will be printed on page 0 of your book. If you leave it empty, page 0 will contain only an illustration with no text.'}
          </p>
        </div>
      </div>
    </div>
  );
}

export default StorySettings;
