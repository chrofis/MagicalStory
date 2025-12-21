import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type { User, AuthState } from '@/types/user';
import logger from '@/services/logger';
import { signInWithGoogle, getIdToken, firebaseSignOut, onFirebaseAuthStateChanged, handleRedirectResult, type FirebaseUser } from '@/services/firebase';

interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, email?: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  logout: () => void;
  updateCredits: (credits: number) => void;
  refreshUser: () => Promise<void>;
  impersonate: (userId: string) => Promise<void>;
  stopImpersonating: () => Promise<void>;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

const API_URL = import.meta.env.VITE_API_URL || '';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    user: null,
    token: null,
    isImpersonating: false,
    originalAdmin: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const redirectCheckedRef = useRef(false);
  const authInProgressRef = useRef(false);

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
        // Restore impersonation state if present
        const impersonationJson = localStorage.getItem('impersonation_state');
        let isImpersonating = false;
        let originalAdmin = null;
        if (impersonationJson) {
          try {
            const impersonationState = JSON.parse(impersonationJson);
            isImpersonating = impersonationState.isImpersonating || false;
            originalAdmin = impersonationState.originalAdmin || null;
          } catch {
            localStorage.removeItem('impersonation_state');
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
      } catch {
        // Invalid stored data, clear it
        localStorage.removeItem('auth_token');
        localStorage.removeItem('current_user');
        localStorage.removeItem('impersonation_state');
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
      credits: data.user.credits,
      preferredLanguage: data.user.preferredLanguage,
    };

    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('current_user', JSON.stringify(user));
    localStorage.removeItem('impersonation_state'); // Clear any impersonation state on fresh login

    // Set UI language based on user's preferred language
    if (data.user.preferredLanguage) {
      const langMap: Record<string, string> = { 'English': 'en', 'German': 'de', 'French': 'fr' };
      const langCode = langMap[data.user.preferredLanguage] || 'en';
      localStorage.setItem('magicalstory_language', langCode);
      // Dispatch event to notify LanguageContext
      window.dispatchEvent(new Event('languageUpdated'));
    }

    setState({
      isAuthenticated: true,
      user,
      token: data.token,
      isImpersonating: false,
      originalAdmin: null,
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

  // Handle Firebase user authentication with our backend
  const handleFirebaseAuth = useCallback(async (firebaseUser: FirebaseUser) => {
    const idToken = await getIdToken(firebaseUser);

    const response = await fetch(`${API_URL}/api/auth/firebase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Firebase authentication failed');
    }

    const data = await response.json();
    const user: User = {
      id: data.user.id,
      username: data.user.username,
      email: data.user.email,
      role: data.user.role,
      credits: data.user.credits,
      preferredLanguage: data.user.preferredLanguage,
    };

    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('current_user', JSON.stringify(user));
    localStorage.removeItem('impersonation_state');

    // Set UI language based on user's preferred language
    if (data.user.preferredLanguage) {
      const langMap: Record<string, string> = { 'English': 'en', 'German': 'de', 'French': 'fr' };
      const langCode = langMap[data.user.preferredLanguage] || 'en';
      localStorage.setItem('magicalstory_language', langCode);
      // Dispatch event to notify LanguageContext
      window.dispatchEvent(new Event('languageUpdated'));
    }

    setState({
      isAuthenticated: true,
      user,
      token: data.token,
      isImpersonating: false,
      originalAdmin: null,
    });

    logger.configure({ isAdmin: user.role === 'admin' });
    logger.success(`Logged in with Google as ${user.username}`);
  }, []);

  const loginWithGoogle = useCallback(async () => {
    const firebaseUser = await signInWithGoogle();
    await handleFirebaseAuth(firebaseUser);
  }, [handleFirebaseAuth]);

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
    localStorage.removeItem('impersonation_state');
    // Also sign out from Firebase
    firebaseSignOut().catch(err => {
      console.warn('Firebase sign out error:', err);
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
    };

    // Store impersonation state
    const impersonationState = {
      isImpersonating: true,
      originalAdmin: data.originalAdmin,
    };

    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('current_user', JSON.stringify(user));
    localStorage.setItem('impersonation_state', JSON.stringify(impersonationState));

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
    };

    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('current_user', JSON.stringify(user));
    localStorage.removeItem('impersonation_state');

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

  // Handle redirect result on page load (for mobile Google sign-in)
  // This must only run ONCE because getRedirectResult() consumes the result
  useEffect(() => {
    const checkRedirectResult = async () => {
      // Only check once - getRedirectResult returns null on subsequent calls
      if (redirectCheckedRef.current) {
        return;
      }
      redirectCheckedRef.current = true;

      try {
        logger.info('Checking for Google redirect result...');
        const firebaseUser = await handleRedirectResult();
        if (firebaseUser) {
          // Prevent duplicate auth if auth state listener also fires
          if (authInProgressRef.current) {
            logger.info('Redirect result: Auth already in progress, skipping');
            return;
          }
          authInProgressRef.current = true;
          logger.info('Redirect result: Firebase user detected, completing login...');
          await handleFirebaseAuth(firebaseUser);
          authInProgressRef.current = false;
        } else {
          logger.info('Redirect result: No pending redirect');
        }
      } catch (err) {
        authInProgressRef.current = false;
        console.error('Redirect result error:', err);
      }
    };
    checkRedirectResult();
  }, [handleFirebaseAuth]);

  // Firebase Auth State Listener - catches sign-in even if redirect handling fails
  useEffect(() => {
    const unsubscribe = onFirebaseAuthStateChanged(async (firebaseUser) => {
      // Only process if we have a Firebase user but NOT already authenticated in our app
      // Also check authInProgressRef to avoid duplicate auth attempts
      if (firebaseUser && !state.isAuthenticated && !state.token && !authInProgressRef.current) {
        authInProgressRef.current = true;
        logger.info('Firebase auth state changed: User detected, completing login...');
        try {
          await handleFirebaseAuth(firebaseUser);
        } catch (err) {
          console.error('Firebase auth state change error:', err);
        }
        authInProgressRef.current = false;
      }
    });

    return () => unsubscribe();
  }, [state.isAuthenticated, state.token, handleFirebaseAuth]);

  const updateCredits = useCallback((credits: number) => {
    setState(prev => {
      if (!prev.user) return prev;
      const updatedUser = {
        ...prev.user,
        credits,
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
        updateCredits,
        impersonate,
        stopImpersonating,
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
