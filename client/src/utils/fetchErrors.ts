/**
 * Returns true when an error from a fetch() call represents an in-flight
 * request that was cancelled due to browser navigation (SPA route change,
 * tab close, etc.) rather than a real failure.
 *
 * These surface two ways in Chromium:
 *   - AbortError (from explicit AbortController or auto-abort on unmount)
 *   - TypeError "Failed to fetch" (network layer cancelled the request)
 *
 * Call sites should log these at `debug` level; real network errors keep
 * their `error`-level log so they still surface in Sentry / devtools.
 */
export function isNavigationAbort(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof TypeError && /failed to fetch/i.test(error.message)) return true;
  return false;
}
