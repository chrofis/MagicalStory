export interface User {
  id: string;
  username: string;
  email?: string;
  role: 'user' | 'admin';
  credits: number;
  storyQuota?: number;
  storiesGenerated?: number;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: User | null;
  token: string | null;
}

export interface UserQuota {
  storyQuota: number;
  storiesGenerated: number;
  remaining: number;
}

export interface UserCredits {
  credits: number;
  unlimited: boolean;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface RegisterData {
  username: string;
  password: string;
  email?: string;
}
