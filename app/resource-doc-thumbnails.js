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

// Short uppercase badge for a file's type ("PDF", "DOCX", "XLSX"), shown
// on document cards. Normalizes the handful of extensions that have two
// spellings so a .jpeg and a .jpg don't render as two different badges;
// anything unrecognized just uses its own extension, which is almost
// always what a teacher would expect to see anyway.
const TYPE_LABEL_ALIASES = {
  jpeg: 'JPG',
  htm: 'HTML',
  tif: 'TIFF',
  yml: 'YAML',
};

export function fileTypeLabel(filename) {
  const parts = (filename || '').toLowerCase().split('.');
  if (parts.length < 2) return 'FILE';
  const ext = parts.pop();
  if (!ext) return 'FILE';
  // Cap the length so a pathological "document.verylongextension" can't
  // blow out the fixed-width badge in the card layout.
  return (TYPE_LABEL_ALIASES[ext] || ext.toUpperCase()).slice(0, 5);
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

// Renders every page of a PDF to a PNG data URL and wraps them in a minimal
// print-only HTML document (one page per sheet, centered/scaled, no browser
// chrome). Used so printing a PDF never depends on the browser's own
// PDF-viewer print pipeline — Chrome's built-in viewer print has been seen
// to render some documents' orientation incorrectly (rotated/cut off) on
// some Windows machines while the same file prints fine elsewhere. Doing
// the rendering ourselves gives identical, predictable output everywhere.
const PDF_PRINT_SCALE = 2; // ~144 DPI at PDF's native page size — legible without huge data URLs

export async function renderPdfPrintHtml(signedUrl) {
  const pdfjsLib = await loadPdfJs();
  const pdf = await pdfjsLib.getDocument(signedUrl).promise;

  let landscapeCount = 0;
  const pageHtmls = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: PDF_PRINT_SCALE });
    if (viewport.width > viewport.height) landscapeCount++;

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    pageHtmls.push('<div class="pg"><img src="' + canvas.toDataURL('image/png') + '"></div>');
  }

  const landscape = landscapeCount > pdf.numPages / 2;
  return '<!DOCTYPE html><html><head><style>' +
    '@page{size:' + (landscape ? 'landscape' : 'portrait') + ';margin:0;}' +
    'html,body{margin:0;}' +
    '.pg{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;box-sizing:border-box;page-break-after:always;}' +
    '.pg:last-child{page-break-after:auto;}' +
    '.pg img{max-width:100%;max-height:100%;object-fit:contain;}' +
    '</style></head><body>' + pageHtmls.join('') + '</body></html>';
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
