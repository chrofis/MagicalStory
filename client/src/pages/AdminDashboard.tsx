import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { adminService, type DashboardStats, type AdminUser, type CreditTransaction, type UserDetailsResponse, type PrintProduct, type GelatoProduct, type PaginationInfo } from '@/services';
import {
  Users,
  BookOpen,
  Image,
  Database,
  AlertTriangle,
  ArrowLeft,
  Trash2,
  Edit2,
  Shield,
  ShieldOff,
  Loader2,
  RefreshCw,
  Download,
  FileText,
  History,
  Eye,
  Calendar,
  CreditCard,
  Clock,
  ChevronDown,
  ChevronUp,
  Mail,
  MailX,
  Camera,
  CameraOff,
  Printer,
  Plus,
  Search,
  Check,
  ToggleLeft,
  ToggleRight
} from 'lucide-react';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { Input } from '@/components/common/Input';
import { adminTranslations, StatCard } from './admin';

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { user, isAuthenticated, impersonate, isLoading: isAuthLoading, isImpersonating } = useAuth();
  const { language } = useLanguage();

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [userSearch, setUserSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'stats' | 'users' | 'products'>('stats');

  // Modal states
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [newCredits, setNewCredits] = useState('');
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Credit history state
  const [creditHistoryUser, setCreditHistoryUser] = useState<AdminUser | null>(null);
  const [creditHistory, setCreditHistory] = useState<CreditTransaction[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // User details state
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [userDetails, setUserDetails] = useState<UserDetailsResponse | null>(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    stories: false,
    purchases: false,
    credits: false
  });

  // Print Products state
  const [printProducts, setPrintProducts] = useState<PrintProduct[]>([]);
  const [gelatoProducts, setGelatoProducts] = useState<GelatoProduct[]>([]);
  const [isLoadingProducts, setIsLoadingProducts] = useState(false);
  const [isFetchingGelato, setIsFetchingGelato] = useState(false);
  const [editingProduct, setEditingProduct] = useState<PrintProduct | null>(null);
  const [editMinPages, setEditMinPages] = useState('');
  const [editMaxPages, setEditMaxPages] = useState('');

  // Use extracted translations
  const texts = adminTranslations[language as keyof typeof adminTranslations] || adminTranslations.en;

  const fetchData = async (page = 1, search = '') => {
    setIsLoading(true);
    setError(null);
    try {
      const [statsData, usersResponse] = await Promise.all([
        adminService.getStats(),
        adminService.getUsers({ page, limit: 50, search }).catch(() => ({ users: [], pagination: null })),
      ]);
      setStats(statsData);
      setUsers(usersResponse.users || []);
      setPagination(usersResponse.pagination || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    fetchData(page, userSearch);
  };

  const handleSearchUsers = () => {
    setCurrentPage(1);
    fetchData(1, userSearch);
  };

  useEffect(() => {
    if (isAuthenticated && (user?.role === 'admin' || isImpersonating)) {
      fetchData();
    }
  }, [isAuthenticated, user, isImpersonating]);

  const handleCleanOrphaned = async () => {
    setIsActionLoading(true);
    try {
      const result = await adminService.cleanOrphanedFiles();
      setActionMessage({
        type: 'success',
        text: texts.cleaned.replace('{count}', String(result.cleaned))
      });
      fetchData();
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleExportData = async () => {
    setIsActionLoading(true);
    try {
      const blob = await adminService.exportUserData();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'users-export.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleClearCache = async () => {
    setIsActionLoading(true);
    try {
      await adminService.clearCache();
      setActionMessage({ type: 'success', text: texts.cacheCleared });
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleUpdateCredits = async () => {
    if (!editingUser) return;
    setIsActionLoading(true);
    try {
      const credits = newCredits === '-1' ? -1 : parseInt(newCredits, 10);
      await adminService.updateUserCredits(editingUser.id, credits);
      setUsers(users.map(u =>
        u.id === editingUser.id ? { ...u, credits } : u
      ));
      setEditingUser(null);
      setNewCredits('');
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleToggleRole = async (targetUser: AdminUser) => {
    const newRole = targetUser.role === 'admin' ? 'user' : 'admin';
    setIsActionLoading(true);
    try {
      await adminService.updateUserRole(targetUser.id, newRole);
      setUsers(users.map(u =>
        u.id === targetUser.id ? { ...u, role: newRole } : u
      ));
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleDeleteUser = async (targetUser: AdminUser) => {
    if (!confirm(texts.confirmDelete)) return;
    setIsActionLoading(true);
    try {
      await adminService.deleteUser(targetUser.id);
      setUsers(users.filter(u => u.id !== targetUser.id));
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleToggleEmailVerified = async (targetUser: AdminUser) => {
    const newStatus = !targetUser.emailVerified;
    setIsActionLoading(true);
    try {
      await adminService.toggleEmailVerified(targetUser.id, newStatus);
      setUsers(users.map(u =>
        u.id === targetUser.id ? { ...u, emailVerified: newStatus } : u
      ));
      setActionMessage({
        type: 'success',
        text: `Email ${newStatus ? 'verified' : 'unverified'} for ${targetUser.username}`
      });
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleTogglePhotoConsent = async (targetUser: AdminUser) => {
    const hasConsent = !!targetUser.photoConsentAt;
    const newStatus = !hasConsent;
    setIsActionLoading(true);
    try {
      const result = await adminService.togglePhotoConsent(targetUser.id, newStatus);
      setUsers(users.map(u =>
        u.id === targetUser.id ? { ...u, photoConsentAt: result.user.photoConsentAt } : u
      ));
      setActionMessage({
        type: 'success',
        text: `Photo consent ${newStatus ? 'granted' : 'revoked'} for ${targetUser.username}`
      });
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleImpersonate = async (targetUser: AdminUser) => {
    setIsActionLoading(true);
    try {
      await impersonate(targetUser.id);
      // Navigate to home page as the impersonated user
      navigate('/');
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Impersonation failed' });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleViewCreditHistory = async (targetUser: AdminUser) => {
    setCreditHistoryUser(targetUser);
    setIsLoadingHistory(true);
    setCreditHistory([]);
    try {
      const result = await adminService.getCreditHistory(targetUser.id);
      setCreditHistory(result.transactions);
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load credit history' });
      setCreditHistoryUser(null);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const handleViewUserDetails = async (targetUser: AdminUser) => {
    setSelectedUser(targetUser);
    setIsLoadingDetails(true);
    setUserDetails(null);
    setExpandedSections({ stories: false, purchases: false, credits: false });
    try {
      const result = await adminService.getUserDetails(targetUser.id);
      setUserDetails(result);
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load user details' });
      setSelectedUser(null);
    } finally {
      setIsLoadingDetails(false);
    }
  };

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const formatDate = (dateStr: string | null | undefined) => {
    if (!dateStr) return texts.never;
    return new Date(dateStr).toLocaleDateString() + ' ' + new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Print Products handlers
  const fetchPrintProducts = async () => {
    setIsLoadingProducts(true);
    try {
      const result = await adminService.getPrintProducts();
      setPrintProducts(result.products || []);
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load products' });
    } finally {
      setIsLoadingProducts(false);
    }
  };

  const fetchGelatoProducts = async () => {
    setIsFetchingGelato(true);
    try {
      const result = await adminService.fetchGelatoProducts();
      setGelatoProducts(result.products || []);
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to fetch from Gelato' });
    } finally {
      setIsFetchingGelato(false);
    }
  };

  const handleAddProduct = async (gelatoProduct: GelatoProduct) => {
    setIsActionLoading(true);
    try {
      const sizeMatch = (gelatoProduct.name || gelatoProduct.productName || '').match(/(\d+)x(\d+)/i);
      const size = sizeMatch ? `${sizeMatch[1]}x${sizeMatch[2]}mm` : '';
      const productUid = gelatoProduct.productUid || gelatoProduct.uid || '';
      const coverType = productUid.toLowerCase().includes('hardcover') ? 'hardcover' : 'softcover';

      const newProduct = {
        product_uid: productUid,
        product_name: gelatoProduct.name || gelatoProduct.productName || 'Unknown Product',
        description: gelatoProduct.description || '',
        size,
        cover_type: coverType,
        min_pages: gelatoProduct.pageCount?.min || 24,
        max_pages: gelatoProduct.pageCount?.max || 100,
        available_page_counts: [],
        is_active: true,
      };

      await adminService.createPrintProduct(newProduct);
      setActionMessage({ type: 'success', text: 'Product added successfully' });
      fetchPrintProducts();
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to add product' });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleToggleProduct = async (product: PrintProduct) => {
    setIsActionLoading(true);
    try {
      await adminService.togglePrintProduct(product.id, product.is_active);
      setPrintProducts(products =>
        products.map(p => p.id === product.id ? { ...p, is_active: !p.is_active } : p)
      );
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to toggle product' });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleDeleteProduct = async (product: PrintProduct) => {
    if (!confirm(texts.confirmDeleteProduct)) return;
    setIsActionLoading(true);
    try {
      await adminService.deletePrintProduct(product.id);
      setPrintProducts(products => products.filter(p => p.id !== product.id));
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to delete product' });
    } finally {
      setIsActionLoading(false);
    }
  };

  const startEditingProduct = (product: PrintProduct) => {
    setEditingProduct(product);
    setEditMinPages(String(product.min_pages));
    setEditMaxPages(String(product.max_pages));
  };

  const handleUpdateProduct = async () => {
    if (!editingProduct) return;
    setIsActionLoading(true);
    try {
      const minPages = parseInt(editMinPages, 10);
      const maxPages = parseInt(editMaxPages, 10);
      if (isNaN(minPages) || isNaN(maxPages) || minPages < 1 || maxPages < minPages) {
        setActionMessage({ type: 'error', text: 'Invalid page range' });
        return;
      }
      await adminService.updatePrintProduct(editingProduct.id, { min_pages: minPages, max_pages: maxPages });
      setPrintProducts(products =>
        products.map(p => p.id === editingProduct.id ? { ...p, min_pages: minPages, max_pages: maxPages } : p)
      );
      setEditingProduct(null);
      setActionMessage({ type: 'success', text: 'Product updated successfully' });
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to update product' });
    } finally {
      setIsActionLoading(false);
    }
  };

  // Load products when products tab is selected
  useEffect(() => {
    if (activeTab === 'products' && printProducts.length === 0) {
      fetchPrintProducts();
    }
  }, [activeTab]);

  // Wait for auth to finish loading before showing access denied
  if (isAuthLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 via-pink-50 to-blue-50">
        <Loader2 className="w-12 h-12 animate-spin text-indigo-600" />
      </div>
    );
  }

  // Allow access for admins or impersonating admins
  if (!isAuthenticated || (user?.role !== 'admin' && !isImpersonating)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 via-pink-50 to-blue-50">
        <div className="bg-white rounded-2xl shadow-xl p-8 text-center max-w-md">
          <AlertTriangle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-4">{texts.accessDenied}</h2>
          <p className="text-gray-600 mb-6">{texts.accessDeniedDesc}</p>
          <Button onClick={() => navigate('/')}>
            {texts.goHome}
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 via-pink-50 to-blue-50">
        <Loader2 className="w-12 h-12 animate-spin text-indigo-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-pink-50 to-blue-50 py-8 px-4">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate('/')}
              className="p-2 rounded-lg hover:bg-white/50 transition-colors"
            >
              <ArrowLeft size={24} />
            </button>
            <h1 className="text-3xl font-bold text-gray-800">{texts.title}</h1>
          </div>
          <Button variant="outline" onClick={() => fetchData(currentPage, userSearch)} disabled={isLoading}>
            <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
            {texts.refreshStats}
          </Button>
        </div>

        {/* Messages */}
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg mb-6">
            {error}
          </div>
        )}
        {actionMessage && (
          <div className={`px-4 py-3 rounded-lg mb-6 ${
            actionMessage.type === 'success'
              ? 'bg-green-100 border border-green-400 text-green-700'
              : 'bg-red-100 border border-red-400 text-red-700'
          }`}>
            {actionMessage.text}
            <button
              onClick={() => setActionMessage(null)}
              className="float-right font-bold"
            >
              &times;
            </button>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setActiveTab('stats')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'stats'
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            {texts.stats}
          </button>
          <button
            onClick={() => setActiveTab('users')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'users'
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            {texts.users}
          </button>
          <button
            onClick={() => setActiveTab('products')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
              activeTab === 'products'
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Printer size={18} />
            {texts.printProducts}
          </button>
        </div>

        {activeTab === 'stats' && (
          <>
            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
              <StatCard
                icon={<Users className="w-8 h-8 text-purple-600" />}
                title={texts.totalUsers}
                value={stats?.totalUsers ?? 0}
              />
              <StatCard
                icon={<BookOpen className="w-8 h-8 text-pink-600" />}
                title={texts.totalStories}
                value={stats?.totalStories ?? 0}
              />
              <StatCard
                icon={<Users className="w-8 h-8 text-blue-600" />}
                title={texts.totalCharacters}
                value={stats?.totalCharacters ?? 0}
              />
              <StatCard
                icon={<Image className="w-8 h-8 text-green-600" />}
                title={texts.totalImages}
                value={stats?.totalImages ?? 0}
              />
              <StatCard
                icon={<AlertTriangle className="w-8 h-8 text-yellow-600" />}
                title={texts.orphanedFiles}
                value={stats?.orphanedFiles ?? 0}
              />
              <StatCard
                icon={<Database className="w-8 h-8 text-indigo-600" />}
                title={texts.databaseSize}
                value={stats?.databaseSize ?? 'N/A'}
                isString
              />
            </div>

            {/* Admin Actions */}
            <div className="bg-white rounded-2xl shadow-lg p-6">
              <h2 className="text-xl font-bold mb-4">{texts.adminActions}</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Button
                  variant="secondary"
                  onClick={handleCleanOrphaned}
                  disabled={isActionLoading}
                >
                  <Trash2 size={16} />
                  {texts.cleanOrphaned}
                </Button>
                <Button
                  variant="secondary"
                  onClick={handleExportData}
                  disabled={isActionLoading}
                >
                  <Download size={16} />
                  {texts.exportData}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => navigate('/admin/logs')}
                  disabled={isActionLoading}
                >
                  <FileText size={16} />
                  {texts.viewLogs}
                </Button>
                <Button
                  variant="danger"
                  onClick={handleClearCache}
                  disabled={isActionLoading}
                >
                  <RefreshCw size={16} />
                  {texts.clearCache}
                </Button>
              </div>
            </div>
          </>
        )}

        {activeTab === 'users' && (
          <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
            {/* Search bar */}
            <div className="p-4 border-b bg-gray-50 flex gap-2 items-center">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                <input
                  type="text"
                  placeholder={texts.searchUsers || 'Search users...'}
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearchUsers()}
                  className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
              <Button onClick={handleSearchUsers} variant="secondary" size="sm">
                {texts.search || 'Search'}
              </Button>
              {pagination && (
                <span className="text-sm text-gray-500 ml-auto">
                  {texts.showingUsers?.replace('{from}', String((pagination.page - 1) * pagination.limit + 1))
                    .replace('{to}', String(Math.min(pagination.page * pagination.limit, pagination.totalUsers)))
                    .replace('{total}', String(pagination.totalUsers)) ||
                    `Showing ${(pagination.page - 1) * pagination.limit + 1}-${Math.min(pagination.page * pagination.limit, pagination.totalUsers)} of ${pagination.totalUsers}`}
                </span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.username}</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.email}</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.role}</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.credits}</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.actions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-gray-50">
                      <td
                        className="px-4 py-3 text-sm cursor-pointer hover:text-indigo-600 hover:underline"
                        onClick={() => handleViewUserDetails(u)}
                      >
                        {u.username}
                      </td>
                      <td
                        className="px-4 py-3 text-sm text-gray-600 cursor-pointer hover:text-indigo-600"
                        onClick={() => handleViewUserDetails(u)}
                      >
                        {u.email}
                      </td>
                      <td className="px-4 py-3 cursor-pointer" onClick={() => handleViewUserDetails(u)}>
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                          u.role === 'admin'
                            ? 'bg-purple-100 text-purple-700'
                            : 'bg-gray-100 text-gray-700'
                        }`}>
                          {u.role}
                        </span>
                      </td>
                      <td
                        className="px-4 py-3 text-sm cursor-pointer hover:text-indigo-600"
                        onClick={() => handleViewUserDetails(u)}
                      >
                        {u.credits === -1 ? texts.unlimited : u.credits}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              setEditingUser(u);
                              setNewCredits(String(u.credits));
                            }}
                            className="p-1 rounded hover:bg-gray-100 text-blue-600"
                            title={texts.editCredits}
                          >
                            <Edit2 size={16} />
                          </button>
                          <button
                            onClick={() => handleToggleRole(u)}
                            className={`p-1 rounded hover:bg-gray-100 ${
                              u.role === 'admin' ? 'text-yellow-600' : 'text-purple-600'
                            }`}
                            title={u.role === 'admin' ? texts.removeAdmin : texts.makeAdmin}
                            disabled={u.id === user?.id}
                          >
                            {u.role === 'admin' ? <ShieldOff size={16} /> : <Shield size={16} />}
                          </button>
                          <button
                            onClick={() => handleViewCreditHistory(u)}
                            className="p-1 rounded hover:bg-gray-100 text-green-600"
                            title={texts.viewHistory || 'View History'}
                          >
                            <History size={16} />
                          </button>
                          <button
                            onClick={() => handleToggleEmailVerified(u)}
                            className={`p-1 rounded hover:bg-gray-100 ${
                              u.emailVerified ? 'text-emerald-600' : 'text-orange-500'
                            }`}
                            title={u.emailVerified ? 'Email verified - click to unverify' : 'Email NOT verified - click to verify'}
                          >
                            {u.emailVerified ? <Mail size={16} /> : <MailX size={16} />}
                          </button>
                          <button
                            onClick={() => handleTogglePhotoConsent(u)}
                            className={`p-1 rounded hover:bg-gray-100 ${
                              u.photoConsentAt ? 'text-emerald-600' : 'text-orange-500'
                            }`}
                            title={u.photoConsentAt ? 'Photo consent given - click to revoke' : 'Photo consent NOT given - click to grant'}
                          >
                            {u.photoConsentAt ? <Camera size={16} /> : <CameraOff size={16} />}
                          </button>
                          <button
                            onClick={() => handleImpersonate(u)}
                            className="p-1 rounded hover:bg-gray-100 text-cyan-600"
                            title={texts.impersonate}
                            disabled={u.id === user?.id}
                          >
                            <Eye size={16} />
                          </button>
                          <button
                            onClick={() => handleDeleteUser(u)}
                            className="p-1 rounded hover:bg-gray-100 text-red-600"
                            title={texts.deleteUser}
                            disabled={u.id === user?.id}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Pagination controls */}
            {pagination && pagination.totalPages > 1 && (
              <div className="p-4 border-t bg-gray-50 flex justify-center items-center gap-2">
                <Button
                  onClick={() => handlePageChange(1)}
                  disabled={!pagination.hasPrevPage}
                  variant="secondary"
                  size="sm"
                >
                  {'<<'}
                </Button>
                <Button
                  onClick={() => handlePageChange(currentPage - 1)}
                  disabled={!pagination.hasPrevPage}
                  variant="secondary"
                  size="sm"
                >
                  {'<'}
                </Button>
                <span className="px-4 py-2 text-sm">
                  {texts.pageOf?.replace('{page}', String(pagination.page)).replace('{total}', String(pagination.totalPages)) ||
                    `Page ${pagination.page} of ${pagination.totalPages}`}
                </span>
                <Button
                  onClick={() => handlePageChange(currentPage + 1)}
                  disabled={!pagination.hasNextPage}
                  variant="secondary"
                  size="sm"
                >
                  {'>'}
                </Button>
                <Button
                  onClick={() => handlePageChange(pagination.totalPages)}
                  disabled={!pagination.hasNextPage}
                  variant="secondary"
                  size="sm"
                >
                  {'>>'}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Print Products Tab */}
        {activeTab === 'products' && (
          <div className="space-y-6">
            {/* Actions Bar */}
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold text-gray-800">{texts.printProducts}</h2>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={fetchPrintProducts}
                  disabled={isLoadingProducts}
                >
                  <RefreshCw size={16} className={isLoadingProducts ? 'animate-spin' : ''} />
                  {texts.refreshStats}
                </Button>
                <Button
                  onClick={fetchGelatoProducts}
                  disabled={isFetchingGelato}
                >
                  <Search size={16} className={isFetchingGelato ? 'animate-spin' : ''} />
                  {texts.fetchFromGelato}
                </Button>
              </div>
            </div>

            {/* Saved Products */}
            <div className="bg-white rounded-2xl shadow-lg p-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-4">{texts.savedProducts}</h3>
              {isLoadingProducts ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
                </div>
              ) : printProducts.length === 0 ? (
                <p className="text-gray-500 text-center py-8">{texts.noProducts}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.productName}</th>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.size}</th>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.coverType}</th>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.pages}</th>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.status}</th>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.actions}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {printProducts.map((product) => (
                        <tr key={product.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3">
                            <div>
                              <div className="font-medium text-gray-800">{product.product_name}</div>
                              <div className="text-xs text-gray-500 font-mono truncate max-w-xs" title={product.product_uid}>
                                {product.product_uid.substring(0, 40)}...
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">{product.size || '-'}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                              product.cover_type === 'hardcover'
                                ? 'bg-purple-100 text-purple-700'
                                : 'bg-blue-100 text-blue-700'
                            }`}>
                              {product.cover_type === 'hardcover' ? texts.hardcover : texts.softcover}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">{product.min_pages} - {product.max_pages}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                              product.is_active
                                ? 'bg-green-100 text-green-700'
                                : 'bg-gray-100 text-gray-700'
                            }`}>
                              {product.is_active ? texts.active : texts.inactive}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex gap-2">
                              <button
                                onClick={() => startEditingProduct(product)}
                                className="p-1.5 rounded hover:bg-gray-100 text-indigo-600"
                                title={texts.editPages}
                                disabled={isActionLoading}
                              >
                                <Edit2 size={16} />
                              </button>
                              <button
                                onClick={() => handleToggleProduct(product)}
                                className={`p-1.5 rounded hover:bg-gray-100 ${product.is_active ? 'text-green-600' : 'text-gray-400'}`}
                                title={product.is_active ? texts.active : texts.inactive}
                                disabled={isActionLoading}
                              >
                                {product.is_active ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                              </button>
                              <button
                                onClick={() => handleDeleteProduct(product)}
                                className="p-1.5 rounded hover:bg-gray-100 text-red-600"
                                title={texts.deleteUser}
                                disabled={isActionLoading}
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Gelato Products */}
            {gelatoProducts.length > 0 && (
              <div className="bg-white rounded-2xl shadow-lg p-6">
                <h3 className="text-lg font-semibold text-gray-800 mb-4">
                  {texts.gelatoProducts} ({gelatoProducts.length})
                </h3>
                <p className="text-sm text-gray-500 mb-4">{texts.selectProduct}</p>
                <div className="grid gap-3 max-h-96 overflow-y-auto">
                  {gelatoProducts.map((product) => {
                    const productUid = product.productUid || product.uid || '';
                    const productName = product.name || product.productName || 'Unknown';
                    const isHardcover = productUid.toLowerCase().includes('hardcover');
                    const sizeMatch = productName.match(/(\d+)x(\d+)/i);
                    const size = sizeMatch ? `${sizeMatch[1]}x${sizeMatch[2]}mm` : '';
                    const alreadyAdded = printProducts.some(p => p.product_uid === productUid);

                    return (
                      <div
                        key={productUid}
                        className={`p-4 border rounded-lg ${alreadyAdded ? 'bg-gray-50 opacity-60' : 'hover:border-indigo-300 cursor-pointer'}`}
                        onClick={() => !alreadyAdded && handleAddProduct(product)}
                      >
                        <div className="flex justify-between items-start">
                          <div className="flex-1">
                            <div className="font-medium text-gray-800">{productName}</div>
                            <div className="text-xs text-gray-500 font-mono mt-1 truncate" title={productUid}>
                              {productUid.substring(0, 60)}...
                            </div>
                            <div className="flex gap-2 mt-2">
                              {size && (
                                <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">{size}</span>
                              )}
                              <span className={`px-2 py-0.5 text-xs rounded ${
                                isHardcover ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                              }`}>
                                {isHardcover ? texts.hardcover : texts.softcover}
                              </span>
                            </div>
                          </div>
                          {alreadyAdded ? (
                            <Check size={20} className="text-green-600" />
                          ) : (
                            <Plus size={20} className="text-indigo-600" />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {isFetchingGelato && (
              <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
                <Loader2 className="w-8 h-8 animate-spin text-indigo-600 mx-auto mb-2" />
                <p className="text-gray-600">{texts.fetching}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Edit Credits Modal */}
      <Modal
        isOpen={!!editingUser}
        onClose={() => {
          setEditingUser(null);
          setNewCredits('');
        }}
        title={texts.editCredits}
      >
        <div className="space-y-4">
          <p className="text-gray-600">
            {editingUser?.username} ({editingUser?.email})
          </p>
          <Input
            label={texts.newCredits}
            type="number"
            value={newCredits}
            onChange={(e) => setNewCredits(e.target.value)}
            placeholder="-1 for unlimited"
          />
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setEditingUser(null)}>
              {texts.cancel}
            </Button>
            <Button onClick={handleUpdateCredits} disabled={isActionLoading}>
              {texts.save}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Credit History Modal */}
      <Modal
        isOpen={!!creditHistoryUser}
        onClose={() => {
          setCreditHistoryUser(null);
          setCreditHistory([]);
        }}
        title={`${texts.creditHistory || 'Credit History'}: ${creditHistoryUser?.username || ''}`}
      >
        <div className="space-y-4">
          {/* Current Balance */}
          <div className="bg-indigo-50 rounded-lg p-4">
            <p className="text-sm text-indigo-600 font-medium">{texts.currentBalance || 'Current Balance'}</p>
            <p className="text-2xl font-bold text-indigo-800">
              {creditHistoryUser?.credits === -1 ? (texts.unlimited || 'Unlimited') : creditHistoryUser?.credits}
            </p>
          </div>

          {/* Transaction List */}
          {isLoadingHistory ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
            </div>
          ) : creditHistory.length === 0 ? (
            <p className="text-center text-gray-500 py-8">{texts.noTransactions || 'No transactions found'}</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">{texts.date || 'Date'}</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">{texts.type || 'Type'}</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-700">{texts.amount || 'Amount'}</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-700">{texts.balance || 'Balance'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {creditHistory.map((tx) => (
                    <tr key={tx.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-600">
                        {new Date(tx.createdAt).toLocaleDateString()} {new Date(tx.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          tx.type === 'story_reserve' ? 'bg-yellow-100 text-yellow-700' :
                          tx.type === 'story_complete' ? 'bg-green-100 text-green-700' :
                          tx.type === 'story_refund' ? 'bg-blue-100 text-blue-700' :
                          tx.type === 'admin_add' ? 'bg-purple-100 text-purple-700' :
                          tx.type === 'admin_deduct' ? 'bg-red-100 text-red-700' :
                          tx.type === 'initial' ? 'bg-gray-100 text-gray-700' :
                          'bg-gray-100 text-gray-700'
                        }`}>
                          {tx.type.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className={`px-3 py-2 text-right font-medium ${
                        tx.amount > 0 ? 'text-green-600' : tx.amount < 0 ? 'text-red-600' : 'text-gray-600'
                      }`}>
                        {tx.amount > 0 ? '+' : ''}{tx.amount}
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-gray-800">
                        {tx.balanceAfter}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => setCreditHistoryUser(null)}>
              {texts.cancel || 'Close'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* User Details Modal */}
      <Modal
        isOpen={!!selectedUser}
        onClose={() => {
          setSelectedUser(null);
          setUserDetails(null);
        }}
        title={`${texts.userDetails}: ${selectedUser?.username || ''}`}
      >
        <div className="space-y-4 max-h-[70vh] overflow-y-auto">
          {isLoadingDetails ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
            </div>
          ) : userDetails ? (
            <>
              {/* User Info Section */}
              <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-lg p-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-gray-500">{texts.email}</p>
                    <p className="font-medium text-gray-800">{userDetails.user.email}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">{texts.role}</p>
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                      userDetails.user.role === 'admin'
                        ? 'bg-purple-100 text-purple-700'
                        : 'bg-gray-100 text-gray-700'
                    }`}>
                      {userDetails.user.role}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Calendar size={14} className="text-gray-400" />
                    <div>
                      <p className="text-xs text-gray-500">{texts.memberSince}</p>
                      <p className="font-medium text-gray-800 text-sm">{formatDate(userDetails.user.createdAt)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock size={14} className="text-gray-400" />
                    <div>
                      <p className="text-xs text-gray-500">{texts.lastLogin}</p>
                      <p className="font-medium text-gray-800 text-sm">{formatDate(userDetails.user.lastLogin)}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Stats Summary */}
              <div className="grid grid-cols-4 gap-3">
                <div className="bg-pink-50 rounded-lg p-3 text-center">
                  <BookOpen size={20} className="mx-auto text-pink-600 mb-1" />
                  <p className="text-2xl font-bold text-pink-700">{userDetails.stats.totalStories}</p>
                  <p className="text-xs text-pink-600">{texts.stories}</p>
                </div>
                <div className="bg-blue-50 rounded-lg p-3 text-center">
                  <Users size={20} className="mx-auto text-blue-600 mb-1" />
                  <p className="text-2xl font-bold text-blue-700">{userDetails.stats.totalCharacters}</p>
                  <p className="text-xs text-blue-600">{texts.characters}</p>
                </div>
                <div className="bg-green-50 rounded-lg p-3 text-center">
                  <Image size={20} className="mx-auto text-green-600 mb-1" />
                  <p className="text-2xl font-bold text-green-700">{userDetails.stats.totalImages}</p>
                  <p className="text-xs text-green-600">{texts.images}</p>
                </div>
                <div className="bg-amber-50 rounded-lg p-3 text-center">
                  <CreditCard size={20} className="mx-auto text-amber-600 mb-1" />
                  <p className="text-2xl font-bold text-amber-700">{userDetails.stats.totalPurchases}</p>
                  <p className="text-xs text-amber-600">{texts.purchases}</p>
                </div>
              </div>

              {/* Credits Info */}
              <div className="bg-indigo-50 rounded-lg p-3 flex items-center justify-between">
                <div>
                  <p className="text-sm text-indigo-600 font-medium">{texts.currentBalance}</p>
                  <p className="text-xl font-bold text-indigo-800">
                    {userDetails.user.credits === -1 ? texts.unlimited : userDetails.user.credits}
                  </p>
                </div>
                {userDetails.stats.totalSpent > 0 && (
                  <div className="text-right">
                    <p className="text-sm text-indigo-600 font-medium">{texts.totalSpent}</p>
                    <p className="text-xl font-bold text-indigo-800">
                      ${userDetails.stats.totalSpent.toFixed(2)}
                    </p>
                  </div>
                )}
              </div>

              {/* Token Usage Section */}
              {userDetails.stats.tokenUsage && userDetails.stats.tokenUsage.totalInputTokens > 0 && (
                <div className="bg-orange-50 rounded-lg p-4">
                  <p className="text-sm text-orange-600 font-medium mb-2">{texts.totalTokens}</p>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <p className="text-xl font-bold text-orange-700">
                        {(userDetails.stats.tokenUsage.totalInputTokens / 1000).toFixed(1)}K
                      </p>
                      <p className="text-xs text-orange-600">{texts.inputTokens}</p>
                    </div>
                    <div>
                      <p className="text-xl font-bold text-orange-700">
                        {(userDetails.stats.tokenUsage.totalOutputTokens / 1000).toFixed(1)}K
                      </p>
                      <p className="text-xs text-orange-600">{texts.outputTokens}</p>
                    </div>
                    <div>
                      <p className="text-xl font-bold text-orange-700">
                        {userDetails.stats.tokenUsage.totalCalls}
                      </p>
                      <p className="text-xs text-orange-600">{texts.apiCalls}</p>
                    </div>
                  </div>
                  <div className="mt-2 pt-2 border-t border-orange-200 text-xs text-orange-600 grid grid-cols-2 gap-1">
                    <span>Anthropic: {((userDetails.stats.tokenUsage.anthropic?.input_tokens || 0) / 1000).toFixed(1)}K in / {((userDetails.stats.tokenUsage.anthropic?.output_tokens || 0) / 1000).toFixed(1)}K out</span>
                    <span>Gemini: {((userDetails.stats.tokenUsage.gemini_image?.input_tokens || 0) / 1000).toFixed(1)}K in / {((userDetails.stats.tokenUsage.gemini_image?.output_tokens || 0) / 1000).toFixed(1)}K out</span>
                  </div>
                </div>
              )}

              {/* Stories Section (Collapsible) */}
              <div className="border rounded-lg">
                <button
                  onClick={() => toggleSection('stories')}
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50"
                >
                  <span className="font-medium text-gray-700 flex items-center gap-2">
                    <BookOpen size={16} />
                    {texts.stories} ({userDetails.stories.length})
                  </span>
                  {expandedSections.stories ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                {expandedSections.stories && (
                  <div className="border-t px-4 py-3 max-h-48 overflow-y-auto">
                    {userDetails.stories.length === 0 ? (
                      <p className="text-gray-500 text-sm text-center py-2">{texts.noStories}</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-gray-500">
                            <th className="pb-2">{texts.storyTitle}</th>
                            <th className="pb-2">{texts.pages}</th>
                            <th className="pb-2">{texts.images}</th>
                            <th className="pb-2">{texts.date}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {userDetails.stories.map(story => (
                            <tr key={story.id} className="border-t">
                              <td className="py-2 font-medium">{story.title}</td>
                              <td className="py-2">{story.pageCount}</td>
                              <td className="py-2">{story.imageCount}</td>
                              <td className="py-2 text-gray-500">
                                {new Date(story.createdAt).toLocaleDateString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>

              {/* Purchases Section (Collapsible) */}
              <div className="border rounded-lg">
                <button
                  onClick={() => toggleSection('purchases')}
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50"
                >
                  <span className="font-medium text-gray-700 flex items-center gap-2">
                    <CreditCard size={16} />
                    {texts.purchaseHistory} ({userDetails.purchases.length})
                  </span>
                  {expandedSections.purchases ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                {expandedSections.purchases && (
                  <div className="border-t px-4 py-3 max-h-48 overflow-y-auto">
                    {userDetails.purchases.length === 0 ? (
                      <p className="text-gray-500 text-sm text-center py-2">{texts.noPurchases}</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-gray-500">
                            <th className="pb-2">{texts.date}</th>
                            <th className="pb-2">{texts.amount}</th>
                            <th className="pb-2">{texts.status}</th>
                            <th className="pb-2">{texts.product}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {userDetails.purchases.map(purchase => (
                            <tr key={purchase.id} className="border-t">
                              <td className="py-2 text-gray-500">
                                {new Date(purchase.createdAt).toLocaleDateString()}
                              </td>
                              <td className="py-2 font-medium">
                                {purchase.currency} {purchase.amount}
                              </td>
                              <td className="py-2">
                                <span className={`px-2 py-0.5 rounded-full text-xs ${
                                  purchase.status === 'paid' ? 'bg-green-100 text-green-700' :
                                  purchase.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                                  'bg-red-100 text-red-700'
                                }`}>
                                  {purchase.status}
                                </span>
                              </td>
                              <td className="py-2 text-gray-600 text-xs">
                                {purchase.productVariant || '-'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>

              {/* Credit History Section (Collapsible) */}
              <div className="border rounded-lg">
                <button
                  onClick={() => toggleSection('credits')}
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50"
                >
                  <span className="font-medium text-gray-700 flex items-center gap-2">
                    <History size={16} />
                    {texts.creditHistory} ({userDetails.creditHistory.length})
                  </span>
                  {expandedSections.credits ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                {expandedSections.credits && (
                  <div className="border-t px-4 py-3 max-h-48 overflow-y-auto">
                    {userDetails.creditHistory.length === 0 ? (
                      <p className="text-gray-500 text-sm text-center py-2">{texts.noTransactions}</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-gray-500">
                            <th className="pb-2">{texts.date}</th>
                            <th className="pb-2">{texts.type}</th>
                            <th className="pb-2 text-right">{texts.amount}</th>
                            <th className="pb-2 text-right">{texts.balance}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {userDetails.creditHistory.map(tx => (
                            <tr key={tx.id} className="border-t">
                              <td className="py-2 text-gray-500">
                                {new Date(tx.createdAt).toLocaleDateString()}
                              </td>
                              <td className="py-2">
                                <span className={`px-2 py-0.5 rounded-full text-xs ${
                                  tx.type === 'admin_add' ? 'bg-purple-100 text-purple-700' :
                                  tx.type === 'story_complete' ? 'bg-green-100 text-green-700' :
                                  tx.type === 'story_refund' ? 'bg-blue-100 text-blue-700' :
                                  tx.type === 'story_reserve' ? 'bg-yellow-100 text-yellow-700' :
                                  'bg-gray-100 text-gray-700'
                                }`}>
                                  {tx.type.replace(/_/g, ' ')}
                                </span>
                              </td>
                              <td className={`py-2 text-right font-medium ${
                                tx.amount > 0 ? 'text-green-600' : 'text-red-600'
                              }`}>
                                {tx.amount > 0 ? '+' : ''}{tx.amount}
                              </td>
                              <td className="py-2 text-right font-medium">
                                {tx.balanceAfter}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <p className="text-center text-gray-500 py-4">Failed to load user details</p>
          )}

          <div className="flex justify-end pt-2">
            <Button variant="secondary" onClick={() => setSelectedUser(null)}>
              {texts.close}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit Product Modal */}
      <Modal
        isOpen={!!editingProduct}
        onClose={() => setEditingProduct(null)}
        title={texts.editPages}
      >
        <div className="space-y-4">
          <p className="text-gray-600 text-sm">
            {editingProduct?.product_name}
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label={texts.minPages}
              type="number"
              value={editMinPages}
              onChange={(e) => setEditMinPages(e.target.value)}
              min={1}
            />
            <Input
              label={texts.maxPages}
              type="number"
              value={editMaxPages}
              onChange={(e) => setEditMaxPages(e.target.value)}
              min={1}
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setEditingProduct(null)}>
              {texts.cancel}
            </Button>
            <Button onClick={handleUpdateProduct} disabled={isActionLoading}>
              {texts.save}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
