/**
 * ShadowMac - Visualizer state updates and transcript rendering helpers.
 * Split from the original monolithic app.js; loaded as an ordered classic script.
 */

// --- Visualizer States ---
function setVisualizerState(state) {
  const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  const wasSpeaking = currentVisualizerState === 'speaking';
  const wasThinking = currentVisualizerState === 'thinking';
  currentVisualizerState = state;
  if (state === 'thinking' && !wasThinking) _thinkingEnteredAt = Date.now();
  updateDiagnosticsPanel();
  if (wasSpeaking && state !== 'speaking' && state !== 'interrupting') {
    flushDeferredSubagentNotifications();
    tryDeliverPendingNotifications();
    if (audioPlayer) {
      audioPlayer.reset();
    }
  }
  switch (state) {
    case 'disconnected':
      visualizerStatus.textContent = `Click Connect to talk to ${assistantLabel}`;
      break;
    case 'connecting':
      visualizerStatus.textContent = 'Opening contact...';
      break;
    case 'listening':
      visualizerStatus.textContent = `${assistantLabel} is listening...`;
      break;
    case 'thinking':
      visualizerStatus.textContent = `${assistantLabel} is thinking...`;
      break;
    case 'speaking':
      visualizerStatus.textContent = `${assistantLabel} is speaking`;
      break;
    case 'interrupting':
      visualizerStatus.textContent = `Interrupting ${assistantLabel}...`;
      break;
  }
}

// Keep the idle ("disconnected") status line showing the CURRENT assistant name. setVisualizerState
// only re-renders that line on an actual disconnect, so at boot, right after onboarding, or after a
// rename it can otherwise still show the old/default "Shadow" until the first connect/disconnect.
// Call this whenever the name may have changed while idle.
function refreshIdleAssistantName() {
  if (typeof isConnected !== 'undefined' && isConnected) return;
  if (currentVisualizerState !== 'disconnected') return;
  if (typeof visualizerStatus === 'undefined' || !visualizerStatus) return;
  const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  visualizerStatus.textContent = `Click Connect to talk to ${assistantLabel}`;
}

// Safety net for a stuck "thinking" indicator. 'thinking' is a transient state set while waiting on
// the model or a tool follow-up. A few paths can end a turn without cleanly transitioning out of it
// (e.g. a tool call the model never follows up on, or an output-audio stall that resolved), leaving
// the indicator on "thinking" while nothing is actually happening. When we're connected, fully idle
// (no turn or user turn in progress), not awaiting a tool follow-up or system notice, and no audio is
// playing, snap back to "listening". The turnInProgress/userTurnActive guards mean this never fires
// during the legitimate "user spoke, model is responding" window. Throttled to only act when stuck.
let _idleVisualizerCheckAt = 0;
let _thinkingEnteredAt = 0;
const VISUALIZER_THINKING_STUCK_MS = 14000;
function maybeRecoverIdleVisualizerState() {
  if (currentVisualizerState !== 'thinking') return;
  const now = Date.now();
  if (now - _idleVisualizerCheckAt < 400) return;
  _idleVisualizerCheckAt = now;
  if (!isConnected) return;
  const audioPlaying = !!(audioPlayer && audioPlayer.activeSources && audioPlayer.activeSources.length > 0);
  // Clean idle: nothing is in flight -> snap straight back to listening.
  const fullyIdle = !turnInProgress && !userTurnActive
    && !(typeof toolResponseFollowupPending !== 'undefined' && toolResponseFollowupPending)
    && !(typeof systemNoticeInFlight !== 'undefined' && systemNoticeInFlight)
    && !(typeof serverInterruptPending !== 'undefined' && serverInterruptPending)
    && !audioPlaying;
  if (fullyIdle) {
    setVisualizerState('listening');
    return;
  }
  // Ultimate stuck guard: "thinking" must never sit for many seconds with no audio playing. If it
  // has, a turn/follow-up flag got stuck (e.g. a turn that ended without a turnComplete, or a
  // barge-in mid tool follow-up). Because that stuck "thinking" state keeps the mic input gate
  // CLOSED (isLiveWorkActiveForVoiceBargeIn), the session would otherwise look frozen until a manual
  // reconnect. Force the turn fully idle so the mic reopens and the purple "thinking" bubble clears.
  // The threshold is well above the 12s tool-follow-up timeout and 8s audio-stall recovery, so it
  // never fires during legitimate waits. We additionally skip while genuine backend work is in
  // flight (a running command/tool or an in-progress prompt refinement) so we never cut off a slow
  // but legitimate tool -- that case is not stuck, just slow.
  const realWorkInFlight =
    (typeof activeLiveBackendCommandIds !== 'undefined' && activeLiveBackendCommandIds.size > 0) ||
    (typeof activeLiveToolCallEpochs !== 'undefined' && activeLiveToolCallEpochs.size > 0) ||
    (typeof subagentPromptRefinementInProgress !== 'undefined' && subagentPromptRefinementInProgress);
  if (!audioPlaying && !realWorkInFlight && _thinkingEnteredAt && (now - _thinkingEnteredAt) > VISUALIZER_THINKING_STUCK_MS) {
    if (typeof forceRecoverStuckLiveTurn === 'function') {
      forceRecoverStuckLiveTurn('stuck-thinking watchdog');
    } else {
      if (typeof markTurnIdle === 'function') markTurnIdle('stuck-thinking watchdog');
      setVisualizerState('listening');
    }
  }
}

// maybeRecoverIdleVisualizerState also runs from the rAF visualizer loop (07-visualizer.js), but the
// browser throttles -- and for a minimized/hidden window fully PAUSES -- requestAnimationFrame. That
// is the normal state for a hands-free voice assistant you talk to while doing something else. A
// stuck-"thinking" state closes the mic input gate, so rAF-only recovery means a turn could freeze
// (mic gated, no reply) until the window regained focus or the user manually reconnected -- the rare
// "it just stops replying" bug. This setInterval runs the SAME recovery on a focus-independent timer
// so a stuck turn always self-heals within ~14s even when the window is in the background.
// Background setInterval is throttled to ~1s but, unlike rAF, keeps firing; Shadow's live
// AudioContext also keeps the page from heavy timer throttling. The recovery is internally throttled
// and idempotent, so running it from both the rAF loop and this ticker is safe.
let _idleVisualizerRecoveryTicker = null;
function startIdleVisualizerRecoveryTicker() {
  if (_idleVisualizerRecoveryTicker) return;
  _idleVisualizerRecoveryTicker = setInterval(() => {
    try {
      if (typeof maybeRecoverIdleVisualizerState === 'function') maybeRecoverIdleVisualizerState();
    } catch (e) {}
  }, 1000);
}

// --- Transcript Feed Handlers ---
function addSystemMessage(text) {
  const safeText = redactSensitiveText(text);
  if (!SHOW_TEXT_TRANSCRIPT) {
    console.debug('[Shadow notice]', truncateTextForDisplay(safeText, SYSTEM_NOTICE_CONSOLE_LIMIT));
    return;
  }
  appendBubble(truncateTextForDisplay(safeText, SYSTEM_NOTICE_TRANSCRIPT_LIMIT), 'system-bubble');
}

let lastUserPartial = ''; // debounce for Gemini 2.5 tiny chunk spamming

function saveRecentDialogueTurns() {
  try {
    localStorage.setItem(RECENT_DIALOGUE_STORAGE_KEY, JSON.stringify(recentDialogueTurns.slice(-RECENT_DIALOGUE_LIMIT)));
  } catch (err) {
    console.warn('Failed to persist recent dialogue history:', err);
  }
}

function clearRecentDialogueTurns() {
  recentDialogueTurns = [];
  try {
    localStorage.removeItem(RECENT_DIALOGUE_STORAGE_KEY);
  } catch (err) {
    console.warn('Failed to clear recent dialogue history:', err);
  }
}

function rememberDialogueTurn(role, text) {
  const roleText = String(role || '').trim();
  const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  const cleanRole = /^(shadow|assistant)$/i.test(roleText) || roleText.toLowerCase() === assistantLabel.toLowerCase() ? 'Assistant' : 'User';
  const clean = sanitizeAITranscriptText(text).trim();
  if (!clean) return;
  const last = recentDialogueTurns[recentDialogueTurns.length - 1];
  if (last && last.role === cleanRole && (clean.startsWith(last.text) || last.text.startsWith(clean))) {
    last.text = clean.length >= last.text.length ? clean : last.text;
    last.at = Date.now();
  } else {
    recentDialogueTurns.push({ role: cleanRole, text: clean, at: Date.now() });
  }
  if (recentDialogueTurns.length > RECENT_DIALOGUE_LIMIT) {
    recentDialogueTurns = recentDialogueTurns.slice(-RECENT_DIALOGUE_LIMIT);
  }
  saveRecentDialogueTurns();
}

function formatRecentDialogueTurns() {
  const assistantLabel = typeof getAssistantRoleLabel === 'function' ? getAssistantRoleLabel() : 'Assistant';
  return recentDialogueTurns
    .slice(-8)
    .map(turn => `${/^(shadow|assistant)$/i.test(turn.role) ? assistantLabel : turn.role}: ${turn.text.slice(0, 260)}`)
    .join('\n');
}

function hasDutchMunicipalityContext(text) {
  const clean = normalizeTranscriptCompare(text);
  return /\b(gemeente|municipality|oss|waste|pass|mailed|mail|ordered|gemeentes)\b/.test(clean);
}

function hasHamantaschenFoodContext(text) {
  const clean = normalizeTranscriptCompare(text);
  return /\b(cookie|cookies|pastry|pastries|dessert|bread|bakery|baking|jewish|purim|jam|poppy|speculoos)\b/.test(clean);
}

function applyUserTranscriptDisplayCorrections(text, contextText = '') {
  let displayText = String(text || '');
  const context = String(contextText || '');

  if (/\b(?:hamentashen|hamantaschen|hamentaschen|hamantashen)\b/i.test(displayText)) {
    const likelyMunicipality = hasDutchMunicipalityContext(`${displayText} ${context}`);
    const likelyFood = hasHamantaschenFoodContext(`${displayText} ${context}`);
    if (likelyMunicipality && !likelyFood) {
      displayText = displayText.replace(/\b(?:hamentashen|hamantaschen|hamentaschen|hamantashen)\b/gi, 'gemeente Oss');
    }
  }

  return displayText.replace(/\bit's\s+it's\b/gi, "it's");
}

function addUserTranscript(text) {
  clearTimeout(userTranscriptTimeout);

  const contextText = recentAIOutputForEcho || (getLastBotBubble() && getLastBotBubble().textContent) || '';
  const displayText = applyUserTranscriptDisplayCorrections(text, contextText);
  const clean = (displayText || '').trim();
  if (!clean) return;
  if (isTinyUserTranscriptRevision(clean)) return;
  lastUserPartial = clean;
  checkWhisperStateToggle(clean);
  userSpeechSeq++;
  clearSystemNoticeInFlight();
  dropStaleNonCriticalNotifications();
  if (shouldHandleUserIntent(clean)) {
    void maybeDirectHandleSubagentUtterance(clean);
    maybeDirectHandleProactiveUtterance(clean);
  }
  // Memory is compiled into the session prompt. Do not inject per-turn memory
  // recall as a fake user turn; stale recall notices caused repeated old replies.
  rememberDialogueTurn('User', clean);

  signalProactiveAttention('user_speech');

  if (!SHOW_TEXT_TRANSCRIPT) {
    currentUserTranscript = displayText;
    userTranscriptTimeout = setTimeout(() => {
      void finalizeCurrentUserTranscriptForMemory();
      currentUserTranscript = '';
      lastUserPartial = '';
    }, 5000);
    return;
  }

  if (!currentUserTranscript) {
    appendBubble(displayText, 'user-bubble', 'current-user-bubble');
    currentUserTranscript = displayText;
  } else {
    const cleanNew = displayText.trim();
    const cleanOld = currentUserTranscript.trim();
    if (cleanNew.toLowerCase().startsWith(cleanOld.toLowerCase())) {
      currentUserTranscript = displayText;
    } else {
      currentUserTranscript = displayText;
    }
    updateLastUserTranscript(currentUserTranscript);
  }

  userTranscriptTimeout = setTimeout(() => {
    void finalizeCurrentUserTranscriptForMemory();
    const bubble = document.querySelector('.current-user-bubble');
    if (bubble) bubble.classList.remove('current-user-bubble');
    currentUserTranscript = '';
    lastUserPartial = '';
  }, 5000);
}

function updateLastUserTranscript(text) {
  const bubble = document.querySelector('.current-user-bubble');
  if (bubble) {
    bubble.textContent = text;
    scrollTranscript();
  }
}

function getLastBotBubble() {
  const bubbles = transcriptFeed ? transcriptFeed.querySelectorAll('.bot-bubble') : [];
  return bubbles.length ? bubbles[bubbles.length - 1] : null;
}

function accumulateAIText(text, options = {}) {
  const { replace = false, allowReplaceLast = false } = options;
  const displayText = sanitizeAITranscriptText(text);
  recentAIOutputForEcho = replace
    ? displayText.slice(-1200)
    : (recentAIOutputForEcho + displayText).slice(-1200);
  if (replace) {
    const bubble = document.querySelector('.current-ai-bubble') || (allowReplaceLast ? getLastBotBubble() : null);
    if (bubble) {
      bubble.textContent = displayText;
      bubble.classList.add('current-ai-bubble');
      currentAITranscript = displayText;
    } else {
      appendBubble(displayText, 'bot-bubble', 'current-ai-bubble');
      currentAITranscript = displayText;
    }
  } else if (!currentAITranscript) {
    appendBubble(displayText, 'bot-bubble', 'current-ai-bubble');
    currentAITranscript = displayText;
  } else {
    currentAITranscript += displayText;
    updateLastAITranscript(currentAITranscript);
  }

  // The bubble's '.current-ai-bubble' class is removed natively by the server's 'turnComplete' event.
}

function sanitizeAITranscriptText(text) {
  return redactSensitiveText(String(text || '')
    .replace(/\*{1,3}([^*\n]+?)\*{1,3}/g, '$1')
    .replace(/\*/g, '')
    .replace(/\s+([.,!?;:])/g, '$1'));
}

function normalizeTranscriptCompare(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function transcriptJoiner(base, incoming) {
  if (!base || /[\s("']$/.test(base)) return '';
  if (/^[\s.,!?;:)'"-]/.test(incoming)) return '';
  return ' ';
}

function mergeOutputTranscription(text) {
  const incoming = String(text || '').trim();
  if (!incoming) return;

  const incomingNorm = normalizeTranscriptCompare(incoming);
  const lastNorm = normalizeTranscriptCompare(lastOutputTranscriptionText);
  if (incomingNorm && incomingNorm === lastNorm) return;

  const lastBot = getLastBotBubble();
  const lateWindowOpen = lastAITurnCompleteTime > 0 && (Date.now() - lastAITurnCompleteTime) < LATE_TRANSCRIPTION_WINDOW_MS;
  const base = currentAITranscript || (lateWindowOpen && lastBot ? (lastBot.textContent || '') : '');
  const baseNorm = normalizeTranscriptCompare(base);

  if (!baseNorm) {
    lastOutputTranscriptionText = incoming;
    accumulateAIText(incoming, { replace: true, allowReplaceLast: false });
    return;
  }

  // Some models send cumulative ASR text; use it if it clearly contains the current transcript.
  const basePrefix = baseNorm.substring(0, Math.min(baseNorm.length, 80));
  if (incoming.length > base.length && basePrefix && incomingNorm.includes(basePrefix)) {
    lastOutputTranscriptionText = incoming;
    accumulateAIText(incoming, { replace: true, allowReplaceLast: Boolean(currentAITranscript) || lateWindowOpen });
    return;
  }

  // If modelTurn.parts already gave us text, short ASR chunks are usually deltas.
  // Appending them creates garbled/repeated text like "new Good ... found".
  if (currentAITranscriptHasModelText) {
    lastOutputTranscriptionText = incoming;
    return;
  }

  // Other models send short ASR deltas. Do not let the last tiny chunk replace the full bubble.
  if (baseNorm.endsWith(incomingNorm) || baseNorm.includes(incomingNorm)) {
    lastOutputTranscriptionText = incoming;
    return;
  }

  const merged = `${base}${transcriptJoiner(base, incoming)}${incoming}`;
  lastOutputTranscriptionText = incoming;
  accumulateAIText(merged, { replace: true, allowReplaceLast: Boolean(currentAITranscript) || lateWindowOpen });
}

function updateLastAITranscript(text) {
  const bubble = document.querySelector('.current-ai-bubble');
  if (bubble) {
    bubble.textContent = sanitizeAITranscriptText(text);
    scrollTranscript();
  }
}

function appendBubble(text, className, idName = '') {
  if (!SHOW_TEXT_TRANSCRIPT || !transcriptFeed) return null;
  const bubble = document.createElement('div');
  bubble.className = `transcript-bubble ${className}`;
  if (idName) bubble.classList.add(idName);
  bubble.textContent = text;
  transcriptFeed.appendChild(bubble);
  scrollTranscript();
  return bubble;
}

function scrollTranscript() {
  if (!SHOW_TEXT_TRANSCRIPT) return;
  const container = document.querySelector('.transcript-container');
  if (!container) return;
  container.scrollTop = container.scrollHeight;
}
