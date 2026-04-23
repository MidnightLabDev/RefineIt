// ─── State ────────────────────────────────────────────────────────────────────
let currentStep = 0;
let activeProvider = 'openrouter';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const steps    = Array.from(document.querySelectorAll('.ob-step'));
const dots     = Array.from(document.querySelectorAll('.dot'));
const provTabs = Array.from(document.querySelectorAll('.ob-tab'));
const panels   = Array.from(document.querySelectorAll('.ob-panel'));

const step1Status = document.getElementById('step1Status');

// ─── Step navigation ──────────────────────────────────────────────────────────
function goTo(n) {
  steps.forEach((s, i) => s.classList.toggle('active', i === n));
  dots.forEach((d, i) => d.classList.toggle('active', i === n));
  currentStep = n;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.getElementById('step0Next').addEventListener('click', () => goTo(1));
document.getElementById('step1Back').addEventListener('click', () => goTo(0));

document.getElementById('step1Next').addEventListener('click', async () => {
  const { key, model } = getActiveKeyAndModel();

  if (!key.trim()) {
    setStep1Status('Please paste your API key first.', 'error');
    return;
  }

  // Save to chrome.storage.sync
  const saveData = { activeProvider };
  if (activeProvider === 'openrouter') {
    saveData.openRouterApiKey = key.trim();
    saveData.orModel = model;
  } else if (activeProvider === 'openai') {
    saveData.openAiApiKey = key.trim();
    saveData.oaiModel = model;
  } else if (activeProvider === 'gemini') {
    saveData.geminiApiKey = key.trim();
    saveData.gemModel = model;
  }

  try {
    await chrome.storage.sync.set(saveData);
    // Mark onboarding as complete
    await chrome.storage.sync.set({ onboardingDone: true });
    setStep1Status('Saved!', 'success');
    setTimeout(() => goTo(2), 500);
  } catch (err) {
    setStep1Status('Could not save: ' + (err.message || 'Unknown error'), 'error');
  }
});

document.getElementById('step2Done').addEventListener('click', async () => {
  // Ensure onboarding flag is set even if they skipped step 1
  await chrome.storage.sync.set({ onboardingDone: true }).catch(() => {});
  window.close();
});

// ─── Provider tab switching ───────────────────────────────────────────────────
provTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    activeProvider = tab.dataset.prov;
    provTabs.forEach(t => t.classList.toggle('active', t.dataset.prov === activeProvider));
    panels.forEach(p => p.classList.toggle('active', p.id === `ob-panel-${activeProvider}`));
    setStep1Status('');
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getActiveKeyAndModel() {
  if (activeProvider === 'openrouter') {
    return {
      key:   document.getElementById('obOrKey').value,
      model: document.getElementById('obOrModel').value
    };
  }
  if (activeProvider === 'openai') {
    return {
      key:   document.getElementById('obOaiKey').value,
      model: document.getElementById('obOaiModel').value
    };
  }
  // gemini
  return {
    key:   document.getElementById('obGemKey').value,
    model: document.getElementById('obGemModel').value
  };
}

function setStep1Status(msg, type = '') {
  step1Status.textContent = msg;
  step1Status.className = 'ob-status ' + type;
}

// ─── Pre-fill if keys already exist ──────────────────────────────────────────
(async () => {
  try {
    const stored = await chrome.storage.sync.get([
      'activeProvider',
      'openRouterApiKey', 'orModel',
      'openAiApiKey',     'oaiModel',
      'geminiApiKey',     'gemModel'
    ]);

    if (stored.activeProvider) {
      activeProvider = stored.activeProvider;
      provTabs.forEach(t => t.classList.toggle('active', t.dataset.prov === activeProvider));
      panels.forEach(p => p.classList.toggle('active', p.id === `ob-panel-${activeProvider}`));
    }

    if (stored.openRouterApiKey) document.getElementById('obOrKey').value  = stored.openRouterApiKey;
    if (stored.openAiApiKey)     document.getElementById('obOaiKey').value = stored.openAiApiKey;
    if (stored.geminiApiKey)     document.getElementById('obGemKey').value = stored.geminiApiKey;

    if (stored.orModel)  setSelectValue('obOrModel',  stored.orModel);
    if (stored.oaiModel) setSelectValue('obOaiModel', stored.oaiModel);
    if (stored.gemModel) setSelectValue('obGemModel', stored.gemModel);
  } catch (_) {}
})();

function setSelectValue(id, value) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const opt = Array.from(sel.options).find(o => o.value === value);
  if (opt) sel.value = value;
}

// ─── Step 3 back button ───────────────────────────────────────────────────────
document.getElementById('step2Back').addEventListener('click', () => goTo(1));

// ─── Step 3 demo mini-bubble ──────────────────────────────────────────────────
// Chrome never injects content scripts into chrome-extension:// pages, so we
// build a fully functional mini-bubble here that calls the real AI via
// chrome.runtime.sendMessage → background.js → callAI.
(function () {
  const MODE_MAP = {
    'Fix grammar':      'fix',
    'Improve clarity':  'clarity',
    'Shorten':          'shorten',
    'Polish':           'polish',
    'Professional':     'professional',
    'Friendly':         'friendly'
  };
  const ACTIONS = Object.keys(MODE_MAP);

  // ── Build bubble DOM ────────────────────────────────────────────────────────
  const bubble = document.createElement('div');
  bubble.id = 'ob-mini-bubble';

  // Header
  const header = document.createElement('div');
  header.className = 'ob-bubble-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'ob-bubble-title';
  titleEl.textContent = '✦ Refine It!';

  const headerRight = document.createElement('div');
  headerRight.className = 'ob-bubble-header-right';

  ['B', 'I'].forEach(label => {
    const b = document.createElement('button');
    b.className = 'ob-bubble-fmt-btn';
    b.innerHTML = label === 'B' ? '<b>B</b>' : '<i>I</i>';
    b.title = label === 'B' ? 'Bold' : 'Italic';
    // Format buttons: apply execCommand to the textarea selection
    b.addEventListener('click', () => {
      const ta = document.getElementById('obDemoTextarea');
      if (!ta) return;
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      if (end <= start) return;
      const selected = ta.value.substring(start, end);
      const wrapped  = label === 'B' ? `**${selected}**` : `_${selected}_`;
      ta.setRangeText(wrapped, start, end, 'end');
    });
    headerRight.appendChild(b);
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ob-bubble-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('mousedown', e => { e.preventDefault(); hideBubble(); });
  headerRight.appendChild(closeBtn);

  header.appendChild(titleEl);
  header.appendChild(headerRight);
  bubble.appendChild(header);

  // Status line (shows "Rewriting…" / error)
  const statusLine = document.createElement('div');
  statusLine.id = 'ob-bubble-status';
  Object.assign(statusLine.style, {
    fontSize: '11px',
    color: '#9ca3af',
    display: 'none',
    padding: '0 2px'
  });
  bubble.appendChild(statusLine);

  // Action buttons
  const actionsRow = document.createElement('div');
  actionsRow.className = 'ob-bubble-actions';

  ACTIONS.forEach(label => {
    const btn = document.createElement('button');
    btn.className = 'ob-bubble-action-btn';
    btn.textContent = label;
    btn.addEventListener('mousedown', e => e.preventDefault()); // keep textarea focus
    btn.addEventListener('click', () => runRewrite(MODE_MAP[label], btn));
    actionsRow.appendChild(btn);
  });

  bubble.appendChild(actionsRow);
  document.body.appendChild(bubble);

  // ── Rewrite logic ───────────────────────────────────────────────────────────
  let isRewriting = false;

  async function runRewrite(mode, clickedBtn) {
    if (isRewriting) return;
    const ta = document.getElementById('obDemoTextarea');
    if (!ta) return;

    const start = ta.selectionStart;
    const end   = ta.selectionEnd;
    const text  = ta.value.substring(start, end).trim();
    if (!text) {
      showStatus('Select some text first!', '#f87171');
      return;
    }

    isRewriting = true;
    setAllBtnsDisabled(true);
    clickedBtn.textContent = '…';
    showStatus('Rewriting…', '#a78bfa');

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'REFINETHIS_REWRITE',
        payload: { text, mode, customInstruction: null, contextBefore: '', contextAfter: '' }
      });

      if (response?.ok && response.rewrittenText) {
        ta.setRangeText(response.rewrittenText, start, end, 'end');
        showStatus('✓ Done!', '#34d399');
        setTimeout(() => { hideStatus(); hideBubble(); }, 1200);
      } else {
        showStatus('Error: ' + (response?.error || 'Unknown error'), '#f87171');
        setTimeout(hideStatus, 3000);
      }
    } catch (err) {
      showStatus('Error: ' + (err.message || 'Failed'), '#f87171');
      setTimeout(hideStatus, 3000);
    } finally {
      isRewriting = false;
      setAllBtnsDisabled(false);
      clickedBtn.textContent = ACTIONS.find(l => MODE_MAP[l] === mode) || mode;
    }
  }

  function setAllBtnsDisabled(disabled) {
    actionsRow.querySelectorAll('.ob-bubble-action-btn').forEach(b => {
      b.disabled = disabled;
      b.style.opacity = disabled ? '0.5' : '1';
    });
  }

  function showStatus(msg, color) {
    statusLine.textContent = msg;
    statusLine.style.color = color || '#9ca3af';
    statusLine.style.display = 'block';
  }
  function hideStatus() {
    statusLine.style.display = 'none';
  }

  // ── Positioning ─────────────────────────────────────────────────────────────
  function showBubble() {
    const ta = document.getElementById('obDemoTextarea');
    if (!ta) return;
    if (ta.selectionEnd <= ta.selectionStart) { hideBubble(); return; }

    bubble.classList.add('visible');

    const rect = ta.getBoundingClientRect();
    const bh   = bubble.offsetHeight;
    const bw   = bubble.offsetWidth;
    const vw   = window.innerWidth;

    let left = rect.left + rect.width / 2 - bw / 2;
    let top  = rect.top  - bh - 12;

    if (left < 8)           left = 8;
    if (left + bw > vw - 8) left = vw - bw - 8;
    if (top < 8)            top  = rect.bottom + 12;

    bubble.style.left = left + 'px';
    bubble.style.top  = top  + 'px';
  }

  function hideBubble() {
    if (isRewriting) return;
    bubble.classList.remove('visible');
    hideStatus();
  }

  // ── Event wiring ────────────────────────────────────────────────────────────
  function wireDemo() {
    const ta = document.getElementById('obDemoTextarea');
    if (!ta) return;
    ta.addEventListener('mouseup', () => setTimeout(showBubble, 80));
    ta.addEventListener('keyup',   () => setTimeout(showBubble, 80));
    ta.addEventListener('select',  () => setTimeout(showBubble, 80));
    ta.addEventListener('blur', () => {
      setTimeout(() => {
        if (!bubble.contains(document.activeElement)) hideBubble();
      }, 180);
    });
  }

  document.addEventListener('DOMContentLoaded', wireDemo);
  if (document.readyState !== 'loading') wireDemo();

  document.addEventListener('mousedown', e => {
    const ta = document.getElementById('obDemoTextarea');
    if (!bubble.contains(e.target) && e.target !== ta) hideBubble();
  }, true);
})();
