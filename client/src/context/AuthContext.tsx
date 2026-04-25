import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type { User, AuthState } from '@/types/user';
import logger from '@/services/logger';
import storage, { STORAGE_KEYS } from '@/services/storage';
import { signInWithGoogle, googleSignOut, consumeAuthHash } from '@/services/googleAuth';
import { isNavigationAbort } from '@/utils/fetchErrors';

interface BotProtectionData {
  website?: string;
  _formStartTime?: number;
}

interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, email?: string, botProtection?: BotProtectionData) => Promise<void>;
  loginWithGoogle: (redirectUrl?: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  updateCredits: (credits: number) => void;
  refreshUser: () => Promise<User | null>;
  refreshToken: () => Promise<boolean>;
  impersonate: (userId: string) => Promise<void>;
  stopImpersonating: () => Promise<void>;
  recordPhotoConsent: () => Promise<void>;
  isLoading: boolean;
  storageWarning: string | null;
}

const AuthContext = createContext<AuthContextType | null>(null);

const API_URL = import.meta.env.VITE_API_URL || '';

// Token refresh interval (refresh when 1 day left of 7 day token)
const TOKEN_REFRESH_THRESHOLD_MS = 6 * 24 * 60 * 60 * 1000; // 6 days

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    user: null,
    token: null,
    isImpersonating: false,
    originalAdmin: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  // (redirect-flow refs removed — Google Identity Services uses a popup, not a redirect)
  const tokenRefreshTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Check storage availability and warn user if limited
  useEffect(() => {
    const storageType = storage.getStorageType();
    if (storageType === 'sessionStorage') {
      setStorageWarning('Your session will not persist after closing the browser (private mode detected)');
    } else if (storageType === 'memory') {
      setStorageWarning('Your session will be lost on page refresh (storage unavailable)');
    }
  }, []);

  // Parse JWT to get expiration time
  const getTokenExpiry = useCallback((token: string): number | null => {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.exp ? payload.exp * 1000 : null; // Convert to ms
    } catch {
      return null;
    }
  }, []);

  // Refresh token before it expires
  const refreshToken = useCallback(async (): Promise<boolean> => {
    const token = storage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    if (!token) return false;

    try {
      const response = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        logger.warn('Token refresh failed, user may need to re-login');
        return false;
      }

      const data = await response.json();
      storage.setItem(STORAGE_KEYS.AUTH_TOKEN, data.token);

      setState(prev => ({
        ...prev,
        token: data.token,
      }));

      logger.info('Token refreshed successfully');
      return true;
    } catch (error) {
      // Fetches cancelled by browser navigation (e.g. trial → /stories
      // redirect) surface as AbortError or "Failed to fetch" TypeError.
      // These are expected transitions, not bugs — log at debug so real
      // errors still surface at error level.
      if (isNavigationAbort(error)) {
        logger.debug('Token refresh aborted (navigation):', error);
      } else {
        logger.error('Token refresh error:', error);
      }
      return false;
    }
  }, []);

  // Schedule token refresh
  const scheduleTokenRefresh = useCallback((token: string) => {
    // Clear any existing interval
    if (tokenRefreshTimeoutRef.current) {
      clearInterval(tokenRefreshTimeoutRef.current);
    }

    const expiry = getTokenExpiry(token);
    if (!expiry) return;

    const now = Date.now();
    const timeUntilRefresh = expiry - now - TOKEN_REFRESH_THRESHOLD_MS;

    if (timeUntilRefresh > 0) {
      // Schedule refresh
      tokenRefreshTimeoutRef.current = setTimeout(async () => {
        const success = await refreshToken();
        if (success) {
          const newToken = storage.getItem(STORAGE_KEYS.AUTH_TOKEN);
          if (newToken) {
            scheduleTokenRefresh(newToken);
          }
        }
      }, timeUntilRefresh);
      logger.info(`Token refresh scheduled in ${Math.round(timeUntilRefresh / 1000 / 60)} minutes`);
    } else if (now < expiry) {
      // Token expires soon, refresh now
      refreshToken();
    }
  }, [getTokenExpiry, refreshToken]);

  // Restore session from storage on mount
  useEffect(() => {
    // Migration: copy old 'token' key to 'auth_token' if needed
    const oldToken = storage.getItem('token');
    if (oldToken && !storage.getItem(STORAGE_KEYS.AUTH_TOKEN)) {
      storage.setItem(STORAGE_KEYS.AUTH_TOKEN, oldToken);
      storage.removeItem('token');
    }

    const token = storage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    const userJson = storage.getItem(STORAGE_KEYS.CURRENT_USER);

    if (token && userJson) {
      try {
        // Check if token is expired
        const expiry = getTokenExpiry(token);
        if (expiry && Date.now() >= expiry) {
          logger.warn('Stored token has expired, clearing session');
          storage.clearAuthStorage();
          setIsLoading(false);
          return;
        }

        const user = JSON.parse(userJson) as User;

        // Clear developer mode for non-admin users on session restore
        if (user.role !== 'admin') {
          storage.removeItem('developer_mode');
        }

        // Restore impersonation state if present
        const impersonationJson = storage.getItem(STORAGE_KEYS.IMPERSONATION_STATE);
        let isImpersonating = false;
        let originalAdmin = null;
        if (impersonationJson) {
          try {
            const impersonationState = JSON.parse(impersonationJson);
            isImpersonating = impersonationState.isImpersonating || false;
            originalAdmin = impersonationState.originalAdmin || null;
          } catch {
            storage.removeItem(STORAGE_KEYS.IMPERSONATION_STATE);
          }
        }
        setState({
          isAuthenticated: true,
          user,
          token,
          isImpersonating,
          originalAdmin,
        });
        // Configure logger based on original admin role or current user role
        logger.configure({ isAdmin: originalAdmin ? true : user.role === 'admin' });
        logger.info(`Session restored for ${user.username}${isImpersonating ? ' (impersonating)' : ''}`);

        // Schedule token refresh
        scheduleTokenRefresh(token);
      } catch {
        // Invalid stored data, clear it
        storage.clearAuthStorage();
      }
      setIsLoading(false);
    } else if (token && !userJson) {
      // Token exists but no stored user data (e.g. trial email verification redirect).
      // Fetch user profile from API to complete the session.
      logger.info('Token found without user data, fetching profile from API...');
      fetch(`${API_URL}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.ok ? r.json() : Promise.reject(new Error('Failed to fetch user')))
        .then(data => {
          if (data?.user) {
            const user = data.user as User;
            storage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(user));
            if (user.role !== 'admin') {
              storage.removeItem('developer_mode');
            }
            setState({
              isAuthenticated: true,
              user,
              token,
              isImpersonating: false,
              originalAdmin: null,
            });
            logger.info(`Session restored from API for ${user.username}`);
            scheduleTokenRefresh(token);
          } else {
            storage.clearAuthStorage();
          }
        })
        .catch(() => {
          logger.warn('Failed to fetch user profile, clearing token');
          storage.clearAuthStorage();
        })
        .finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, [getTokenExpiry, scheduleTokenRefresh]);

  // Save auth data to storage
  const saveAuthData = useCallback((token: string, user: User) => {
    storage.setItem(STORAGE_KEYS.AUTH_TOKEN, token);
    storage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(user));
    storage.removeItem(STORAGE_KEYS.IMPERSONATION_STATE);

    // Clear developer mode for non-admin users (prevents non-admins from seeing dev features
    // if an admin previously enabled it on the same browser)
    if (user.role !== 'admin') {
      storage.removeItem('developer_mode');
    }

    // Set UI language based on user's preferred language, but only if no language is already set
    // This preserves the language the user selected on the landing page before logging in
    const existingLanguage = storage.getItem(STORAGE_KEYS.LANGUAGE);
    if (!existingLanguage && user.preferredLanguage) {
      const langMap: Record<string, string> = { 'English': 'en', 'German': 'de', 'French': 'fr' };
      const langCode = langMap[user.preferredLanguage] || 'en';
      storage.setItem(STORAGE_KEYS.LANGUAGE, langCode);
      window.dispatchEvent(new Event('languageUpdated'));
    }

    // Schedule token refresh
    scheduleTokenRefresh(token);
  }, [scheduleTokenRefresh]);

  const login = useCallback(async (username: string, password: string) => {
    const response = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      const error = new Error(errorData.error || 'Login failed') as Error & { code?: string };
      error.code = errorData.code;
      throw error;
    }

    const data = await response.json();
    const user: User = {
      id: data.user.id,
      username: data.user.username,
      email: data.user.email,
      role: data.user.role,
      credits: data.user.credits,
      preferredLanguage: data.user.preferredLanguage,
      emailVerified: data.user.emailVerified,
      photoConsentAt: data.user.photoConsentAt,
    };

    saveAuthData(data.token, user);

    setState({
      isAuthenticated: true,
      user,
      token: data.token,
      isImpersonating: false,
      originalAdmin: null,
    });

    logger.configure({ isAdmin: user.role === 'admin' });
    logger.success(`Logged in as ${user.username} (${user.role})`);
  }, [saveAuthData]);

  const register = useCallback(async (username: string, password: string, email?: string, botProtection?: BotProtectionData) => {
    const response = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        email,
        // Bot protection fields
        website: botProtection?.website,
        _formStartTime: botProtection?._formStartTime,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Registration failed');
    }

    // Auto-login after registration
    await login(username, password);
  }, [login]);

  // (handleGoogleAuth removed — popup-based ID-token exchange is no longer
  //  used for primary sign-in. Trial-link / claim-account flows have their
  //  own server endpoints and call signInWithGooglePopup directly.)

  const loginWithGoogle = useCallback(async (redirectUrl?: string) => {
    // Auth-code redirect flow: navigate to server's start endpoint, server
    // redirects to Google, Google redirects to server callback, server
    // redirects back to us with #auth=token=...&user=...
    const targetUrl = redirectUrl || window.location.pathname || '/create';
    signInWithGoogle(targetUrl);
    // Returning a never-resolving promise so callers' loading spinners stay on
    // until the page navigates away. The await contract for this function is
    // historical — kept for ABI compatibility with consumers.
    await new Promise(() => {});
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

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const token = storage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    if (!token) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`${API_URL}/api/auth/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Password change failed');
    }

    logger.success('Password changed successfully');
  }, []);

  const logout = useCallback(async () => {
    logger.info('Logging out...');

    // Clear refresh timer
    if (tokenRefreshTimeoutRef.current) {
      clearTimeout(tokenRefreshTimeoutRef.current);
      tokenRefreshTimeoutRef.current = null;
    }

    // Try to invalidate token on server (best effort)
    const token = storage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    if (token) {
      try {
        await fetch(`${API_URL}/api/auth/logout`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });
      } catch {
        // Ignore errors - logout should succeed even if server call fails
      }
    }

    // Clear all auth storage
    storage.clearAuthStorage();

    // Disable Google Identity Services auto-select so the next sign-in shows chooser
    googleSignOut().catch(err => {
      console.warn('Google sign out error:', err);
    });

    setState({
      isAuthenticated: false,
      user: null,
      token: null,
      isImpersonating: false,
      originalAdmin: null,
    });

    // Reset logger to non-admin mode
    logger.configure({ isAdmin: false });
  }, []);

  // Impersonate another user (admin only)
  const impersonate = useCallback(async (userId: string) => {
    const response = await fetch(`${API_URL}/api/admin/impersonate/${userId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Impersonation failed');
    }

    const data = await response.json();
    const user: User = {
      id: data.user.id,
      username: data.user.username,
      email: data.user.email,
      role: data.user.role,
      credits: data.user.credits || 0,
      emailVerified: data.user.emailVerified,
      photoConsentAt: data.user.photoConsentAt,
    };

    // Store impersonation state
    const impersonationState = {
      isImpersonating: true,
      originalAdmin: data.originalAdmin,
    };

    storage.setItem(STORAGE_KEYS.AUTH_TOKEN, data.token);
    storage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(user));
    storage.setItem(STORAGE_KEYS.IMPERSONATION_STATE, JSON.stringify(impersonationState));

    setState({
      isAuthenticated: true,
      user,
      token: data.token,
      isImpersonating: true,
      originalAdmin: data.originalAdmin,
    });

    logger.configure({ isAdmin: true }); // Keep admin logging
    logger.info(`Now impersonating ${user.username}`);
  }, [state.token]);

  // Stop impersonating and return to admin account
  const stopImpersonating = useCallback(async () => {
    const response = await fetch(`${API_URL}/api/admin/stop-impersonate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to stop impersonation');
    }

    const data = await response.json();
    const user: User = {
      id: data.user.id,
      username: data.user.username,
      email: data.user.email,
      role: data.user.role,
      credits: data.user.credits || 0,
      emailVerified: data.user.emailVerified,
      photoConsentAt: data.user.photoConsentAt,
    };

    storage.setItem(STORAGE_KEYS.AUTH_TOKEN, data.token);
    storage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(user));
    storage.removeItem(STORAGE_KEYS.IMPERSONATION_STATE);

    setState({
      isAuthenticated: true,
      user,
      token: data.token,
      isImpersonating: false,
      originalAdmin: null,
    });

    logger.configure({ isAdmin: true });
    logger.info(`Stopped impersonating, back to ${user.username}`);
  }, [state.token]);

  // Auth-code flow returns the JWT in the URL hash (#auth=token=...&user=...).
  // Consume it on first mount, persist, and clean the URL.
  useEffect(() => {
    const result = consumeAuthHash();
    if (!result) return;
    const user: User = {
      id: result.user.id,
      username: result.user.username,
      email: result.user.email,
      role: (result.user.role === 'admin' ? 'admin' : 'user') as User['role'],
      credits: result.user.credits,
      preferredLanguage: result.user.preferredLanguage as User['preferredLanguage'],
      emailVerified: result.user.emailVerified,
      photoConsentAt: result.user.photoConsentAt,
    };
    saveAuthData(result.token, user);
    setState({
      isAuthenticated: true,
      user,
      token: result.token,
      isImpersonating: false,
      originalAdmin: null,
    });
    logger.configure({ isAdmin: user.role === 'admin' });
    logger.success(`Logged in with Google as ${user.username}`);
  }, [saveAuthData]);

  const updateCredits = useCallback((credits: number) => {
    setState(prev => {
      if (!prev.user) return prev;
      const updatedUser = {
        ...prev.user,
        credits,
      };
      storage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(updatedUser));
      return {
        ...prev,
        user: updatedUser,
      };
    });
  }, []);

  const refreshUser = useCallback(async (): Promise<User | null> => {
    const token = storage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    if (!token) return null;

    try {
      const response = await fetch(`${API_URL}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) return null;

      const data = await response.json();
      const user: User = {
        id: data.user.id,
        username: data.user.username,
        email: data.user.email,
        role: data.user.role,
        credits: data.user.credits,
        preferredLanguage: data.user.preferredLanguage,
        emailVerified: data.user.emailVerified,
        photoConsentAt: data.user.photoConsentAt,
      };

      storage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(user));
      setState(prev => ({
        ...prev,
        user,
      }));
      return user;
    } catch (error) {
      logger.error('Failed to refresh user:', error);
      return null;
    }
  }, []);

  const recordPhotoConsent = useCallback(async () => {
    const token = storage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    if (!token) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`${API_URL}/api/auth/photo-consent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to record consent');
    }

    const data = await response.json();

    // Update user state with consent timestamp
    setState(prev => {
      if (!prev.user) return prev;
      const updatedUser = {
        ...prev.user,
        photoConsentAt: data.photoConsentAt,
      };
      storage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(updatedUser));
      return {
        ...prev,
        user: updatedUser,
      };
    });

    logger.info('Photo consent recorded');
  }, []);

  // Listen for 401 auth:expired events from api.ts and trigger logout
  useEffect(() => {
    const handleAuthExpired = () => {
      logger.warn('Auth token expired (401), logging out...');
      logout();
    };
    window.addEventListener('auth:expired', handleAuthExpired);
    return () => {
      window.removeEventListener('auth:expired', handleAuthExpired);
    };
  }, [logout]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (tokenRefreshTimeoutRef.current) {
        clearTimeout(tokenRefreshTimeoutRef.current);
      }
    };
  }, []);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        login,
        register,
        loginWithGoogle,
        resetPassword,
        changePassword,
        logout,
        updateCredits,
        refreshUser,
        refreshToken,
        impersonate,
        stopImpersonating,
        recordPhotoConsent,
        isLoading,
        storageWarning,
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
