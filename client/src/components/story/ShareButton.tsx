import { useState, useEffect } from 'react';
import { Share2, Copy, Check, Loader2, Link2, Link2Off, MessageCircle } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

interface ShareButtonProps {
  storyId: string;
  onShareStatusChange?: (isShared: boolean) => void;
  /** Use 'full' for grid layout with full-width button matching other action buttons */
  variant?: 'compact' | 'full';
}

interface ShareStatus {
  isShared: boolean;
  shareToken: string | null;
  shareUrl: string | null;
}

export function ShareButton({ storyId, onShareStatusChange, variant = 'compact' }: ShareButtonProps) {
  const { language } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState<ShareStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isFullVariant = variant === 'full';

  // Translations
  const t = {
    share: language === 'de' ? 'Teilen' : language === 'fr' ? 'Partager' : 'Share',
    shareStory: language === 'de' ? 'Geschichte teilen' : language === 'fr' ? 'Partager l\'histoire' : 'Share Story',
    enableSharing: language === 'de' ? 'Link aktivieren' : language === 'fr' ? 'Activer le lien' : 'Enable sharing',
    disableSharing: language === 'de' ? 'Link deaktivieren' : language === 'fr' ? 'Désactiver le lien' : 'Disable sharing',
    copyLink: language === 'de' ? 'Link kopieren' : language === 'fr' ? 'Copier le lien' : 'Copy link',
    copied: language === 'de' ? 'Kopiert!' : language === 'fr' ? 'Copié!' : 'Copied!',
    shareWhatsApp: language === 'de' ? 'Per WhatsApp teilen' : language === 'fr' ? 'Partager sur WhatsApp' : 'Share on WhatsApp',
    sharingEnabled: language === 'de' ? 'Teilen aktiv' : language === 'fr' ? 'Partage actif' : 'Sharing enabled',
    sharingDisabled: language === 'de' ? 'Teilen inaktiv' : language === 'fr' ? 'Partage inactif' : 'Sharing disabled',
    anyoneWithLink: language === 'de' ? 'Jeder mit dem Link kann die Geschichte lesen' : language === 'fr' ? 'Toute personne avec le lien peut lire l\'histoire' : 'Anyone with the link can read the story',
    errorLoading: language === 'de' ? 'Fehler beim Laden' : language === 'fr' ? 'Erreur de chargement' : 'Error loading',
  };

  // Fetch share status when dropdown opens
  useEffect(() => {
    if (isOpen && !shareStatus) {
      fetchShareStatus();
    }
  }, [isOpen]);

  const fetchShareStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch(`/api/stories/${storyId}/share-status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error('Failed to fetch status');
      const data = await response.json();
      setShareStatus(data);
    } catch (err) {
      setError(t.errorLoading);
    } finally {
      setLoading(false);
    }
  };

  const toggleSharing = async () => {
    setLoading(true);
    setError(null);
    try {
      const isCurrentlyShared = shareStatus?.isShared;
      const method = isCurrentlyShared ? 'DELETE' : 'POST';
      const token = localStorage.getItem('auth_token');

      const response = await fetch(`/api/stories/${storyId}/share`, {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) throw new Error('Failed to toggle sharing');
      const data = await response.json();

      setShareStatus({
        isShared: data.isShared,
        shareToken: data.shareToken,
        shareUrl: data.shareUrl
      });

      onShareStatusChange?.(data.isShared);
    } catch (err) {
      setError('Failed to update sharing');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async () => {
    if (!shareStatus?.shareUrl) return;

    try {
      await navigator.clipboard.writeText(shareStatus.shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = shareStatus.shareUrl;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const shareOnWhatsApp = () => {
    if (!shareStatus?.shareUrl) return;
    const text = encodeURIComponent(shareStatus.shareUrl);
    window.open(`https://wa.me/?text=${text}`, '_blank');
  };

  return (
    <div className="relative">
      {/* Main share button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={isFullVariant
          ? "bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 w-full hover:bg-indigo-600"
          : "flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-blue-500 to-indigo-500 text-white rounded-lg hover:from-blue-600 hover:to-indigo-600 transition-all shadow-md hover:shadow-lg"
        }
        title={t.share}
      >
        <Share2 className={isFullVariant ? "w-4 h-4" : "w-4 h-4"} />
        <span className={isFullVariant ? "" : "hidden sm:inline"}>{t.share}</span>
        {shareStatus?.isShared && (
          <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
        )}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown content */}
          <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl shadow-xl border border-gray-200 z-50 overflow-hidden">
            <div className="p-4 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
              <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                <Share2 className="w-5 h-5 text-blue-600" />
                {t.shareStory}
              </h3>
            </div>

            <div className="p-4 space-y-4">
              {loading && !shareStatus ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                </div>
              ) : error ? (
                <div className="text-red-500 text-sm py-2">{error}</div>
              ) : (
                <>
                  {/* Enable/disable toggle */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {shareStatus?.isShared ? (
                        <Link2 className="w-5 h-5 text-green-500" />
                      ) : (
                        <Link2Off className="w-5 h-5 text-gray-400" />
                      )}
                      <span className={shareStatus?.isShared ? 'text-green-700' : 'text-gray-600'}>
                        {shareStatus?.isShared ? t.sharingEnabled : t.sharingDisabled}
                      </span>
                    </div>
                    <button
                      onClick={toggleSharing}
                      disabled={loading}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        shareStatus?.isShared
                          ? 'bg-red-100 text-red-700 hover:bg-red-200'
                          : 'bg-green-100 text-green-700 hover:bg-green-200'
                      } disabled:opacity-50`}
                    >
                      {loading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : shareStatus?.isShared ? (
                        t.disableSharing
                      ) : (
                        t.enableSharing
                      )}
                    </button>
                  </div>

                  {shareStatus?.isShared && shareStatus.shareUrl && (
                    <>
                      <p className="text-xs text-gray-500">{t.anyoneWithLink}</p>

                      {/* Copy link button */}
                      <button
                        onClick={copyToClipboard}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg transition-colors"
                      >
                        {copied ? (
                          <>
                            <Check className="w-4 h-4 text-green-500" />
                            {t.copied}
                          </>
                        ) : (
                          <>
                            <Copy className="w-4 h-4" />
                            {t.copyLink}
                          </>
                        )}
                      </button>

                      {/* WhatsApp share */}
                      <button
                        onClick={shareOnWhatsApp}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors"
                      >
                        <MessageCircle className="w-4 h-4" />
                        {t.shareWhatsApp}
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
