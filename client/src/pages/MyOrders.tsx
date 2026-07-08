import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, Eye, Truck, CheckCircle, Clock, ExternalLink, Coins } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { LoadingSpinner, Navigation } from '@/components/common';
import { api } from '@/services/api';
import { createLogger } from '@/services/logger';

const log = createLogger('MyOrders');

interface CreditTransaction {
  id: number;
  amount: number;
  balanceAfter: number;
  type: string;
  description: string | null;
  createdAt: string;
}

const TX_LABELS: Record<string, { de: string; fr: string; it: string; en: string }> = {
  initial: { de: 'Willkommens-Credits', fr: 'Crédits de bienvenue', it: 'Crediti di benvenuto', en: 'Welcome credits' },
  purchase: { de: 'Credits gekauft', fr: 'Crédits achetés', it: 'Crediti acquistati', en: 'Credits purchased' },
  story_reserve: { de: 'Geschichte erstellt', fr: 'Histoire créée', it: 'Storia creata', en: 'Story created' },
  story_complete: { de: 'Geschichte abgeschlossen', fr: 'Histoire terminée', it: 'Storia completata', en: 'Story completed' },
  story_refund: { de: 'Rückerstattung', fr: 'Remboursement', it: 'Rimborso', en: 'Refund' },
  image_regeneration: { de: 'Bild neu generiert', fr: 'Image régénérée', it: 'Immagine rigenerata', en: 'Image regenerated' },
  image_iteration: { de: 'Bild überarbeitet', fr: 'Image retravaillée', it: 'Immagine rielaborata', en: 'Image revised' },
  cover_regeneration: { de: 'Cover neu generiert', fr: 'Couverture régénérée', it: 'Copertina rigenerata', en: 'Cover regenerated' },
  character_repair: { de: 'Charakter korrigiert', fr: 'Personnage corrigé', it: 'Personaggio corretto', en: 'Character repaired' },
  book_purchase_reward: { de: 'Bonus für Buchbestellung', fr: 'Bonus commande de livre', it: 'Bonus per ordine libro', en: 'Book order bonus' },
  referral_conversion: { de: 'Empfehlungs-Guthaben umgewandelt', fr: 'Solde de parrainage converti', it: 'Saldo referral convertito', en: 'Referral balance converted' },
  admin_add: { de: 'Anpassung durch Support', fr: 'Ajustement par le support', it: 'Rettifica del supporto', en: 'Support adjustment' },
  admin_deduct: { de: 'Anpassung durch Support', fr: 'Ajustement par le support', it: 'Rettifica del supporto', en: 'Support adjustment' },
};

function txLabel(tx: CreditTransaction, language: string): string {
  const lang = language === 'de' ? 'de' : language === 'fr' ? 'fr' : language === 'it' ? 'it' : 'en';
  const entry = TX_LABELS[tx.type];
  let label = entry ? entry[lang] : tx.description || tx.type;
  // Story descriptions carry the page count, e.g. "Reserved 250 credits for 25-page story"
  if (tx.type === 'story_reserve') {
    const m = /(\d+)-page/.exec(tx.description || '');
    if (m) label += language === 'de' ? ` (${m[1]} Seiten)` : language === 'it' ? ` (${m[1]} pagine)` : ` (${m[1]} pages)`;
  }
  return label;
}

interface Order {
  id: number | string;
  displayOrderId?: string;  // Gelato order ID (first 8 chars) for display
  type: 'book' | 'credits';
  // Book order fields
  storyId?: string;
  storyTitle?: string;
  thumbnailUrl?: string;    // URL to fetch cover thumbnail
  customerName?: string;
  shippingName?: string;
  shippingAddress?: {
    line1: string;
    city: string;
    postalCode: string;
    country: string;
  };
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  // Credit purchase fields
  creditsAmount?: number;
  balanceAfter?: number;
  description?: string;
  // Shared fields
  amount: number | null;  // credit purchases from before price_cents existed may lack it
  currency: string;
  paymentStatus: string;
  orderStatus: string;
  createdAt: string;
}

function OrderStatusBadge({ status, language }: { status: string; language: string }) {
  // Map Gelato statuses to user-friendly display
  // Gelato: created, passed, in_production, printed, shipped, delivered, failed
  const getStatusConfig = () => {
    switch (status.toLowerCase()) {
      case 'delivered':
        return {
          icon: <CheckCircle size={14} />,
          text: language === 'de' ? 'Geliefert' : language === 'fr' ? 'Livré' : 'Delivered',
          className: 'bg-green-100 text-green-800'
        };
      case 'shipped':
      case 'in_transit':
        return {
          icon: <Truck size={14} />,
          text: language === 'de' ? 'Versendet' : language === 'fr' ? 'Expédié' : 'Shipped',
          className: 'bg-blue-100 text-blue-800'
        };
      case 'printed':
        return {
          icon: <Package size={14} />,
          text: language === 'de' ? 'Gedruckt' : language === 'fr' ? 'Imprimé' : 'Printed',
          className: 'bg-indigo-100 text-indigo-800'
        };
      case 'in_production':
      case 'printing':
        return {
          icon: <Clock size={14} />,
          text: language === 'de' ? 'Wird gedruckt' : language === 'fr' ? 'Impression' : 'Printing',
          className: 'bg-indigo-100 text-indigo-800'
        };
      case 'cancelled':
      case 'canceled':
      case 'failed':
        return {
          icon: <Clock size={14} />,
          text: language === 'de' ? 'Fehlgeschlagen' : language === 'fr' ? 'Échoué' : 'Failed',
          className: 'bg-red-100 text-red-800'
        };
      case 'paid':
        return {
          icon: <CheckCircle size={14} />,
          text: language === 'de' ? 'Bezahlt' : language === 'fr' ? 'Payé' : 'Paid',
          className: 'bg-emerald-100 text-emerald-800'
        };
      case 'created':
      case 'passed':
      case 'submitted':
      case 'processing':
      default:
        return {
          icon: <Clock size={14} />,
          text: language === 'de' ? 'In Bearbeitung' : language === 'fr' ? 'En cours' : 'Processing',
          className: 'bg-amber-100 text-amber-800'
        };
    }
  };

  const config = getStatusConfig();

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${config.className}`}>
      {config.icon}
      {config.text}
    </span>
  );
}

function CreditOrderCard({
  order,
  language,
  formatDate,
  formatAmount
}: {
  order: Order;
  language: string;
  formatDate: (date: string | null) => string;
  formatAmount: (amount: number, currency: string) => string;
}) {
  return (
    <div className="bg-white rounded-2xl shadow-md overflow-hidden hover:shadow-lg transition-shadow border-l-4 border-amber-400">
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center">
              <Coins className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <p className="text-xs text-gray-500">
                {language === 'de' ? 'Guthaben' : language === 'fr' ? 'Crédits' : 'Credits'}
              </p>
              <h3 className="font-bold text-lg text-gray-800">
                +{order.creditsAmount} {language === 'de' ? 'Credits' : language === 'fr' ? 'crédits' : 'credits'}
              </h3>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
            <CheckCircle size={14} />
            {language === 'de' ? 'Abgeschlossen' : language === 'fr' ? 'Terminé' : 'Completed'}
          </span>
        </div>

        {/* Details */}
        <div className="space-y-2 text-sm text-gray-600">
          <p>
            <span className="font-medium">
              {language === 'de' ? 'Datum:' : language === 'fr' ? 'Date:' : 'Date:'}
            </span>{' '}
            {formatDate(order.createdAt)}
          </p>
          {order.amount != null && (
            <p>
              <span className="font-medium">
                {language === 'de' ? 'Betrag:' : language === 'fr' ? 'Montant:' : 'Amount:'}
              </span>{' '}
              {formatAmount(order.amount, order.currency)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function BookOrderCard({
  order,
  language,
  onViewStory,
  formatDate,
  formatAmount
}: {
  order: Order;
  language: string;
  onViewStory: () => void;
  formatDate: (date: string | null) => string;
  formatAmount: (amount: number, currency: string) => string;
}) {
  const [thumbnailData, setThumbnailData] = useState<string | null>(null);

  // Load thumbnail on mount
  useEffect(() => {
    if (order.thumbnailUrl) {
      api.get<{ coverImage: string | { imageData?: string } }>(order.thumbnailUrl)
        .then(data => {
          // Backend /cover endpoint may return either a base64 string or a
          // cover object {imageData, ...}. Normalize to a string here.
          const raw = data.coverImage;
          const str = typeof raw === 'string'
            ? raw
            : (raw && typeof raw === 'object' ? raw.imageData : null);
          if (str && typeof str === 'string') {
            setThumbnailData(str);
          }
        })
        .catch(() => {
          // Ignore thumbnail load errors
        });
    }
  }, [order.thumbnailUrl]);

  return (
    <div className="bg-white rounded-2xl shadow-md overflow-hidden hover:shadow-lg transition-shadow">
      {/* Thumbnail header */}
      {thumbnailData && (
        <div className="h-32 bg-gray-100 overflow-hidden">
          <img
            src={thumbnailData.startsWith('data:') ? thumbnailData : `data:image/jpeg;base64,${thumbnailData}`}
            alt={order.storyTitle || 'Book cover'}
            className="w-full h-full object-cover"
          />
        </div>
      )}
      <div className="p-4">
        {/* Header: Order info and status */}
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-xs text-gray-500">
              {language === 'de' ? 'Bestellung' : language === 'fr' ? 'Commande' : 'Order'} {order.displayOrderId || `#${order.id}`}
            </p>
            <h3 className="font-bold text-lg text-gray-800 line-clamp-2">{order.storyTitle || 'Untitled Story'}</h3>
          </div>
          <OrderStatusBadge status={order.orderStatus} language={language} />
        </div>

        {/* Order details */}
        <div className="space-y-1 text-sm text-gray-600 mb-4">
          <p>
            <span className="font-medium">
              {language === 'de' ? 'Datum:' : language === 'fr' ? 'Date:' : 'Date:'}
            </span>{' '}
            {formatDate(order.createdAt)}
          </p>
          {order.amount != null && (
            <p>
              <span className="font-medium">
                {language === 'de' ? 'Betrag:' : language === 'fr' ? 'Montant:' : 'Amount:'}
              </span>{' '}
              {formatAmount(order.amount, order.currency)}
            </p>
          )}
          {order.shippingAddress && (
            <p>
              <span className="font-medium">
                {language === 'de' ? 'Lieferadresse:' : language === 'fr' ? 'Adresse:' : 'Ship to:'}
              </span>{' '}
              {order.shippingAddress.city}, {order.shippingAddress.country}
            </p>
          )}
        </div>

        {/* Tracking info */}
        {order.trackingNumber && (
          <div className="bg-blue-50 rounded-lg p-3 mb-4">
            <p className="text-sm font-medium text-blue-800 mb-1">
              {language === 'de' ? 'Sendungsverfolgung' : language === 'fr' ? 'Suivi' : 'Tracking'}
            </p>
            {order.trackingUrl ? (
              <a
                href={order.trackingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline text-sm flex items-center gap-1"
              >
                {order.trackingNumber}
                <ExternalLink size={12} />
              </a>
            ) : (
              <p className="text-sm text-blue-700">{order.trackingNumber}</p>
            )}
          </div>
        )}

        {/* Actions */}
        {order.storyId && (
          <div className="flex gap-2">
            <button
              onClick={onViewStory}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 text-sm font-medium"
            >
              <Eye size={16} />
              {language === 'de' ? 'Geschichte ansehen' : language === 'fr' ? 'Voir l\'histoire' : 'View Story'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function MyOrders() {
  const navigate = useNavigate();
  const { language } = useLanguage();
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [creditHistory, setCreditHistory] = useState<CreditTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (isAuthLoading) return; // Wait for auth to load
    if (!isAuthenticated) {
      navigate('/');
      return;
    }
    loadOrders();
  }, [isAuthenticated, isAuthLoading, navigate]);

  const loadOrders = async () => {
    log.debug('Loading orders...');
    try {
      setIsLoading(true);
      const [data, history] = await Promise.all([
        api.get<{ orders: Order[] }>('/api/user/orders'),
        api.get<{ transactions: CreditTransaction[] }>('/api/user/credit-history')
          .catch(err => { log.error('Failed to load credit history:', err); return { transactions: [] }; }),
      ]);
      log.info('Loaded orders:', data.orders?.length || 0, 'credit transactions:', history.transactions?.length || 0);
      setOrders(data.orders || []);
      setCreditHistory(history.transactions || []);
    } catch (error) {
      log.error('Failed to load orders:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const formatDate = useCallback((dateStr: string | null) => {
    if (!dateStr) return '-';
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString(language === 'de' ? 'de-CH' : language === 'fr' ? 'fr-CH' : language === 'it' ? 'it-CH' : 'en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return '-';
    }
  }, [language]);

  const formatAmount = useCallback((amount: number, currency: string) => {
    // Amount is in cents
    const value = amount / 100;
    return new Intl.NumberFormat(language === 'de' ? 'de-CH' : language === 'fr' ? 'fr-CH' : 'en-US', {
      style: 'currency',
      currency: currency.toUpperCase()
    }).format(value);
  }, [language]);

  if (isAuthLoading || !isAuthenticated) {
    return <LoadingSpinner fullScreen />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation currentStep={0} />

      <div className="px-4 md:px-8 py-8 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl md:text-3xl font-bold text-gray-800 flex items-center gap-2">
            <Package size={28} />
            {language === 'de' ? 'Bestellungen & Guthaben' : language === 'fr' ? 'Commandes & crédits' : language === 'it' ? 'Ordini e crediti' : 'Orders & Credits'}
          </h1>
        </div>

        {isLoading ? (
          <LoadingSpinner message={language === 'de' ? 'Laden...' : language === 'fr' ? 'Chargement...' : 'Loading...'} />
        ) : orders.length === 0 ? (
          <div className="text-center py-12">
            <Package className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 text-lg">
              {language === 'de'
                ? 'Noch keine Bestellungen'
                : language === 'fr'
                ? 'Aucune commande'
                : 'No orders yet'}
            </p>
            <p className="text-gray-400 text-sm mt-2">
              {language === 'de'
                ? 'Wenn du ein Buch bestellst, wird es hier angezeigt.'
                : language === 'fr'
                ? 'Quand vous commandez un livre, il apparaîtra ici.'
                : 'When you order a book, it will appear here.'}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {orders.map((order) => (
              order.type === 'credits' ? (
                <CreditOrderCard
                  key={order.id}
                  order={order}
                  language={language}
                  formatDate={formatDate}
                  formatAmount={formatAmount}
                />
              ) : (
                <BookOrderCard
                  key={order.id}
                  order={order}
                  language={language}
                  onViewStory={() => navigate(`/create?storyId=${order.storyId}`)}
                  formatDate={formatDate}
                  formatAmount={formatAmount}
                />
              )
            ))}
          </div>
        )}

        {/* Credit history ledger */}
        {!isLoading && creditHistory.length > 0 && (
          <div className="mt-10">
            <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2 mb-4">
              <Coins size={22} />
              {language === 'de' ? 'Guthaben-Verlauf' : language === 'fr' ? 'Historique des crédits' : language === 'it' ? 'Cronologia crediti' : 'Credit History'}
            </h2>
            <div className="bg-white rounded-2xl shadow-md divide-y divide-gray-100">
              {creditHistory.map(tx => (
                <div key={tx.id} className="flex items-center justify-between px-4 md:px-6 py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-800">{txLabel(tx, language)}</p>
                    <p className="text-xs text-gray-500">{formatDate(tx.createdAt)}</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-semibold ${tx.amount > 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {tx.amount > 0 ? '+' : ''}{tx.amount}
                    </p>
                    {tx.balanceAfter >= 0 && (
                      <p className="text-xs text-gray-400">
                        {language === 'de' ? 'Saldo' : language === 'fr' ? 'Solde' : language === 'it' ? 'Saldo' : 'Balance'}: {tx.balanceAfter}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
