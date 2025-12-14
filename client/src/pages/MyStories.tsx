import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Book, ArrowLeft, Trash2, Eye } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { storyService } from '@/services';
import { LoadingSpinner, Navigation } from '@/components/common';
import { createLogger } from '@/services/logger';

const log = createLogger('MyStories');

interface StoryListItem {
  id: string;
  title: string;
  story_type: string;
  art_style: string;
  language: string;
  pages: number;
  created_at: string;
  thumbnail?: string;
}

export default function MyStories() {
  const navigate = useNavigate();
  const { language } = useLanguage();
  const { isAuthenticated } = useAuth();
  const [stories, setStories] = useState<StoryListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/');
      return;
    }
    loadStories();
  }, [isAuthenticated, navigate]);

  const loadStories = async () => {
    log.debug('Loading stories...');
    try {
      setIsLoading(true);
      const data = await storyService.getStories();
      log.info('Loaded stories:', data.length);
      setStories(data as unknown as StoryListItem[]);
    } catch (error) {
      log.error('Failed to load stories:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const deleteStory = async (id: string) => {
    const confirmMsg = language === 'de'
      ? 'Diese Geschichte wirklich löschen?'
      : language === 'fr'
      ? 'Voulez-vous vraiment supprimer cette histoire?'
      : 'Are you sure you want to delete this story?';

    if (!confirm(confirmMsg)) return;

    try {
      await storyService.deleteStory(id);
      setStories(stories.filter(s => s.id !== id));
    } catch (error) {
      log.error('Failed to delete story:', error);
      alert(language === 'de'
        ? 'Geschichte konnte nicht gelöscht werden. Bitte versuche es erneut.'
        : language === 'fr'
        ? 'Impossible de supprimer l\'histoire. Veuillez réessayer.'
        : 'Failed to delete story. Please try again.');
    }
  };

  const formatDate = (dateStr: string | undefined) => {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString(language === 'de' ? 'de-DE' : language === 'fr' ? 'fr-FR' : 'en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return '';
    }
  };

  if (!isAuthenticated) {
    return <LoadingSpinner fullScreen />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation currentStep={0} />

      <div className="px-4 md:px-8 py-8">
        <div className="flex items-center gap-4 mb-6">
          <button
            onClick={() => navigate('/create')}
            className="p-2 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <ArrowLeft size={24} />
          </button>
          <h1 className="text-2xl md:text-3xl font-bold text-gray-800 flex items-center gap-2">
            <Book size={28} />
            {language === 'de' ? 'Meine Geschichten' : language === 'fr' ? 'Mes histoires' : 'My Stories'}
          </h1>
        </div>

        {isLoading ? (
          <LoadingSpinner message={language === 'de' ? 'Laden...' : language === 'fr' ? 'Chargement...' : 'Loading...'} />
        ) : stories.length === 0 ? (
          <div className="text-center py-12">
            <Book className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 text-lg">
              {language === 'de'
                ? 'Noch keine Geschichten erstellt'
                : language === 'fr'
                ? 'Aucune histoire créée'
                : 'No stories created yet'}
            </p>
            <button
              onClick={() => navigate('/create')}
              className="mt-4 px-6 py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700"
            >
              {language === 'de' ? 'Geschichte erstellen' : language === 'fr' ? 'Créer une histoire' : 'Create Story'}
            </button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {stories.map((story) => (
              <div
                key={story.id}
                className="bg-white rounded-xl shadow-md overflow-hidden hover:shadow-lg transition-shadow flex flex-col"
              >
                {story.thumbnail && (
                  <img
                    src={story.thumbnail}
                    alt={story.title}
                    className="w-full h-48 object-cover"
                  />
                )}
                <div className="p-4 flex flex-col flex-1">
                  <div className="flex-1">
                    <h3 className="font-bold text-lg text-gray-800 mb-2">{story.title}</h3>
                    <p className="text-sm text-gray-500 mb-3">
                      {story.pages} {language === 'de' ? 'Seiten' : language === 'fr' ? 'pages' : 'pages'} • {formatDate(story.created_at)}
                    </p>
                  </div>
                  <div className="flex gap-2 mt-auto">
                    <button
                      onClick={() => navigate(`/create?storyId=${story.id}`)}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                    >
                      <Eye size={18} />
                      {language === 'de' ? 'Ansehen' : language === 'fr' ? 'Voir' : 'View'}
                    </button>
                    <button
                      onClick={() => deleteStory(story.id)}
                      className="p-2 text-red-600 hover:bg-red-50 rounded-lg"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
