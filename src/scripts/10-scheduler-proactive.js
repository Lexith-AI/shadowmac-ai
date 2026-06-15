/**
 * ShadowMac - Scheduler API integration, notifications, and proactive attention.
 * Split from the original monolithic app.js; loaded as an ordered classic script.
 */

// --- Scheduler / Cron Integration ---
let schedulerPoller = null;
let schedulerPollInFlight = false;

async function readSchedulerResponseJsonWithTimeout(response, timeoutMs = SCHEDULER_API_TIMEOUT_MS) {
  if (typeof readFetchResponseJsonWithTimeout === 'function') {
    return await readFetchResponseJsonWithTimeout(response, timeoutMs);
  }
  return await readSchedulerResponseBodyWithTimeout(response, timeoutMs, () => response.json());
}

async function readSchedulerResponseTextWithTimeout(response, timeoutMs = SCHEDULER_API_TIMEOUT_MS) {
  if (typeof readFetchResponseTextWithTimeout === 'function') {
    return await readFetchResponseTextWithTimeout(response, timeoutMs);
  }
  return await readSchedulerResponseBodyWithTimeout(response, timeoutMs, () => response.text());
}

async function readSchedulerResponseBodyWithTimeout(response, timeoutMs, reader) {
  let timeoutId = null;
  const bodyPromise = reader();
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      if (typeof cancelFetchResponseBody === 'function') cancelFetchResponseBody(response);
      reject(new Error(`Response body timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([bodyPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function schedulerCreateTask(data) {
  try {
    const res = await fetchLocalApiWithTimeout('/api/scheduler/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }, SCHEDULER_API_TIMEOUT_MS);
    return await readSchedulerResponseJsonWithTimeout(res, SCHEDULER_API_TIMEOUT_MS);
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

async function schedulerListTasks(filter = {}) {
  try {
    const params = new URLSearchParams();
    if (filter.type) params.set('type', filter.type);
    if (filter.status) params.set('status', filter.status);
    if (filter.activeOnly) params.set('activeOnly', 'true');
    const res = await fetchLocalApiWithTimeout(`/api/scheduler/tasks?${params.toString()}`, {}, SCHEDULER_API_TIMEOUT_MS);
    return await readSchedulerResponseJsonWithTimeout(res, SCHEDULER_API_TIMEOUT_MS);
  } catch (e) {
    return { status: 'error', error: e.message, tasks: [] };
  }
}

async function schedulerCancelTask(taskId) {
  try {
    const res = await fetchLocalApiWithTimeout(`/api/scheduler/tasks/${taskId}`, { method: 'DELETE' }, SCHEDULER_API_TIMEOUT_MS);
    return await readSchedulerResponseJsonWithTimeout(res, SCHEDULER_API_TIMEOUT_MS);
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

async function schedulerDeleteTask(taskId) {
  try {
    const res = await fetchLocalApiWithTimeout(`/api/scheduler/tasks/${taskId}/delete`, { method: 'POST' }, SCHEDULER_API_TIMEOUT_MS);
    return await readSchedulerResponseJsonWithTimeout(res, SCHEDULER_API_TIMEOUT_MS);
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

async function schedulerRescheduleTask(taskId, data) {
  try {
    const res = await fetchLocalApiWithTimeout(`/api/scheduler/tasks/${taskId}/reschedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }, SCHEDULER_API_TIMEOUT_MS);
    return await readSchedulerResponseJsonWithTimeout(res, SCHEDULER_API_TIMEOUT_MS);
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

async function schedulerGetTask(taskId) {
  try {
    const res = await fetchLocalApiWithTimeout(`/api/scheduler/tasks/${taskId}`, {}, SCHEDULER_API_TIMEOUT_MS);
    return await readSchedulerResponseJsonWithTimeout(res, SCHEDULER_API_TIMEOUT_MS);
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

function getProactiveConfig() {
  const profile = PROACTIVE_PROFILES[normalizeProactiveProfile(proactiveProfile)] || PROACTIVE_PROFILES.balanced;
  return { ...PROACTIVE_PROFILES.balanced, ...profile };
}

function randomBetween(min, max) {
  const low = Math.min(Number(min) || 0, Number(max) || 0);
  const high = Math.max(Number(min) || 0, Number(max) || 0);
  return Math.floor(low + Math.random() * Math.max(1, high - low));
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function getLastProactiveActivityAt() {
  const latestDialogueAt = recentDialogueTurns.length
    ? recentDialogueTurns[recentDialogueTurns.length - 1].at || 0
    : 0;
  return Math.max(lastUserAudioDetectedTime || 0, lastAITurnCompleteTime || 0, latestDialogueAt || 0);
}

function hasProactiveConversationContext() {
  return Boolean(
    screenStream ||
    getActiveSubagentDisplayCount() > 0 ||
    hasProactiveTextContext()
  );
}

function hasProactiveTextContext() {
  return Boolean(
    recentDialogueTurns.length > 0 ||
    (currentUserTranscript || '').trim() ||
    (currentAITranscript || '').trim()
  );
}

function getProactiveDialogueDigest() {
  return recentDialogueTurns
    .slice(-4)
    .map(turn => `${turn.role}:${String(turn.text || '').slice(-180)}`)
    .join('|');
}

function getProactiveSubagentDigest() {
  const subagents = typeof getSubagentStatusList === 'function'
    ? getSubagentStatusList(6)
    : activeSubagents.slice(-6);
  return subagents
    .map(s => [
      s.id,
      s.status,
      `step ${s.step}`,
      s.lastMessage,
      s.evidenceSummary,
      s.lastError,
      s.summary,
      s.authCheckpoint && s.authCheckpoint.message
    ].filter(Boolean).join(':').slice(0, 260))
    .join('|');
}

function getProactiveSignalScore(reason, hints = {}) {
  const noveltyScore = Number(hints.noveltyScore) || 0;
  switch (reason) {
    case 'screen_started': return 8;
    case 'screen_stopped': return 4;
    case 'screen_frame':
      if (isProactiveProfileAtLeast(proactiveProfile, 'immersive')) return Math.max(9, noveltyScore);
      if (isProactiveProfileAtLeast(proactiveProfile, 'lively')) return Math.max(8, noveltyScore);
      if (isProactiveProfileAtLeast(proactiveProfile, 'engaged')) return Math.max(5, noveltyScore);
      return Math.max(2, noveltyScore);
    case 'user_speech': return 6;
    case 'ai_turn_complete': return 5;
    case 'subagent_update': return 8;
    case 'settings_changed': return 5;
    case 'session_ready': return 3;
    case 'idle_reflection': return 1;
    default: return Math.max(1, noveltyScore);
  }
}

function getNoScreenPresenceScore(triggerReason, contextSignal, config) {
  if (screenStream) return 0;

  const trigger = String(triggerReason || '');
  const noScreenTriggers = ['session_ready', 'screen_stopped', 'settings_changed', 'idle_reflection', 'deferred'];
  if (trigger === 'ai_turn_complete' && hasProactiveTextContext()) {
    return Math.max(config.minContextScore, 1);
  }
  if (!noScreenTriggers.includes(trigger)) return 0;

  if (hasProactiveTextContext()) {
    return Math.max(config.minContextScore, Number(contextSignal?.score) || 1);
  }
  if (isProactiveProfileAtLeast(proactiveProfile, 'unhinged')) {
    return Math.max(config.minContextScore, 1);
  }
  return 0;
}

function getProactiveAttentionDelay(reason, score = 0) {
  const config = getProactiveConfig();
  if (reason === 'idle_reflection') {
    return randomBetween(config.idleDelayMs[0], config.idleDelayMs[1]);
  }

  const urgency = clampNumber(score / 10, 0, 1);
  const minEventDelayMs = Number(config.minEventDelayMs) || 900;
  const minDelay = Math.max(minEventDelayMs, config.eventDelayMs[0] * (1 - urgency * 0.45));
  const maxDelay = Math.max(minDelay + 500, config.eventDelayMs[1] * (1 - urgency * 0.35));
  let delay = randomBetween(minDelay, maxDelay);

  if (reason === 'user_speech') delay = Math.max(delay, 7000);
  if (reason === 'screen_frame' && isProactiveProfileAtLeast(proactiveProfile, 'engaged')) {
    delay = Math.min(delay, config.eventDelayMs[1]);
  }
  return delay;
}

function scheduleProactiveAttention(reason = 'idle_reflection', options = {}) {
  if (!proactiveEnabled || !isConnected) return;

  const score = Number(options.score) || (proactiveQueuedSignal && proactiveQueuedSignal.score) || 0;
  const config = getProactiveConfig();
  const minEventDelayMs = Number(config.minEventDelayMs) || 900;
  const delayMs = options.delayMs !== undefined
    ? Math.max(minEventDelayMs, Number(options.delayMs) || 0)
    : getProactiveAttentionDelay(reason, score);
  const desiredAt = Date.now() + delayMs;

  if (proactiveAttentionTimer) {
    if (!options.force && proactiveNextAttentionAt && proactiveNextAttentionAt <= desiredAt) return;
    clearTimeout(proactiveAttentionTimer);
    proactiveAttentionTimer = null;
  }

  proactiveNextAttentionAt = desiredAt;
  proactiveAttentionTimer = setTimeout(() => {
    proactiveAttentionTimer = null;
    proactiveNextAttentionAt = 0;
    runProactiveAttention(reason).catch(err => {
      console.warn('[Proactive] Attention pass failed:', err);
      scheduleProactiveAttention('idle_reflection', { delayMs: 15000, force: true });
    });
  }, delayMs);
}

function signalProactiveAttention(reason, hints = {}) {
  if (!proactiveEnabled || !isConnected) return;

  const now = Date.now();
  if (reason === 'screen_frame') {
    if (now - lastProactiveScreenSignalAt < 2500) return;
    lastProactiveScreenSignalAt = now;
  }

  const score = getProactiveSignalScore(reason, hints);
  if (!proactiveQueuedSignal || score >= proactiveQueuedSignal.score || now - proactiveQueuedSignal.at > 30000) {
    proactiveQueuedSignal = { reason, score, hints, at: now };
  }

  scheduleProactiveAttention(reason, {
    score,
    force: score >= 8
  });
}

function startProactiveAttention(delayMs = null) {
  const config = getProactiveConfig();
  const initialDelayMs = delayMs !== null && delayMs !== undefined
    ? delayMs
    : (screenStream
      ? 5000
      : Math.max(1000, Number(config.minEventDelayMs) || 900, Math.min(12000, Number(config.eventDelayMs?.[0]) || 12000)));
  scheduleProactiveAttention('session_ready', { delayMs: initialDelayMs, force: false });
}

function stopProactiveAttention() {
  if (proactiveAttentionTimer) {
    clearTimeout(proactiveAttentionTimer);
    proactiveAttentionTimer = null;
  }
  proactiveNextAttentionAt = 0;
  proactiveQueuedSignal = null;
  proactiveAttentionInFlight = false;
}

function isSubagentPromptRefinementActive() {
  return Boolean(typeof subagentPromptRefinementInProgress !== 'undefined' && subagentPromptRefinementInProgress);
}

function scheduleNextProactiveAttention(delayMs = null) {
  if (!proactiveEnabled || !isConnected) return;
  if (delayMs !== null) {
    scheduleProactiveAttention('deferred', { delayMs, force: true });
    return;
  }
  scheduleProactiveAttention('idle_reflection');
}

function isSafeForProactiveEvaluation(options = {}) {
  if (!proactiveEnabled) return false;
  if (proactiveAttentionInFlight && !options.allowCurrentAttentionPass) return false;
  if (!isConnected || !socket || socket.readyState !== WebSocket.OPEN) return false;
  if (isSubagentPromptRefinementActive()) return false;
  if (systemNoticeInFlight || suppressInterruptedTurnAudio || turnInProgress || userTurnActive) return false;
  if (currentVisualizerState === 'speaking' || currentVisualizerState === 'thinking' || currentVisualizerState === 'connecting' || currentVisualizerState === 'interrupting') return false;
  if (Date.now() - lastUserAudioDetectedTime < SYSTEM_NOTICE_RECENT_USER_AUDIO_COOLDOWN_MS) return false;
  if (Date.now() - lastVoiceInterruptTime < SYSTEM_NOTICE_AFTER_INTERRUPT_COOLDOWN_MS) return false;
  return true;
}

function getProactiveScreenSnapshot() {
  if (!screenStream || !screenVideo || screenVideo.videoWidth === 0 || screenVideo.videoHeight === 0) return null;
  try {
    const maxW = 360;
    const maxH = 203;
    let width = screenVideo.videoWidth;
    let height = screenVideo.videoHeight;
    if (width > maxW) {
      height = Math.floor(height * (maxW / width));
      width = maxW;
    }
    if (height > maxH) {
      width = Math.floor(width * (maxH / height));
      height = maxH;
    }
    screenCanvas.width = width;
    screenCanvas.height = height;
    const canvasCtx = screenCanvas.getContext('2d');
    canvasCtx.drawImage(screenVideo, 0, 0, width, height);
    const dataUrl = screenCanvas.toDataURL('image/jpeg', 0.32);
    const base64Data = dataUrl.split(',')[1];
    if (!base64Data || base64Data.length > 180000) return null;
    return base64Data;
  } catch (err) {
    console.warn('[Proactive] Screen snapshot failed:', err);
    return null;
  }
}

function getProactiveEvaluatorProfileGuidance(config) {
  if (config.label === 'quiet') {
    return 'Quiet profile: stay silent unless there is a clearly useful reason to speak.';
  }
  if (config.label === 'balanced') {
    return 'Balanced profile: be selective, but a timely comment about recent conversation is welcome.';
  }
  if (config.label === 'engaged') {
    return 'Engaged profile: speak when a recent thread, pause, visible change, or subagent update gives you a natural opening.';
  }
  if (config.label === 'lively') {
    return 'Lively profile: be noticeably present. If idle reflection is eligible and recent dialogue exists, usually speak with one specific thought even without screen sharing.';
  }
  if (config.label === 'immersive') {
    return 'Immersive profile: be highly present. For movie/shared-screen moments and active conversations, react often to concrete context; without screen sharing, keep the conversation alive from recent dialogue.';
  }
  if (config.label === 'unhinged') {
    return 'Unhinged profile: the most present mode. Evaluate frequently and speak on small but real openings (recent dialogue, pauses, visible changes), while still keeping each message short and context-grounded.';
  }
  const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  return `Use the current profile to decide how present ${assistantLabel} should be.`;
}

function buildProactiveEvaluationPrompt(attentionContext = {}) {
  const config = getProactiveConfig();
  const activeCount = getActiveSubagentDisplayCount();
  const latestSubagentStatus = getProactiveRelevantSubagentStatus();
  const secondsSinceUserAudio = Math.round((Date.now() - lastUserAudioDetectedTime) / 1000);
  const secondsSinceAiSpoke = lastAITurnCompleteTime > 0 ? Math.round((Date.now() - lastAITurnCompleteTime) / 1000) : null;
  const secondsSinceProactiveSpeech = lastProactiveSpokeAt > 0 ? Math.round((Date.now() - lastProactiveSpokeAt) / 1000) : null;
  const contextSignal = attentionContext.contextSignal || {};
  const triggerReason = attentionContext.triggerReason || 'unknown';
  const noveltyReasons = (contextSignal.reasons || []).join(', ') || '(none)';
  const noveltyScore = Number(attentionContext.mergedScore || contextSignal.score || 0);

  const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  return `You are ${assistantLabel}'s proactive attention evaluator. Decide if ${assistantLabel} should speak right now.
${assistantLabel} should feel like it has intuition, taste, and situational awareness, not a timer.

Return ONLY strict JSON:
{"action":"silent","reason":"short reason"}
or
{"action":"speak","message":"one short natural sentence ${assistantLabel} should say","reason":"short reason"}

Rules:
- For quiet/balanced, default to silent. For engaged and above, be increasingly willing to speak when there is recent dialogue or a natural pause, even without screen sharing.
- Speak only when there is a specific reason: a useful observation, an unresolved thread, a meaningful visible change, a subagent update, or a fitting screen-aware reaction.
- Do not claim research/background work is happening unless Active subagents is greater than 0 or the latest subagent status is running/waiting_auth.
- Completed, partial, failed, and cancelled subagents are historical. Mention them only as finished history, never as work currently being done.
- If screen sharing is active, react only to a clearly interesting, funny, surprising, or task-relevant visible moment.
- If screen sharing is inactive, recent dialogue, an unresolved thread, or an emotionally fitting callback can be enough reason in engaged/lively/immersive/hyper/unhinged modes.
- If this is an idle reflection, speak only if the thought directly connects to recent dialogue or visible context; in lively and higher modes, prefer speaking when recent dialogue exists.
- Never speak only because time passed.
- Do not ask generic check-in questions unless there is a strong contextual reason.
- Do not mention attention notices, JSON, evaluator, system notice, proactive mode, timers, or screenshots.
- Keep message under 22 words.
- Current proactive profile: ${config.label} (${config.description}).
- Profile guidance: ${getProactiveEvaluatorProfileGuidance(config)}
- Attention trigger: ${triggerReason}.
- Context novelty score: ${noveltyScore}.
- Context novelty reasons: ${noveltyReasons}.
- Idle reflection eligible: ${attentionContext.idleReflection ? 'yes' : 'no'}.
- Max quiet window reached: ${attentionContext.maxQuietDue ? 'yes' : 'no'}.
- Screen sharing: ${screenStream ? 'active' : 'inactive'}.
- Current UI state: ${currentVisualizerState}.
- Active subagents: ${activeCount}.
- Latest active/recent subagent: ${latestSubagentStatus ? `[${latestSubagentStatus.id}] ${latestSubagentStatus.status}; activity=${latestSubagentStatus.activityState || (latestSubagentStatus.isActive ? 'active' : 'historical')}; ${latestSubagentStatus.lastMessage || latestSubagentStatus.task || ''}; evidence=${latestSubagentStatus.evidenceSummary || 'none'}; idle=${latestSubagentStatus.idleSeconds === null ? 'unknown' : `${latestSubagentStatus.idleSeconds}s`}; completedAge=${latestSubagentStatus.completedAgeSeconds === null || latestSubagentStatus.completedAgeSeconds === undefined ? 'n/a' : `${latestSubagentStatus.completedAgeSeconds}s`}` : 'none'}.
- Seconds since user audio: ${Number.isFinite(secondsSinceUserAudio) ? secondsSinceUserAudio : 'unknown'}.
- Seconds since ${assistantLabel} last spoke: ${secondsSinceAiSpoke === null ? 'unknown' : secondsSinceAiSpoke}.
- Seconds since last proactive speech: ${secondsSinceProactiveSpeech === null ? 'never' : secondsSinceProactiveSpeech}.
- Recent user transcript: ${(currentUserTranscript || '').slice(-500) || '(none)'}.
- Recent ${assistantLabel} transcript: ${(recentAIOutputForEcho || currentAITranscript || '').slice(-700) || '(none)'}.
- Recent dialogue:
${formatRecentDialogueTurns() || '(none)'}
- Previous proactive decision reason: ${lastProactiveDecisionReason || '(none)'}.`;
}

function parseProactiveDecision(text) {
  const raw = String(text || '').trim();
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  try {
    const parsed = JSON.parse(jsonText);
    const action = String(parsed.action || 'silent').toLowerCase();
    const message = String(parsed.message || '').trim();
    const reason = String(parsed.reason || '').trim();
    if (action === 'speak' && message) {
      return { action: 'speak', message: message.slice(0, 240), reason };
    }
    return { action: 'silent', reason };
  } catch (err) {
    return { action: 'silent', reason: `unparseable decision: ${raw.slice(0, 120)}` };
  }
}

function isTimeoutError(err) {
  return /timed out|abort/i.test(String(err && err.message || ''));
}

function isTransientProactiveError(err) {
  const status = Number(err && err.status) || Number(String(err && err.message || '').match(/\b(429|5\d\d)\b/)?.[1]);
  return status === 429 || status >= 500 || isTimeoutError(err);
}

function getProactiveRelevantSubagentStatus(now = Date.now()) {
  const payloads = typeof getSubagentStatusList === 'function'
    ? getSubagentStatusList(8, now)
    : activeSubagents.slice(-8).map(subagent => typeof getSubagentStatusPayload === 'function'
      ? getSubagentStatusPayload(subagent, now)
      : subagent).filter(Boolean);
  const active = payloads.filter(item => item && item.isActive);
  if (active.length > 0) return active[active.length - 1];
  const recentTerminal = payloads
    .filter(item => item && item.isTerminal && Number(item.completedAgeSeconds) <= 120)
    .slice(-1)[0];
  return recentTerminal || null;
}

function buildLocalProactiveFallbackDecision(attentionContext = {}, err = null) {
  const trigger = attentionContext.triggerReason || 'unknown';
  const score = Number(attentionContext.mergedScore) || 0;
  const reasons = attentionContext.contextSignal?.reasons || [];
  const latestSubagent = getProactiveRelevantSubagentStatus();

  if (latestSubagent && ['completed', 'failed', 'partial', 'waiting_auth'].includes(latestSubagent.status)) {
    if (latestSubagent.status === 'completed') {
      return { action: 'speak', message: 'Quick update: the background task finished.', reason: 'local fallback: subagent completed' };
    }
    if (latestSubagent.status === 'waiting_auth') {
      return { action: 'speak', message: 'I need you for a login or verification step before I can keep going.', reason: 'local fallback: subagent waiting for auth' };
    }
    if (latestSubagent.status === 'partial') {
      return { action: 'speak', message: 'Quick update: the background task finished with something left to check.', reason: 'local fallback: subagent partial' };
    }
    return { action: 'speak', message: 'Quick update: the background task needs attention.', reason: 'local fallback: subagent failed' };
  }

  if (trigger === 'screen_started') {
    return { action: 'speak', message: "I can see your screen now; I'll stay selective.", reason: 'local fallback: screen sharing started' };
  }

  if (attentionContext.maxQuietDue && hasProactiveConversationContext()) {
    return { action: 'speak', message: "I'm still here with you, just staying quiet until I have something useful.", reason: 'local fallback: max quiet window' };
  }

  if (!screenStream && hasProactiveTextContext() && isProactiveProfileAtLeast(proactiveProfile, 'lively') && ['idle_reflection', 'deferred', 'ai_turn_complete'].includes(trigger)) {
    return { action: 'speak', message: 'I was still thinking about that thread with you.', reason: 'local fallback: no-screen recent dialogue' };
  }

  if (!screenStream && isProactiveProfileAtLeast(proactiveProfile, 'unhinged') && ['session_ready', 'idle_reflection', 'deferred'].includes(trigger)) {
    return { action: 'speak', message: "I'm here and staying actively with you.", reason: 'local fallback: no-screen extreme presence' };
  }

  if (screenStream && isProactiveProfileAtLeast(proactiveProfile, 'immersive') && ['screen_frame', 'idle_reflection'].includes(trigger)) {
    return { action: 'speak', message: 'I am watching with you; that moment had a definite shift.', reason: 'local fallback: immersive screen presence' };
  }

  if (screenStream && score >= 12 && isProactiveProfileAtLeast(proactiveProfile, 'engaged')) {
    return { action: 'speak', message: 'Something on screen shifted pretty noticeably.', reason: 'local fallback: high screen novelty' };
  }

  return {
    action: 'silent',
    reason: `local fallback silent after evaluator issue: ${err?.message || reasons.join(', ') || trigger}`
  };
}

function shouldUseProactiveFallback(err, attentionContext = {}) {
  const transient = isTransientProactiveError(err);
  if (!transient) return false;
  if (attentionContext.maxQuietDue) return true;
  if (attentionContext.triggerReason === 'screen_started') return true;
  if (attentionContext.triggerReason === 'subagent_update') return true;
  if (!screenStream && hasProactiveTextContext() && isProactiveProfileAtLeast(proactiveProfile, 'lively')) return true;
  if (!screenStream && isProactiveProfileAtLeast(proactiveProfile, 'unhinged')) return true;
  if (screenStream && isProactiveProfileAtLeast(proactiveProfile, 'lively')) return true;
  if (screenStream && isProactiveProfileAtLeast(proactiveProfile, 'engaged') && Number(attentionContext.mergedScore) >= 12) return true;
  return false;
}

function normalizeGeminiModelName(model) {
  const raw = String(model || '').trim();
  if (!raw) return '';
  return raw.startsWith('models/') ? raw : `models/${raw}`;
}

function getProactiveEvaluatorModel(model = selectedModel) {
  const activeModel = normalizeGeminiModelName(model);
  if (!activeModel) return PROACTIVE_EVALUATOR_FALLBACK_MODEL;

  if (PROACTIVE_EVALUATOR_MODEL_BY_LIVE_MODEL[activeModel]) {
    return PROACTIVE_EVALUATOR_MODEL_BY_LIVE_MODEL[activeModel];
  }

  let evaluatorModel = activeModel
    .replace('-native-audio-latest', '')
    .replace('-native-audio-preview-09-2025', '')
    .replace('-live-preview', '');

  if (evaluatorModel === 'models/gemini-3.1-flash') return 'models/gemini-3.1-flash-lite';
  if (evaluatorModel === 'models/gemini-3-flash') return 'models/gemini-3-flash-preview';

  return evaluatorModel || PROACTIVE_EVALUATOR_FALLBACK_MODEL;
}

function parseRetryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const retryDate = Date.parse(value);
  if (Number.isFinite(retryDate)) return Math.max(0, retryDate - Date.now());

  return 0;
}

async function buildGeminiApiError(res, model) {
  const err = new Error(`Gemini proactive evaluator returned ${res.status} for ${model}`);
  err.status = res.status;
  err.retryAfterMs = parseRetryAfterMs(res.headers?.get?.('retry-after'));
  try {
    err.responseText = (await readSchedulerResponseTextWithTimeout(res, PROACTIVE_EVALUATOR_TIMEOUT_MS)).slice(0, 500);
  } catch (e) {}
  return err;
}

async function evaluateProactiveAttention(attentionContext = {}) {
  const prompt = buildProactiveEvaluationPrompt(attentionContext);
  const parts = [{ text: prompt }];
  const screenSnapshot = getProactiveScreenSnapshot();
  if (screenSnapshot) {
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: screenSnapshot
      }
    });
  }

  const proactiveModel = getProactiveEvaluatorModel(selectedModel);
  console.debug(`[Proactive] Evaluating with ${proactiveModel} (main model: ${selectedModel})`);
  const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/${proactiveModel}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: screenStream || isProactiveProfileAtLeast(proactiveProfile, 'lively') ? 0.7 : 0.35,
        maxOutputTokens: 90,
        responseMimeType: 'application/json'
      }
    })
  }, PROACTIVE_EVALUATOR_TIMEOUT_MS);

  if (!res.ok) {
    throw await buildGeminiApiError(res, proactiveModel);
  }
  const data = await readSchedulerResponseJsonWithTimeout(res, PROACTIVE_EVALUATOR_TIMEOUT_MS);
  const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
  return parseProactiveDecision(text);
}

let lastProactiveContext = {
  transcriptLength: 0,
  aiTranscriptLength: 0,
  dialogueDigest: '',
  subagentDigest: '',
  screenPixels: null,
  screenDiff: 0
};

function collectProactiveContextSignal() {
  const config = getProactiveConfig();
  const currentTLength = (currentUserTranscript || '').length;
  const currentAILength = (currentAITranscript || '').length;
  const dialogueDigest = getProactiveDialogueDigest();
  const subagentDigest = getProactiveSubagentDigest();

  const reasons = [];
  let score = 0;

  if (currentTLength !== lastProactiveContext.transcriptLength) {
    reasons.push('user transcript changed');
    score += currentTLength > lastProactiveContext.transcriptLength ? 5 : 3;
  }

  if (currentAILength !== lastProactiveContext.aiTranscriptLength) {
    reasons.push('Shadow transcript changed');
    score += currentAILength > lastProactiveContext.aiTranscriptLength ? 4 : 2;
  }

  if (dialogueDigest && dialogueDigest !== lastProactiveContext.dialogueDigest) {
    reasons.push('recent dialogue changed');
    score += 4;
  }

  if (subagentDigest !== lastProactiveContext.subagentDigest) {
    reasons.push('subagent state changed');
    score += 7;
  }

  lastProactiveContext.transcriptLength = currentTLength;
  lastProactiveContext.aiTranscriptLength = currentAILength;
  lastProactiveContext.dialogueDigest = dialogueDigest;
  lastProactiveContext.subagentDigest = subagentDigest;

  if (!screenStream || !screenVideo || screenVideo.videoWidth === 0) {
    lastProactiveContext.screenPixels = null;
    lastProactiveContext.screenDiff = 0;
    const timeSinceLastCheck = lastProactiveCheckAt ? Date.now() - lastProactiveCheckAt : Number.POSITIVE_INFINITY;
    const idleHeartbeatDue = timeSinceLastCheck > config.idleReflectionAfterMs / 2;
    if (idleHeartbeatDue && hasProactiveTextContext()) {
      reasons.push('no-screen dialogue heartbeat');
      score += Math.max(config.minContextScore, isProactiveProfileAtLeast(proactiveProfile, 'lively') ? 3 : 1);
    } else if (idleHeartbeatDue && isProactiveProfileAtLeast(proactiveProfile, 'unhinged')) {
      reasons.push('no-screen extreme presence heartbeat');
      score += Math.max(config.minContextScore, 1);
    }
    return { changed: score > 0, score: Math.round(score), reasons, screenDiff: 0 };
  }

  try {
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 32;
    thumbCanvas.height = 32;
    const ctx = thumbCanvas.getContext('2d');
    ctx.drawImage(screenVideo, 0, 0, 32, 32);
    const imgData = ctx.getImageData(0, 0, 32, 32).data;

    if (!lastProactiveContext.screenPixels) {
      lastProactiveContext.screenPixels = imgData;
      lastProactiveContext.screenDiff = 0;
      reasons.push('screen became visible');
      score += 5;
      return { changed: true, score: Math.round(score), reasons, screenDiff: 0 };
    }

    let diff = 0;
    const len = imgData.length;
    for (let i = 0; i < len; i += 4) {
      diff += Math.abs(imgData[i] - lastProactiveContext.screenPixels[i]);
      diff += Math.abs(imgData[i+1] - lastProactiveContext.screenPixels[i+1]);
      diff += Math.abs(imgData[i+2] - lastProactiveContext.screenPixels[i+2]);
    }
    const avgDiff = diff / ((len / 4) * 3);

    lastProactiveContext.screenPixels = imgData;
    lastProactiveContext.screenDiff = avgDiff;

    if (avgDiff > config.screenDiffThreshold) {
      reasons.push(`screen changed (${avgDiff.toFixed(1)})`);
      score += clampNumber(3 + avgDiff / 3, 3, 10);
    }
  } catch (err) {
    reasons.push('screen change could not be measured');
    score += 3;
  }

  return { changed: score > 0, score: Math.round(score), reasons, screenDiff: lastProactiveContext.screenDiff || 0 };
}

function hasProactiveContextChanged() {
  return collectProactiveContextSignal().changed;
}

function isProactiveIdleReflectionDue(triggerReason) {
  if (!hasProactiveConversationContext()) return false;
  if (triggerReason !== 'idle_reflection' && triggerReason !== 'deferred') return false;
  const config = getProactiveConfig();
  const lastActivityAt = getLastProactiveActivityAt();
  if (!lastActivityAt) return false;
  return Date.now() - lastActivityAt >= config.idleReflectionAfterMs;
}

function isProactiveMaxQuietDue() {
  if (!hasProactiveConversationContext()) return false;
  const config = getProactiveConfig();
  const lastActivityAt = getLastProactiveActivityAt();
  if (!lastActivityAt) return false;
  const lastSpeechOrActivity = Math.max(lastProactiveSpokeAt || 0, lastActivityAt);
  return Date.now() - lastSpeechOrActivity >= config.maxQuietMs;
}

async function runProactiveAttention(triggerReason = 'idle_reflection') {
  if (!proactiveEnabled || !isConnected) return;
  const apiBackoffRemainingMs = proactiveApiBackoffUntil - Date.now();
  if (apiBackoffRemainingMs > 0) {
    scheduleNextProactiveAttention(apiBackoffRemainingMs);
    return;
  }
  if (!isSafeForProactiveEvaluation()) {
    scheduleNextProactiveAttention(2500);
    return;
  }

  const queuedSignal = proactiveQueuedSignal;
  proactiveQueuedSignal = null;
  const config = getProactiveConfig();
  const contextSignal = collectProactiveContextSignal();
  const signalScore = queuedSignal ? queuedSignal.score : 0;
  const effectiveTrigger = queuedSignal ? queuedSignal.reason : triggerReason;
  const noScreenPresenceScore = getNoScreenPresenceScore(effectiveTrigger, contextSignal, config);
  const mergedScore = contextSignal.score + signalScore + noScreenPresenceScore;
  const idleReflection = isProactiveIdleReflectionDue(effectiveTrigger);
  const maxQuietDue = isProactiveMaxQuietDue();
  const triggerWorthEvaluating = signalScore >= config.minContextScore ||
    noScreenPresenceScore >= config.minContextScore ||
    ['screen_started', 'screen_stopped', 'session_ready', 'subagent_update', 'settings_changed'].includes(effectiveTrigger);
  const contextWorthEvaluating = (contextSignal.changed || triggerWorthEvaluating) && mergedScore >= config.minContextScore;

  const minGapRemaining = config.minEvalGapMs - (Date.now() - lastProactiveCheckAt);
  if (minGapRemaining > 0 && !maxQuietDue) {
    scheduleNextProactiveAttention(minGapRemaining);
    return;
  }

  if (!contextWorthEvaluating && !idleReflection && !maxQuietDue) {
    scheduleNextProactiveAttention();
    return;
  }

  proactiveAttentionInFlight = true;
  lastProactiveCheckAt = Date.now();
  let delayOverride = null;
  let attentionContext = null;
  try {
    attentionContext = {
      triggerReason: effectiveTrigger,
      contextSignal,
      mergedScore,
      idleReflection,
      maxQuietDue
    };
    const decision = await evaluateProactiveAttention(attentionContext);
    proactiveConsecutiveApiFailures = 0;
    proactiveApiBackoffUntil = 0;
    lastProactiveDecisionReason = decision.reason || decision.action;
    const canSpeak = Date.now() - lastProactiveSpokeAt >= config.minSpeakGapMs;
    if (decision.action === 'speak' && canSpeak && isSafeForProactiveEvaluation({ allowCurrentAttentionPass: true })) {
      lastProactiveSpokeAt = Date.now();
      queueSchedulerMessage(`[PROACTIVE ATTENTION]\nSay this naturally in your own voice, as one short sentence: "${decision.message}"`, {
        lane: 'proactive',
        ttlMs: 12000
      });
      addSystemMessage(`[Proactive] Queued: ${decision.message}`);
    } else {
      console.debug('[Proactive] Silent:', decision.reason || (canSpeak ? 'no reason' : 'cooldown'));
    }
  } catch (err) {
    const status = err.status || Number(String(err.message || '').match(/\b(400|403|404|429)\b/)?.[1]);
    if ([400, 403, 404, 429].includes(status) || status >= 500) {
      proactiveConsecutiveApiFailures = Math.min(proactiveConsecutiveApiFailures + 1, 6);
      const retryAfterMs = Number(err.retryAfterMs) || 0;
      const exponentialBackoffMs = PROACTIVE_API_MIN_BACKOFF_MS * (2 ** (proactiveConsecutiveApiFailures - 1));
      delayOverride = Math.min(
        PROACTIVE_API_MAX_BACKOFF_MS,
        Math.max(PROACTIVE_API_MIN_BACKOFF_MS, retryAfterMs, exponentialBackoffMs)
      );
      proactiveApiBackoffUntil = Date.now() + delayOverride;
      const responseHint = err.responseText ? ` Response: ${err.responseText}` : '';
      console.warn(`[Proactive] Evaluator unavailable (${err.message}). Backing off for ${Math.round(delayOverride / 1000)} seconds.${responseHint}`);
      if (shouldUseProactiveFallback(err, attentionContext)) {
        const fallbackDecision = buildLocalProactiveFallbackDecision(attentionContext, err);
        lastProactiveDecisionReason = fallbackDecision.reason || 'local fallback';
        const canSpeak = Date.now() - lastProactiveSpokeAt >= config.minSpeakGapMs;
        if (fallbackDecision.action === 'speak' && canSpeak && isSafeForProactiveEvaluation({ allowCurrentAttentionPass: true })) {
          lastProactiveSpokeAt = Date.now();
          queueSchedulerMessage(`[PROACTIVE ATTENTION]\nSay this naturally in your own voice, as one short sentence: "${fallbackDecision.message}"`, {
            lane: 'proactive',
            ttlMs: 12000
          });
          addSystemMessage(`[Proactive] Local fallback queued: ${fallbackDecision.message}`);
        }
      }
    } else {
      if (shouldUseProactiveFallback(err, attentionContext)) {
        const fallbackDecision = buildLocalProactiveFallbackDecision(attentionContext, err);
        lastProactiveDecisionReason = fallbackDecision.reason || 'local fallback';
        const canSpeak = Date.now() - lastProactiveSpokeAt >= config.minSpeakGapMs;
        if (fallbackDecision.action === 'speak' && canSpeak && isSafeForProactiveEvaluation({ allowCurrentAttentionPass: true })) {
          lastProactiveSpokeAt = Date.now();
          queueSchedulerMessage(`[PROACTIVE ATTENTION]\nSay this naturally in your own voice, as one short sentence: "${fallbackDecision.message}"`, {
            lane: 'proactive',
            ttlMs: 12000
          });
          addSystemMessage(`[Proactive] Local fallback queued: ${fallbackDecision.message}`);
        } else {
          console.debug('[Proactive] Local fallback silent:', fallbackDecision.reason || (canSpeak ? 'no reason' : 'cooldown'));
        }
      } else {
        console.warn('[Proactive] Evaluation failed:', err);
      }
    }
  } finally {
    proactiveAttentionInFlight = false;
    scheduleNextProactiveAttention(delayOverride);
  }
}

// Queue for scheduler notifications that arrive while Shadow is speaking
let pendingSchedulerNotifications = [];

function startSchedulerPoller() {
  if (schedulerPoller) return;
  schedulerPoller = setInterval(async () => {
    if (schedulerPollInFlight) return;
    schedulerPollInFlight = true;
    try {
      const res = await fetchLocalApiWithTimeout('/api/scheduler/notifications', {}, SCHEDULER_NOTIFICATION_TIMEOUT_MS);
      const data = await readSchedulerResponseJsonWithTimeout(res, SCHEDULER_NOTIFICATION_TIMEOUT_MS);
      if (data.status === 'success' && data.notifications && data.notifications.length > 0) {
        for (const notification of data.notifications) {
          // If Shadow is currently speaking or thinking, queue the notification
          if (suppressInterruptedTurnAudio || currentVisualizerState === 'speaking' || currentVisualizerState === 'thinking' || currentVisualizerState === 'interrupting') {
            console.log('[Scheduler] Queuing notification (AI is busy):', notification.message);
            pendingSchedulerNotifications.push(notification);
          } else {
            handleSchedulerNotification(notification);
          }
        }
      }

      // Drain the queue when Shadow is idle/listening
      if (pendingSchedulerNotifications.length > 0 &&
          currentVisualizerState !== 'speaking' &&
          currentVisualizerState !== 'thinking' &&
          currentVisualizerState !== 'interrupting' &&
          !suppressInterruptedTurnAudio) {
        const next = pendingSchedulerNotifications.shift();
        console.log('[Scheduler] Delivering queued notification:', next.message);
        handleSchedulerNotification(next);
      }
    } catch (e) {
      console.debug('[Scheduler] Notification poll failed:', e.message);
    } finally {
      schedulerPollInFlight = false;
    }
  }, 2000);
}

function stopSchedulerPoller() {
  if (schedulerPoller) {
    clearInterval(schedulerPoller);
    schedulerPoller = null;
  }
}

async function handleSchedulerNotification(notification) {
  const type = notification.type || 'reminder';
  const message = notification.message || '';

  if (type === 'reminder' || type === 'recurring') {
    addSystemMessage(`Ã¢ÂÂ° Reminder: ${message}`);
    queueSchedulerMessage(`This is a scheduled reminder. Please announce this to the user in your natural voice and style: "${message}"`, {
      critical: true,
      lane: 'reminder',
      dedupeKey: notification.id || notification.taskId || `reminder:${message}`
    });
  } else if (type === 'subagent_task') {
    addSystemMessage(`Ã¢ÂÂ° Scheduled Subagent Task: ${message}`);
    let steerMsg = `[SCHEDULED SUBAGENT TASK] It's time to execute a scheduled task. Please spawn a background subagent with this task: "${message}"`;
    if (notification.subagentProvider) {
      steerMsg += ` Use the ${notification.subagentProvider} provider`;
      if (notification.subagentModel) steerMsg += ` with model ${notification.subagentModel}`;
      steerMsg += '.';
    }
    queueSchedulerMessage(steerMsg, {
      critical: true,
      lane: 'scheduler',
      dedupeKey: notification.id || notification.taskId || `subagent_task:${message}`
    });
  } else if (type === 'main_agent_task') {
    addSystemMessage(`Ã¢ÂÂ° Scheduled Main Agent Task: ${message}`);
    queueSchedulerMessage(`[SCHEDULED TASK] It's time to execute a scheduled task. Please do the following: "${message}". Execute this immediately.`, {
      critical: true,
      lane: 'scheduler',
      dedupeKey: notification.id || notification.taskId || `main_agent_task:${message}`
    });
  }
}

// Queue messages so they don't interrupt the AI mid-speech
function queueSchedulerMessage(text, options = {}) {
  const noticeText = String(text || '');
  const now = Date.now();
  const critical = Boolean(options.critical);
  const lane = normalizeNotificationLane(options.lane, critical);
  const ttlMs = Number(options.ttlMs) || (critical ? 10 * 60 * 1000 : 30000);
  const dedupeTtlMs = Number(options.dedupeTtlMs) || NOTIFICATION_DEDUPE_TTL_MS;
  const dedupeKey = String(options.dedupeKey || `${lane}:${normalizeNotificationTextForKey(noticeText)}`);
  if (!noticeText.trim() || !dedupeKey.trim()) return null;

  pruneNotificationCaches(now);
  if (notificationSeenKeys.has(dedupeKey)) {
    console.debug('[Scheduler] Dropped duplicate queued notification:', dedupeKey);
    updateDiagnosticsPanel();
    return null;
  }

  const item = {
    id: options.id || `notice_${++notificationSequence}`,
    text: noticeText,
    lane,
    dedupeKey,
    critical,
    createdAt: now,
    speechSeq: userSpeechSeq,
    ttlMs,
    dedupeTtlMs,
    source: options.source || lane,
    // Snapshot the spawn generation so a subagent status notice that gets superseded by a newer
    // spawn before it is delivered can be recognized as stale and skipped (see delivery below).
    spawnGen: typeof subagentSpawnGeneration === 'number' ? subagentSpawnGeneration : 0
  };
  notificationSeenKeys.set(dedupeKey, { at: now, ttlMs: dedupeTtlMs, id: item.id });
  pendingNotifications.push(item);
  updateDiagnosticsPanel();
  tryDeliverPendingNotifications();
  return item.id;
}

function normalizePendingNotification(item) {
  if (typeof item === 'string') {
    const lane = 'default';
    return {
      id: `legacy_${++notificationSequence}`,
      text: item,
      lane,
      dedupeKey: `${lane}:${normalizeNotificationTextForKey(item)}`,
      critical: false,
      createdAt: Date.now(),
      speechSeq: userSpeechSeq,
      ttlMs: 30000,
      dedupeTtlMs: NOTIFICATION_DEDUPE_TTL_MS,
      source: lane
    };
  }
  if (!item) {
    return normalizePendingNotification('');
  }
  const critical = Boolean(item.critical);
  const lane = normalizeNotificationLane(item.lane, critical);
  return {
    ...item,
    id: item.id || `notice_${++notificationSequence}`,
    text: String(item.text || ''),
    lane,
    dedupeKey: item.dedupeKey || `${lane}:${normalizeNotificationTextForKey(item.text || '')}`,
    critical,
    createdAt: Number(item.createdAt) || Date.now(),
    speechSeq: Number.isFinite(item.speechSeq) ? item.speechSeq : userSpeechSeq,
    ttlMs: Number(item.ttlMs) || (critical ? 10 * 60 * 1000 : 30000),
    dedupeTtlMs: Number(item.dedupeTtlMs) || NOTIFICATION_DEDUPE_TTL_MS,
    source: item.source || lane
  };
}

function dropStaleNonCriticalNotifications() {
  const now = Date.now();
  pendingNotifications = pendingNotifications
    .map(normalizePendingNotification)
    .filter(item => item.critical || (item.speechSeq === userSpeechSeq && now - item.createdAt <= item.ttlMs));
  pruneNotificationCaches(now);
  updateDiagnosticsPanel();
}

function isSafeToInjectSystemNotice() {
  if (!isConnected || !socket || socket.readyState !== WebSocket.OPEN) return false;
  if (isSubagentPromptRefinementActive()) return false;
  if (systemNoticeInFlight || suppressInterruptedTurnAudio || turnInProgress || userTurnActive) return false;
  if (currentVisualizerState === 'speaking' || currentVisualizerState === 'thinking' || currentVisualizerState === 'connecting' || currentVisualizerState === 'interrupting') return false;

  // Guard: if user has spoken recently, do NOT inject system notices.
  // This prevents system notices from interrupting/colliding with user speech turns.
  if (Date.now() - lastUserAudioDetectedTime < SYSTEM_NOTICE_RECENT_USER_AUDIO_COOLDOWN_MS) return false;
  if (Date.now() - lastVoiceInterruptTime < SYSTEM_NOTICE_AFTER_INTERRUPT_COOLDOWN_MS) return false;

  if (lastAITurnCompleteTime > 0) {
    const elapsed = Date.now() - lastAITurnCompleteTime;
    if (elapsed < NOTIFICATION_COOLDOWN_MS) return false;
  }
  return true;
}

function getPendingNotificationBlockReason() {
  if (!isConnected) return 'not connected';
  if (!socket || socket.readyState !== WebSocket.OPEN) return 'socket not open';
  if (systemNoticeInFlight) return 'notice in flight';
  if (isSubagentPromptRefinementActive()) return 'subagent prompt refinement active';
  if (suppressInterruptedTurnAudio) return 'interrupted audio cleanup';
  if (turnInProgress) return `turn busy (${shadowTurnState.phase})`;
  if (userTurnActive) return 'user turn active';
  if (currentVisualizerState === 'speaking' || currentVisualizerState === 'thinking' || currentVisualizerState === 'connecting' || currentVisualizerState === 'interrupting') {
    return `visualizer ${currentVisualizerState}`;
  }
  if (Date.now() - lastUserAudioDetectedTime < SYSTEM_NOTICE_RECENT_USER_AUDIO_COOLDOWN_MS) return 'recent user audio';
  if (Date.now() - lastVoiceInterruptTime < SYSTEM_NOTICE_AFTER_INTERRUPT_COOLDOWN_MS) return 'recent voice interruption';
  if (lastAITurnCompleteTime > 0) {
    const elapsed = Date.now() - lastAITurnCompleteTime;
    if (elapsed < NOTIFICATION_COOLDOWN_MS) return `cooldown ${Math.ceil((NOTIFICATION_COOLDOWN_MS - elapsed) / 1000)}s`;
  }
  return 'ready';
}

function getSystemNoticeRetryDelay() {
  if (isSubagentPromptRefinementActive()) return 1000;
  const userAudioRemaining = SYSTEM_NOTICE_RECENT_USER_AUDIO_COOLDOWN_MS - (Date.now() - lastUserAudioDetectedTime);
  if (userAudioRemaining > 0) return Math.max(userAudioRemaining + 100, 500);
  const interruptRemaining = SYSTEM_NOTICE_AFTER_INTERRUPT_COOLDOWN_MS - (Date.now() - lastVoiceInterruptTime);
  if (interruptRemaining > 0) return Math.max(interruptRemaining + 100, 500);
  if (lastAITurnCompleteTime > 0) {
    const elapsed = Date.now() - lastAITurnCompleteTime;
    const remaining = NOTIFICATION_COOLDOWN_MS - elapsed;
    if (remaining > 0) return Math.max(remaining + 100, 500);
  }
  return 1000;
}

function schedulePendingNotificationRetry(delay = getSystemNoticeRetryDelay()) {
  dropStaleNonCriticalNotifications();
  if (pendingNotificationRetryTimer || pendingNotifications.length === 0) return;
  pendingNotificationRetryTimer = setTimeout(() => {
    pendingNotificationRetryTimer = null;
    tryDeliverPendingNotifications();
  }, delay);
}

function markSystemNoticeInFlight() {
  systemNoticeInFlight = true;
  clearTimeout(systemNoticeInFlightTimer);
  systemNoticeInFlightTimer = setTimeout(() => {
    systemNoticeInFlight = false;
    updateDiagnosticsPanel();
    tryDeliverPendingNotifications();
  }, SYSTEM_NOTICE_INFLIGHT_TIMEOUT_MS);
  updateDiagnosticsPanel();
}

function clearSystemNoticeInFlight() {
  systemNoticeInFlight = false;
  clearTimeout(systemNoticeInFlightTimer);
  systemNoticeInFlightTimer = null;
  updateDiagnosticsPanel();
}

function clearPendingSystemNotifications(reason = '') {
  const clearedCount = pendingNotifications.length;
  pendingNotifications = [];
  clearTimeout(pendingNotificationRetryTimer);
  pendingNotificationRetryTimer = null;
  clearSystemNoticeInFlight();
  if (clearedCount > 0) {
    console.warn(`[Scheduler] Cleared ${clearedCount} pending notification(s)${reason ? `: ${reason}` : ''}`);
  }
  updateDiagnosticsPanel();
  return clearedCount;
}

function tryDeliverPendingNotifications() {
  dropStaleNonCriticalNotifications();
  if (pendingNotifications.length === 0) return;
  if (!isSafeToInjectSystemNotice()) {
    updateDiagnosticsPanel();
    schedulePendingNotificationRetry();
    return;
  }

  const next = getNextPendingNotification();
  if (!next) return;
  const item = normalizePendingNotification(pendingNotifications.splice(next.index, 1)[0]);
  const text = item.text;
  if (!text) return;
  // Skip a stale subagent status notice: it was queued before a newer subagent spawned, so the task
  // it reports on is no longer the one in flight. Voicing "the calculator is done" while a freshly
  // spawned subagent is still building one makes the model conflate them and appear to lie. The
  // completion already produced a transcript bubble + chime, so the user was still informed.
  if (item.lane === 'subagent' && Number(item.spawnGen || 0) < (typeof subagentSpawnGeneration === 'number' ? subagentSpawnGeneration : 0)) {
    console.log(`[Scheduler] Skipped stale subagent notice ${item.id} (spawn gen ${item.spawnGen} < current ${subagentSpawnGeneration}); a newer subagent has since spawned.`);
    deliveredNotificationIds.add(item.id);
    updateDiagnosticsPanel();
    if (pendingNotifications.length > 0) schedulePendingNotificationRetry(NOTIFICATION_COOLDOWN_MS);
    return;
  }
  if (deliveredNotificationIds.has(item.id)) {
    console.debug('[Scheduler] Skipping already delivered notification id:', item.id);
    updateDiagnosticsPanel();
    if (pendingNotifications.length > 0) schedulePendingNotificationRetry(NOTIFICATION_COOLDOWN_MS);
    return;
  }
  try {
    socket.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true
      }
    }));
    deliveredNotificationIds.add(item.id);
    notificationDeliveryHistory.unshift({
      id: item.id,
      lane: item.lane,
      dedupeKey: item.dedupeKey,
      deliveredAt: Date.now(),
      text: text.substring(0, 160)
    });
    pruneNotificationCaches();
    markSystemNoticeInFlight();
    console.log(`[Scheduler] Delivered queued notification (${item.lane} ${item.id}):`, text.substring(0, 80));
  } catch (e) {
    console.error('[Scheduler] Failed to send queued notification:', e);
    pendingNotifications.unshift(item);
    schedulePendingNotificationRetry(2000);
  }
  updateDiagnosticsPanel();

  // Try delivering more after a short delay
  if (pendingNotifications.length > 0) {
    schedulePendingNotificationRetry(NOTIFICATION_COOLDOWN_MS);
  }
}

// Queue reminder for delivery so it doesn't interrupt AI mid-speech
async function speakReminderViaAI(message) {
  queueSchedulerMessage(`This is a scheduled reminder. Please announce this to the user in your natural voice and style: "${message}"`, {
    critical: true,
    lane: 'reminder',
    dedupeKey: `reminder:${message}`
  });
}

// Browser TTS fallback (not used for reminders - kept for other potential uses)
function speakText(text) {
  if (!text) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;
  const voices = speechSynthesis.getVoices();
  const preferred = voices.find(v => v.name.includes('Google') || v.name.includes('Natural')) || voices[0];
  if (preferred) utterance.voice = preferred;
  speechSynthesis.speak(utterance);
}

function isMediaDownloadTask(task) {
  const lower = String(task || '').toLowerCase();
  return /\b(download|get|save|rip|grab)\b/.test(lower) && /\b(song|music|audio|mp3|m4a|track|soundtrack|youtube|video)\b/.test(lower);
}

function getMediaTaskTerms(task) {
  const stopWords = new Set(['download', 'get', 'save', 'rip', 'grab', 'song', 'music', 'audio', 'mp3', 'm4a', 'track', 'soundtrack', 'youtube', 'video', 'file', 'please', 'for', 'from', 'the', 'and', 'with', 'into', 'onto', 'desktop']);
  return Array.from(new Set(String(task || '').toLowerCase().match(/[a-z0-9]+/g) || []))
    .filter(word => word.length >= 2 && !stopWords.has(word));
}

function validateMediaDownloadCommand(task, command, subagentRecord) {
  if (!isMediaDownloadTask(task)) return { ok: true };

  const lower = String(command || '').toLowerCase();
  const usesDownloader = /\b(yt-dlp|youtube-dl|gallery-dl)\b/.test(lower);
  const directMediaDownload = /\b(invoke-webrequest|curl|wget|start-bitstransfer)\b/.test(lower) && /\.(mp3|m4a|webm|mp4|wav|flac)(\b|[?&'"`])/i.test(lower);
  if (!usesDownloader && !directMediaDownload) return { ok: true };

  const isDownloadAction = /\b(yt-dlp|youtube-dl)\b[\s\S]{0,200}?(?:-o\b|--extract|-x\b|--audio-format|--merge-output|bestaudio|bestvideo|--embed-thumbnail|-f\s)/i.test(lower)
    || /\bgallery-dl\b/i.test(lower)
    || /\bffmpeg\b[\s\S]{0,100}?-i\b[\s\S]{0,150}?\.(?:webm|opus|m4a|mp4)(\b|[?&'"`])\s/i.test(lower);
  const isVerificationCommand = /^\s*(?:test-path|get-childitem|get-item|get-content|ls\b|dir\b|type\b|where|select|write|add-content)/i.test(lower)
    || /\b(?:--print\b|--dump|--get-)\w+/i.test(lower);
  if (!isDownloadAction || isVerificationCommand) return { ok: true };

  if (!/rick astley|never gonna give you up|rickroll|rick-roll/.test(String(task || '').toLowerCase()) && /rick astley|never gonna give you up|rickroll|rick-roll/.test(lower)) {
    return { ok: false, error: 'Blocked media download: command references Rick Astley / Never Gonna Give You Up, which was not requested.' };
  }

  const terms = getMediaTaskTerms(task);
  const requiredMatches = Math.min(2, Math.max(1, terms.length));
  const matchCount = terms.filter(term => lower.includes(term)).length;

  if (usesDownloader && !/--match-title\b/i.test(command)) {
    const usableTerms = terms.filter(t => t.length >= 3 && !/[#$@!%^&*()]/.test(t)).slice(0, 3);
    if (usableTerms.length > 0) {
      const matchStr = usableTerms.join('|');
      const escapedMatch = matchStr.replace(/['\\$]/g, "' + '\\$&' + '").replace(/"/g, '\\"');
      const inject = ` --match-title "' + '(?i)' + '${escapedMatch}' + "`;
      return { ok: true, autoFixed: true, command: command.trimEnd() + inject };
    }
    return { ok: false, error: 'Blocked media download: yt-dlp/youtube-dl commands for requested music must include --match-title with the requested title/artist/game terms so mismatched results fail instead of downloading the wrong song.' };
  }

  if (matchCount < requiredMatches) {
    return { ok: false, error: `Blocked media download: command does not contain enough requested media terms (${terms.join(', ') || 'none'}). Verify the exact result and include --match-title instead of guessing.` };
  }

  return { ok: true };
}

function getSubagentToolTimeoutForCommand(command) {
  return /\b(yt-dlp|youtube-dl|gallery-dl|ffmpeg)\b/i.test(String(command || ''))
    ? SUBAGENT_LONG_TOOL_TIMEOUT_MS
    : SUBAGENT_TOOL_TIMEOUT_MS;
}

function isRepeatableLearningTask(task) {
  const lower = String(task || '').toLowerCase();
  if (!lower) return false;
  if (/^\s*(what|why|who|when|where|explain|tell me|summarize)\b/.test(lower)) return false;
  if (isMediaDownloadTask(task)) return true;
  return /\b(automate|automation|download|convert|compress|resize|upload|scrape|extract|transcribe|ocr|backup|sync|batch|browser|youtube|deploy|build|test|generate|create|make|write script|powershell|workflow)\b/.test(lower);
}
