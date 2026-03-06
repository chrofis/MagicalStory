import api from './api';
import type { User, UserQuota, UserCredits } from '@/types/user';

// API response uses snake_case, mapped to camelCase in code
interface LoginResponseRaw {
  token: string;
  user: {
    id: string;
    username: string;
    email?: string;
    role: 'user' | 'admin';
    credits: number;
    storyQuota?: number;      // Server already sends camelCase
    storiesGenerated?: number;
    emailVerified?: boolean;
    photoConsentAt?: string | null;
  };
}

interface RegisterResponse {
  message: string;
  user: {
    id: string;
    username: string;
  };
}

export const authService = {
  async login(username: string, password: string): Promise<{ token: string; user: User }> {
    const response = await api.post<LoginResponseRaw>('/api/auth/login', {
      username,
      password,
    }, { skipAuth: true });

    const user: User = {
      id: response.user.id,
      username: response.user.username,
      email: response.user.email,
      role: response.user.role,
      credits: response.user.credits,
    };

    return { token: response.token, user };
  },

  async register(username: string, password: string, email?: string): Promise<RegisterResponse> {
    return api.post<RegisterResponse>('/api/auth/register', {
      username,
      password,
      email,
    }, { skipAuth: true });
  },

  async loginWithFirebase(idToken: string): Promise<{ token: string; user: User }> {
    const response = await api.post<LoginResponseRaw>('/api/auth/firebase', {
      idToken,
    }, { skipAuth: true });

    const user: User = {
      id: response.user.id,
      username: response.user.username,
      email: response.user.email,
      role: response.user.role,
      credits: response.user.credits,
    };

    return { token: response.token, user };
  },

  async getQuota(): Promise<UserQuota> {
    // Server already sends camelCase
    const response = await api.get<{
      storyQuota: number;
      storiesGenerated: number;
      remaining: number;
    }>('/api/user/quota');

    return {
      storyQuota: response.storyQuota,
      storiesGenerated: response.storiesGenerated,
      remaining: response.remaining,
    };
  },

  async getCredits(): Promise<UserCredits> {
    const response = await api.get<{
      credits: number;
      unlimited: boolean;
    }>('/api/user/quota');

    return {
      credits: response.credits,
      unlimited: response.unlimited,
    };
  },

  async updateEmail(email: string): Promise<void> {
    await api.put('/api/user/update-email', { email });
  },

  async getShippingAddress(): Promise<{
    firstName: string;
    lastName: string;
    addressLine1: string;
    city: string;
    postCode: string;
    country: string;
    email?: string;
  } | null> {
    try {
      // Server returns the address directly, not wrapped in { address: ... }
      const response = await api.get<{
        firstName: string;
        lastName: string;
        addressLine1: string;
        city: string;
        postCode: string;
        country: string;
        email?: string;
      } | null>('/api/user/shipping-address');
      return response;
    } catch {
      return null;
    }
  },

  async updateShippingAddress(address: {
    firstName: string;
    lastName: string;
    addressLine1: string;
    city: string;
    postCode: string;
    country: string;
    email?: string;
  }): Promise<void> {
    await api.put('/api/user/shipping-address', address);
  },
};

export default authService;
