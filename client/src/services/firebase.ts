import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
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

export async function signInWithGoogle(): Promise<FirebaseUser> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
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
