/**
 * Page rasteriser for the book preview (docs/decisions.md 2026-10-28 "Book preview").
 *
 * Turns the print PDF into one JPEG per page, in PDF order, so the preview is the printed
 * file itself rather than a second drawing of it. mupdf is a WASM build of MuPDF: it needs no
 * system package on Railway (the Dockerfile has none for PDF rendering). It is ESM-only, so it is
 * loaded with a dynamic import. Pages are rendered one at a time and destroyed straight away to
 * keep the WASM heap small.
 */

const PREVIEW_PAGE_HEIGHT_PX = 1200;   // every page, cover spread included, is rendered this tall
const PREVIEW_JPEG_QUALITY = 82;

let mupdfPromise = null;
const loadMupdf = () => (mupdfPromise ||= import('mupdf'));

/**
 * @param {Buffer} pdfBuffer
 * @param {{ onPage?: (index:number, total:number) => void }} [opts]
 * @returns {AsyncGenerator<{index:number, total:number, width:number, height:number, jpeg:Buffer}>}
 *   one item per PDF page, in PDF order (a generator so the caller can upload each page before the next is drawn)
 */
async function* rasterisePdfPages(pdfBuffer) {
  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) throw new Error('pdfRaster: empty PDF');
  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
  try {
    const total = doc.countPages();
    for (let index = 0; index < total; index++) {
      const page = doc.loadPage(index);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        const scale = PREVIEW_PAGE_HEIGHT_PX / (y1 - y0);
        const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
        try {
          yield { index, total, width: pix.getWidth(), height: pix.getHeight(), jpeg: Buffer.from(pix.asJPEG(PREVIEW_JPEG_QUALITY, false)) };
        } finally { pix.destroy(); }
      } finally { page.destroy(); }
    }
  } finally { doc.destroy(); }
}

module.exports = { rasterisePdfPages, PREVIEW_PAGE_HEIGHT_PX };
