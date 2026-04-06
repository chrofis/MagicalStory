import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  browserPopupRedirectResolver,
  type Auth,
  type User as FirebaseUser
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyCtdyVIpckWhIfy1_9O8qOaEnTXFuiRYaQ",
  authDomain: "magical-story-3b745.firebaseapp.com",
  projectId: "magical-story-3b745",
  storageBucket: "magical-story-3b745.firebasestorage.app",
  messagingSenderId: "69965481554",
  appId: "1:69965481554:web:d264515ca92d2306f5018b",
  measurementId: "G-TERDSLHHDG"
};

// Lazy initialization — Firebase touches `window` and `indexedDB` at init time,
// which crashes during SSR / pre-rendering. We defer init until first call so the
// module can be safely imported in a Node environment.
let _app: FirebaseApp | null = null;
let _auth: Auth | null = null;
let _googleProvider: GoogleAuthProvider | null = null;

function ensureFirebase(): { auth: Auth; provider: GoogleAuthProvider } {
  if (typeof window === 'undefined') {
    throw new Error('Firebase is not available in server-side rendering');
  }
  if (!_app) {
    _app = initializeApp(firebaseConfig);
    _auth = getAuth(_app);
    _googleProvider = new GoogleAuthProvider();
    _googleProvider.setCustomParameters({ prompt: 'select_account' });
  }
  return { auth: _auth!, provider: _googleProvider! };
}

export async function signInWithGoogle(): Promise<FirebaseUser> {
  const { auth, provider } = ensureFirebase();
  try {
    // Try popup first - works on most desktop browsers
    const result = await signInWithPopup(auth, provider, browserPopupRedirectResolver);
    return result.user;
  } catch (error: unknown) {
    const firebaseError = error as { code?: string; message?: string };
    console.error('Popup sign-in failed:', firebaseError.code, firebaseError.message);

    // Fall back to redirect for ANY popup failure (iOS Safari blocks popups entirely,
    // and may return various error codes beyond just popup-blocked)
    if (firebaseError.code === 'auth/popup-closed-by-user') {
      // User explicitly closed the popup — don't redirect, they cancelled
      throw error;
    }

    // All other popup failures → try redirect (covers popup-blocked, cancelled-popup-request,
    // operation-not-supported-in-this-environment, internal-error, etc.)
    console.log('Popup failed, trying redirect...');
    await signInWithRedirect(auth, provider);
    throw new Error('Redirecting to Google...');
  }
}

// Handle redirect result when returning from Google auth
export async function handleRedirectResult(): Promise<FirebaseUser | null> {
  const { auth } = ensureFirebase();
  try {
    const result = await getRedirectResult(auth, browserPopupRedirectResolver);
    if (result) {
      console.log('Redirect result: user found');
      return result.user;
    }
    return null;
  } catch (error) {
    console.error('Error handling redirect result:', error);
    return null;
  }
}

export async function getIdToken(user: FirebaseUser): Promise<string> {
  return user.getIdToken();
}

export async function firebaseSignOut(): Promise<void> {
  const { auth } = ensureFirebase();
  await signOut(auth);
}

/**
 * Returns the Firebase Auth instance, lazily initializing if needed.
 * Throws when called outside a browser environment.
 */
export function getFirebaseAuth(): Auth {
  return ensureFirebase().auth;
}

export type { FirebaseUser };
