// ─── Constants ────────────────────────────────────────────────────────────────
const APP_TITLE = 'Refine It!';
const APP_SITE  = 'chrome-extension://refine-this';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENAI_URL     = 'https://api.openai.com/v1/chat/completions';
// Gemini uses a different endpoint pattern — handled in background.js

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const statusEl              = document.getElementById('status');
const customInstructionInput = document.getElementById('customInstruction');
const customRewriteButton   = document.getElementById('customRewrite');
const actionButtons         = Array.from(document.querySelectorAll('.action-button'));

// Provider tabs
const tabBtns    = Array.from(document.querySelectorAll('.tab-btn'));
const panels     = Array.from(document.querySelectorAll('.provider-panel'));

// OpenRouter
const orKeyInput  = document.getElementById('orKey');
const orModelSel  = document.getElementById('orModel');
const saveOrBtn   = document.getElementById('saveOrKey');

// OpenAI / ChatGPT
const oaiKeyInput = document.getElementById('oaiKey');
const oaiModelSel = document.getElementById('oaiModel');
const saveOaiBtn  = document.getElementById('saveOaiKey');

// Gemini
const gemKeyInput = document.getElementById('gemKey');
const gemModelSel = document.getElementById('gemModel');
const saveGemBtn  = document.getElementById('saveGemKey');

// Settings
const langDetectToggle  = document.getElementById('langDetect');
const contextAwareToggle = document.getElementById('contextAware');

// Format
const fmtBoldBtn   = document.getElementById('fmtBold');
const fmtItalicBtn = document.getElementById('fmtItalic');

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // ── First-run: redirect to onboarding if no key and not yet onboarded ────────
  const onboardCheck = await chrome.storage.sync.get([
    'onboardingDone', 'openRouterApiKey', 'openAiApiKey', 'geminiApiKey'
  ]).catch(() => ({}));
  const hasAnyKey = !!(onboardCheck.openRouterApiKey || onboardCheck.openAiApiKey || onboardCheck.geminiApiKey);
  if (!onboardCheck.onboardingDone && !hasAnyKey) {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    window.close();
    return;
  }

  const stored = await chrome.storage.sync.get([
    'openRouterApiKey', 'orModel',
    'openAiApiKey',     'oaiModel',
    'geminiApiKey',     'gemModel',
    'activeProvider',
    'langDetect',
    'contextAware'
  ]);

  // Restore keys
  if (stored.openRouterApiKey) orKeyInput.value  = stored.openRouterApiKey;
  if (stored.openAiApiKey)     oaiKeyInput.value = stored.openAiApiKey;
  if (stored.geminiApiKey)     gemKeyInput.value  = stored.gemKeyInput;

  // Restore model selections
  if (stored.orModel)  setSelectValue(orModelSel,  stored.orModel);
  if (stored.oaiModel) setSelectValue(oaiModelSel, stored.oaiModel);
  if (stored.gemModel) setSelectValue(gemModelSel, stored.gemModel);

  // Restore active provider tab
  const provider = stored.activeProvider || 'openrouter';
  switchProvider(provider);

  // Restore settings toggles
  langDetectToggle.checked  = stored.langDetect  !== false;
  contextAwareToggle.checked = stored.contextAware !== false;
}

function setSelectValue(sel, value) {
  const opt = Array.from(sel.options).find(o => o.value === value);
  if (opt) sel.value = value;
}

// ─── Provider tabs ────────────────────────────────────────────────────────────
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const p = btn.dataset.provider;
    switchProvider(p);
    chrome.storage.sync.set({ activeProvider: p });
  });
});

function switchProvider(provider) {
  tabBtns.forEach(b => b.classList.toggle('active', b.dataset.provider === provider));
  panels.forEach(p => p.classList.toggle('hidden', p.id !== `panel-${provider}`));
}

// ─── Save API keys ────────────────────────────────────────────────────────────
saveOrBtn.addEventListener('click', async () => {
  const key = orKeyInput.value.trim();
  if (!key) { setStatus('Paste your OpenRouter API key first.', 'error'); return; }
  await chrome.storage.sync.set({ openRouterApiKey: key });
  setStatus('OpenRouter API key saved.', 'success');
});

saveOaiBtn.addEventListener('click', async () => {
  const key = oaiKeyInput.value.trim();
  if (!key) { setStatus('Paste your OpenAI API key first.', 'error'); return; }
  await chrome.storage.sync.set({ openAiApiKey: key });
  setStatus('OpenAI API key saved.', 'success');
});

saveGemBtn.addEventListener('click', async () => {
  const key = gemKeyInput.value.trim();
  if (!key) { setStatus('Paste your Google AI API key first.', 'error'); return; }
  await chrome.storage.sync.set({ geminiApiKey: key });
  setStatus('Gemini API key saved.', 'success');
});

// ─── Persist model selections ─────────────────────────────────────────────────
orModelSel.addEventListener('change',  () => chrome.storage.sync.set({ orModel:  orModelSel.value }));
oaiModelSel.addEventListener('change', () => chrome.storage.sync.set({ oaiModel: oaiModelSel.value }));
gemModelSel.addEventListener('change', () => chrome.storage.sync.set({ gemModel: gemModelSel.value }));

// ─── Persist settings toggles ─────────────────────────────────────────────────
langDetectToggle.addEventListener('change',   () => chrome.storage.sync.set({ langDetect:   langDetectToggle.checked }));
contextAwareToggle.addEventListener('change', () => chrome.storage.sync.set({ contextAware: contextAwareToggle.checked }));

// ─── Format buttons ────────────────────────────────────────────────────────────────
fmtBoldBtn.addEventListener('click',   () => applyFormat('bold'));
fmtItalicBtn.addEventListener('click', () => applyFormat('italic'));

// ─── Usage stats ────────────────────────────────────────────────────────────────
const statSessionRewrites = document.getElementById('statSessionRewrites');
const statSessionTokens   = document.getElementById('statSessionTokens');
const statTotalRewrites   = document.getElementById('statTotalRewrites');
const statTotalTokens     = document.getElementById('statTotalTokens');
const resetUsageBtn       = document.getElementById('resetUsageBtn');

async function loadUsageStats() {
  try {
    const res = await sendRuntimeMessage({ type: 'GET_USAGE_STATS' });
    if (res?.ok && res.stats) {
      statSessionRewrites.textContent = fmt(res.stats.sessionRewrites);
      statSessionTokens.textContent   = fmt(res.stats.sessionTokens);
      statTotalRewrites.textContent   = fmt(res.stats.totalRewrites);
      statTotalTokens.textContent     = fmt(res.stats.totalTokens);
    }
  } catch (_) {}
}

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

resetUsageBtn.addEventListener('click', async () => {
  await sendRuntimeMessage({ type: 'RESET_USAGE_STATS' }).catch(() => {});
  await loadUsageStats();
  setStatus('Usage stats reset.', 'success');
});

// Load on open
loadUsageStats();

async function applyFormat(formatType) {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error('No active tab found.');
    const result = await sendTabMessage(tab.id, {
      type: 'APPLY_FORMAT',
      payload: { formatType }
    });
    if (result?.ok) {
      setStatus(`${formatType === 'bold' ? 'Bold' : 'Italic'} applied.`, 'success');
    } else {
      setStatus(result?.error || 'Could not apply formatting.', 'error');
    }
  } catch (err) {
    setStatus(err.message || 'Format failed.', 'error');
  }
}

// ─── Action buttons ───────────────────────────────────────────────────────────
actionButtons.forEach(btn => btn.addEventListener('click', () => runRewrite(btn.dataset.mode)));
customRewriteButton.addEventListener('click', () => runRewrite('custom'));

// ─── Core rewrite ─────────────────────────────────────────────────────────────
async function runRewrite(mode) {
  if (mode === 'custom' && !customInstructionInput.value.trim()) {
    setStatus('Enter a custom instruction first.', 'error');
    return;
  }

  setBusy(true);
  setStatus('Finding your highlighted text...');

  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error('No active tab found.');

    const selectionTarget = await getSelectionTarget(tab.id);
    if (!selectionTarget?.text) {
      throw new Error('No highlighted text found. Highlight text on the page, then open the extension.');
    }

    setStatus('Rewriting...');

    // Delegate to background.js which has access to cross-origin fetch
    const result = await sendRuntimeMessage({
      type: 'REFINETHIS_REWRITE',
      payload: {
        text: selectionTarget.text,
        mode,
        customInstruction: customInstructionInput.value,
        contextBefore: selectionTarget.contextBefore || '',
        contextAfter:  selectionTarget.contextAfter  || ''
      }
    });

    if (!result?.ok) throw new Error(result?.error || 'Rewrite failed.');

    setStatus('Replacing text on the page...');
    const replaceResult = await sendTabMessage(tab.id, {
      type: 'REPLACE_SELECTION',
      payload: { text: result.rewrittenText }
    }, selectionTarget.targetOptions);

    if (!replaceResult?.ok) throw new Error(replaceResult?.error || 'Could not replace the selected text.');

    setStatus('Done. Your text was rewritten in place.', 'success');
  } catch (err) {
    setStatus(err.message || 'Something went wrong.', 'error');
  } finally {
    setBusy(false);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setBusy(isBusy) {
  const all = [saveOrBtn, saveOaiBtn, saveGemBtn, customRewriteButton, fmtBoldBtn, fmtItalicBtn, ...actionButtons];
  all.forEach(b => { b.disabled = isBusy; });
}

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`.trim();
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function sendTabMessage(tabId, message, options) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, options || {}, response => {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message)); return; }
      resolve(response);
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message)); return; }
      resolve(response);
    });
  });
}

async function getSelectionTarget(tabId) {
  let directSelection = null;
  try {
    directSelection = await sendTabMessage(tabId, { type: 'GET_SELECTION_STATE' });
  } catch (_) {}

  if (directSelection?.text) {
    return {
      text: directSelection.text,
      contextBefore: directSelection.contextBefore || '',
      contextAfter:  directSelection.contextAfter  || '',
      targetOptions: undefined
    };
  }

  const cached = await sendRuntimeMessage({
    type: 'GET_CACHED_REFINETHIS_SELECTION',
    tabId
  }).catch(() => null);

  if (cached?.text) {
    return {
      text: cached.text,
      contextBefore: cached.contextBefore || '',
      contextAfter:  cached.contextAfter  || '',
      targetOptions: Number.isInteger(cached.frameId) ? { frameId: cached.frameId } : undefined
    };
  }

  return { text: '', contextBefore: '', contextAfter: '', targetOptions: undefined };
}
