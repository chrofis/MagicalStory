import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { adminService, type DashboardStats, type AdminUser } from '@/services';
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
  FileText
} from 'lucide-react';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { Input } from '@/components/common/Input';

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuth();
  const { language } = useLanguage();

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'stats' | 'users'>('stats');

  // Modal states
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [newQuota, setNewQuota] = useState('');
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const t = {
    en: {
      title: 'Admin Dashboard',
      stats: 'Statistics',
      users: 'User Management',
      totalUsers: 'Total Users',
      totalStories: 'Total Stories',
      totalCharacters: 'Total Characters',
      totalImages: 'Total Images',
      orphanedFiles: 'Orphaned Files',
      databaseSize: 'Database Size',
      adminActions: 'Admin Actions',
      cleanOrphaned: 'Clean Orphaned Files',
      exportData: 'Export User Data',
      viewLogs: 'View System Logs',
      clearCache: 'Clear Cache',
      accessDenied: 'Access Denied',
      accessDeniedDesc: 'You need admin privileges to access this page.',
      goHome: 'Go Home',
      username: 'Username',
      email: 'Email',
      role: 'Role',
      quota: 'Quota',
      generated: 'Generated',
      actions: 'Actions',
      editQuota: 'Edit Quota',
      newQuota: 'New Quota',
      save: 'Save',
      cancel: 'Cancel',
      makeAdmin: 'Make Admin',
      removeAdmin: 'Remove Admin',
      deleteUser: 'Delete User',
      confirmDelete: 'Are you sure you want to delete this user?',
      unlimited: 'Unlimited',
      cleaned: 'Cleaned {count} orphaned files',
      cacheCleared: 'Cache cleared successfully',
      refreshStats: 'Refresh Stats',
    },
    de: {
      title: 'Admin-Dashboard',
      stats: 'Statistiken',
      users: 'Benutzerverwaltung',
      totalUsers: 'Benutzer gesamt',
      totalStories: 'Geschichten gesamt',
      totalCharacters: 'Charaktere gesamt',
      totalImages: 'Bilder gesamt',
      orphanedFiles: 'Verwaiste Dateien',
      databaseSize: 'Datenbankgroesse',
      adminActions: 'Admin-Aktionen',
      cleanOrphaned: 'Verwaiste Dateien bereinigen',
      exportData: 'Benutzerdaten exportieren',
      viewLogs: 'Systemprotokolle anzeigen',
      clearCache: 'Cache leeren',
      accessDenied: 'Zugriff verweigert',
      accessDeniedDesc: 'Sie benoetigen Admin-Rechte um auf diese Seite zuzugreifen.',
      goHome: 'Zur Startseite',
      username: 'Benutzername',
      email: 'E-Mail',
      role: 'Rolle',
      quota: 'Kontingent',
      generated: 'Generiert',
      actions: 'Aktionen',
      editQuota: 'Kontingent bearbeiten',
      newQuota: 'Neues Kontingent',
      save: 'Speichern',
      cancel: 'Abbrechen',
      makeAdmin: 'Zum Admin machen',
      removeAdmin: 'Admin-Rechte entfernen',
      deleteUser: 'Benutzer loeschen',
      confirmDelete: 'Sind Sie sicher, dass Sie diesen Benutzer loeschen moechten?',
      unlimited: 'Unbegrenzt',
      cleaned: '{count} verwaiste Dateien bereinigt',
      cacheCleared: 'Cache erfolgreich geleert',
      refreshStats: 'Statistiken aktualisieren',
    },
    fr: {
      title: 'Tableau de bord Admin',
      stats: 'Statistiques',
      users: 'Gestion des utilisateurs',
      totalUsers: 'Utilisateurs totaux',
      totalStories: 'Histoires totales',
      totalCharacters: 'Personnages totaux',
      totalImages: 'Images totales',
      orphanedFiles: 'Fichiers orphelins',
      databaseSize: 'Taille de la base',
      adminActions: 'Actions Admin',
      cleanOrphaned: 'Nettoyer fichiers orphelins',
      exportData: 'Exporter les donnees',
      viewLogs: 'Voir les logs systeme',
      clearCache: 'Vider le cache',
      accessDenied: 'Acces refuse',
      accessDeniedDesc: 'Vous avez besoin des privileges admin pour acceder a cette page.',
      goHome: 'Accueil',
      username: 'Nom d\'utilisateur',
      email: 'E-mail',
      role: 'Role',
      quota: 'Quota',
      generated: 'Genere',
      actions: 'Actions',
      editQuota: 'Modifier le quota',
      newQuota: 'Nouveau quota',
      save: 'Enregistrer',
      cancel: 'Annuler',
      makeAdmin: 'Rendre admin',
      removeAdmin: 'Retirer admin',
      deleteUser: 'Supprimer l\'utilisateur',
      confirmDelete: 'Etes-vous sur de vouloir supprimer cet utilisateur?',
      unlimited: 'Illimite',
      cleaned: '{count} fichiers orphelins nettoyes',
      cacheCleared: 'Cache vide avec succes',
      refreshStats: 'Actualiser les stats',
    },
  };

  const texts = t[language as keyof typeof t] || t.en;

  const fetchData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [statsData, usersData] = await Promise.all([
        adminService.getStats(),
        adminService.getUsers().catch(() => [] as AdminUser[]),
      ]);
      setStats(statsData);
      setUsers(usersData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated && user?.role === 'admin') {
      fetchData();
    }
  }, [isAuthenticated, user]);

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

  const handleUpdateQuota = async () => {
    if (!editingUser) return;
    setIsActionLoading(true);
    try {
      const quota = newQuota === '-1' ? -1 : parseInt(newQuota, 10);
      await adminService.updateUserQuota(editingUser.id, quota);
      setUsers(users.map(u =>
        u.id === editingUser.id ? { ...u, storyQuota: quota } : u
      ));
      setEditingUser(null);
      setNewQuota('');
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

  if (!isAuthenticated || user?.role !== 'admin') {
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
          <Button variant="outline" onClick={fetchData} disabled={isLoading}>
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
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.username}</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.email}</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.role}</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.quota}</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.generated}</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">{texts.actions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm">{u.username}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{u.email}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                          u.role === 'admin'
                            ? 'bg-purple-100 text-purple-700'
                            : 'bg-gray-100 text-gray-700'
                        }`}>
                          {u.role}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {u.storyQuota === -1 ? texts.unlimited : u.storyQuota}
                      </td>
                      <td className="px-4 py-3 text-sm">{u.storiesGenerated}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              setEditingUser(u);
                              setNewQuota(String(u.storyQuota));
                            }}
                            className="p-1 rounded hover:bg-gray-100 text-blue-600"
                            title={texts.editQuota}
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
          </div>
        )}
      </div>

      {/* Edit Quota Modal */}
      <Modal
        isOpen={!!editingUser}
        onClose={() => {
          setEditingUser(null);
          setNewQuota('');
        }}
        title={texts.editQuota}
      >
        <div className="space-y-4">
          <p className="text-gray-600">
            {editingUser?.username} ({editingUser?.email})
          </p>
          <Input
            label={texts.newQuota}
            type="number"
            value={newQuota}
            onChange={(e) => setNewQuota(e.target.value)}
            placeholder="-1 for unlimited"
          />
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setEditingUser(null)}>
              {texts.cancel}
            </Button>
            <Button onClick={handleUpdateQuota} disabled={isActionLoading}>
              {texts.save}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

interface StatCardProps {
  icon: React.ReactNode;
  title: string;
  value: number | string;
  isString?: boolean;
}

function StatCard({ icon, title, value, isString = false }: StatCardProps) {
  return (
    <div className="bg-white rounded-2xl shadow-lg p-6 flex items-center gap-4">
      <div className="p-3 bg-gray-100 rounded-lg">{icon}</div>
      <div>
        <p className="text-sm text-gray-600">{title}</p>
        <p className="text-2xl font-bold text-gray-800">
          {isString ? value : (typeof value === 'number' ? value.toLocaleString() : value)}
        </p>
      </div>
    </div>
  );
}
