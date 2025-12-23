import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  browserPopupRedirectResolver,
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

// Add prompt to force account selection
googleProvider.setCustomParameters({
  prompt: 'select_account'
});

export async function signInWithGoogle(): Promise<FirebaseUser> {
  try {
    // Try popup first - works on most browsers
    const result = await signInWithPopup(auth, googleProvider, browserPopupRedirectResolver);
    return result.user;
  } catch (error: unknown) {
    const firebaseError = error as { code?: string; message?: string };
    console.error('Popup sign-in failed:', firebaseError.code, firebaseError.message);

    // If popup was blocked or failed, try redirect
    if (firebaseError.code === 'auth/popup-blocked' ||
        firebaseError.code === 'auth/popup-closed-by-user' ||
        firebaseError.code === 'auth/cancelled-popup-request') {
      console.log('Popup failed, trying redirect...');
      await signInWithRedirect(auth, googleProvider);
      throw new Error('Redirecting to Google...');
    }

    throw error;
  }
}

// Handle redirect result when returning from Google auth
export async function handleRedirectResult(): Promise<FirebaseUser | null> {
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
  await signOut(auth);
}

export { auth };
export type { FirebaseUser };
