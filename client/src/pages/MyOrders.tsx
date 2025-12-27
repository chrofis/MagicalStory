import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, Eye, Truck, CheckCircle, Clock, ExternalLink, Coins } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { LoadingSpinner, Navigation } from '@/components/common';
import { api } from '@/services/api';
import { createLogger } from '@/services/logger';

const log = createLogger('MyOrders');

interface Order {
  id: number | string;
  type: 'book' | 'credits';
  // Book order fields
  storyId?: string;
  storyTitle?: string;
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
  amount: number;
  currency: string;
  paymentStatus: string;
  orderStatus: string;
  createdAt: string;
}

function OrderStatusBadge({ status, language }: { status: string; language: string }) {
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
          text: language === 'de' ? 'Unterwegs' : language === 'fr' ? 'En transit' : 'Shipped',
          className: 'bg-blue-100 text-blue-800'
        };
      case 'cancelled':
      case 'canceled':
        return {
          icon: <Clock size={14} />,
          text: language === 'de' ? 'Storniert' : language === 'fr' ? 'Annulé' : 'Cancelled',
          className: 'bg-red-100 text-red-800'
        };
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
    <div className="bg-white rounded-xl shadow-md overflow-hidden hover:shadow-lg transition-shadow border-l-4 border-amber-400">
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
          <p>
            <span className="font-medium">
              {language === 'de' ? 'Betrag:' : language === 'fr' ? 'Montant:' : 'Amount:'}
            </span>{' '}
            {formatAmount(order.amount, order.currency)}
          </p>
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
  return (
    <div className="bg-white rounded-xl shadow-md overflow-hidden hover:shadow-lg transition-shadow">
      <div className="p-4">
        {/* Header: Order info and status */}
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-xs text-gray-500">
              {language === 'de' ? 'Bestellung' : language === 'fr' ? 'Commande' : 'Order'} #{order.id}
            </p>
            <h3 className="font-bold text-lg text-gray-800">{order.storyTitle}</h3>
          </div>
          <OrderStatusBadge status={order.orderStatus} language={language} />
        </div>

        {/* Order details */}
        <div className="space-y-2 text-sm text-gray-600 mb-4">
          <p>
            <span className="font-medium">
              {language === 'de' ? 'Datum:' : language === 'fr' ? 'Date:' : 'Date:'}
            </span>{' '}
            {formatDate(order.createdAt)}
          </p>
          <p>
            <span className="font-medium">
              {language === 'de' ? 'Betrag:' : language === 'fr' ? 'Montant:' : 'Amount:'}
            </span>{' '}
            {formatAmount(order.amount, order.currency)}
          </p>
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
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
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
      const data = await api.get<{ orders: Order[] }>('/api/user/orders');
      log.info('Loaded orders:', data.orders?.length || 0);
      setOrders(data.orders || []);
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
      return date.toLocaleDateString(language === 'de' ? 'de-DE' : language === 'fr' ? 'fr-FR' : 'en-US', {
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
            {language === 'de' ? 'Meine Bestellungen' : language === 'fr' ? 'Mes commandes' : 'My Orders'}
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
      </div>
    </div>
  );
}
