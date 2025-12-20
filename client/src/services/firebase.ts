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

// Detect iOS/iPadOS - these devices have issues with popup auth
function isIOSDevice(): boolean {
  const ua = navigator.userAgent;
  // Check for iPhone, iPad, or iPod
  // Also check for iPad on iOS 13+ which reports as Mac
  return /iPhone|iPad|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export async function signInWithGoogle(): Promise<FirebaseUser> {
  if (isIOSDevice()) {
    // On iOS, use redirect - popup is unreliable
    // This will navigate away, and handleRedirectResult will be called on return
    await signInWithRedirect(auth, googleProvider);
    // This won't be reached - page navigates away
    throw new Error('Redirecting to Google...');
  } else {
    // On desktop, use popup
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  }
}

// Handle redirect result when returning from Google auth
export async function handleRedirectResult(): Promise<FirebaseUser | null> {
  try {
    const result = await getRedirectResult(auth);
    if (result) {
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

export function onFirebaseAuthStateChanged(callback: (user: FirebaseUser | null) => void) {
  return onAuthStateChanged(auth, callback);
}

export { auth };
export type { FirebaseUser };
