import { api } from './api';

export interface DashboardStats {
  totalUsers: number;
  totalStories: number;
  totalCharacters: number;
  totalImages: number;
  orphanedFiles: number;
  databaseSize: string;
}

export interface AdminUser {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  credits: number;
  storyQuota?: number;
  storiesGenerated?: number;
  createdAt: string;
  lastLogin?: string;
}

export const adminService = {
  async getStats(): Promise<DashboardStats> {
    return api.get<DashboardStats>('/api/admin/stats');
  },

  async getUsers(): Promise<AdminUser[]> {
    return api.get<AdminUser[]>('/api/admin/users');
  },

  async updateUserCredits(userId: string, credits: number): Promise<void> {
    return api.post(`/api/admin/users/${userId}/quota`, { credits });
  },

  async updateUserRole(userId: string, role: 'user' | 'admin'): Promise<void> {
    return api.post(`/api/admin/users/${userId}/role`, { role });
  },

  async deleteUser(userId: string): Promise<void> {
    return api.delete(`/api/admin/users/${userId}`);
  },

  async cleanOrphanedFiles(): Promise<{ cleaned: number }> {
    return api.post<{ cleaned: number }>('/api/admin/cleanup-orphaned');
  },

  async clearCache(): Promise<void> {
    return api.post('/api/admin/clear-cache');
  },

  async getSystemLogs(): Promise<string[]> {
    return api.get<string[]>('/api/admin/logs');
  },

  async exportUserData(): Promise<Blob> {
    const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/admin/export`, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
      },
    });
    return response.blob();
  },
};
