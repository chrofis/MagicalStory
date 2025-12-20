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

export interface CreditTransaction {
  id: number;
  amount: number;
  balanceAfter: number;
  type: 'initial' | 'story_reserve' | 'story_complete' | 'story_refund' | 'admin_add' | 'admin_deduct' | 'purchase';
  referenceId?: string;
  description: string;
  createdAt: string;
}

export interface CreditHistoryResponse {
  user: {
    id: string;
    username: string;
    email: string;
    currentCredits: number;
  };
  transactions: CreditTransaction[];
}

export interface UserStory {
  id: number;
  title: string;
  createdAt: string;
  pageCount: number;
  imageCount: number;
}

export interface UserPurchase {
  id: number;
  storyId: number;
  amount: string;
  currency: string;
  status: string;
  gelatoOrderId?: string;
  productVariant?: string;
  createdAt: string;
}

export interface UserDetailsResponse {
  user: {
    id: string;
    username: string;
    email: string;
    role: 'user' | 'admin';
    credits: number;
    storyQuota: number;
    storiesGenerated: number;
    createdAt: string;
    lastLogin: string | null;
  };
  stats: {
    totalStories: number;
    totalCharacters: number;
    totalImages: number;
    totalPurchases: number;
    totalSpent: number;
  };
  stories: UserStory[];
  purchases: UserPurchase[];
  creditHistory: CreditTransaction[];
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

  async getCreditHistory(userId: string, limit = 50): Promise<CreditHistoryResponse> {
    return api.get<CreditHistoryResponse>(`/api/admin/users/${userId}/credits?limit=${limit}`);
  },

  async getUserDetails(userId: string): Promise<UserDetailsResponse> {
    return api.get<UserDetailsResponse>(`/api/admin/users/${userId}/details`);
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
