/**
 * ShadowMac - Subagent final/status bubbles and voice-session notifications.
 * Split from the original monolithic app.js; loaded as an ordered classic script.
 */

// Map a subagent failure reason to a known credential so we can raise an actionable
// "add your key" popup instead of a silent/cryptic failure. Returns a credential key
// ('gemini' | 'minimax' | 'moonshot' | 'ollama') or '' when the reason is not a
// recognizable missing-key error (we never guess and deep-link to the wrong field).
function detectMissingCredentialFromReason(reason) {
  const text = String(reason || '').toLowerCase();
  if (!text) return '';
  // Only react to "missing/not set/required" key phrasing, never to generic auth errors.
  if (!/\bapi key\b/.test(text)) return '';
  if (!/(is missing|not set|not configured|required|add it in settings|enter (?:your |a )?.*key)/.test(text)) return '';
  if (/\bollama\b/.test(text)) return 'ollama';
  if (/\bminimax\b/.test(text)) return 'minimax';
  if (/\b(canopy ?wave|moonshot)\b/.test(text)) return 'moonshot';
  if (/\b(gemini|google ai)\b/.test(text)) return 'gemini';
  return '';
}

// Static config per credential: settings field to deep-link, the subagent provider to
// select so a hidden field becomes visible, and the official page to obtain the key.
// getKeyUrl is intentionally left blank for providers whose exact key page is not
// verified, so we never send users to a guessed URL. Returns null for unknown keys.
function getCredentialPromptConfig(credentialKey) {
  switch (String(credentialKey || '')) {
    case 'gemini':
      return {
        title: 'Gemini API key needed',
        label: 'Gemini API key',
        fieldId: 'input-api-key',
        subagentProvider: '',
        getKeyUrl: 'https://aistudio.google.com/apikey',
        getKeyLabel: 'Get a free Gemini key →'
      };
    case 'minimax':
      return {
        title: 'MiniMax API key needed',
        label: 'MiniMax API key',
        fieldId: 'input-minimax-key',
        subagentProvider: 'minimax',
        getKeyUrl: '',
        getKeyLabel: ''
      };
    case 'moonshot':
      return {
        title: 'Canopy Wave API key needed',
        label: 'Canopy Wave API key',
        fieldId: 'input-moonshot-key',
        subagentProvider: 'moonshot',
        getKeyUrl: '',
        getKeyLabel: ''
      };
    case 'ollama':
      return {
        title: 'Ollama Cloud API key needed',
        label: 'Ollama Cloud API key',
        fieldId: 'input-ollama-key',
        subagentProvider: 'ollama',
        getKeyUrl: 'https://ollama.com/settings/keys',
        getKeyLabel: 'Get an Ollama key →'
      };
    default:
      return null;
  }
}

function renderSubagentFinalBubble(title, task, summary) {
  if (!SHOW_TEXT_TRANSCRIPT || !transcriptFeed) return;
  const completeBubble = document.createElement('div');
  completeBubble.className = 'transcript-bubble subagent-bubble-complete';

  const banner = document.createElement('div');
  banner.style.fontWeight = '700';
  banner.style.color = '#00f2fe';
  banner.style.marginBottom = '6px';
  banner.textContent = title;
  completeBubble.appendChild(banner);

  const desc = document.createElement('div');
  desc.style.fontSize = '0.85rem';
  desc.style.color = 'rgba(255,255,255,0.6)';
  desc.style.marginBottom = '10px';
  desc.style.borderBottom = '1px solid rgba(255,255,255,0.08)';
  desc.style.paddingBottom = '6px';
  desc.textContent = `Task: "${redactSensitiveText(task)}"`;
  completeBubble.appendChild(desc);

  const summaryText = document.createElement('div');
  summaryText.style.whiteSpace = 'pre-wrap';
  summaryText.style.fontFamily = 'monospace';
  summaryText.style.fontSize = '0.85rem';
  summaryText.style.background = 'rgba(0,0,0,0.2)';
  summaryText.style.padding = '8px 12px';
  summaryText.style.borderRadius = '6px';
  summaryText.textContent = redactSensitiveText(summary);
  completeBubble.appendChild(summaryText);

  transcriptFeed.appendChild(completeBubble);
  scrollTranscript();
}

function playNotificationChime(kind = 'success') {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const gainNode = audioCtx.createGain();
    const tones = {
      start: { freqs: [523.25, 659.25], duration: 0.34, gain: 0.08 },
      stop: { freqs: [440.00, 329.63], duration: 0.34, gain: 0.08 },
      failure: { freqs: [261.63, 196.00], duration: 0.55, gain: 0.09 },
      success: { freqs: [659.25, 830.61], duration: 1.2, gain: 0.15 }
    };
    const tone = tones[kind] || tones.success;
    const oscillators = tone.freqs.map((freq, index) => {
      const osc = audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime + index * 0.04);
      osc.connect(gainNode);
      return osc;
    });

    gainNode.gain.setValueAtTime(tone.gain, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + tone.duration);
    gainNode.connect(audioCtx.destination);

    oscillators.forEach(osc => {
      osc.start();
      osc.stop(audioCtx.currentTime + tone.duration);
    });
    setTimeout(() => audioCtx.close().catch(() => {}), Math.ceil((tone.duration + 0.1) * 1000));
  } catch (e) {
    console.warn('Notification chime playback failed:', e);
  }
}

function playSuccessChime() {
  playNotificationChime('success');
}

function getNotificationAssistantName() {
  return typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
}



function notifyVoiceSession(task, result, subagentId = '') {
  const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  // Relay the ACTUAL result (a review's findings, a research answer, an analysis) to the voice model, not
  // a 300-char stub. The old truncation + "one short summary" meant the user only ever heard "it's done"
  // and never the findings they asked for.
  const message = redactSensitiveText(`[Subagent${subagentId ? ` (${subagentId})` : ''} Done — completed successfully] Result: ${result.substring(0, 2500)}`);
  addSystemMessage(message);
  playSuccessChime();
  scrollTranscript();
  notifyModelOfSubagentUpdate(message, `The background task SUCCEEDED. Speak as ${assistantLabel} in first person and actually RELAY the result to the user: if it is a review, research answer, analysis, or anything informational, tell them the key findings/answer in your own natural voice (a few sentences is fine when there is real substance). Do NOT just say "it's done" when they asked for findings. This is a SUCCESS — do NOT say it failed or had a problem. Do not read it word-for-word, repeat the internal task prompt, or quote system/bracket text.`, true);
}

function notifyVoiceSessionOfFailure(task, reason, subagentId = '') {
  const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  const message = redactSensitiveText(`[Subagent${subagentId ? ` (${subagentId})` : ''} Failed] Reason: ${String(reason || '').substring(0, 800)}`);
  addSystemMessage(message);
  playNotificationChime('failure');
  scrollTranscript();
  // If the failure was a missing API key, surface an actionable popup that deep-links to
  // the right settings field and (where known) the page to obtain the key.
  const missingCredential = typeof detectMissingCredentialFromReason === 'function'
    ? detectMissingCredentialFromReason(reason)
    : '';
  if (missingCredential && typeof showCredentialPrompt === 'function') {
    showCredentialPrompt(missingCredential, reason);
  }
  notifyModelOfSubagentUpdate(message, `The background task FAILED. Speak as ${assistantLabel} in first person: say I could not finish the background work and summarize the reason in plain language. Do NOT claim it succeeded. Do not repeat the internal task prompt or quote system text.`);
}

function notifyVoiceSessionOfPartial(task, reason, subagentId = '') {
  const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  const message = redactSensitiveText(`[Subagent${subagentId ? ` (${subagentId})` : ''} Partial] Result so far / remaining: ${String(reason || '').substring(0, 1800)}`);
  addSystemMessage(message);
  playNotificationChime('stop');
  scrollTranscript();
  notifyModelOfSubagentUpdate(message, `The background task PARTIALLY completed. Speak as ${assistantLabel} in first person: relay any useful findings/progress it did produce, then say what still remains. Do NOT report it as a full success or a full failure. Do not read it word-for-word or quote system/bracket text.`, true);
}

function notifyModelOfSubagentUpdate(message, speechInstruction = '', relayFindings = false) {
  const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  const safeMessage = redactSensitiveText(message);
  const safeInstruction = speechInstruction
    ? String(speechInstruction)
    : `Speak as ${assistantLabel} in first person and give one short natural update. Do not repeat internal task prompts, subagent IDs, bracket labels, or system notice text.`;
  subagentDeferredNotifications.push({ message: safeMessage, speechInstruction: safeInstruction, relayFindings: !!relayFindings });
  flushDeferredSubagentNotifications();
}

function _sendSubagentNotification(notification) {
  const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  // A final result that should be RELAYED (review findings, research answer) gets a bigger budget and a
  // closing that allows a few sentences. Plain status updates stay capped and one-sentence-terse.
  const relayFindings = !!(notification && typeof notification === 'object' && notification.relayFindings);
  const MAX_NOTIFICATION_LENGTH = relayFindings ? 2800 : 800;
  const safeMessage = redactSensitiveText(
    typeof notification === 'string' ? notification : (notification && notification.message) || ''
  );
  const speechInstruction = typeof notification === 'object' && notification && notification.speechInstruction
    ? notification.speechInstruction
    : `Speak as ${assistantLabel} in first person and give one short natural update. Do not repeat internal task prompts, subagent IDs, bracket labels, or system notice text.`;
  let trimmed = safeMessage;
  if (safeMessage.length > MAX_NOTIFICATION_LENGTH) {
    trimmed = safeMessage.substring(0, MAX_NOTIFICATION_LENGTH) + '... [truncated]';
  }
  const closing = relayFindings
    ? `Relay the key findings/answer to the user in your own natural voice — a few sentences is fine when there is real substance (a review, research result, or analysis). Do not read it word-for-word or quote system/bracket text, and do not spawn another subagent for the same task.`
    : `Say at most one concise first-person sentence about this update only. Do not spawn another subagent for the same task.`;
  queueSchedulerMessage(`[SYSTEM NOTICE - DO NOT READ VERBATIM]\nInternal subagent update: ${trimmed}\nSpoken response instruction: ${speechInstruction} ${closing} Never refer to ${assistantLabel} in third person. Do not repeat prior conversation or mention unrelated promises/memories.`, {
    lane: 'subagent',
    critical: true,
    ttlMs: 10 * 60 * 1000,
    dedupeKey: `subagent:${normalizeNotificationTextForKey(trimmed)}`
  });
}

function flushDeferredSubagentNotifications() {
  if (subagentDeferredNotifications.length === 0) return;
  const pending = subagentDeferredNotifications;
  subagentDeferredNotifications = [];
  const messages = pending.map(item => typeof item === 'string' ? item : item.message).filter(Boolean);
  const instruction = [...pending].reverse().find(item => item && typeof item === 'object' && item.speechInstruction)?.speechInstruction || '';
  const relayFindings = pending.some(item => item && typeof item === 'object' && item.relayFindings);
  _sendSubagentNotification({
    message: messages.join('\n\n'),
    speechInstruction: instruction,
    relayFindings
  });
}
