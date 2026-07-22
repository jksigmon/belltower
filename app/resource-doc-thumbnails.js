// resource-doc-thumbnails.js
// Shared PDF/image thumbnail generation for the admin Operations Manual
// tab and the staff Resources page — keeps pdf.js loading, signed-URL
// fetching, and the in-memory render cache in one place so both surfaces
// stay in sync and don't duplicate the (nontrivial) rendering logic.

const PDFJS_VERSION = '4.7.76';
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];

export function fileKind(filename) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  return 'other';
}

export const TILE_ICON_PDF = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
export const TILE_ICON_IMAGE = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;

export function tileIconSvg(kind) {
  return kind === 'image' ? TILE_ICON_IMAGE : TILE_ICON_PDF;
}

// pdf.js is only fetched the first time a PDF thumbnail is actually needed
// (i.e. the first time someone switches to grid view), not on every page load.
let pdfjsLibPromise = null;
function loadPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import(`https://esm.sh/pdfjs-dist@${PDFJS_VERSION}/build/pdf.mjs`).then(mod => {
      mod.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.mjs`;
      return mod;
    });
  }
  return pdfjsLibPromise;
}

// Keyed by `${id}:${updated_at}` so replacing a file invalidates its cached
// thumbnail without needing an explicit cache-clear call anywhere.
const thumbCache = new Map();

/**
 * Returns a data URL (rendered PDF page 1) or signed URL (image files) to
 * use as a thumbnail, or null for 'other' kinds / on any render failure —
 * callers should fall back to a generic file icon on null.
 */
export async function getThumbnailUrl(supabase, bucket, doc) {
  const kind = fileKind(doc.original_filename);
  if (kind === 'other') return null;

  const cacheKey = `${doc.id}:${doc.updated_at ?? ''}`;
  if (thumbCache.has(cacheKey)) return thumbCache.get(cacheKey);

  const { data: signed, error: signErr } = await supabase.storage
    .from(bucket)
    .createSignedUrl(doc.file_path, 300);
  if (signErr || !signed?.signedUrl) return null;

  if (kind === 'image') {
    thumbCache.set(cacheKey, signed.signedUrl);
    return signed.signedUrl;
  }

  try {
    const pdfjsLib = await loadPdfJs();
    const pdf = await pdfjsLib.getDocument(signed.signedUrl).promise;
    const page = await pdf.getPage(1);
    const unscaled = page.getViewport({ scale: 1 });
    const scale = 200 / unscaled.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    thumbCache.set(cacheKey, dataUrl);
    return dataUrl;
  } catch (err) {
    console.error('Resource document thumbnail render failed', doc.id, err);
    return null;
  }
}

// Runs `worker` over `items` with at most `limit` in flight at once — keeps
// a grid of 20+ PDFs from firing 20 simultaneous fetch+render jobs at once.
export async function withThumbnailConcurrency(items, limit, worker) {
  const queue = [...items];
  const runners = new Array(Math.min(limit, queue.length)).fill(0).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}
