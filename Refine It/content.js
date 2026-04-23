// ─── State ───────────────────────────────────────────────────────────────────

let lastSelection = { source: null, text: '' };
let lastKnownEditable = null;

// Snapshot that survives blur events clearing window.getSelection()
let savedTextSnapshot = { text: '', editableRoot: null, shadowRoot: null };

// Shadow roots we have already attached listeners to
const attachedShadowRoots = new WeakSet();
const knownShadowRoots = new Set();

// Bubble show timer
let bubbleShowTimer = null;

// ─── Undo state ───────────────────────────────────────────────────────────────
// Stores enough info to reverse the last rewrite
let lastRewriteUndo = null;

// ─── Rewrite history (session, max 10) ───────────────────────────────────────
const rewriteHistory = [];
const HISTORY_MAX = 10;

// ─── Constants ────────────────────────────────────────────────────────────────

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'email']);
const BUBBLE_DELAY_MS = 420;
const BUBBLE_ID = 'refinethis-bubble';

const ACTIONS = [
  { mode: 'fix',          label: 'Fix grammar' },
  { mode: 'clarity',      label: 'Improve clarity' },
  { mode: 'shorten',      label: 'Shorten' },
  { mode: 'polish',       label: 'Polish' },
  { mode: 'professional', label: 'Professional' },
  { mode: 'friendly',     label: 'Friendly' }
];

// ─── Platform detection ────────────────────────────────────────────────────────────────

const PLATFORM_ACTIONS = {
  github: [
    { mode: 'bug_report',    label: '🐛 Bug report',    platformInstruction: 'Rewrite this as a well-structured bug report with sections: Summary, Steps to Reproduce, Expected Behavior, Actual Behavior, and Environment. Be concise and precise.' },
    { mode: 'pr_description', label: '🔀 PR description', platformInstruction: 'Rewrite this as a professional GitHub Pull Request description with sections: What, Why, and How. Use clear technical language.' },
    { mode: 'action_items',  label: '✅ Action items',  platformInstruction: 'Convert this into a clear list of action items using GitHub task list syntax (- [ ] item). Each item should be specific and actionable.' }
  ],
  jira: [
    { mode: 'bug_report',    label: '🐛 Bug report',    platformInstruction: 'Rewrite this as a Jira bug report with fields: Summary, Description, Steps to Reproduce, Expected Result, Actual Result, Priority. Use concise, structured language.' },
    { mode: 'user_story',    label: '📋 User story',    platformInstruction: 'Rewrite this as a Jira user story in the format: "As a [user], I want [goal] so that [benefit]." Add acceptance criteria as a bullet list.' },
    { mode: 'action_items',  label: '✅ Action items',  platformInstruction: 'Convert this into a numbered list of clear, specific action items suitable for a Jira ticket description.' }
  ],
  notion: [
    { mode: 'action_items',  label: '✅ Action items',  platformInstruction: 'Convert this into a clean list of action items. Each item should start with a checkbox emoji (☐) and be specific and actionable.' },
    { mode: 'structured',    label: '📝 Structure it',   platformInstruction: 'Rewrite this as a well-structured Notion document with clear headings, bullet points, and concise paragraphs. Preserve all key information.' },
    { mode: 'tldr',          label: '⚡ TL;DR',          platformInstruction: 'Write a concise TL;DR summary of this text in 2-3 sentences, followed by the key points as a bullet list.' }
  ]
};

function detectPlatform() {
  const host = window.location.hostname.toLowerCase();
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  if (host.includes('atlassian.net') || host.includes('jira.')) return 'jira';
  if (host === 'notion.so' || host.endsWith('.notion.so') || host.endsWith('.notion.site')) return 'notion';
  return null;
}

const CURRENT_PLATFORM = detectPlatform();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isTextControl(el) {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
  if (el.tagName !== 'INPUT') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  return TEXT_INPUT_TYPES.has(type) &&
    !el.disabled && !el.readOnly &&
    typeof el.selectionStart === 'number' &&
    typeof el.selectionEnd === 'number';
}

function getElementFromNode(node) {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}

function findEditableRoot(node) {
  let el = getElementFromNode(node);
  while (el) {
    const ce = el.getAttribute?.('contenteditable');
    const role = el.getAttribute?.('role');
    if (
      el.isContentEditable ||
      ce === 'true' ||
      ce === 'plaintext-only' ||
      role === 'textbox'
    ) return el;
    if (el.parentElement) {
      el = el.parentElement;
    } else if (el.getRootNode && el.getRootNode() instanceof ShadowRoot) {
      el = el.getRootNode().host;
    } else {
      break;
    }
  }
  return null;
}

function getShadowRootOf(node) {
  let el = getElementFromNode(node);
  while (el) {
    const root = el.getRootNode?.();
    if (root instanceof ShadowRoot) return root;
    el = el.parentElement;
  }
  return null;
}

function isInShadow(el) {
  try {
    const root = el.getRootNode?.();
    return root instanceof ShadowRoot;
  } catch (_) { return false; }
}

function findQuillEditorDeep(docRoot) {
  const direct = docRoot.querySelector?.('.ql-editor[contenteditable="true"]');
  if (direct) return direct;
  const all = docRoot.querySelectorAll?.('*') || [];
  for (const el of all) {
    if (el.shadowRoot) {
      const found = findQuillEditorDeep(el.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

function trackEditable(target) {
  if (!target) return;
  if (isTextControl(target)) { lastKnownEditable = target; return; }
  const root = findEditableRoot(target);
  if (root) lastKnownEditable = root;
}

function getSelectionFromTextControl(el) {
  if (!isTextControl(el)) return null;
  const start = el.selectionStart, end = el.selectionEnd;
  if (end <= start) return null;
  const text = el.value.slice(start, end);
  if (!text?.trim()) return null;
  return { source: 'text-control', element: el, start, end, text };
}

function getSelectionFromContext(ctx) {
  let sel;
  try {
    sel = ctx.getSelection ? ctx.getSelection() : window.getSelection();
  } catch (_) { sel = window.getSelection(); }
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const text = sel.toString();
  if (!text?.trim()) return null;
  const range = sel.getRangeAt(0);
  const editableRoot = findEditableRoot(range.commonAncestorContainer);
  const shadowRoot = getShadowRootOf(range.commonAncestorContainer);
  return {
    source: editableRoot ? 'contenteditable' : 'dom',
    text,
    range: range.cloneRange(),
    editableRoot,
    shadowRoot: shadowRoot || null
  };
}

function getSelectionFromDocument() {
  const mainSel = getSelectionFromContext(window);
  if (mainSel?.text?.trim()) return mainSel;
  for (const sr of knownShadowRoots) {
    try {
      const srSel = getSelectionFromContext(sr);
      if (srSel?.text?.trim()) return srSel;
    } catch (_) {}
  }
  return null;
}

// ─── Shadow DOM wiring ────────────────────────────────────────────────────────

function attachShadowListeners(shadowRoot) {
  if (!shadowRoot || attachedShadowRoots.has(shadowRoot)) return;
  attachedShadowRoots.add(shadowRoot);
  knownShadowRoots.add(shadowRoot);
  shadowRoot.addEventListener('selectionchange', () => captureSelection(), true);
  shadowRoot.addEventListener('mouseup',         (e) => onMouseUp(e), true);
  shadowRoot.addEventListener('pointerup',       () => captureSelection(), true);
  shadowRoot.addEventListener('keyup',           () => captureSelection(), true);
  shadowRoot.addEventListener('focusin',         (e) => trackEditable(e.target), true);
  shadowRoot.addEventListener('pointerdown',     (e) => trackEditable(e.target), true);
  shadowRoot.addEventListener('mousedown',       (e) => trackEditable(e.target), true);
}

function scanForShadowRoots(root) {
  root.querySelectorAll?.('*').forEach(el => {
    if (el.shadowRoot) {
      attachShadowListeners(el.shadowRoot);
      scanForShadowRoots(el.shadowRoot);
    }
  });
}

function observeForShadowRoots(root) {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.shadowRoot) attachShadowListeners(node.shadowRoot);
        node.querySelectorAll?.('*').forEach(el => {
          if (el.shadowRoot) attachShadowListeners(el.shadowRoot);
        });
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
}

// ─── Selection capture ────────────────────────────────────────────────────────

function cacheSelectionForPopup(selectionState) {
  if (!selectionState?.text?.trim()) return;
  try {
    chrome.runtime.sendMessage({
      type: 'CACHE_REFINETHIS_SELECTION',
      payload: { text: selectionState.text, source: selectionState.source }
    }).catch(() => {});
  } catch (_) {}
}

function captureSelection() {
  let selected = null;
  const active = document.activeElement;
  if (isTextControl(active)) selected = getSelectionFromTextControl(active);
  if (!selected && isTextControl(lastKnownEditable) && document.contains(lastKnownEditable))
    selected = getSelectionFromTextControl(lastKnownEditable);
  if (!selected) selected = getSelectionFromDocument();

  if (selected?.text?.trim()) {
    lastSelection = selected;
    cacheSelectionForPopup(selected);
    savedTextSnapshot = {
      text: selected.text,
      editableRoot: selected.editableRoot ||
        (lastKnownEditable && !isTextControl(lastKnownEditable) ? lastKnownEditable : null),
      shadowRoot: selected.shadowRoot || null
    };
  }
  return selected;
}

// ─── Bubble position helper ───────────────────────────────────────────────────

function getSelectionRect() {
  let sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
    return sel.getRangeAt(0).getBoundingClientRect();
  }
  for (const sr of knownShadowRoots) {
    try {
      sel = sr.getSelection ? sr.getSelection() : null;
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        return sel.getRangeAt(0).getBoundingClientRect();
      }
    } catch (_) {}
  }
  return null;
}

// ─── Word / char count helpers ────────────────────────────────────────────────

function wordCount(str) {
  return (str || '').trim().split(/\s+/).filter(Boolean).length;
}

function formatDelta(charDelta, wordDelta) {
  const sign = n => n > 0 ? `+${n}` : `${n}`;
  return `${sign(wordDelta)} words  ${sign(charDelta)} chars`;
}

function deltaColor(charDelta) {
  if (charDelta < 0) return '#34d399';   // shorter → green
  if (charDelta > 0) return '#fbbf24';   // longer  → amber
  return '#9ca3af';                       // same    → grey
}

// ─── Inline Bubble UI ─────────────────────────────────────────────────────────

function removeBubble() {
  const existing = document.getElementById(BUBBLE_ID);
  if (existing) existing.remove();
}

function showBubble(selectionRect) {
  removeBubble();

  const bubble = document.createElement('div');
  bubble.id = BUBBLE_ID;

  // ── Styles ──────────────────────────────────────────────────────────────────
  Object.assign(bubble.style, {
    position: 'fixed',
    zIndex: '2147483647',
    background: 'rgba(18, 18, 28, 0.97)',
    border: '1px solid rgba(139, 92, 246, 0.55)',
    borderRadius: '14px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(139,92,246,0.15)',
    padding: '10px 12px 10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    minWidth: '320px',
    maxWidth: '420px',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '13px',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    transition: 'opacity 0.15s ease, transform 0.15s ease',
    opacity: '0',
    transform: 'translateY(4px)'
  });

  // ── Header row ──────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '2px'
  });

  const title = document.createElement('span');
  title.textContent = '✦ Refine It!';
  Object.assign(title.style, {
    color: '#a78bfa',
    fontWeight: '700',
    fontSize: '12px',
    letterSpacing: '0.02em'
  });

  // ── Bold / Italic format buttons (top-right of header) ─────────────────────
  function makeFmtBtn(label, title, cmd) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    Object.assign(b.style, {
      background: 'none',
      border: '1px solid rgba(139,92,246,0.3)',
      borderRadius: '4px',
      color: '#9ca3af',
      cursor: 'pointer',
      fontSize: '12px',
      fontWeight: cmd === 'bold' ? '700' : '400',
      fontStyle: cmd === 'italic' ? 'italic' : 'normal',
      padding: '1px 6px',
      lineHeight: '1.4',
      minWidth: '22px',
      transition: 'background 0.12s, color 0.12s'
    });
    b.addEventListener('mouseenter', () => {
      b.style.background = 'rgba(139,92,246,0.18)';
      b.style.color = '#c4b5fd';
    });
    b.addEventListener('mouseleave', () => {
      b.style.background = 'none';
      b.style.color = '#9ca3af';
    });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      // Apply format directly from the bubble
      let done = false;
      try { done = document.execCommand(cmd, false, null); } catch (_) {}
      if (!done) {
        const ctx = resolveEditableContext(lastSelection || {});
        if (ctx?.editableRoot) {
          ctx.editableRoot.focus({ preventScroll: true });
          const doc = ctx.editableRoot.ownerDocument || document;
          try { done = doc.execCommand(cmd, false, null); } catch (_) {}
        }
      }
      // Brief visual feedback
      b.style.background = done ? 'rgba(139,92,246,0.35)' : 'rgba(239,68,68,0.25)';
      b.style.color = done ? '#ede9fe' : '#fca5a5';
      setTimeout(() => { b.style.background = 'none'; b.style.color = '#9ca3af'; }, 600);
    });
    return b;
  }

  const boldBtn   = makeFmtBtn('B', 'Bold',   'bold');
  const italicBtn = makeFmtBtn('I', 'Italic', 'italic');

  // History toggle button (top-right of header, before close)
  const historyBtn = document.createElement('button');
  historyBtn.title = 'Rewrite history';
  historyBtn.textContent = '🕐';
  Object.assign(historyBtn.style, {
    background: 'none',
    border: 'none',
    color: '#6b7280',
    cursor: 'pointer',
    fontSize: '13px',
    padding: '0 4px',
    lineHeight: '1',
    borderRadius: '4px'
  });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, {
    background: 'none',
    border: 'none',
    color: '#6b7280',
    cursor: 'pointer',
    fontSize: '12px',
    padding: '0 2px',
    lineHeight: '1',
    borderRadius: '4px'
  });
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#d1d5db'; });
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = '#6b7280'; });
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeBubble(); });

  const headerRight = document.createElement('div');
  Object.assign(headerRight.style, { display: 'flex', alignItems: 'center', gap: '2px' });
  headerRight.appendChild(boldBtn);
  headerRight.appendChild(italicBtn);
  headerRight.appendChild(historyBtn);
  headerRight.appendChild(closeBtn);

  header.appendChild(title);
  header.appendChild(headerRight);

  // ── Action buttons row ───────────────────────────────────────────────────────
  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px'
  });

  ACTIONS.forEach(({ mode, label }) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.dataset.mode = mode;
    styleActionBtn(btn);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      runBubbleRewrite(mode, null, bubble);
    });
    btnRow.appendChild(btn);
  });

  // ── Platform-specific actions (GitHub / Jira / Notion) ─────────────────────
  const platformActions = CURRENT_PLATFORM ? PLATFORM_ACTIONS[CURRENT_PLATFORM] : null;
  if (platformActions && platformActions.length > 0) {
    const platformDivider = document.createElement('div');
    Object.assign(platformDivider.style, {
      width: '100%',
      height: '1px',
      background: 'rgba(139,92,246,0.18)',
      margin: '2px 0'
    });
    btnRow.appendChild(platformDivider);

    const platformLabel = document.createElement('div');
    const platformNames = { github: 'GitHub', jira: 'Jira', notion: 'Notion' };
    platformLabel.textContent = platformNames[CURRENT_PLATFORM] + ' actions';
    Object.assign(platformLabel.style, {
      width: '100%',
      fontSize: '10px',
      fontWeight: '700',
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
      color: 'rgba(167,139,250,0.7)',
      padding: '0 2px'
    });
    btnRow.appendChild(platformLabel);

    platformActions.forEach(({ mode, label, platformInstruction }) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.dataset.mode = mode;
      btn.dataset.platform = CURRENT_PLATFORM;
      styleActionBtn(btn, true);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        runBubbleRewrite('custom', platformInstruction, bubble);
      });
      btnRow.appendChild(btn);
    });
  }

  // ── History panel (hidden by default) ────────────────────────────────────────
  const historyPanel = document.createElement('div');
  Object.assign(historyPanel.style, {
    display: 'none',
    flexDirection: 'column',
    gap: '6px',
    maxHeight: '180px',
    overflowY: 'auto',
    borderTop: '1px solid rgba(139,92,246,0.2)',
    paddingTop: '6px'
  });

  function refreshHistoryPanel() {
    historyPanel.innerHTML = '';
    if (rewriteHistory.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No rewrites yet this session.';
      Object.assign(empty.style, { color: '#6b7280', fontSize: '11px', textAlign: 'center', padding: '6px 0' });
      historyPanel.appendChild(empty);
      return;
    }
    [...rewriteHistory].reverse().forEach((entry, idx) => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '5px 6px',
        borderRadius: '8px',
        background: 'rgba(139,92,246,0.07)',
        cursor: 'default'
      });

      const info = document.createElement('div');
      Object.assign(info.style, { flex: '1', minWidth: '0' });

      const modeBadge = document.createElement('span');
      modeBadge.textContent = entry.mode;
      Object.assign(modeBadge.style, {
        background: 'rgba(139,92,246,0.25)',
        color: '#c4b5fd',
        borderRadius: '10px',
        padding: '1px 7px',
        fontSize: '10px',
        fontWeight: '600',
        marginRight: '5px'
      });

      const deltaBadge = document.createElement('span');
      deltaBadge.textContent = formatDelta(entry.charDelta, entry.wordDelta);
      Object.assign(deltaBadge.style, {
        color: deltaColor(entry.charDelta),
        fontSize: '10px',
        fontFamily: 'monospace'
      });

      const preview = document.createElement('div');
      preview.textContent = entry.rewritten.substring(0, 80) + (entry.rewritten.length > 80 ? '…' : '');
      Object.assign(preview.style, {
        color: '#d1d5db',
        fontSize: '11px',
        marginTop: '3px',
        lineHeight: '1.4',
        wordBreak: 'break-word'
      });

      info.appendChild(modeBadge);
      info.appendChild(deltaBadge);
      info.appendChild(preview);

      const restoreBtn = document.createElement('button');
      restoreBtn.textContent = '↩';
      restoreBtn.title = 'Restore this version';
      Object.assign(restoreBtn.style, {
        background: 'rgba(139,92,246,0.15)',
        border: '1px solid rgba(139,92,246,0.3)',
        borderRadius: '6px',
        color: '#a78bfa',
        cursor: 'pointer',
        fontSize: '12px',
        padding: '2px 7px',
        flexShrink: '0',
        alignSelf: 'center'
      });
      restoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Re-apply this historical rewrite
        try {
          savedTextSnapshot.text = entry.original;
          lastSelection = { source: 'contenteditable', text: entry.original, range: null,
            editableRoot: savedTextSnapshot.editableRoot, shadowRoot: savedTextSnapshot.shadowRoot };
          replaceSelection(entry.rewritten);
          setBubbleStatus(bubble, `Restored: ${entry.mode}`, 'success');
          setTimeout(() => removeBubble(), 900);
        } catch (err) {
          setBubbleStatus(bubble, err.message, 'error');
        }
      });

      row.appendChild(info);
      row.appendChild(restoreBtn);
      historyPanel.appendChild(row);
    });
  }

  let historyOpen = false;
  historyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    historyOpen = !historyOpen;
    historyPanel.style.display = historyOpen ? 'flex' : 'none';
    historyBtn.style.color = historyOpen ? '#a78bfa' : '#6b7280';
    if (historyOpen) refreshHistoryPanel();
    repositionBubble(bubble);
  });

  // ── Streaming preview area ────────────────────────────────────────────────────
  const previewArea = document.createElement('div');
  previewArea.id = 'refinethis-preview';
  Object.assign(previewArea.style, {
    display: 'none',
    flexDirection: 'column',
    gap: '6px'
  });

  // Skeleton rows shown while waiting for first chunk
  const skeleton = document.createElement('div');
  skeleton.id = 'refinethis-skeleton';
  Object.assign(skeleton.style, {
    display: 'flex',
    flexDirection: 'column',
    gap: '5px'
  });
  const skeletonCSS = `
    @keyframes refinethis-shimmer {
      0%   { background-position: -400px 0; }
      100% { background-position: 400px 0; }
    }
  `;
  if (!document.getElementById('refinethis-skeleton-style')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'refinethis-skeleton-style';
    styleEl.textContent = skeletonCSS;
    document.head.appendChild(styleEl);
  }
  [100, 80, 60].forEach(w => {
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      height: '10px',
      width: `${w}%`,
      borderRadius: '5px',
      background: 'linear-gradient(90deg, rgba(139,92,246,0.1) 25%, rgba(139,92,246,0.25) 50%, rgba(139,92,246,0.1) 75%)',
      backgroundSize: '400px 100%',
      animation: 'refinethis-shimmer 1.4s infinite linear'
    });
    skeleton.appendChild(bar);
  });

  // Live text display during streaming
  const streamText = document.createElement('div');
  streamText.id = 'refinethis-stream-text';
  Object.assign(streamText.style, {
    display: 'none',
    color: '#e5e7eb',
    fontSize: '12px',
    lineHeight: '1.5',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(139,92,246,0.2)',
    borderRadius: '8px',
    padding: '8px 10px',
    maxHeight: '120px',
    overflowY: 'auto',
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap'
  });

  // Accept / Discard buttons (shown after stream completes)
  const previewActions = document.createElement('div');
  previewActions.id = 'refinethis-preview-actions';
  Object.assign(previewActions.style, {
    display: 'none',
    gap: '6px'
  });

  const acceptBtn = document.createElement('button');
  acceptBtn.textContent = '✓ Accept';
  Object.assign(acceptBtn.style, {
    background: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
    border: 'none',
    borderRadius: '8px',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: '600',
    padding: '6px 14px',
    flex: '1',
    transition: 'opacity 0.15s'
  });
  acceptBtn.addEventListener('mouseenter', () => { acceptBtn.style.opacity = '0.85'; });
  acceptBtn.addEventListener('mouseleave', () => { acceptBtn.style.opacity = '1'; });

  const discardBtn = document.createElement('button');
  discardBtn.textContent = '✕ Discard';
  Object.assign(discardBtn.style, {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '8px',
    color: '#9ca3af',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: '500',
    padding: '6px 14px',
    flex: '1',
    transition: 'opacity 0.15s'
  });
  discardBtn.addEventListener('mouseenter', () => { discardBtn.style.opacity = '0.75'; });
  discardBtn.addEventListener('mouseleave', () => { discardBtn.style.opacity = '1'; });
  discardBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeBubble();
  });

  previewActions.appendChild(acceptBtn);
  previewActions.appendChild(discardBtn);

  previewArea.appendChild(skeleton);
  previewArea.appendChild(streamText);
  previewArea.appendChild(previewActions);

  // ── "More options" toggle ───────────────────────────────────────────────────
  const moreToggle = document.createElement('button');
  moreToggle.textContent = 'More options… ▾';
  Object.assign(moreToggle.style, {
    background: 'none',
    border: 'none',
    color: '#6b7280',
    cursor: 'pointer',
    fontSize: '11px',
    padding: '0',
    textAlign: 'left',
    width: 'fit-content'
  });

  const customSection = document.createElement('div');
  Object.assign(customSection.style, {
    display: 'none',
    flexDirection: 'column',
    gap: '6px'
  });

  const customTextarea = document.createElement('textarea');
  customTextarea.placeholder = 'Custom instruction, e.g. "Make it concise and confident"';
  customTextarea.rows = 2;
  Object.assign(customTextarea.style, {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(139, 92, 246, 0.3)',
    borderRadius: '8px',
    color: '#e5e7eb',
    fontSize: '12px',
    padding: '7px 10px',
    resize: 'vertical',
    width: '100%',
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    outline: 'none'
  });
  customTextarea.addEventListener('focus', () => {
    customTextarea.style.borderColor = 'rgba(139, 92, 246, 0.7)';
  });
  customTextarea.addEventListener('blur', () => {
    customTextarea.style.borderColor = 'rgba(139, 92, 246, 0.3)';
  });

  const customRunBtn = document.createElement('button');
  customRunBtn.textContent = 'Rewrite with custom instruction';
  Object.assign(customRunBtn.style, {
    background: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
    border: 'none',
    borderRadius: '8px',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: '600',
    padding: '7px 14px',
    width: '100%',
    transition: 'opacity 0.15s'
  });
  customRunBtn.addEventListener('mouseenter', () => { customRunBtn.style.opacity = '0.85'; });
  customRunBtn.addEventListener('mouseleave', () => { customRunBtn.style.opacity = '1'; });
  customRunBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    runBubbleRewrite('custom', customTextarea.value.trim(), bubble);
  });

  customSection.appendChild(customTextarea);
  customSection.appendChild(customRunBtn);

  let moreOpen = false;
  moreToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    moreOpen = !moreOpen;
    customSection.style.display = moreOpen ? 'flex' : 'none';
    moreToggle.textContent = moreOpen ? 'Less options… ▴' : 'More options… ▾';
    repositionBubble(bubble);
  });

  // ── Status line ─────────────────────────────────────────────────────────────
  const statusLine = document.createElement('div');
  statusLine.id = 'refinethis-bubble-status';
  Object.assign(statusLine.style, {
    color: '#9ca3af',
    fontSize: '11px',
    minHeight: '14px',
    display: 'none',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap'
  });

  // ── Assemble ────────────────────────────────────────────────────────────────
  bubble.appendChild(header);
  bubble.appendChild(btnRow);
  bubble.appendChild(previewArea);
  bubble.appendChild(historyPanel);
  bubble.appendChild(moreToggle);
  bubble.appendChild(customSection);
  bubble.appendChild(statusLine);

  document.documentElement.appendChild(bubble);

  // ── Position ────────────────────────────────────────────────────────────────
  positionBubble(bubble, selectionRect);

  // Animate in
  requestAnimationFrame(() => {
    bubble.style.opacity = '1';
    bubble.style.transform = 'translateY(0)';
  });

  // Dismiss on outside click
  const outsideClick = (e) => {
    if (!bubble.contains(e.target)) {
      removeBubble();
      document.removeEventListener('mousedown', outsideClick, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', outsideClick, true);
  }, 200);

  // Dismiss on Escape
  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      removeBubble();
      document.removeEventListener('keydown', keyHandler, true);
    }
  };
  document.addEventListener('keydown', keyHandler, true);
}

function styleActionBtn(btn, isPlatform = false) {
  // Platform actions get a teal/cyan tint to visually distinguish them
  const bg     = isPlatform ? 'rgba(20, 184, 166, 0.12)' : 'rgba(139, 92, 246, 0.12)';
  const border = isPlatform ? 'rgba(20, 184, 166, 0.35)'  : 'rgba(139, 92, 246, 0.35)';
  const color  = isPlatform ? '#5eead4'                    : '#c4b5fd';
  const bgHov  = isPlatform ? 'rgba(20, 184, 166, 0.28)'  : 'rgba(139, 92, 246, 0.28)';
  const bdHov  = isPlatform ? 'rgba(20, 184, 166, 0.7)'   : 'rgba(139, 92, 246, 0.7)';
  const coHov  = isPlatform ? '#99f6e4'                    : '#ede9fe';
  Object.assign(btn.style, {
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: '20px',
    color: color,
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: '500',
    padding: '5px 12px',
    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
    whiteSpace: 'nowrap'
  });
  btn.addEventListener('mouseenter', () => {
    if (!btn.disabled) {
      btn.style.background = bgHov;
      btn.style.borderColor = bdHov;
      btn.style.color = coHov;
    }
  });
  btn.addEventListener('mouseleave', () => {
    if (!btn.disabled) {
      btn.style.background = bg;
      btn.style.borderColor = border;
      btn.style.color = color;
    }
  });
}

function positionBubble(bubble, rect) {
  if (!rect) return;
  const MARGIN = 8;
  const bubbleW = bubble.offsetWidth || 340;
  const bubbleH = bubble.offsetHeight || 120;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top = rect.top - bubbleH - MARGIN;
  let left = rect.left + (rect.width / 2) - (bubbleW / 2);

  if (top < MARGIN) top = rect.bottom + MARGIN;
  if (left < MARGIN) left = MARGIN;
  if (left + bubbleW > vw - MARGIN) left = vw - bubbleW - MARGIN;
  if (top + bubbleH > vh - MARGIN) top = vh - bubbleH - MARGIN;
  if (top < MARGIN) top = MARGIN;

  bubble.style.top  = `${top}px`;
  bubble.style.left = `${left}px`;
}

function repositionBubble(bubble) {
  const rect = getSelectionRect();
  if (rect) positionBubble(bubble, rect);
}

// ─── Bubble rewrite logic ─────────────────────────────────────────────────────

function setBubbleBusy(bubble, isBusy) {
  bubble.querySelectorAll('button').forEach(btn => {
    btn.disabled = isBusy;
    btn.style.opacity = isBusy ? '0.5' : '1';
    btn.style.cursor  = isBusy ? 'not-allowed' : 'pointer';
  });
}

function setBubbleStatus(bubble, text, type, extra) {
  const statusLine = bubble.querySelector('#refinethis-bubble-status');
  if (!statusLine) return;
  statusLine.innerHTML = '';
  if (!text) { statusLine.style.display = 'none'; return; }

  statusLine.style.display = 'flex';
  statusLine.style.color = type === 'error' ? '#f87171'
    : type === 'success' ? '#34d399'
    : '#9ca3af';

  const textNode = document.createElement('span');
  textNode.textContent = text;
  statusLine.appendChild(textNode);

  // Delta badge
  if (extra?.delta) {
    const badge = document.createElement('span');
    badge.textContent = extra.delta;
    Object.assign(badge.style, {
      color: extra.deltaColor || '#9ca3af',
      fontFamily: 'monospace',
      fontSize: '10px',
      background: 'rgba(255,255,255,0.06)',
      borderRadius: '6px',
      padding: '1px 6px'
    });
    statusLine.appendChild(badge);
  }

  // Undo button
  if (extra?.showUndo) {
    const undoBtn = document.createElement('button');
    undoBtn.textContent = '↩ Undo';
    Object.assign(undoBtn.style, {
      background: 'rgba(139,92,246,0.15)',
      border: '1px solid rgba(139,92,246,0.35)',
      borderRadius: '6px',
      color: '#a78bfa',
      cursor: 'pointer',
      fontSize: '10px',
      fontWeight: '600',
      padding: '2px 8px',
      marginLeft: '4px'
    });
    undoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      undoLastRewrite(bubble);
    });
    statusLine.appendChild(undoBtn);
  }
}

// ─── Undo last rewrite ────────────────────────────────────────────────────────

function undoLastRewrite(bubble) {
  if (!lastRewriteUndo) {
    setBubbleStatus(bubble, 'Nothing to undo.', 'error');
    return;
  }
  try {
    const { originalText, source, element, start, end, editableRoot, shadowRoot } = lastRewriteUndo;

    if (source === 'text-control' && element) {
      // Restore text control: we need to find the rewritten text position
      // Use the stored start offset and rewritten length to locate current text
      const rewrittenLen = lastRewriteUndo.rewrittenLen;
      const before = element.value.slice(0, start);
      const after  = element.value.slice(start + rewrittenLen);
      const next   = `${before}${originalText}${after}`;
      const setter = getNativeValueSetter(element);
      if (setter) setter.call(element, next); else element.value = next;
      element.setSelectionRange(start, start + originalText.length);
      dispatchInputEvents(element, originalText);
    } else {
      // Restore contenteditable: find the rewritten text and replace with original
      savedTextSnapshot = { text: lastRewriteUndo.rewrittenText, editableRoot, shadowRoot };
      lastSelection = { source: 'contenteditable', text: lastRewriteUndo.rewrittenText, range: null, editableRoot, shadowRoot };
      replaceSelection(originalText);
    }

    setBubbleStatus(bubble, 'Reverted to original.', 'success');
    lastRewriteUndo = null;
    setTimeout(() => removeBubble(), 900);
  } catch (err) {
    setBubbleStatus(bubble, `Undo failed: ${err.message}`, 'error');
  }
}

// ─── Streaming rewrite ────────────────────────────────────────────────────────

async function runBubbleRewrite(mode, customInstruction, bubble) {
  // ── Load all settings ────────────────────────────────────────────────────────
  let settings = {};
  try {
    settings = await chrome.storage.sync.get([
      'activeProvider',
      'openRouterApiKey', 'orModel',
      'openAiApiKey',     'oaiModel',
      'geminiApiKey',     'gemModel',
      'langDetect',       'contextAware'
    ]);
  } catch (_) {}

  const provider = (settings.activeProvider || 'openrouter').toLowerCase();

  // Validate the correct API key for the active provider
  let apiKey = '';
  let providerLabel = '';
  if (provider === 'openai') {
    apiKey = (settings.openAiApiKey || '').trim();
    providerLabel = 'ChatGPT (OpenAI)';
  } else if (provider === 'gemini') {
    apiKey = (settings.geminiApiKey || '').trim();
    providerLabel = 'Gemini';
  } else {
    apiKey = (settings.openRouterApiKey || '').trim();
    providerLabel = 'OpenRouter';
  }

  if (!apiKey) {
    setBubbleStatus(bubble, `Add your ${providerLabel} API key in the extension popup first.`, 'error');
    return;
  }

  if (mode === 'custom' && !customInstruction) {
    setBubbleStatus(bubble, 'Enter a custom instruction first.', 'error');
    return;
  }

  const snapshotText = savedTextSnapshot?.text || lastSelection?.text || '';
  if (!snapshotText?.trim()) {
    setBubbleStatus(bubble, 'No text selected. Highlight text and try again.', 'error');
    return;
  }

  // ── Capture context (text surrounding the selection) ─────────────────────────
  let contextBefore = '';
  let contextAfter  = '';
  if (settings.contextAware) {
    try {
      const ctx = resolveEditableContext(lastSelection || {});
      const root = ctx?.editableRoot || savedTextSnapshot?.editableRoot;
      if (root) {
        const fullText = root.value !== undefined ? root.value : root.textContent || '';
        const selText  = snapshotText;
        const normFull = normaliseSpaces(fullText);
        const normSel  = normaliseSpaces(selText);
        const idx      = normFull.indexOf(normSel);
        if (idx !== -1) {
          contextBefore = fullText.slice(Math.max(0, idx - 300), idx);
          contextAfter  = fullText.slice(idx + selText.length, idx + selText.length + 300);
        }
      }
    } catch (_) {}
  }

  // ── Show streaming preview area, hide action buttons ─────────────────────────
  setBubbleBusy(bubble, true);
  setBubbleStatus(bubble, '');

  const previewArea   = bubble.querySelector('#refinethis-preview');
  const skeleton      = bubble.querySelector('#refinethis-skeleton');
  const streamTextEl  = bubble.querySelector('#refinethis-stream-text');
  const previewActions = bubble.querySelector('#refinethis-preview-actions');

  previewArea.style.display   = 'flex';
  skeleton.style.display      = 'flex';
  streamTextEl.style.display  = 'none';
  previewActions.style.display = 'none';
  streamTextEl.textContent    = '';

  repositionBubble(bubble);

  let accumulatedText = '';

  try {
    // Request rewrite from background — pass provider, model, context, and lang settings
    const result = await chrome.runtime.sendMessage({
      type: 'REFINETHIS_REWRITE',
      payload: {
        text: snapshotText,
        mode,
        customInstruction: customInstruction || '',
        stream: false,
        langDetect:    !!settings.langDetect,
        contextAware:  !!settings.contextAware,
        contextBefore,
        contextAfter
      }
    });

    if (!result?.ok || !result?.rewrittenText) {
      throw new Error(result?.error || 'The rewrite result was empty.');
    }

    accumulatedText = result.rewrittenText;

    // ── Simulate streaming: reveal text character-by-character ────────────────
    skeleton.style.display     = 'none';
    streamTextEl.style.display = 'block';

    await simulateStream(streamTextEl, accumulatedText, bubble);

    // ── Show Accept / Discard ─────────────────────────────────────────────────
    previewActions.style.display = 'flex';
    repositionBubble(bubble);

    // Compute delta
    const origWords = wordCount(snapshotText);
    const newWords  = wordCount(accumulatedText);
    const charDelta = accumulatedText.length - snapshotText.length;
    const wordDelta = newWords - origWords;

    setBubbleStatus(bubble, 'Ready', 'success', {
      delta: formatDelta(charDelta, wordDelta),
      deltaColor: deltaColor(charDelta)
    });

    // Wire Accept button
    const acceptBtn = bubble.querySelector('#refinethis-preview-actions button:first-child');
    if (acceptBtn) {
      acceptBtn.onclick = (e) => {
        e.stopPropagation();
        try {
          // Save undo state before replacing
          saveUndoState(snapshotText, accumulatedText);

          replaceSelection(accumulatedText);

          // Save to history
          addToHistory({ original: snapshotText, rewritten: accumulatedText, mode, charDelta, wordDelta });

          setBubbleStatus(bubble, 'Done!', 'success', {
            delta: formatDelta(charDelta, wordDelta),
            deltaColor: deltaColor(charDelta),
            showUndo: true
          });

          // Hide preview area, re-enable buttons for potential next action
          previewArea.style.display = 'none';
          setBubbleBusy(bubble, false);

          setTimeout(() => removeBubble(), 2500);
        } catch (err) {
          setBubbleStatus(bubble, err.message || 'Replace failed.', 'error');
          setBubbleBusy(bubble, false);
        }
      };
    }

    setBubbleBusy(bubble, false);
    // Keep discard button active
    const discardBtn = bubble.querySelector('#refinethis-preview-actions button:last-child');
    if (discardBtn) discardBtn.disabled = false;

  } catch (err) {
    skeleton.style.display     = 'none';
    previewArea.style.display  = 'none';
    setBubbleStatus(bubble, err.message || 'Something went wrong.', 'error');
    setBubbleBusy(bubble, false);
  }
}

// ─── Simulate character-by-character streaming ────────────────────────────────

function simulateStream(el, text, bubble) {
  return new Promise((resolve) => {
    let i = 0;
    const CHUNK = 4;       // characters per tick
    const DELAY = 18;      // ms between ticks — ~220 chars/sec

    function tick() {
      if (i >= text.length) { resolve(); return; }
      const end = Math.min(i + CHUNK, text.length);
      el.textContent += text.slice(i, end);
      el.scrollTop = el.scrollHeight;
      i = end;
      setTimeout(tick, DELAY);
    }
    tick();
  });
}

// ─── Undo state saver ─────────────────────────────────────────────────────────

function saveUndoState(originalText, rewrittenText) {
  const ctx = {
    originalText,
    rewrittenText,
    rewrittenLen: rewrittenText.length,
    source: lastSelection?.source,
    element: lastSelection?.element || null,
    start: lastSelection?.start ?? null,
    end: lastSelection?.end ?? null,
    editableRoot: savedTextSnapshot?.editableRoot || lastSelection?.editableRoot || null,
    shadowRoot: savedTextSnapshot?.shadowRoot || lastSelection?.shadowRoot || null
  };
  lastRewriteUndo = ctx;
}

// ─── History management ───────────────────────────────────────────────────────

function addToHistory({ original, rewritten, mode, charDelta, wordDelta }) {
  const entry = {
    original,
    rewritten,
    mode,
    charDelta,
    wordDelta,
    timestamp: Date.now()
  };
  rewriteHistory.unshift(entry);
  if (rewriteHistory.length > HISTORY_MAX) rewriteHistory.pop();
}

// ─── Mouse-up handler: show bubble after selection ───────────────────────────

function onMouseUp(e) {
  const bubble = document.getElementById(BUBBLE_ID);
  if (bubble && bubble.contains(e.target)) return;

  clearTimeout(bubbleShowTimer);
  bubbleShowTimer = setTimeout(() => {
    const selected = captureSelection();
    const text = selected?.text?.trim() || savedTextSnapshot?.text?.trim();
    if (!text) return;

    const isWritable =
      selected?.source === 'contenteditable' ||
      selected?.source === 'text-control' ||
      (selected?.source !== 'dom' && savedTextSnapshot?.editableRoot != null);

    if (!isWritable) return;

    const rect = getSelectionRect();
    if (!rect || rect.width === 0) return;

    showBubble(rect);
  }, BUBBLE_DELAY_MS);
}

// ─── Whitespace normalisation ─────────────────────────────────────────────────

function normaliseSpaces(str) {
  return str
    .replace(/\u00A0/g, ' ')
    .replace(/\u202F/g, ' ')
    .replace(/\u2009/g, ' ')
    .replace(/\u2003/g, ' ')
    .replace(/\u2002/g, ' ');
}

// ─── Text-node walker ─────────────────────────────────────────────────────────

function findTextInEditable(root, searchText) {
  if (!root || !searchText) return null;
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let full = '';
  let n;
  while ((n = walker.nextNode())) {
    nodes.push({ node: n, start: full.length, len: n.textContent.length });
    full += n.textContent;
  }
  if (!full) return null;
  const normFull   = normaliseSpaces(full);
  const normSearch = normaliseSpaces(searchText);
  const idx = normFull.indexOf(normSearch);
  if (idx === -1) return null;
  const end = idx + normSearch.length;
  let sn = null, so = 0, en = null, eo = 0;
  for (const { node: nd, start: s, len } of nodes) {
    const e = s + len;
    if (!sn && idx >= s && idx < e) { sn = nd; so = idx - s; }
    if (!en && end > s && end <= e) { en = nd; eo = end - s; }
    if (sn && en) break;
  }
  if (!sn || !en) return null;
  const r = doc.createRange();
  r.setStart(sn, so);
  r.setEnd(en, eo);
  return r;
}

// ─── Native value setter ──────────────────────────────────────────────────────

function getNativeValueSetter(el) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement?.prototype
    : window.HTMLInputElement?.prototype;
  return Object.getOwnPropertyDescriptor(proto || {}, 'value')?.set;
}

// ─── Input event dispatcher ───────────────────────────────────────────────────

function dispatchInputEvents(target, insertedText) {
  if (!target) return;
  try {
    target.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, composed: true,
      inputType: 'insertReplacementText', data: insertedText
    }));
  } catch (_) {}
  let ev;
  try {
    ev = new InputEvent('input', {
      bubbles: true, cancelable: false, composed: true,
      inputType: 'insertReplacementText', data: insertedText
    });
  } catch (_) {
    ev = new Event('input', { bubbles: true, composed: true });
  }
  target.dispatchEvent(ev);
  target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

// ─── <input> / <textarea> replacement ────────────────────────────────────────

function replaceInTextControl(sel, newText) {
  const el = sel.element;
  if (!el || !document.contains(el)) throw new Error('The original text field is no longer available.');
  el.focus({ preventScroll: true });
  el.setSelectionRange(sel.start, sel.end);
  const before = el.value.slice(0, sel.start);
  const after  = el.value.slice(sel.end);
  const next   = `${before}${newText}${after}`;
  const cursor = before.length + newText.length;
  const setter = getNativeValueSetter(el);
  if (setter) setter.call(el, next); else el.value = next;
  el.setSelectionRange(cursor, cursor);
  dispatchInputEvents(el, newText);
  lastSelection = { source: 'text-control', element: el, start: cursor, end: cursor, text: '' };
}

// ─── execCommand replacement ──────────────────────────────────────────────────

function execCommandReplace(editableRoot, range, newText, shadowRoot) {
  editableRoot.focus({ preventScroll: true });
  let sel;
  try {
    sel = shadowRoot?.getSelection ? shadowRoot.getSelection() : window.getSelection();
  } catch (_) { sel = window.getSelection(); }
  try { sel.removeAllRanges(); } catch (_) {}
  try { sel.addRange(range); } catch (_) {}
  const doc = editableRoot.ownerDocument || document;
  let inserted = false;
  try { inserted = doc.execCommand('insertText', false, newText); } catch (_) {}
  if (inserted) return true;
  try { inserted = document.execCommand('insertText', false, newText); } catch (_) {}
  if (inserted) return true;
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', newText);
    dt.setData('text/html', newText);
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, composed: true, clipboardData: dt
    });
    editableRoot.dispatchEvent(pasteEvent);
    if (pasteEvent.defaultPrevented) return true;
  } catch (_) {}
  return false;
}

// ─── DOM fallback ─────────────────────────────────────────────────────────────

function domFallbackReplace(editableRoot, range, newText) {
  const sel = window.getSelection();
  try { sel.removeAllRanges(); } catch (_) {}
  try { sel.addRange(range); } catch (_) {}
  range.deleteContents();
  const doc  = editableRoot.ownerDocument || document;
  const node = doc.createTextNode(newText);
  range.insertNode(node);
  const nr = doc.createRange();
  nr.setStartAfter(node);
  nr.collapse(true);
  try { sel.removeAllRanges(); sel.addRange(nr); } catch (_) {}
  dispatchInputEvents(editableRoot || node.parentElement || document.body, newText);
}

// ─── Resolve editable context ─────────────────────────────────────────────────

function resolveEditableContext(sel) {
  if (sel.editableRoot && (document.contains(sel.editableRoot) || isInShadow(sel.editableRoot))) {
    return { editableRoot: sel.editableRoot, shadowRoot: sel.shadowRoot || null };
  }
  if (savedTextSnapshot?.editableRoot &&
      (document.contains(savedTextSnapshot.editableRoot) || isInShadow(savedTextSnapshot.editableRoot))) {
    return { editableRoot: savedTextSnapshot.editableRoot, shadowRoot: savedTextSnapshot.shadowRoot || null };
  }
  if (lastKnownEditable && !isTextControl(lastKnownEditable) &&
      (document.contains(lastKnownEditable) || isInShadow(lastKnownEditable))) {
    return { editableRoot: lastKnownEditable, shadowRoot: getShadowRootOf(lastKnownEditable) || null };
  }
  const quill = findQuillEditorDeep(document);
  if (quill) {
    return { editableRoot: quill, shadowRoot: getShadowRootOf(quill) || null };
  }
  return null;
}

// ─── Main contenteditable replacement ────────────────────────────────────────

function replaceInContentEditable(sel, newText) {
  const ctx = resolveEditableContext(sel);
  if (!ctx) {
    throw new Error('No saved selection found. Highlight the text again and retry.');
  }
  const { editableRoot, shadowRoot } = ctx;

  const liveRange = sel.range;
  const liveRangeUsable = liveRange &&
    (document.contains(liveRange.commonAncestorContainer) || isInShadow(liveRange.commonAncestorContainer)) &&
    !liveRange.collapsed;

  if (liveRangeUsable) {
    const ok = execCommandReplace(editableRoot, liveRange, newText, shadowRoot);
    if (!ok) domFallbackReplace(editableRoot, liveRange, newText);
    savedTextSnapshot = { text: '', editableRoot: null, shadowRoot: null };
    lastSelection = { source: 'contenteditable', text: '', editableRoot };
    return;
  }

  const snapshotText = savedTextSnapshot?.text || sel.text || '';
  if (!snapshotText) {
    throw new Error('No saved selection found. Highlight the text again and retry.');
  }

  const freshRange = findTextInEditable(editableRoot, snapshotText);
  if (!freshRange) {
    throw new Error('Could not locate the highlighted text in the editor. Highlight the text again and retry.');
  }

  const ok = execCommandReplace(editableRoot, freshRange, newText, shadowRoot);
  if (!ok) domFallbackReplace(editableRoot, freshRange, newText);

  savedTextSnapshot = { text: '', editableRoot: null, shadowRoot: null };
  lastSelection = { source: 'contenteditable', text: '', editableRoot };
}

// ─── Public replacement dispatcher ───────────────────────────────────────────

function replaceSelection(newText) {
  const hasLive     = lastSelection?.text?.trim();
  const isTextCtrl  = lastSelection?.source === 'text-control';
  const hasSnapshot = savedTextSnapshot?.text?.trim();

  if (!hasLive && !isTextCtrl && !hasSnapshot) {
    throw new Error('No saved selection found. Highlight the text again and retry.');
  }

  if (isTextCtrl) {
    replaceInTextControl(lastSelection, newText);
    return;
  }

  const sel = (lastSelection.source === 'contenteditable' || lastSelection.source === 'dom')
    ? lastSelection
    : {
        source: 'contenteditable',
        text: savedTextSnapshot.text,
        range: null,
        editableRoot: savedTextSnapshot.editableRoot,
        shadowRoot: savedTextSnapshot.shadowRoot
      };

  replaceInContentEditable(sel, newText);
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

document.addEventListener('focusin',        (e) => trackEditable(e.target), true);
document.addEventListener('pointerdown',    (e) => trackEditable(e.target), true);
document.addEventListener('mousedown',      (e) => trackEditable(e.target), true);
document.addEventListener('selectionchange',() => captureSelection());
document.addEventListener('mouseup',        (e) => onMouseUp(e), true);
document.addEventListener('pointerup',      () => captureSelection(), true);
document.addEventListener('keyup',          () => captureSelection(), true);
document.addEventListener('input',          () => captureSelection(), true);
window.addEventListener('pagehide',         () => captureSelection(), true);

// Hide bubble when selection collapses via keyboard
document.addEventListener('keydown', (e) => {
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)) {
    clearTimeout(bubbleShowTimer);
    removeBubble();
  }
}, true);

// ─── Shadow DOM wiring ────────────────────────────────────────────────────────

scanForShadowRoots(document);
observeForShadowRoots(document);

let shadowScanCount = 0;
const shadowScanInterval = setInterval(() => {
  scanForShadowRoots(document);
  if (++shadowScanCount >= 20) clearInterval(shadowScanInterval);
}, 1000);

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    if (message?.type === 'GET_SELECTION_STATE') {
      const current = captureSelection();
      const sel  = current?.text ? current : lastSelection;
      const text = sel?.text || savedTextSnapshot?.text || '';
      sendResponse({
        ok: true,
        text,
        source: sel?.source || (savedTextSnapshot?.text ? 'contenteditable' : null)
      });
      return true;
    }

    if (message?.type === 'REPLACE_SELECTION') {
      replaceSelection(message?.payload?.text || '');
      chrome.runtime.sendMessage({ type: 'CLEAR_REFINETHIS_SELECTION' }).catch(() => {});
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'SHOW_REFINETHIS_MESSAGE') {
      showRefineToast(message?.payload?.text || 'Done.');
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'APPLY_FORMAT') {
      const formatType = message?.payload?.formatType;
      if (!formatType) { sendResponse({ ok: false, error: 'No formatType provided.' }); return true; }
      try {
        // Try execCommand first (works in most contenteditable editors)
        const cmd = formatType === 'bold' ? 'bold' : 'italic';
        let done = false;
        try { done = document.execCommand(cmd, false, null); } catch (_) {}
        if (!done) {
          // Shadow DOM fallback: focus the editable root and try there
          const ctx = resolveEditableContext(lastSelection || {});
          if (ctx?.editableRoot) {
            ctx.editableRoot.focus({ preventScroll: true });
            const doc = ctx.editableRoot.ownerDocument || document;
            try { done = doc.execCommand(cmd, false, null); } catch (_) {}
          }
        }
        sendResponse({ ok: done });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return true;
    }
  } catch (error) {
    sendResponse({ ok: false, error: error.message || 'Unknown content script error.' });
    return true;
  }

  sendResponse({ ok: false, error: 'Unknown message type.' });
  return true;
});

// ─── Toast ────────────────────────────────────────────────────────────────────

function showRefineToast(message) {
  const existing = document.getElementById('refine-this-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'refine-this-toast';
  toast.textContent = message;
  Object.assign(toast.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
    maxWidth: '320px', padding: '10px 14px', borderRadius: '12px',
    background: 'rgba(17,17,17,0.94)', color: '#fff', fontSize: '13px',
    lineHeight: '1.4', boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
    fontFamily: 'system-ui, BlinkMacSystemFont, Segoe UI, sans-serif'
  });
  document.documentElement.appendChild(toast);
  window.setTimeout(() => toast.remove(), 2800);
}
