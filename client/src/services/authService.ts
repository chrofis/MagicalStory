import api from './api';
import type { User, UserQuota } from '@/types/user';

interface LoginResponse {
  token: string;
  user: {
    id: string;
    username: string;
    email?: string;
    role: 'user' | 'admin';
    story_quota: number;
    stories_generated: number;
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
    const response = await api.post<LoginResponse>('/api/auth/login', {
      username,
      password,
    }, { skipAuth: true });

    const user: User = {
      id: response.user.id,
      username: response.user.username,
      email: response.user.email,
      role: response.user.role,
      storyQuota: response.user.story_quota,
      storiesGenerated: response.user.stories_generated,
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
    const response = await api.post<LoginResponse>('/api/auth/firebase', {
      idToken,
    }, { skipAuth: true });

    const user: User = {
      id: response.user.id,
      username: response.user.username,
      email: response.user.email,
      role: response.user.role,
      storyQuota: response.user.story_quota,
      storiesGenerated: response.user.stories_generated,
    };

    return { token: response.token, user };
  },

  async getQuota(): Promise<UserQuota> {
    const response = await api.get<{
      story_quota: number;
      stories_generated: number;
      remaining: number;
    }>('/api/user/quota');

    return {
      storyQuota: response.story_quota,
      storiesGenerated: response.stories_generated,
      remaining: response.remaining,
    };
  },

  async updateEmail(email: string): Promise<void> {
    await api.put('/api/user/update-email', { email });
  },

  async getShippingAddress(): Promise<{
    name: string;
    address1: string;
    address2?: string;
    city: string;
    state?: string;
    postcode: string;
    country: string;
  } | null> {
    try {
      const response = await api.get<{ address: unknown }>('/api/user/shipping-address');
      return response.address as ReturnType<typeof authService.getShippingAddress> extends Promise<infer T> ? T : never;
    } catch {
      return null;
    }
  },

  async updateShippingAddress(address: {
    name: string;
    address1: string;
    address2?: string;
    city: string;
    state?: string;
    postcode: string;
    country: string;
  }): Promise<void> {
    await api.put('/api/user/shipping-address', address);
  },
};

export default authService;
