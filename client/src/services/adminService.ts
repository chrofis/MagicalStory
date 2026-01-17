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
  emailVerified?: boolean;
  photoConsentAt?: string | null;
  totalOrders?: number;
  failedOrders?: number;
}

export interface PaginationInfo {
  page: number;
  limit: number;
  totalUsers: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface UsersResponse {
  users: AdminUser[];
  pagination: PaginationInfo;
}

export interface GetUsersParams {
  page?: number;
  limit?: number;
  search?: string;
}

export interface CreditTransaction {
  id: number;
  amount: number;
  balanceAfter: number;
  type: 'initial' | 'story_reserve' | 'story_complete' | 'story_refund' | 'admin_add' | 'admin_deduct' | 'purchase' | 'book_purchase_reward';
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

export interface PrintProduct {
  id: number;
  product_uid: string;
  product_name: string;
  description?: string;
  size?: string;
  cover_type?: string;
  min_pages: number;
  max_pages: number;
  available_page_counts: number[];
  is_active: boolean;
  created_at: string;
  updated_at?: string;
}

export interface GelatoProduct {
  productUid: string;
  uid?: string;
  name?: string;
  productName?: string;
  description?: string;
  pageCount?: {
    min: number;
    max: number;
  };
}

// Token Usage Types
export interface ProviderTokens {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  calls: number;
}

export interface RunwareUsage {
  direct_cost: number;
  calls: number;
}

export interface ProviderCost {
  input: number;
  output: number;
  thinking: number;
  total: number;
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  calls: number;
  cost?: number;
}

export interface TokenUsageTotals {
  anthropic: ProviderTokens;
  gemini_text: ProviderTokens;
  gemini_image: ProviderTokens;
  gemini_quality: ProviderTokens;
  runware: RunwareUsage;
  avatarByModel: Record<string, ModelUsage>;
  imageByModel: Record<string, ModelUsage>;
}

export interface GeminiImageCost extends ProviderCost {
  imageEstimate: number;
  byModel?: Record<string, ModelUsage>;
}

export interface TokenUsageCosts {
  anthropic: ProviderCost;
  gemini_text: ProviderCost;
  gemini_image: GeminiImageCost;
  gemini_quality: ProviderCost;
  runware: { total: number };
  avatarByModel: Record<string, ModelUsage>;
  totalAvatarCost: number;
  grandTotal: number;
}

export interface TokenUsageByUser {
  userId: string;
  email: string;
  name: string;
  storyCount: number;
  totalBookPages: number;
  anthropic: ProviderTokens;
  gemini_text: ProviderTokens;
  gemini_image: ProviderTokens;
  gemini_quality: ProviderTokens;
  avatarByModel: Record<string, ModelUsage>;
  runware: RunwareUsage;
}

export interface TokenUsageByDay {
  date: string;
  storyCount: number;
  totalBookPages: number;
  anthropic: ProviderTokens;
  gemini_text: ProviderTokens;
  gemini_image: ProviderTokens;
  gemini_quality: ProviderTokens;
  runware: RunwareUsage;
  totalCost: number;
}

export interface TokenUsageByMonth {
  month: string;
  storyCount: number;
  totalBookPages: number;
  anthropic: ProviderTokens;
  gemini_text: ProviderTokens;
  gemini_image: ProviderTokens;
  gemini_quality: ProviderTokens;
  runware: RunwareUsage;
  totalCost: number;
}

export interface TokenUsageByStoryType {
  [storyType: string]: {
    storyCount: number;
    totalBookPages: number;
    anthropic: ProviderTokens;
    gemini_text: ProviderTokens;
    gemini_image: ProviderTokens;
    gemini_quality: ProviderTokens;
    runware: RunwareUsage;
  };
}

export interface RecentStoryTokenUsage {
  id: string;
  title: string;
  storyType: string;
  storyPages: number;
  bookPages: number;
  userId: string;
  userEmail: string;
  createdAt: string;
  tokenUsage: TokenUsageTotals;
}

export interface TokenUsageResponse {
  summary: {
    totalStories: number;
    storiesWithTokenData: number;
    storiesWithoutTokenData: number;
    totalBookPages: number;
  };
  totals: TokenUsageTotals;
  costs: TokenUsageCosts;
  byUser: TokenUsageByUser[];
  byStoryType: TokenUsageByStoryType;
  byDay: TokenUsageByDay[];
  byMonth: TokenUsageByMonth[];
  recentStories: RecentStoryTokenUsage[];
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
    tokenUsage?: {
      anthropic: { input_tokens: number; output_tokens: number; calls: number };
      gemini_text: { input_tokens: number; output_tokens: number; calls: number };
      gemini_image: { input_tokens: number; output_tokens: number; calls: number };
      gemini_quality: { input_tokens: number; output_tokens: number; calls: number };
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCalls: number;
    };
  };
  stories: UserStory[];
  purchases: UserPurchase[];
  creditHistory: CreditTransaction[];
}

export const adminService = {
  async getStats(): Promise<DashboardStats> {
    return api.get<DashboardStats>('/api/admin/stats');
  },

  async getUsers(params: GetUsersParams = {}): Promise<UsersResponse> {
    const searchParams = new URLSearchParams();
    if (params.page) searchParams.set('page', String(params.page));
    if (params.limit) searchParams.set('limit', String(params.limit));
    if (params.search) searchParams.set('search', params.search);
    const query = searchParams.toString();
    return api.get<UsersResponse>(`/api/admin/users${query ? `?${query}` : ''}`);
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

  async toggleEmailVerified(userId: string, emailVerified: boolean): Promise<{ user: { emailVerified: boolean } }> {
    return api.post(`/api/admin/users/${userId}/email-verified`, { emailVerified });
  },

  async togglePhotoConsent(userId: string, hasConsent: boolean): Promise<{ user: { photoConsentAt: string | null } }> {
    return api.post(`/api/admin/users/${userId}/photo-consent`, { hasConsent });
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

  // Print Products Management
  async getPrintProducts(): Promise<{ products: PrintProduct[] }> {
    return api.get<{ products: PrintProduct[] }>('/api/admin/print-products');
  },

  async fetchGelatoProducts(): Promise<{ products: GelatoProduct[]; count: number }> {
    return api.get<{ products: GelatoProduct[]; count: number }>('/api/admin/print-provider/fetch-products');
  },

  async createPrintProduct(product: Omit<PrintProduct, 'id' | 'created_at' | 'updated_at'>): Promise<{ product: PrintProduct }> {
    return api.post<{ product: PrintProduct }>('/api/admin/print-products', product);
  },

  async updatePrintProduct(id: number, product: Partial<PrintProduct>): Promise<{ product: PrintProduct }> {
    return api.put<{ product: PrintProduct }>(`/api/admin/print-products/${id}`, product);
  },

  async togglePrintProduct(id: number, currentIsActive: boolean): Promise<{ product: PrintProduct }> {
    return api.put<{ product: PrintProduct }>(`/api/admin/print-products/${id}/toggle`, { is_active: currentIsActive });
  },

  async deletePrintProduct(id: number): Promise<void> {
    return api.delete(`/api/admin/print-products/${id}`);
  },

  // Token Usage Analytics
  async getTokenUsage(days = 30, limit = 1000): Promise<TokenUsageResponse> {
    return api.get<TokenUsageResponse>(`/api/admin/token-usage?days=${days}&limit=${limit}`);
  },

  // Token Promotion Config
  async getTokenPromo(): Promise<{ multiplier: number; isPromoActive: boolean }> {
    return api.get<{ multiplier: number; isPromoActive: boolean }>('/api/admin/config/token-promo');
  },

  async setTokenPromo(multiplier: number): Promise<{ success: boolean; multiplier: number }> {
    return api.post<{ success: boolean; multiplier: number }>('/api/admin/config/token-promo', { multiplier });
  },
};
