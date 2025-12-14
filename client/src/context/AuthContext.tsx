import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import type { User, AuthState } from '@/types/user';
import logger from '@/services/logger';

interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, email?: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  logout: () => void;
  updateQuota: (quota: { storyQuota: number; storiesGenerated: number }) => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

const API_URL = import.meta.env.VITE_API_URL || '';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    user: null,
    token: null,
  });
  const [isLoading, setIsLoading] = useState(true);

  // Restore session from localStorage on mount
  useEffect(() => {
    // Migration: copy old 'token' key to 'auth_token' if needed
    const oldToken = localStorage.getItem('token');
    if (oldToken && !localStorage.getItem('auth_token')) {
      localStorage.setItem('auth_token', oldToken);
      localStorage.removeItem('token');
    }

    const token = localStorage.getItem('auth_token');
    const userJson = localStorage.getItem('current_user');

    if (token && userJson) {
      try {
        const user = JSON.parse(userJson) as User;
        setState({
          isAuthenticated: true,
          user,
          token,
        });
        // Configure logger based on user role
        logger.configure({ isAdmin: user.role === 'admin' });
        logger.info(`Session restored for ${user.username}`);
      } catch {
        // Invalid stored data, clear it
        localStorage.removeItem('auth_token');
        localStorage.removeItem('current_user');
      }
    }
    setIsLoading(false);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const response = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Login failed');
    }

    const data = await response.json();
    const user: User = {
      id: data.user.id,
      username: data.user.username,
      email: data.user.email,
      role: data.user.role,
      storyQuota: data.user.story_quota,
      storiesGenerated: data.user.stories_generated,
    };

    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('current_user', JSON.stringify(user));

    setState({
      isAuthenticated: true,
      user,
      token: data.token,
    });

    // Configure logger based on user role
    logger.configure({ isAdmin: user.role === 'admin' });
    logger.success(`Logged in as ${user.username} (${user.role})`);
  }, []);

  const register = useCallback(async (username: string, password: string, email?: string) => {
    const response = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, email }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Registration failed');
    }

    // Auto-login after registration
    await login(username, password);
  }, [login]);

  const loginWithGoogle = useCallback(async () => {
    // Firebase Google auth implementation
    // This will be implemented when Firebase is properly set up
    throw new Error('Google login not yet implemented');
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    const response = await fetch(`${API_URL}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Password reset failed');
    }
  }, []);

  const logout = useCallback(() => {
    logger.info('Logging out...');
    localStorage.removeItem('auth_token');
    localStorage.removeItem('current_user');
    setState({
      isAuthenticated: false,
      user: null,
      token: null,
    });
    // Reset logger to non-admin mode
    logger.configure({ isAdmin: false });
  }, []);

  const updateQuota = useCallback((quota: { storyQuota: number; storiesGenerated: number }) => {
    setState(prev => {
      if (!prev.user) return prev;
      const updatedUser = {
        ...prev.user,
        storyQuota: quota.storyQuota,
        storiesGenerated: quota.storiesGenerated,
      };
      localStorage.setItem('current_user', JSON.stringify(updatedUser));
      return {
        ...prev,
        user: updatedUser,
      };
    });
  }, []);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        login,
        register,
        loginWithGoogle,
        resetPassword,
        logout,
        updateQuota,
        isLoading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
