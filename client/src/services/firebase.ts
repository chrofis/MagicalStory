import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
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

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// Detect mobile/tablet devices
function isMobileDevice(): boolean {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

// Detect iOS specifically (Safari has different auth behavior)
function isIOS(): boolean {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export async function signInWithGoogle(): Promise<FirebaseUser> {
  // On iOS: Try popup first (works better with Safari ITP), fall back to redirect
  // On Android: Use redirect (popup often blocked)
  // On Desktop: Use popup (faster UX)

  if (isMobileDevice() && !isIOS()) {
    // Android - use redirect (popup usually blocked)
    await signInWithRedirect(auth, googleProvider);
    throw new Error('Redirecting to Google...');
  }

  // iOS and Desktop - try popup first
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error: unknown) {
    const firebaseError = error as { code?: string };
    console.log('Popup auth error:', firebaseError.code);

    // If popup fails, fall back to redirect
    if (firebaseError.code === 'auth/popup-closed-by-user' ||
        firebaseError.code === 'auth/popup-blocked' ||
        firebaseError.code === 'auth/cancelled-popup-request') {
      console.log('Popup failed, falling back to redirect...');
      await signInWithRedirect(auth, googleProvider);
      throw new Error('Redirecting to Google...');
    }
    throw error;
  }
}

// Handle redirect result on page load
export async function handleRedirectResult(): Promise<FirebaseUser | null> {
  try {
    const result = await getRedirectResult(auth);
    return result?.user || null;
  } catch (error) {
    console.error('Error handling redirect result:', error);
    return null;
  }
}

export async function getIdToken(user: FirebaseUser): Promise<string> {
  return user.getIdToken();
}

export async function firebaseSignOut(): Promise<void> {
  await signOut(auth);
}

export function onFirebaseAuthStateChanged(callback: (user: FirebaseUser | null) => void) {
  return onAuthStateChanged(auth, callback);
}

export { auth };
export type { FirebaseUser };
