/**
 * Normalize a stored image value into a valid <img src>.
 *
 * Image fields arrive in three shapes since the R2 migration:
 *   - data:image/...;base64,XXX  → pass through
 *   - https://images.…/key.jpg   → pass through (browser fetches it)
 *   - raw base64 string          → wrap as a data: URI
 *
 * Checking only startsWith('data:') and wrapping everything else wraps an
 * R2 URL into `data:image/jpeg;base64,https://…`, which breaks the <img>
 * entirely — the bug that blanked every orders-page thumbnail once covers
 * became URL-only. Mirror of the server-side toImgSrc in images.js.
 */
export function toImgSrc(img: string | null | undefined, mime: string = 'image/jpeg'): string | null {
  if (!img || typeof img !== 'string') return null;
  if (img.startsWith('data:') || /^https?:\/\//i.test(img)) return img;
  return `data:${mime};base64,${img}`;
}
