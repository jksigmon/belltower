
import { supabase } from './admin.supabase.js';
import { initPage } from './admin.auth.js';
import { DRAWERS, openDrawer, closeDrawer, showToast } from './admin.compliance.utils.js';

import {
  loadBgChecks, resetBgCache, saveBgCheck, onBgArchiveClick, wireBgFilters,
} from './admin.compliance.bg.js';

import {
  loadTemplates, loadAgreements, resetAgreementCache,
  saveTemplate, deleteTemplate, createLink, openTemplateDrawer,
  onGuardianSearchInput, saveLinkGuardian,
  applySubmittedData, dismissSubmittedData,
  wireFormFilters,
} from './admin.compliance.forms.js';

import {
  loadGrants, openGrantDrawer, saveGrant, onGrantStaffSearchInput,
} from './admin.compliance.grants.js';

let currentProfile = null;

// ── Init ──────────────────────────────────────────────────────────────
async function init() {
  const profile = await initPage({ requiredCap: 'can_manage_compliance' });
  if (!profile) return;
  currentProfile = profile;

  wireDrawers();
  wireBgFilters();
  wireFormFilters();
  wireSettings();

  document.getElementById('signOut')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = '/login.html';
  });

  document.getElementById('sideNav')?.classList.remove('hidden');
  window.addEventListener('hashchange', () => setActive(location.hash || '#bg-checks'));

  setActive(location.hash || '#bg-checks');
}

// ── Nav routing ───────────────────────────────────────────────────────
function setActive(hash) {
  const VALID = ['#bg-checks', '#templates', '#agreements', '#settings'];
  const target = VALID.includes(hash) ? hash : '#bg-checks';

  history.replaceState(null, '', target);

  const subtitleMap = {
    '#bg-checks':  'Background Checks',
    '#templates':  'Form Templates',
    '#agreements': 'Agreements',
    '#settings':   'Settings',
  };
  const subtitle = document.getElementById('pageSubtitle');
  if (subtitle) subtitle.textContent = subtitleMap[target] ?? 'Compliance';

  document.querySelectorAll('#sideNav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === target);
  });

  document.querySelectorAll('main section').forEach(s => {
    s.style.display = 'none';
  });

  const section = document.querySelector(target);
  if (section) section.style.display = 'block';

  const key = target.slice(1);
  if (key === 'bg-checks') {
    resetBgCache();
    const rSel = document.getElementById('bgRequestorFilter');
    if (rSel) { rSel.dataset.populated = ''; rSel.querySelectorAll('option:not([value=""])').forEach(o => o.remove()); }
    loadBgChecks(currentProfile);
  }
  if (key === 'templates')  loadTemplates(currentProfile);
  if (key === 'agreements') { resetAgreementCache(); loadAgreements(currentProfile); }
  if (key === 'settings')   { loadSettings(); loadGrants(currentProfile); }
}

// ── Drawer system ─────────────────────────────────────────────────────
function wireDrawers() {
  Object.entries(DRAWERS).forEach(([key, cfg]) => {
    document.getElementById(cfg.overlay)?.addEventListener('click', () => closeDrawer(key));
    cfg.close.forEach(id => document.getElementById(id)?.addEventListener('click', () => closeDrawer(key)));
  });

  document.getElementById('bgDrawerSave')?.addEventListener('click',      saveBgCheck);
  document.getElementById('bgDrawerArchive')?.addEventListener('click',   onBgArchiveClick);
  document.getElementById('tplDrawerSave')?.addEventListener('click',     saveTemplate);
  document.getElementById('tplDrawerDelete')?.addEventListener('click',   deleteTemplate);
  document.getElementById('linkDrawerSave')?.addEventListener('click',    createLink);
  document.getElementById('linkGuardianSave')?.addEventListener('click',  saveLinkGuardian);
  document.getElementById('newTemplateBtn')?.addEventListener('click',    () => openTemplateDrawer(null));
  document.getElementById('linkGuardianSearch')?.addEventListener('input', onGuardianSearchInput);

  document.getElementById('newGrantBtn')?.addEventListener('click',      openGrantDrawer);
  document.getElementById('grantDrawerSave')?.addEventListener('click',  saveGrant);
  document.getElementById('grantStaffSearch')?.addEventListener('input', onGrantStaffSearchInput);

  document.getElementById('reviewDataApply')?.addEventListener('click',   applySubmittedData);
  document.getElementById('reviewDataDismiss')?.addEventListener('click', dismissSubmittedData);
}

// ── Settings — School Logo ────────────────────────────────────────────
async function loadSettings() {
  const preview   = document.getElementById('logoPreview');
  const removeBtn = document.getElementById('logoRemoveBtn');
  if (!preview) return;

  const { data: school } = await supabase
    .from('schools')
    .select('logo_url')
    .eq('id', currentProfile.school_id)
    .single();

  if (school?.logo_url) {
    preview.src = school.logo_url;
    preview.style.display = 'block';
    if (removeBtn) removeBtn.style.display = '';
  } else {
    preview.style.display = 'none';
    if (removeBtn) removeBtn.style.display = 'none';
  }
}

function wireSettings() {
  document.getElementById('logoUploadInput')?.addEventListener('change', uploadLogo);
  document.getElementById('logoRemoveBtn')?.addEventListener('click', removeLogo);
}

async function uploadLogo(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
  if (!allowed.includes(file.type)) {
    document.getElementById('logoUploadMsg').textContent = 'Please upload a PNG, JPG, WebP, or SVG image.';
    return;
  }

  const msgEl = document.getElementById('logoUploadMsg');
  msgEl.textContent = 'Uploading…';

  const ext  = file.name.split('.').pop();
  const path = `${currentProfile.school_id}/logo.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from('school-assets')
    .upload(path, file, { upsert: true, contentType: file.type });

  if (uploadErr) { msgEl.textContent = `Upload failed: ${uploadErr.message}`; return; }

  const { data: { publicUrl } } = supabase.storage.from('school-assets').getPublicUrl(path);

  const { error: updateErr } = await supabase
    .from('schools')
    .update({ logo_url: publicUrl })
    .eq('id', currentProfile.school_id);

  if (updateErr) { msgEl.textContent = `Saved file but failed to update school record: ${updateErr.message}`; return; }

  msgEl.textContent = '';
  showToast('Logo uploaded successfully');
  await loadSettings();
  e.target.value = '';
}

async function removeLogo() {
  if (!confirm('Remove the school logo?')) return;
  await supabase.from('schools').update({ logo_url: null }).eq('id', currentProfile.school_id);
  document.getElementById('logoPreview').style.display = 'none';
  document.getElementById('logoRemoveBtn').style.display = 'none';
  showToast('Logo removed');
}

init();
