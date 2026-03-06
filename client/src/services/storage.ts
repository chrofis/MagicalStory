/**
 * Storage Utility with Fallbacks
 *
 * Handles localStorage with fallbacks for:
 * - iPhone Safari private mode (localStorage blocked)
 * - Browsers with localStorage disabled
 * - Storage quota exceeded
 *
 * Fallback order: localStorage -> sessionStorage -> memory
 */

// In-memory fallback storage
const memoryStorage: Record<string, string> = {};

// Track which storage is available
let storageType: 'localStorage' | 'sessionStorage' | 'memory' = 'localStorage';
let storageChecked = false;

/**
 * Check if localStorage is available and working
 */
function checkStorageAvailability(): void {
  if (storageChecked) return;
  storageChecked = true;

  const testKey = '__storage_test__';

  // Try localStorage first
  try {
    localStorage.setItem(testKey, testKey);
    localStorage.removeItem(testKey);
    storageType = 'localStorage';
    return;
  } catch {
    console.warn('localStorage not available, trying sessionStorage');
  }

  // Try sessionStorage as fallback
  try {
    sessionStorage.setItem(testKey, testKey);
    sessionStorage.removeItem(testKey);
    storageType = 'sessionStorage';
    console.warn('Using sessionStorage as fallback (session will not persist)');
    return;
  } catch {
    console.warn('sessionStorage not available, using memory storage');
  }

  // Fall back to memory storage
  storageType = 'memory';
  console.warn('Using memory storage (session will be lost on page refresh)');
}

/**
 * Get the active storage mechanism
 */
function getStorage(): Storage | null {
  checkStorageAvailability();

  if (storageType === 'localStorage') {
    return localStorage;
  } else if (storageType === 'sessionStorage') {
    return sessionStorage;
  }
  return null;
}

/**
 * Get an item from storage
 */
export function getItem(key: string): string | null {
  checkStorageAvailability();

  const storage = getStorage();
  if (storage) {
    try {
      return storage.getItem(key);
    } catch {
      // Storage access failed, try memory
    }
  }

  return memoryStorage[key] ?? null;
}

/**
 * Set an item in storage
 */
export function setItem(key: string, value: string): boolean {
  checkStorageAvailability();

  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(key, value);
      return true;
    } catch (e) {
      console.warn(`Failed to save to ${storageType}:`, e);
      // Fall through to memory storage
    }
  }

  // Always save to memory as backup
  memoryStorage[key] = value;
  return storageType === 'memory';
}

/**
 * Remove an item from storage
 */
export function removeItem(key: string): void {
  checkStorageAvailability();

  const storage = getStorage();
  if (storage) {
    try {
      storage.removeItem(key);
    } catch {
      // Ignore errors
    }
  }

  delete memoryStorage[key];
}

/**
 * Clear all auth-related storage
 */
export function clearAuthStorage(): void {
  const authKeys = [
    'auth_token',
    'current_user',
    'impersonation_state',
    'auth_redirect_url',
    'pendingStoryGeneration',
    'developer_mode', // Clear developer mode on logout to prevent non-admins from seeing dev features
  ];

  authKeys.forEach(key => removeItem(key));
}

/**
 * Get the current storage type being used
 */
export function getStorageType(): string {
  checkStorageAvailability();
  return storageType;
}

/**
 * Check if persistent storage is available
 */
export function isPersistentStorage(): boolean {
  checkStorageAvailability();
  return storageType === 'localStorage';
}

// Storage keys constants
export const STORAGE_KEYS = {
  AUTH_TOKEN: 'auth_token',
  CURRENT_USER: 'current_user',
  IMPERSONATION_STATE: 'impersonation_state',
  AUTH_REDIRECT_URL: 'auth_redirect_url',
  PENDING_STORY_GENERATION: 'pendingStoryGeneration',
  LANGUAGE: 'magicalstory_language',
  STORIES_SELECTED: 'mystories_selected',
} as const;

export default {
  getItem,
  setItem,
  removeItem,
  clearAuthStorage,
  getStorageType,
  isPersistentStorage,
  STORAGE_KEYS,
};
