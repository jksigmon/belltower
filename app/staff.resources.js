// staff.resources.js
// Staff-portal Resources tab (the read-only view of the admin Operations
// Manual): document list, thumbnail grid, and the view/print overlay.
//
// Extracted verbatim from staff.html, where it lived inline. Two things
// changed in the move, both deliberate:
//   1. The two `window.staff*Resource` globals that existed only so
//      generated `onclick="..."` strings could find them are gone,
//      replaced by delegated listeners on the list container.
//   2. A failed load no longer renders as "No documents available yet"
//      (see renderList) -- that conflation hid a real staff-facing bug.

import { supabase } from '/app/admin.supabase.js?v=2';
import { esc, debounce, categoryChipStyle, fmtRelativeDate, isToday } from '/app/admin.shared.js?v=3';
import {
  fileKind,
  fileTypeLabel,
  tileIconSvg,
  getThumbnailUrl,
  withThumbnailConcurrency,
  renderPdfPrintHtml,
} from '/app/resource-doc-thumbnails.js?v=2';

const BUCKET = 'resource-docs';
// Intentionally the same localStorage key the admin Operations Manual tab
// uses, so a list/grid preference carries across both surfaces.
const VIEW_MODE_KEY = 'rdViewMode';
const RECENT_LIMIT = 5;

const ICON_BOOKMARK_OUTLINE = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
const ICON_BOOKMARK_FILLED  = '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
const ICON_PIN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';

let profile = null;
let docs = [];
let categories = [];
let bookmarkIds = new Set();
let viewMode = localStorage.getItem(VIEW_MODE_KEY) === 'grid' ? 'grid' : 'list';
let searchTerm = '';
let categoryFilter = '';   // '' = all, or a category id, or UNCATEGORIZED
const UNCATEGORIZED = '__uncategorized__';

/* ===============================
   ENTRY POINT
================================ */
export async function initStaffResources(p) {
  profile = p;
  await Promise.all([loadCategories(), loadBookmarks()]);
  await loadDocs();
}

/* ===============================
   LOAD + RENDER
================================ */
async function loadDocs() {
  const list = document.getElementById('staffResourcesList');
  if (!list) return;

  list.innerHTML = '<p class="muted" style="text-align:center;padding:24px 0;">Loading…</p>';

  const { data, error } = await supabase
    .from('resource_documents')
    .select('id, title, file_path, original_filename, updated_at, category_id')
    .eq('school_id', profile.school_id)
    .order('sort_order')
    .order('title');

  if (error) {
    // Distinct from the empty state on purpose. These are not the same
    // situation to a teacher -- "nothing here yet" is normal and needs no
    // action, while a failed query means the documents exist and they
    // can't reach them, which is worth reporting. Collapsing the two hid
    // exactly that failure the last time it happened.
    console.error('loadStaffResources', error);
    docs = [];
    list.innerHTML =
      '<p class="muted" style="text-align:center;padding:24px 0;">' +
      "Couldn't load documents. Refresh the page, and let an administrator " +
      'know if it keeps happening.</p>';
    return;
  }

  docs = data ?? [];
  renderAll();
  wireViewToggle();
  wireSearch();
  wireListActions();
}

async function loadCategories() {
  const { data, error } = await supabase
    .from('resource_document_categories')
    .select('id, name, color, sort_order')
    .eq('school_id', profile.school_id)
    .order('sort_order')
    .order('name');

  if (error) { console.error('loadCategories', error); categories = []; return; }
  categories = data ?? [];
}

// RLS restricts this table to the caller's own rows, so no filter is
// needed (or possible) here -- see resource_doc_bookmarks_own.
async function loadBookmarks() {
  const { data, error } = await supabase
    .from('resource_document_bookmarks')
    .select('document_id')
    .order('sort_order');

  if (error) { console.error('loadBookmarks', error); bookmarkIds = new Set(); return; }
  bookmarkIds = new Set((data ?? []).map(function (b) { return b.document_id; }));
}

function categoryById(id) {
  return categories.find(function (c) { return c.id === id; }) || null;
}

function visibleDocs() {
  return docs.filter(function (d) {
    if (categoryFilter === UNCATEGORIZED) {
      if (d.category_id) return false;
    } else if (categoryFilter && d.category_id !== categoryFilter) {
      return false;
    }
    if (!searchTerm) return true;
    return (d.title || '').toLowerCase().indexOf(searchTerm) !== -1 ||
           (d.original_filename || '').toLowerCase().indexOf(searchTerm) !== -1;
  });
}

function renderAll() {
  renderCategoryNav();
  renderRecent();
  renderPinned();
  renderList();
}

function categoryChipHtml(categoryId) {
  const cat = categoryById(categoryId);
  if (!cat) return '';
  const style = categoryChipStyle(cat.color, cat.id);
  return '<span class="rd-cat-chip" style="background:' + style.bg + ';color:' + style.fg + ';">' +
    esc(cat.name) + '</span>';
}

function typeBadgeHtml(d) {
  return '<span class="rd-type-badge">' + esc(fileTypeLabel(d.original_filename)) + '</span>';
}

function bookmarkBtnHtml(d) {
  const pinned = bookmarkIds.has(d.id);
  return '<button class="rd-bookmark-btn' + (pinned ? ' pinned' : '') + '"' +
    ' data-bookmark="' + esc(d.id) + '"' +
    ' aria-pressed="' + (pinned ? 'true' : 'false') + '"' +
    ' title="' + (pinned ? 'Remove from pinned' : 'Pin to top') + '"' +
    ' aria-label="' + (pinned ? 'Remove from pinned' : 'Pin to top') + '">' +
    (pinned ? ICON_BOOKMARK_FILLED : ICON_BOOKMARK_OUTLINE) +
    '</button>';
}

/* ===============================
   SIDEBAR
================================ */
function renderCategoryNav() {
  const nav = document.getElementById('staffRdCategories');
  if (!nav) return;

  // Counts ignore the active category but respect the search term, so the
  // sidebar answers "where else would my search have hit?" rather than
  // going all-zeros-but-one the moment a category is selected.
  const searched = docs.filter(function (d) {
    if (!searchTerm) return true;
    return (d.title || '').toLowerCase().indexOf(searchTerm) !== -1 ||
           (d.original_filename || '').toLowerCase().indexOf(searchTerm) !== -1;
  });

  const items = [{ id: '', name: 'All Documents', count: searched.length, dot: null }];

  categories.forEach(function (c) {
    items.push({
      id: c.id,
      name: c.name,
      count: searched.filter(function (d) { return d.category_id === c.id; }).length,
      dot: categoryChipStyle(c.color, c.id).fg,
    });
  });

  // Only surfaced when something is actually uncategorized -- an empty
  // bucket in the sidebar just looks like a bug.
  const uncat = searched.filter(function (d) { return !d.category_id; }).length;
  if (uncat) items.push({ id: UNCATEGORIZED, name: 'Uncategorized', count: uncat, dot: '#cbd5e1' });

  nav.innerHTML = items.map(function (it) {
    return '<button class="rd-cat-item' + (categoryFilter === it.id ? ' active' : '') + '"' +
      ' data-cat="' + esc(it.id) + '">' +
      (it.dot ? '<span class="rd-cat-dot" style="background:' + it.dot + ';"></span>' : '') +
      '<span class="rd-cat-item-name">' + esc(it.name) + '</span>' +
      '<span class="rd-cat-item-count">' + it.count + '</span>' +
    '</button>';
  }).join('');
}

function renderRecent() {
  const block = document.getElementById('staffRdRecentBlock');
  const wrap = document.getElementById('staffRdRecent');
  if (!block || !wrap) return;

  // Not filtered by category or search on purpose: this is a standing
  // "what changed lately" list, not a view of the current query.
  const recent = docs.slice()
    .filter(function (d) { return d.updated_at; })
    .sort(function (a, b) { return new Date(b.updated_at) - new Date(a.updated_at); })
    .slice(0, RECENT_LIMIT);

  if (!recent.length) { block.hidden = true; return; }
  block.hidden = false;

  wrap.innerHTML = recent.map(function (d) {
    return '<button class="rd-recent-item" data-open="' + esc(d.id) + '">' +
      '<div class="rd-recent-body">' +
        '<div class="rd-recent-title">' + esc(d.title) + '</div>' +
        '<div class="rd-recent-when">' + esc(fmtRelativeDate(d.updated_at)) + '</div>' +
      '</div>' +
      (isToday(d.updated_at) ? '<span class="rd-recent-dot"></span>' : '') +
    '</button>';
  }).join('');
}

/* ===============================
   PINNED STRIP
================================ */
function renderPinned() {
  const wrap = document.getElementById('staffRdPinned');
  if (!wrap) return;

  // Deleted documents can't appear here: the bookmark rows are removed by
  // the ON DELETE CASCADE on resource_document_bookmarks.document_id, so
  // this list only ever contains documents that still exist.
  const pinned = docs.filter(function (d) { return bookmarkIds.has(d.id); });

  if (!pinned.length) { wrap.hidden = true; wrap.innerHTML = ''; return; }
  wrap.hidden = false;

  wrap.innerHTML =
    '<div class="rd-pinned-head">' + ICON_PIN +
      '<span class="rd-pinned-title">My Pinned Documents</span>' +
      '<span class="rd-pinned-count">' + pinned.length + '</span>' +
    '</div>' +
    '<div class="rd-pinned-rail">' + pinned.map(tileHtml).join('') + '</div>';

  loadThumbnails(pinned);
}

// Word/Excel/etc. have no in-browser viewer, so those get a plain download
// link rather than pretending to protect a file type the viewer can't render.
function actionFor(d) {
  return fileKind(d.original_filename) === 'other'
    ? { label: 'Download', action: 'download' }
    : { label: 'View &amp; Print', action: 'view' };
}

function tileHtml(d) {
  const kind = fileKind(d.original_filename);
  const act = actionFor(d);
  return '<div class="rd-doc-tile" data-id="' + esc(d.id) + '">' +
    bookmarkBtnHtml(d) +
    '<div class="rd-doc-tile-icon rd-doc-tile-icon--' + kind + '" data-thumb-icon="' + esc(d.id) + '">' + tileIconSvg(kind) + '</div>' +
    '<div class="rd-doc-tile-title">' + esc(d.title) + '</div>' +
    '<div class="rd-doc-tile-meta">' + categoryChipHtml(d.category_id) + typeBadgeHtml(d) + '</div>' +
    '<div class="rd-doc-tile-actions">' +
      '<button class="btn btn-sm btn-primary" data-id="' + esc(d.id) + '" data-action="' + act.action + '">' + act.label + '</button>' +
    '</div>' +
  '</div>';
}

function rowHtml(d) {
  const act = actionFor(d);
  return '<div class="rd-doc-row" data-id="' + esc(d.id) + '">' +
    bookmarkBtnHtml(d) +
    '<div class="rd-doc-row-main">' +
      '<div class="rd-doc-row-title">' + esc(d.title) + '</div>' +
      '<div class="rd-doc-row-meta">' + categoryChipHtml(d.category_id) + typeBadgeHtml(d) + '</div>' +
    '</div>' +
    '<button class="btn btn-sm btn-primary" data-id="' + esc(d.id) + '" data-action="' + act.action + '">' + act.label + '</button>' +
  '</div>';
}

function renderList() {
  const list = document.getElementById('staffResourcesList');
  if (!list) return;

  const data = visibleDocs();

  if (!data.length) {
    const filtering = searchTerm || categoryFilter;
    list.innerHTML = '<p class="muted" style="text-align:center;padding:24px 0;">' +
      (docs.length
        ? (filtering ? 'No documents match your search.' : 'No documents available yet.')
        : 'No documents available yet.') + '</p>';
    return;
  }

  if (viewMode === 'grid') {
    list.innerHTML = '<div class="rd-doc-tiles">' + data.map(tileHtml).join('') + '</div>';
    loadThumbnails(data);
    return;
  }

  list.innerHTML = data.map(rowHtml).join('');
}

async function loadThumbnails(data) {
  const candidates = data.filter(function (d) { return fileKind(d.original_filename) !== 'other'; });
  if (!candidates.length) return;

  await withThumbnailConcurrency(candidates, 3, async function (d) {
    const url = await getThumbnailUrl(supabase, BUCKET, d);
    if (!url) return;
    // querySelectorAll, not querySelector: a pinned document appears both
    // in the pinned rail and in the main grid, so the same id legitimately
    // matches twice and only filling the first would leave the other tile
    // showing a generic icon forever.
    document.querySelectorAll('.rd-doc-tile-icon[data-thumb-icon="' + CSS.escape(d.id) + '"]')
      .forEach(function (iconEl) {
        iconEl.innerHTML = '<img src="' + esc(url) + '" alt="" />';
      });
  });
}

/* ===============================
   WIRING
================================ */
// Delegated from the container, which survives every re-render -- so this
// binds once rather than re-binding a listener per button per render.
function wireListActions() {
  // One listener on a stable ancestor covers the main list, the pinned
  // rail, and the sidebar at once -- all three re-render constantly, and
  // binding per-element would leak a listener on every render.
  const root = document.getElementById('resources');
  if (!root || root.dataset.rdWired) return;
  root.dataset.rdWired = '1';

  root.addEventListener('click', function (e) {
    const bookmarkBtn = e.target.closest('[data-bookmark]');
    if (bookmarkBtn) { toggleBookmark(bookmarkBtn.dataset.bookmark, bookmarkBtn); return; }

    const catBtn = e.target.closest('[data-cat]');
    if (catBtn) {
      categoryFilter = catBtn.dataset.cat;
      renderCategoryNav();
      renderList();
      return;
    }

    const recentBtn = e.target.closest('[data-open]');
    if (recentBtn) {
      const doc = docs.find(function (d) { return d.id === recentBtn.dataset.open; });
      if (doc) openDoc(doc);
      return;
    }

    const actionBtn = e.target.closest('button[data-action]');
    if (actionBtn) {
      const doc = docs.find(function (d) { return d.id === actionBtn.dataset.id; });
      if (doc) openDoc(doc);
    }
  });
}

function openDoc(doc) {
  if (actionFor(doc).action === 'download') downloadDoc(doc);
  else viewDoc(doc);
}

/* ===============================
   BOOKMARKS
================================ */
async function toggleBookmark(docId, btn) {
  const pinning = !bookmarkIds.has(docId);

  // Optimistic: flip local state and repaint immediately, then reconcile.
  // Pinning is a low-stakes personal preference -- waiting on a round trip
  // before the icon responds feels broken for something this small.
  if (pinning) bookmarkIds.add(docId);
  else bookmarkIds.delete(docId);
  if (btn) btn.disabled = true;
  renderPinned();
  renderList();

  const { error } = pinning
    ? await supabase.from('resource_document_bookmarks').insert({
        profile_id: profile.id,
        document_id: docId,
        sort_order: bookmarkIds.size,
      })
    : await supabase.from('resource_document_bookmarks')
        .delete()
        .eq('profile_id', profile.id)
        .eq('document_id', docId);

  if (error) {
    console.error('toggleBookmark', error);
    // Put the local state back so the icon matches the database again.
    if (pinning) bookmarkIds.delete(docId);
    else bookmarkIds.add(docId);
    renderPinned();
    renderList();
    alert(pinning
      ? 'Could not pin this document. Please try again.'
      : 'Could not remove this pin. Please try again.');
  }
}

function wireSearch() {
  const input = document.getElementById('staffRdSearch');
  if (!input || input.dataset.wired) return;
  input.dataset.wired = '1';
  input.addEventListener('input', debounce(function (e) {
    searchTerm = e.target.value.trim().toLowerCase();
    // The sidebar counts are search-aware, so they have to repaint too --
    // otherwise they'd keep showing totals for the unfiltered list.
    renderCategoryNav();
    renderList();
  }, 200));
}

function wireViewToggle() {
  const toggle = document.getElementById('staffRdViewToggle');
  if (!toggle || toggle.dataset.wired) {
    updateViewButtons();
    return;
  }
  toggle.dataset.wired = '1';
  toggle.addEventListener('click', function (e) {
    const btn = e.target.closest('.rd-view-btn');
    if (!btn) return;
    viewMode = btn.dataset.view === 'grid' ? 'grid' : 'list';
    localStorage.setItem(VIEW_MODE_KEY, viewMode);
    updateViewButtons();
    renderList();
  });
  updateViewButtons();
}

function updateViewButtons() {
  document.querySelectorAll('#staffRdViewToggle .rd-view-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.view === viewMode);
  });
}

/* ===============================
   VIEW / DOWNLOAD
================================ */
// { kind, signedUrl } for whatever's currently open, so the Print button
// can build a same-origin copy without re-signing. Cleared on close.
let viewerCurrentDoc = null;

function waitForFrameLoad(frame, timeoutMs) {
  return new Promise(function (resolve) {
    let done = false;
    function finish(ok) { if (!done) { done = true; resolve(ok); } }
    frame.addEventListener('load', function () { finish(true); }, { once: true });
    setTimeout(function () { finish(false); }, timeoutMs);
  });
}

/**
 * Signing a URL fails for two very different reasons: the document was
 * deleted by an admin while this page sat open, or something transient
 * went wrong. Telling them apart matters -- "try again" is useless advice
 * for a file that no longer exists, and the stale tile would sit there
 * until a manual refresh. So: re-check the row, and if it's genuinely
 * gone, refresh the whole view (which also drops it from the pinned
 * strip) and say so plainly.
 */
async function handleOpenFailure(doc, verb) {
  const { data: stillThere } = await supabase
    .from('resource_documents')
    .select('id')
    .eq('id', doc.id)
    .maybeSingle();

  if (stillThere) {
    alert('Could not ' + verb + ' this document. Please try again.');
    return;
  }

  await Promise.all([loadBookmarks(), loadCategories()]);
  await loadDocs();
  showNotice('"' + doc.title + '" is no longer available — an administrator removed it. '
    + 'It has been taken off this page.');
}

function showNotice(msg) {
  const main = document.querySelector('#resources .rd-main');
  if (!main) return;
  main.querySelector('.rd-notice')?.remove();

  const el = document.createElement('div');
  el.className = 'rd-notice';
  el.innerHTML = '<div class="rd-notice-body"></div>' +
    '<button class="rd-notice-close" aria-label="Dismiss">&times;</button>';
  el.querySelector('.rd-notice-body').textContent = msg;
  el.querySelector('.rd-notice-close').addEventListener('click', function () { el.remove(); });
  main.prepend(el);
}

async function viewDoc(doc) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(doc.file_path, 300);

  if (error || !data?.signedUrl) {
    await handleOpenFailure(doc, 'open');
    return;
  }

  const kind = fileKind(doc.original_filename);
  const frame = document.getElementById('resourceViewerFrame');
  frame.removeAttribute('srcdoc');
  viewerCurrentDoc = { kind: kind, signedUrl: data.signedUrl };

  // Always load the direct signed URL for viewing. Same-origin blob:/srcdoc
  // navigation (used only for printing, below) is blocked outright on some
  // school-managed devices' security policy, which broke viewing entirely
  // when we briefly used it here — this direct load is the one path that's
  // reliably worked everywhere it's been reported from.
  frame.src = kind === 'pdf' ? data.signedUrl + '#toolbar=0' : data.signedUrl;

  document.getElementById('resourceViewerTitle').textContent = doc.title;
  document.getElementById('resourceViewerOverlay').style.display = 'flex';
  document.body.classList.add('resource-viewer-open');
}

async function downloadDoc(doc) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(doc.file_path, 300, { download: doc.original_filename || true });

  if (error || !data?.signedUrl) {
    await handleOpenFailure(doc, 'download');
    return;
  }

  const a = document.createElement('a');
  a.href = data.signedUrl;
  a.download = doc.original_filename || doc.title;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function closeViewer() {
  document.getElementById('resourceViewerOverlay').style.display = 'none';
  document.getElementById('resourceViewerFrame').src = 'about:blank';
  document.getElementById('resourceViewerFrame').removeAttribute('srcdoc');
  document.body.classList.remove('resource-viewer-open');
  viewerCurrentDoc = null;
}

/* ===============================
   VIEWER CHROME
   The overlay markup is static in staff.html, and module scripts are
   deferred, so these bind once at import time exactly as they did when
   this code was inline.
================================ */
document.getElementById('resourceViewerCloseBtn')?.addEventListener('click', closeViewer);

document.getElementById('resourceViewerPrintBtn')?.addEventListener('click', async function () {
  const doc = viewerCurrentDoc;
  const frame = document.getElementById('resourceViewerFrame');
  const originalSrc = frame.src;
  const printBtn = document.getElementById('resourceViewerPrintBtn');

  // Best-effort upgrade: the visible iframe is cross-origin (Supabase
  // storage), so window.print() (the fallback below) can only rasterize
  // whatever's currently visible in its viewport — partial/off-center
  // pages, extra dark viewer chrome. PDFs are rendered to images ourselves
  // (see renderPdfPrintHtml) rather than handed to the browser's built-in
  // PDF-viewer print pipeline, which has been seen to render some
  // documents' orientation wrong (sideways/cut off) on some Windows
  // machines while the identical file prints fine elsewhere — rendering it
  // ourselves gives the same output everywhere. Images get the same
  // same-origin srcdoc treatment they've always had. Either is verified as
  // actually loaded before printing (some school-managed devices block
  // same-origin srcdoc navigation outright) — on any failure the working
  // view is restored and we fall back to window.print() rather than
  // leaving the viewer showing a blocked/blank frame.
  if (doc && (doc.kind === 'pdf' || doc.kind === 'image')) {
    const prevLabel = printBtn.textContent;
    try {
      if (doc.kind === 'pdf') {
        printBtn.textContent = 'Preparing…';
        printBtn.disabled = true;
        frame.srcdoc = await renderPdfPrintHtml(doc.signedUrl);
      } else {
        frame.srcdoc = '<!DOCTYPE html><html><head><style>' +
          'html,body{margin:0;height:100%;background:#fff;display:flex;align-items:center;justify-content:center;}' +
          'img{max-width:100%;max-height:100%;object-fit:contain;}' +
          '@media print{ @page{margin:0;} }' +
          '</style></head><body><img src="' + doc.signedUrl + '"></body></html>';
      }

      const loaded = await waitForFrameLoad(frame, 4000);
      if (!loaded) throw new Error('Print frame did not load in time');
      // Same-origin content is readable; a blocked navigation replaces it
      // with an opaque internal error page, which throws on access instead.
      void frame.contentWindow.document.title;

      frame.contentWindow.focus();
      frame.contentWindow.print();
      return;
    } catch (err) {
      console.error('Enhanced print unavailable, falling back to window.print()', err);
      frame.removeAttribute('srcdoc');
      frame.src = originalSrc;
    } finally {
      printBtn.textContent = prevLabel;
      printBtn.disabled = false;
    }
  }
  window.print();
});

// Light deterrent against right-click "Save As" on the embedded viewer —
// not foolproof (screenshots always work), matches the agreed scope.
document.getElementById('resourceViewerOverlay')?.addEventListener('contextmenu', function (e) {
  e.preventDefault();
});
