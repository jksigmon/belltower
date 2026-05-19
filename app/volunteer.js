import { supabase } from './admin.supabase.js';

// ── State ─────────────────────────────────────────────────────────────
let formData    = null;   // response from compliance_form_lookup
let signaturePad = null;
let sigMode     = 'draw'; // 'draw' | 'type'

// ── On load ───────────────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const token  = params.get('form');

if (!token) {
  showError('No form token', 'Please use the link provided by your school.');
} else {
  loadForm(token);
}

async function loadForm(token) {
  try {
    const res = await supabase.functions.invoke('compliance_form_lookup', {
      body: { token },
    });

    if (res.error || res.data?.error) {
      const msg = res.data?.error ?? res.error?.message ?? 'Unknown error';
      showError('Form unavailable', msg);
      return;
    }

    formData = res.data;
    renderForm(formData);
  } catch (err) {
    showError('Failed to load form', 'Please try again or contact the school.');
    console.error(err);
  }
}

function renderForm(data) {
  // School header
  if (data.school_logo) {
    const logoEl = document.getElementById('schoolLogo');
    logoEl.src = data.school_logo;
    logoEl.alt = data.school_name ?? '';
    logoEl.style.display = 'block';
  }
  document.getElementById('schoolName').textContent = data.school_name ?? '';

  // Form content
  document.getElementById('formTitle').textContent = data.form_title;

  const descEl = document.getElementById('formDesc');
  if (data.form_desc) {
    descEl.textContent = data.form_desc;
    descEl.style.display = '';
  }

  // Render body HTML (admin-authored, not user input — safe to use innerHTML)
  document.getElementById('formBody').innerHTML = data.body_html ?? '';

  // Set document title
  document.title = `${data.form_title} — ${data.school_name ?? 'Form'}`;

  // Show the form
  document.getElementById('stateLoading').classList.remove('visible');
  document.getElementById('formWrap').style.display = '';

  // Init signature pad
  initSignaturePad();
  wireSigModeToggle();
  wireSubmit();
}

// ── Signature Pad (Draw mode) ─────────────────────────────────────────
function initSignaturePad() {
  const canvas = document.getElementById('sigCanvas');
  if (!canvas || !window.SignaturePad) return;

  // Size canvas to match its CSS display size
  const rect = canvas.getBoundingClientRect();
  canvas.width  = rect.width  || 600;
  canvas.height = rect.height || 140;

  signaturePad = new window.SignaturePad(canvas, {
    penColor:       '#1e293b',
    backgroundColor: 'rgb(255,255,255)',
    minWidth:  1,
    maxWidth:  2.5,
  });

  signaturePad.addEventListener('beginStroke', () => {
    document.getElementById('sigCanvasHint').style.display = 'none';
  });

  signaturePad.addEventListener('endStroke', () => {
    if (signaturePad.isEmpty()) {
      document.getElementById('sigCanvasHint').style.display = '';
    }
  });

  document.getElementById('sigClearBtn')?.addEventListener('click', () => {
    signaturePad.clear();
    document.getElementById('sigCanvasHint').style.display = '';
  });

  // Resize canvas on window resize without losing drawing
  window.addEventListener('resize', () => {
    const wasEmpty = signaturePad.isEmpty();
    const saved = wasEmpty ? null : signaturePad.toDataURL();
    const r = canvas.getBoundingClientRect();
    canvas.width  = r.width  || 600;
    canvas.height = r.height || 140;
    signaturePad.clear();
    if (saved) {
      const img = new Image();
      img.onload = () => {
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      img.src = saved;
    }
  });
}

// ── Signature mode toggle ─────────────────────────────────────────────
function wireSigModeToggle() {
  document.querySelectorAll('.sig-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sigMode = btn.dataset.mode;
      document.querySelectorAll('.sig-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === sigMode));
      document.getElementById('sigDrawWrap').style.display = sigMode === 'draw' ? 'block' : 'none';
      document.getElementById('sigTypeWrap').style.display = sigMode === 'type' ? 'block' : 'none';
    });
  });

  // Live cursive preview for type mode
  const typeInput   = document.getElementById('sigTypeInput');
  const previewText = document.getElementById('sigTypePreviewText');

  typeInput?.addEventListener('input', () => {
    previewText.textContent = typeInput.value;
  });
}

// ── Get signature data URL ────────────────────────────────────────────
function getSignatureDataUrl() {
  if (sigMode === 'draw') {
    if (!signaturePad || signaturePad.isEmpty()) return null;
    return signaturePad.toDataURL('image/png');
  }

  // Type mode: render to canvas
  const text = document.getElementById('sigTypeInput')?.value?.trim();
  if (!text) return null;

  const canvas = document.getElementById('sigTypeCanvas');
  canvas.width  = 480;
  canvas.height = 100;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.font         = '700 68px "Dancing Script"';
  ctx.fillStyle    = '#1e293b';
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'left';

  // Scale text to fit within canvas
  let fontSize = 68;
  while (ctx.measureText(text).width > canvas.width - 32 && fontSize > 18) {
    fontSize -= 2;
    ctx.font = `700 ${fontSize}px "Dancing Script"`;
  }

  ctx.fillText(text, 16, canvas.height / 2);

  return canvas.toDataURL('image/png');
}

// ── Submit ────────────────────────────────────────────────────────────
function wireSubmit() {
  document.getElementById('submitBtn')?.addEventListener('click', submitForm);
}

async function submitForm() {
  const signerName  = document.getElementById('signerName')?.value.trim();
  const signerEmail = document.getElementById('signerEmail')?.value.trim();
  const errorEl     = document.getElementById('formError');
  errorEl.textContent = '';

  if (!signerName) {
    errorEl.textContent = 'Please enter your full legal name.';
    document.getElementById('signerName').focus();
    return;
  }
  if (!signerEmail || !signerEmail.includes('@')) {
    errorEl.textContent = 'Please enter a valid email address.';
    document.getElementById('signerEmail').focus();
    return;
  }

  const signatureData = getSignatureDataUrl();
  if (!signatureData) {
    errorEl.textContent = sigMode === 'draw'
      ? 'Please draw your signature in the box above.'
      : 'Please type your name to generate a signature.';
    return;
  }

  const btn = document.getElementById('submitBtn');
  btn.disabled    = true;
  btn.textContent = 'Submitting…';

  try {
    const res = await supabase.functions.invoke('compliance_form_submit', {
      body: {
        token,
        signer_name:             signerName,
        signer_email:            signerEmail,
        signature_type:          sigMode === 'type' ? 'typed' : sigMode,
        signature_data:          signatureData,
        student_name_hint:       document.getElementById('studentNameHint')?.value.trim()   || null,
        carline_tag_hint:        document.getElementById('carlineTagHint')?.value.trim()    || null,
        submitted_phone:         document.getElementById('submittedPhone')?.value.trim()    || null,
        submitted_relationship:  document.getElementById('submittedRelationship')?.value    || null,
      },
    });

    if (res.error || res.data?.error) {
      const errData = res.data ?? {};

      // Duplicate submission — friendly message
      if (errData.error === 'duplicate') {
        errorEl.textContent = errData.message
          ?? 'A signed agreement already exists for this email address.';
        btn.disabled    = false;
        btn.textContent = 'Submit Signed Agreement';
        return;
      }

      errorEl.textContent = errData.error ?? res.error?.message ?? 'Submission failed. Please try again.';
      btn.disabled    = false;
      btn.textContent = 'Submit Signed Agreement';
      return;
    }

    // Success
    document.getElementById('formWrap').style.display = 'none';
    const successBody = document.getElementById('stateSuccessBody');
    successBody.textContent = `Your agreement has been signed and recorded (${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}). You may close this page.`;
    document.getElementById('stateSuccess').classList.add('visible');
    document.title = 'Agreement Signed';

  } catch (err) {
    console.error(err);
    errorEl.textContent = 'An unexpected error occurred. Please try again.';
    btn.disabled    = false;
    btn.textContent = 'Submit Signed Agreement';
  }
}

// ── Error screen ──────────────────────────────────────────────────────
function showError(title, body) {
  document.getElementById('stateLoading').classList.remove('visible');
  document.getElementById('stateErrorTitle').textContent = title;
  document.getElementById('stateErrorBody').textContent  = body;
  document.getElementById('stateError').classList.add('visible');
}
