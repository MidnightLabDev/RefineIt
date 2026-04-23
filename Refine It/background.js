// ─── Endpoints ────────────────────────────────────────────────────────────────
const OPENROUTER_URL  = 'https://openrouter.ai/api/v1/chat/completions';
const OPENAI_URL      = 'https://api.openai.com/v1/chat/completions';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const APP_TITLE = 'Refine It!';
const APP_SITE  = 'chrome-extension://refine-this';

// ─── Default models per provider ─────────────────────────────────────────────
const DEFAULT_MODELS = {
  openrouter: 'meta-llama/llama-3.1-8b-instruct',
  openai:     'gpt-4o-mini',
  gemini:     'gemini-2.0-flash'
};

// ─── Context-menu items ───────────────────────────────────────────────────────
const MENU_ROOT  = 'refine-this-root';
const MENU_ITEMS = {
  fix:          'Fix grammar',
  clarity:      'Improve clarity',
  shorten:      'Shorten',
  polish:       'Polish',
  professional: 'Make professional',
  friendly:     'Make friendly'
};

const selectionCache = new Map();

// ─── Usage / token tracking ───────────────────────────────────────────────────
// Stored in chrome.storage.local so it persists across service worker restarts.
// Keys: usageRewriteCount (total all-time), usageTotalTokens (all-time),
//       usageSessionCount (since last browser start), usageSessionTokens.
async function incrementUsage(tokensUsed) {
  try {
    const stored = await chrome.storage.local.get([
      'usageRewriteCount', 'usageTotalTokens',
      'usageSessionCount', 'usageSessionTokens'
    ]);
    const updates = {
      usageRewriteCount:  (stored.usageRewriteCount  || 0) + 1,
      usageTotalTokens:   (stored.usageTotalTokens   || 0) + (tokensUsed || 0),
      usageSessionCount:  (stored.usageSessionCount  || 0) + 1,
      usageSessionTokens: (stored.usageSessionTokens || 0) + (tokensUsed || 0)
    };
    await chrome.storage.local.set(updates);
    return updates;
  } catch (_) { return null; }
}

async function getUsageStats() {
  try {
    const stored = await chrome.storage.local.get([
      'usageRewriteCount', 'usageTotalTokens',
      'usageSessionCount', 'usageSessionTokens'
    ]);
    return {
      totalRewrites:   stored.usageRewriteCount  || 0,
      totalTokens:     stored.usageTotalTokens   || 0,
      sessionRewrites: stored.usageSessionCount  || 0,
      sessionTokens:   stored.usageSessionTokens || 0
    };
  } catch (_) {
    return { totalRewrites: 0, totalTokens: 0, sessionRewrites: 0, sessionTokens: 0 };
  }
}

// Reset session counters on startup
chrome.runtime.onStartup?.addListener(() => {
  chrome.storage.local.set({ usageSessionCount: 0, usageSessionTokens: 0 }).catch(() => {});
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  createContextMenus();

  // Open onboarding on fresh install (not on update)
  if (details.reason === 'install') {
    const stored = await chrome.storage.sync.get('onboardingDone').catch(() => ({}));
    if (!stored.onboardingDone) {
      chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    }
  }
});
chrome.runtime.onStartup?.addListener(() => createContextMenus());

chrome.tabs.onRemoved?.addListener((tabId) => {
  selectionCache.delete(String(tabId));
  chrome.storage.session?.remove?.(`selection:${tabId}`);
});

chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    selectionCache.delete(String(tabId));
    chrome.storage.session?.remove?.(`selection:${tabId}`);
  }
});

// ─── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'REFINETHIS_REWRITE') {
    handleBubbleRewrite(message, sendResponse);
    return true;
  }
  if (message?.type === 'CACHE_REFINETHIS_SELECTION') {
    cacheSelectionFromContentScript(message, sender)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e?.message }));
    return true;
  }
  if (message?.type === 'CLEAR_REFINETHIS_SELECTION') {
    const tabId = sender?.tab?.id ?? message?.tabId;
    if (Number.isInteger(tabId)) {
      selectionCache.delete(String(tabId));
      chrome.storage.session?.remove?.(`selection:${tabId}`);
    }
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === 'GET_CACHED_REFINETHIS_SELECTION') {
    getCachedSelection(message?.tabId)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e?.message }));
    return true;
  }
  if (message?.type === 'GET_USAGE_STATS') {
    getUsageStats().then(stats => sendResponse({ ok: true, stats })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'RESET_USAGE_STATS') {
    chrome.storage.local.set({
      usageRewriteCount: 0, usageTotalTokens: 0,
      usageSessionCount: 0, usageSessionTokens: 0
    }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

// ─── Context menus ────────────────────────────────────────────────────────────
function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ROOT, title: 'Refine It!', contexts: ['selection'] });
    for (const [mode, title] of Object.entries(MENU_ITEMS)) {
      chrome.contextMenus.create({
        id: `refine-${mode}`,
        parentId: MENU_ROOT,
        title,
        contexts: ['selection']
      });
    }
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.menuItemId?.startsWith('refine-') || !tab?.id) return;
  const mode = info.menuItemId.replace('refine-', '');
  const targetFrame = Number.isInteger(info.frameId) ? { frameId: info.frameId } : undefined;

  try {
    const cfg = await loadProviderConfig();
    if (!cfg.apiKey) {
      await sendTabMessage(tab.id, {
        type: 'SHOW_REFINETHIS_MESSAGE',
        payload: { text: `Add your ${cfg.providerLabel} API key in the Refine It! popup first.` }
      });
      return;
    }

    await sendTabMessage(tab.id, {
      type: 'SHOW_REFINETHIS_MESSAGE',
      payload: { text: 'Refining selected text...' }
    }, targetFrame);

    const selectionState = await sendTabMessage(tab.id, { type: 'GET_SELECTION_STATE' }, targetFrame);
    const selectedText = (selectionState?.text || info.selectionText || '').trim();
    if (!selectedText) {
      await sendTabMessage(tab.id, {
        type: 'SHOW_REFINETHIS_MESSAGE',
        payload: { text: 'No highlighted text found.' }
      }, targetFrame);
      return;
    }

    const { rewrittenText, tokensUsed } = await callAI({
      cfg,
      text: selectedText,
      mode,
      contextBefore: selectionState?.contextBefore || '',
      contextAfter:  selectionState?.contextAfter  || ''
    });

    if (!rewrittenText) throw new Error('The rewrite result was empty.');
    incrementUsage(tokensUsed).catch(() => {});

    const replaceResult = await sendTabMessage(tab.id, {
      type: 'REPLACE_SELECTION',
      payload: { text: rewrittenText }
    }, targetFrame);

    if (!replaceResult?.ok) throw new Error(replaceResult?.error || 'Could not replace the selected text.');

    await sendTabMessage(tab.id, {
      type: 'SHOW_REFINETHIS_MESSAGE',
      payload: { text: 'Done. Selected text was refined in place.' }
    }, targetFrame);
  } catch (err) {
    await sendTabMessage(tab.id, {
      type: 'SHOW_REFINETHIS_MESSAGE',
      payload: { text: err?.message || 'Something went wrong.' }
    }).catch(() => {});
  }
});

// ─── Bubble rewrite handler ───────────────────────────────────────────────────
async function handleBubbleRewrite(message, sendResponse) {
  try {
    const cfg = await loadProviderConfig();
    if (!cfg.apiKey) {
      sendResponse({ ok: false, error: `Add your ${cfg.providerLabel} API key in the extension popup first.` });
      return;
    }

    const { text, mode, customInstruction, contextBefore = '', contextAfter = '' } = message?.payload || {};
    if (!text?.trim()) {
      sendResponse({ ok: false, error: 'No text to rewrite.' });
      return;
    }

    const { rewrittenText, tokensUsed } = await callAI({ cfg, text, mode, customInstruction, contextBefore, contextAfter });
    if (!rewrittenText) {
      sendResponse({ ok: false, error: 'The rewrite result was empty.' });
      return;
    }
    // Track usage asynchronously — don't block the response
    incrementUsage(tokensUsed).catch(() => {});
    sendResponse({ ok: true, rewrittenText, tokensUsed });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || 'Rewrite failed.' });
  }
}

// ─── Provider config loader ───────────────────────────────────────────────────
async function loadProviderConfig() {
  const stored = await chrome.storage.sync.get([
    'activeProvider',
    'openRouterApiKey', 'orModel',
    'openAiApiKey',     'oaiModel',
    'geminiApiKey',     'gemModel',
    'langDetect',
    'contextAware'
  ]);

  const provider    = stored.activeProvider || 'openrouter';
  const langDetect  = stored.langDetect  !== false;
  const contextAware = stored.contextAware !== false;

  const map = {
    openrouter: {
      provider:      'openrouter',
      providerLabel: 'OpenRouter',
      apiKey:        (stored.openRouterApiKey || '').trim(),
      model:         stored.orModel  || DEFAULT_MODELS.openrouter,
      langDetect,
      contextAware
    },
    openai: {
      provider:      'openai',
      providerLabel: 'OpenAI (ChatGPT)',
      apiKey:        (stored.openAiApiKey || '').trim(),
      model:         stored.oaiModel || DEFAULT_MODELS.openai,
      langDetect,
      contextAware
    },
    gemini: {
      provider:      'gemini',
      providerLabel: 'Google Gemini',
      apiKey:        (stored.geminiApiKey || '').trim(),
      model:         stored.gemModel || DEFAULT_MODELS.gemini,
      langDetect,
      contextAware
    }
  };

  return map[provider] || map.openrouter;
}

// ─── Unified AI caller ──────────────────────────────────────────────────────
async function callAI({ cfg, text, mode, customInstruction, contextBefore = '', contextAfter = '' }) {
  const { systemPrompt, userPrompt } = buildPrompts({
    text,
    mode,
    customInstruction,
    contextBefore,
    contextAfter,
    langDetect:   cfg.langDetect,
    contextAware: cfg.contextAware
  });

  let raw, tokensUsed = 0;
  if (cfg.provider === 'gemini') {
    ({ raw, tokensUsed } = await callGemini({ cfg, systemPrompt, userPrompt }));
  } else {
    ({ raw, tokensUsed } = await callOpenAICompatible({ cfg, systemPrompt, userPrompt }));
  }

  return { rewrittenText: normalizeModelOutput(raw), tokensUsed };
}

// ─── OpenAI-compatible call (OpenRouter + OpenAI) ─────────────────────────────
async function callOpenAICompatible({ cfg, systemPrompt, userPrompt }) {
  const url = cfg.provider === 'openai' ? OPENAI_URL : OPENROUTER_URL;

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`
  };
  if (cfg.provider === 'openrouter') {
    headers['HTTP-Referer']       = APP_SITE;
    headers['X-OpenRouter-Title'] = APP_TITLE;
  }

  const payload = {
    model: cfg.model,
    temperature: 0.4,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt }
    ]
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${cfg.providerLabel} request failed (${response.status}): ${errorText.substring(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('The model returned an empty response.');
  const tokensUsed = data?.usage?.total_tokens || 0;
  return { raw: content, tokensUsed };
}

// ─── Gemini call ──────────────────────────────────────────────────────────────
async function callGemini({ cfg, systemPrompt, userPrompt }) {
  const url = `${GEMINI_BASE_URL}/${cfg.model}:generateContent?key=${cfg.apiKey}`;

  const payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.4 }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${errorText.substring(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Gemini returned an empty response.');
  const tokensUsed = data?.usageMetadata?.totalTokenCount || 0;
  return { raw: content, tokensUsed };
}

// ─── Prompt builder ───────────────────────────────────────────────────────────
function buildPrompts({ text, mode, customInstruction, contextBefore, contextAfter, langDetect, contextAware }) {
  const instructionMap = {
    fix:          'Correct grammar, spelling, punctuation, and awkward phrasing. Preserve the original meaning and tone.',
    clarity:      'Rewrite for clarity and readability. Keep the meaning the same and preserve the original tone.',
    shorten:      'Rewrite the text to be shorter and tighter. Preserve the meaning and tone.',
    polish:       'Polish the writing so it sounds natural, smooth, and well written. Preserve the original meaning.',
    professional: 'Rewrite in a professional, polished, business-appropriate tone. Keep the meaning intact.',
    friendly:     'Rewrite in a warm, friendly, natural tone. Preserve the meaning.'
  };

  const instruction = mode === 'custom'
    ? (customInstruction?.trim() || 'Rewrite this text so it reads better while keeping the same meaning and tone.')
    : (instructionMap[mode] || instructionMap.clarity);

  // System prompt
  const systemParts = [
    'You are a precise writing assistant.',
    'Rewrite the user text according to the instruction.',
    'Return ONLY the final rewritten text — no labels, no explanations, no quotation marks, no commentary.',
    'Preserve URLs, names, numbers, code snippets, and markdown formatting where possible.'
  ];

  if (langDetect) {
    systemParts.push('IMPORTANT: Detect the language of the input text and always respond in that same language. Never translate.');
  }

  if (contextAware && (contextBefore || contextAfter)) {
    systemParts.push(
      'You will be given surrounding context (text before and after the selection). ' +
      'Use this context to better understand the intent, register, and style of the writing, ' +
      'but only rewrite the SELECTED TEXT — do not include the context in your output.'
    );
  }

  const systemPrompt = systemParts.join(' ');

  // User prompt
  const userParts = [`Instruction: ${instruction}`];

  if (contextAware && contextBefore) {
    userParts.push(`\n\nContext before selection:\n${contextBefore.trim()}`);
  }
  if (contextAware && contextAfter) {
    userParts.push(`\n\nContext after selection:\n${contextAfter.trim()}`);
  }

  userParts.push(`\n\nSelected text to rewrite:\n${text}`);

  return { systemPrompt, userPrompt: userParts.join('') };
}

// ─── Output normaliser ────────────────────────────────────────────────────────
function normalizeModelOutput(raw) {
  if (!raw) return '';
  let text = raw.trim();
  text = text.replace(/^```(?:\w+)?\s*/u, '').replace(/\s*```$/u, '').trim();
  text = text.replace(/^"([\s\S]*)"$/u, '$1').trim();
  text = text.replace(/^Output:\s*/iu, '').trim();
  text = text.replace(/^Rewritten text:\s*/iu, '').trim();
  text = text.replace(/^Here(?: is|'s) the rewritten text:\s*/iu, '').trim();
  return text;
}

// ─── Selection cache ──────────────────────────────────────────────────────────
async function cacheSelectionFromContentScript(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false };
  const text = (message?.payload?.text || '').trim();
  if (!text) return { ok: false };

  const cached = {
    tabId,
    frameId:       Number.isInteger(sender.frameId) ? sender.frameId : 0,
    text,
    contextBefore: message?.payload?.contextBefore || '',
    contextAfter:  message?.payload?.contextAfter  || '',
    source:        message?.payload?.source || null,
    updatedAt:     Date.now()
  };

  selectionCache.set(String(tabId), cached);
  await chrome.storage.session?.set?.({ [`selection:${tabId}`]: cached });
  return { ok: true };
}

async function getCachedSelection(tabId) {
  if (!Number.isInteger(tabId)) return { ok: false, text: '' };
  const key = String(tabId);
  const mem = selectionCache.get(key);
  if (mem?.text) return { ok: true, ...mem };

  const stored = await chrome.storage.session?.get?.(`selection:${tabId}`);
  const val = stored?.[`selection:${tabId}`];
  if (val?.text) { selectionCache.set(key, val); return { ok: true, ...val }; }

  return { ok: false, text: '' };
}

// ─── Tab message helper ───────────────────────────────────────────────────────
function sendTabMessage(tabId, message, options) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, options || {}, response => {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message)); return; }
      resolve(response);
    });
  });
}
