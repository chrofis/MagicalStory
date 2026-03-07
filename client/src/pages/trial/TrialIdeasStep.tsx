import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ArrowLeft, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import type { CharacterData, StoryInput, GeneratedIdea } from '../TrialWizard';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Props {
  characterData: CharacterData;
  storyInput: StoryInput;
  generatedIdeas: GeneratedIdea[];
  onIdeasGenerated: (ideas: GeneratedIdea[]) => void;
  selectedIdeaIndex: number | null;
  onSelectIdea: (index: number) => void;
  onBack: () => void;
  onCreate: () => void;
}

interface StreamingIdea {
  text: string;
  isStreaming: boolean;
  isFinal: boolean;
}

// ─── Localized strings ──────────────────────────────────────────────────────

const strings: Record<string, {
  title: string;
  subtitle: string;
  generating: string;
  idea: string;
  selectIdea: string;
  selected: string;
  createStory: string;
  regenerate: string;
  back: string;
  errorTitle: string;
  errorRetry: string;
}> = {
  en: {
    title: 'Your Story Ideas',
    subtitle: 'We created two unique story ideas just for you. Pick your favorite!',
    generating: 'Creating magical story ideas...',
    idea: 'Story Idea',
    selectIdea: 'Click to select',
    selected: 'Selected',
    createStory: 'Create My Story',
    regenerate: 'Generate New Ideas',
    back: 'Back',
    errorTitle: 'Something went wrong',
    errorRetry: 'Try Again',
  },
  de: {
    title: 'Deine Geschichtenideen',
    subtitle: 'Wir haben zwei einzigartige Ideen nur für dich erstellt. Wähle deinen Favoriten!',
    generating: 'Magische Geschichtenideen werden erstellt...',
    idea: 'Geschichtenidee',
    selectIdea: 'Klicke zum Auswählen',
    selected: 'Ausgewählt',
    createStory: 'Meine Geschichte erstellen',
    regenerate: 'Neue Ideen erstellen',
    back: 'Zurück',
    errorTitle: 'Etwas ist schiefgelaufen',
    errorRetry: 'Erneut versuchen',
  },
  fr: {
    title: 'Vos idées d\'histoire',
    subtitle: 'Nous avons créé deux idées uniques rien que pour vous. Choisissez votre préférée !',
    generating: 'Création d\'idées magiques...',
    idea: 'Idée d\'histoire',
    selectIdea: 'Cliquez pour sélectionner',
    selected: 'Sélectionnée',
    createStory: 'Créer mon histoire',
    regenerate: 'Générer de nouvelles idées',
    back: 'Retour',
    errorTitle: 'Quelque chose s\'est mal passé',
    errorRetry: 'Réessayer',
  },
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function TrialIdeasStep({
  characterData,
  storyInput,
  generatedIdeas,
  onIdeasGenerated,
  selectedIdeaIndex,
  onSelectIdea,
  onBack,
  onCreate,
}: Props) {
  const lang = storyInput.language?.startsWith('de') ? 'de' : storyInput.language === 'fr' ? 'fr' : 'en';
  const t = useMemo(() => strings[lang] || strings.en, [lang]);

  const [streamingIdeas, setStreamingIdeas] = useState<StreamingIdea[]>([
    { text: '', isStreaming: false, isFinal: false },
    { text: '', isStreaming: false, isFinal: false },
  ]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasGenerated, setHasGenerated] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Determine if we already have final ideas (from previous generation)
  const hasFinalIdeas = generatedIdeas.length === 2 && generatedIdeas[0].title && generatedIdeas[1].title;

  // ─── Generate ideas via SSE stream ─────────────────────────────────────────

  const generateIdeas = useCallback(async () => {
    // Abort any existing stream
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsGenerating(true);
    setError(null);
    setStreamingIdeas([
      { text: '', isStreaming: true, isFinal: false },
      { text: '', isStreaming: true, isFinal: false },
    ]);

    try {
      const apiUrl = import.meta.env.VITE_API_URL || '';
      const response = await fetch(`${apiUrl}/api/trial/generate-ideas-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storyCategory: storyInput.storyCategory,
          storyTopic: storyInput.storyTopic,
          storyTheme: storyInput.storyTheme,
          language: storyInput.language,
          pages: 10,
          characters: [
            {
              name: characterData.name,
              age: characterData.age,
              gender: characterData.gender,
              isMain: true,
              traits: characterData.traits,
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(line.slice(6));

            if (data.error) {
              setError(data.error);
              setIsGenerating(false);
              return;
            }

            if (data.done) {
              setIsGenerating(false);
              return;
            }

            // Update streaming ideas
            setStreamingIdeas((prev) => {
              const next = [...prev];
              if (data.story1 !== undefined) {
                next[0] = {
                  text: data.story1,
                  isStreaming: !data.isFinal,
                  isFinal: !!data.isFinal,
                };
              }
              if (data.story2 !== undefined) {
                next[1] = {
                  text: data.story2,
                  isStreaming: !data.isFinal,
                  isFinal: !!data.isFinal,
                };
              }
              return next;
            });
          } catch {
            // Ignore malformed JSON lines
          }
        }
      }

      setIsGenerating(false);
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setError(err.message || 'Failed to generate ideas');
      setIsGenerating(false);
    }
  }, [characterData, storyInput]);

  // When both ideas are final, persist to parent
  useEffect(() => {
    if (streamingIdeas[0].isFinal && streamingIdeas[1].isFinal) {
      // Parse title from the text (first line or first sentence)
      const parseIdea = (text: string): GeneratedIdea => {
        const lines = text.trim().split('\n').filter((l) => l.trim());
        // Try to extract a title (first line, often formatted as "**Title**" or "# Title")
        let title = lines[0] || '';
        title = title.replace(/^[#*\s]+/, '').replace(/[*]+$/, '').trim();
        const summary = lines.slice(1).join('\n').trim();
        return { title, summary, themes: [] };
      };

      onIdeasGenerated([parseIdea(streamingIdeas[0].text), parseIdea(streamingIdeas[1].text)]);
      setHasGenerated(true);
    }
  }, [streamingIdeas, onIdeasGenerated]);

  // Auto-generate on mount (only if we don't have ideas already)
  useEffect(() => {
    if (!hasFinalIdeas && !hasGenerated && !isGenerating) {
      generateIdeas();
    }

    return () => {
      abortControllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Display text: use streaming or final ideas ────────────────────────────

  const displayIdeas = hasFinalIdeas
    ? generatedIdeas.map((idea) => ({
        text: idea.title + (idea.summary ? '\n' + idea.summary : ''),
        isStreaming: false,
        isFinal: true,
      }))
    : streamingIdeas;

  const canCreate = selectedIdeaIndex !== null && !isGenerating;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto pt-4">
      <h2 className="text-2xl font-bold text-gray-900 text-center mb-2">{t.title}</h2>
      <p className="text-gray-500 text-center mb-6">{t.subtitle}</p>

      {/* Error state */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-center">
          <p className="text-red-700 font-medium mb-2">{t.errorTitle}</p>
          <p className="text-red-600 text-sm mb-3">{error}</p>
          <button
            onClick={generateIdeas}
            className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium"
          >
            <RefreshCw className="w-4 h-4" />
            {t.errorRetry}
          </button>
        </div>
      )}

      {/* Loading indicator (before any text arrives) */}
      {isGenerating && !displayIdeas[0].text && !displayIdeas[1].text && !error && (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="relative">
            <Sparkles className="w-10 h-10 text-indigo-400 animate-pulse" />
            <Loader2 className="w-6 h-6 text-indigo-600 animate-spin absolute -bottom-1 -right-1" />
          </div>
          <p className="text-indigo-600 font-medium">{t.generating}</p>
        </div>
      )}

      {/* Idea cards */}
      {(displayIdeas[0].text || displayIdeas[1].text) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {displayIdeas.map((idea, index) => {
            const isSelected = selectedIdeaIndex === index;
            const hasText = !!idea.text;
            const isEditable = idea.isFinal || hasFinalIdeas;

            return (
              <div
                key={index}
                onClick={() => {
                  if (isEditable) {
                    onSelectIdea(index);
                  }
                }}
                className={`relative text-left p-5 rounded-xl border-2 transition-all min-h-[40vh] flex flex-col ${
                  isSelected
                    ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200 shadow-lg'
                    : hasText
                      ? 'border-gray-200 hover:border-indigo-300 hover:shadow-md bg-white'
                      : 'border-gray-200 bg-gray-50'
                } ${isEditable ? 'cursor-pointer' : 'cursor-default'}`}
              >
                {/* Card header */}
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-bold uppercase tracking-wider text-gray-400">
                    {t.idea} {index + 1}
                  </span>
                  {isSelected && (
                    <span className="text-xs font-bold text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded-full">
                      {t.selected}
                    </span>
                  )}
                </div>

                {/* Content */}
                {hasText ? (
                  isEditable ? (
                    <textarea
                      value={hasFinalIdeas ? generatedIdeas[index].title + (generatedIdeas[index].summary ? '\n' + generatedIdeas[index].summary : '') : idea.text}
                      onChange={(e) => {
                        e.stopPropagation();
                        const text = e.target.value;
                        const lines = text.split('\n').filter(l => l.trim());
                        let title = lines[0] || '';
                        title = title.replace(/^[#*\s]+/, '').replace(/[*]+$/, '').trim();
                        const summary = lines.slice(1).join('\n').trim();
                        const updated = [...generatedIdeas];
                        updated[index] = { ...updated[index], title, summary };
                        onIdeasGenerated(updated);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 w-full text-sm text-gray-700 leading-relaxed bg-transparent border-0 outline-none resize-none p-0"
                      placeholder={t.idea}
                    />
                  ) : (
                    <div className="text-sm text-gray-700 leading-relaxed whitespace-pre-line flex-1">
                      {idea.text}
                      {idea.isStreaming && (
                        <span className="inline-block w-1.5 h-4 bg-indigo-500 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
                      )}
                    </div>
                  )
                ) : (
                  <div className="flex items-center gap-2 py-8 justify-center flex-1">
                    <Loader2 className="w-5 h-5 text-gray-300 animate-spin" />
                  </div>
                )}

                {/* Select button */}
                {isEditable && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onSelectIdea(index); }}
                    className={`mt-3 w-full py-2 rounded-lg text-sm font-semibold transition-all ${
                      isSelected
                        ? 'bg-indigo-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-indigo-100 hover:text-indigo-700'
                    }`}
                  >
                    {isSelected ? t.selected : t.selectIdea}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Regenerate button (only when not generating) */}
      {!isGenerating && (hasFinalIdeas || hasGenerated) && (
        <div className="text-center mb-4">
          <button
            onClick={generateIdeas}
            className="inline-flex items-center gap-2 text-sm text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            {t.regenerate}
          </button>
        </div>
      )}

      {/* Create Story button */}
      <button
        onClick={onCreate}
        disabled={!canCreate}
        className={`w-full py-4 rounded-xl text-lg font-bold flex items-center justify-center gap-3 transition-all ${
          canCreate
            ? 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-xl shadow-indigo-200 hover:shadow-2xl hover:scale-[1.01]'
            : 'bg-gray-200 text-gray-400 cursor-not-allowed'
        }`}
      >
        <Sparkles className="w-5 h-5" />
        {t.createStory}
      </button>

      {/* Back */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-gray-500 hover:text-gray-700 transition-colors mx-auto mt-4"
      >
        <ArrowLeft className="w-4 h-4" />
        {t.back}
      </button>
    </div>
  );
}
