/**
 * ShadowMac - DOMContentLoaded setup and primary UI event binding.
 * Split from the original monolithic app.js; loaded as an ordered classic script.
 */

function cancelBootResponseBody(response) {
  try {
    if (response && response.body && typeof response.body.cancel === 'function') {
      response.body.cancel().catch(() => {});
    }
  } catch {}
}

async function readBootResponseTextWithTimeout(response, timeoutMs = LOCAL_API_TIMEOUT_MS) {
  let timeoutId = null;
  const bodyPromise = response.text();
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      cancelBootResponseBody(response);
      reject(new Error(`Response body timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([bodyPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function readBootResponseJsonWithTimeout(response, timeoutMs = LOCAL_API_TIMEOUT_MS) {
  const text = await readBootResponseTextWithTimeout(response, timeoutMs);
  if (!String(text || '').trim()) return {};
  return JSON.parse(text);
}

// --- Missing-credential popup ---
let lastCredentialPromptAt = 0;
let lastCredentialPromptKey = '';

// Open Settings (reusing its existing populate handler) and draw the user's eye to the
// exact field they need to fill. For subagent-provider keys, select that provider first
// so its (otherwise hidden) key field becomes visible.
function openSettingsToField(fieldId, subagentProvider = '') {
  if (typeof btnSettings !== 'undefined' && btnSettings) btnSettings.click();
  if (subagentProvider && typeof selectSubagentProvider !== 'undefined' && selectSubagentProvider) {
    selectSubagentProvider.value = subagentProvider;
    selectSubagentProvider.dispatchEvent(new Event('change'));
  }
  if (!fieldId) return;
  const field = document.getElementById(fieldId);
  if (!field) return;
  // Defer so the settings modal has rendered before we scroll/focus inside it.
  setTimeout(() => {
    try {
      field.scrollIntoView({ behavior: 'smooth', block: 'center' });
      field.classList.add('field-attention');
      field.focus({ preventScroll: true });
      setTimeout(() => field.classList.remove('field-attention'), 3800);
    } catch {}
  }, 60);
}

// Auto-update: ask the backend to compare our installed version against the latest GitHub
// release. On a newer version, show the dismissible update toast. Fully silent on any
// failure (offline, GitHub down, disabled) so a check never interrupts the user.
async function maybeCheckForUpdate() {
  try {
    if (typeof autoUpdateCheckEnabled !== 'undefined' && !autoUpdateCheckEnabled) return;
    const res = await fetchLocalApiWithTimeout('/api/update-check', {}, LOCAL_API_TIMEOUT_MS);
    if (!res.ok) return;
    const data = await readBootResponseJsonWithTimeout(res, LOCAL_API_TIMEOUT_MS);
    if (!data || data.status !== 'success' || !data.update_available) return;
    const latest = String(data.latest || '').trim();
    if (!latest) return;
    // Respect a prior "Later" dismissal for this exact version.
    if (typeof updateDismissedVersion !== 'undefined' && updateDismissedVersion && updateDismissedVersion === latest) return;
    showUpdateToast(data);
  } catch (e) {
    // Silent by design: an update check should never surface an error to the user.
  }
}

// Populate and reveal the update toast. The "Update" anchor points at the installer asset
// when the release has one, otherwise the release page; clicking it opens the browser.
function showUpdateToast(data) {
  if (!updateToast) return;
  const latest = String(data.latest || '').trim();
  const current = String(data.current || '').trim();
  const downloadUrl = String(data.download_url || '').trim();
  const releaseUrl = String(data.release_url || '').trim();
  const target = downloadUrl || releaseUrl;
  if (!target) return;
  if (updateToastTitle) updateToastTitle.textContent = `Update available: ${latest}`;
  if (updateToastSubtitle) {
    updateToastSubtitle.textContent = current
      ? `You're on ${current}. Click Update to download the new installer, then run it over your current install (your data is kept).`
      : 'Click Update to download the new installer, then run it over your current install (your data is kept).';
  }
  if (btnUpdateNow) btnUpdateNow.href = target;
  updateToast.dataset.latestVersion = latest;
  updateToast.classList.remove('hidden');
}

// Manual "Check for updates" (Settings button). Unlike the silent launch check, this always
// runs (even with auto-check off), gives explicit feedback, and overrides a prior "Later"
// dismissal so an available update re-surfaces when the user deliberately asks.
async function manualCheckForUpdate() {
  if (!btnCheckUpdates) return;
  const setStatus = (msg, isError) => {
    if (!updateCheckStatus) return;
    updateCheckStatus.textContent = msg || '';
    updateCheckStatus.style.color = isError ? '#ff8a80' : '';
  };
  btnCheckUpdates.disabled = true;
  setStatus('Checking…', false);
  try {
    const res = await fetchLocalApiWithTimeout('/api/update-check', {}, LOCAL_API_TIMEOUT_MS);
    if (!res.ok) { setStatus('Could not check for updates right now.', true); return; }
    const data = await readBootResponseJsonWithTimeout(res, LOCAL_API_TIMEOUT_MS);
    if (!data || data.status !== 'success') {
      setStatus((data && data.error) ? data.error : 'Could not reach GitHub to check for updates.', true);
      return;
    }
    const current = String(data.current || '').trim();
    const latest = String(data.latest || '').trim();
    if (data.update_available && latest) {
      setStatus('Update available: ' + latest, false);
      updateDismissedVersion = '';
      try { localStorage.removeItem('shadow_update_dismissed_version'); } catch (e) {}
      showUpdateToast(data);
    } else {
      setStatus(current ? ("You're on the latest version (" + current + ').') : "You're on the latest version.", false);
    }
  } catch (e) {
    setStatus('Could not reach GitHub to check for updates.', true);
  } finally {
    btnCheckUpdates.disabled = false;
  }
}

// ===== Onboarding wizard =====
let onboardingCurrentStep = 1;

// Per-provider config for the onboarding "Background helpers" step. defaultModel mirrors the
// settings-open defaults so a finished subagent provider is never left with a broken model.
const ONBOARDING_PROVIDER_CONFIG = {
  gemini: { info: 'Uses your Gemini key — nothing else to set up. Great default.', defaultModel: 'models/gemini-3.1-flash-lite' },
  custom_openai: { endpoint: true, key: true, keyLabel: 'API key (optional)', endpointDefault: 'https://api.openai.com/v1', info: 'Any OpenAI-compatible endpoint — a paid hosted API or your own gateway. Enter the base URL + model.', defaultModel: '' },
  ollama: { key: true, keyLabel: 'Ollama Cloud API key', info: 'Runs on Ollama\'s hosted cloud models.', defaultModel: 'deepseek-v3.1:671b-cloud' },
  minimax: { key: true, keyLabel: 'MiniMax API key', info: 'Uses MiniMax\'s hosted models.', defaultModel: 'minimax-m2.7' },
  moonshot: { key: true, keyLabel: 'Canopy Wave API key', info: 'Uses Canopy Wave / Moonshot hosted models.', defaultModel: 'moonshotai/kimi-k2.6' },
  openai_codex: { info: 'Codex uses a one-time sign-in — finish connecting it in Settings after setup.', defaultModel: 'gpt-5.5' }
};

// The Settings model <select> whose options the onboarding model dropdown clones for each
// provider (single source of truth). Local/custom providers fetch their models instead.
function getOnboardingModelSourceSelect(prov) {
  switch (prov) {
    case 'gemini': return selectSubagentModelGemini;
    case 'openai_codex': return selectSubagentModelOpenaiCodex;
    case 'minimax': return selectSubagentModelMinimax;
    case 'moonshot': return selectSubagentModelMoonshot;
    case 'ollama': return selectSubagentModelOllama;
    default: return null;
  }
}

// Populate the wizard from the live Settings selects (single source of truth) and seed
// defaults from current state. Called right before the onboarding modal is shown.
function initOnboardingWizard() {
  if (onboardingVoice && selectVoice) onboardingVoice.innerHTML = selectVoice.innerHTML;
  if (onboardingAccent && selectAccent) onboardingAccent.innerHTML = selectAccent.innerHTML;
  if (onboardingThinking && selectLiveThinkingLevel) onboardingThinking.innerHTML = selectLiveThinkingLevel.innerHTML;
  if (onboardingSubagentProvider && selectSubagentProvider) onboardingSubagentProvider.innerHTML = selectSubagentProvider.innerHTML;

  if (onboardingUserName) onboardingUserName.value = (typeof userName === 'string' && userName) ? userName : '';
  if (onboardingAssistantName) onboardingAssistantName.value = (typeof assistantName === 'string' && assistantName) ? assistantName : '';
  if (onboardingVoice) onboardingVoice.value = voiceName;
  if (onboardingAccent) onboardingAccent.value = accent;
  if (onboardingThinking) onboardingThinking.value = liveThinkingLevel;
  if (onboardingSubagentProvider) onboardingSubagentProvider.value = subagentProvider || 'gemini';

  updateOnboardingSubagentUI();
  goToOnboardingStep(1);
}

function goToOnboardingStep(n) {
  // Tear down any live step-specific resources when leaving a step.
  stopOnboardingMicMeter();
  if (typeof stopOnboardingVoicePreview === 'function') stopOnboardingVoicePreview();

  onboardingCurrentStep = n;
  const steps = document.querySelectorAll('#onboarding-modal .onboarding-step');
  steps.forEach(s => s.classList.toggle('hidden', parseInt(s.dataset.step, 10) !== n));
  const dots = document.querySelectorAll('#onboarding-steps .onboarding-step-dot');
  dots.forEach(d => d.classList.toggle('active', parseInt(d.dataset.step, 10) <= n));
  const isLast = n === 4;
  if (btnOnboardBack) btnOnboardBack.classList.toggle('hidden', n === 1);
  if (btnOnboardNext) btnOnboardNext.classList.toggle('hidden', isLast);
  if (btnGetStarted) btnGetStarted.classList.toggle('hidden', !isLast);

  if (n === 2) startOnboardingMicMeter();
  else if (n === 3) startOnboardingVoiceCarousel();
  updateOnboardingNavGate();
}

// ===== Onboarding step gating: the mic must work, and the subagent must test OK, before proceeding =====
let onboardingMicVerified = false;
let onboardingSubagentTested = false;

function onboardingSubagentReady() {
  const prov = onboardingSubagentProvider ? onboardingSubagentProvider.value : 'gemini';
  if (prov === 'gemini') return true; // Gemini key is already validated by the live voice step
  return !!onboardingSubagentTested;
}

function updateOnboardingNavGate() {
  if (btnOnboardNext) btnOnboardNext.disabled = (onboardingCurrentStep === 2 && !onboardingMicVerified);
  if (btnGetStarted) btnGetStarted.disabled = (onboardingCurrentStep === 4 && !onboardingSubagentReady());
}

// ===== Onboarding mic check: live level meter + verify-on-input =====
let _obMicCtx = null, _obMicStream = null, _obMicSource = null, _obMicAnalyser = null, _obMicRaf = null;

async function startOnboardingMicMeter() {
  stopOnboardingMicMeter();
  onboardingMicVerified = false;
  updateOnboardingNavGate();
  const meterFill = document.getElementById('onboarding-mic-meter-fill');
  const statusEl = document.getElementById('onboarding-mic-status');
  const micSel = document.getElementById('onboarding-mic-device');
  if (statusEl) { statusEl.textContent = 'Say something to test your mic…'; statusEl.classList.remove('ok'); }

  // Reuse the Settings mic enumeration (primed so real device names show), then mirror it here.
  try { if (typeof window.populateMicDevices === 'function') await window.populateMicDevices(true); } catch (e) {}
  if (micSel && typeof selectMicDevice !== 'undefined' && selectMicDevice) {
    micSel.innerHTML = selectMicDevice.innerHTML;
    micSel.value = (typeof selectedMicDeviceId === 'string') ? selectedMicDeviceId : '';
  }

  const wantId = (micSel && micSel.value) ? micSel.value : '';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: wantId ? { deviceId: { exact: wantId } } : true });
  } catch (e) {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e2) {
      if (statusEl) statusEl.textContent = 'No mic detected or access denied — you can still continue.';
      onboardingMicVerified = true; // never hard-block onboarding on the mic check
      updateOnboardingNavGate();
      return;
    }
  }
  _obMicStream = stream;
  _obMicCtx = new (window.AudioContext || window.webkitAudioContext)();
  _obMicSource = _obMicCtx.createMediaStreamSource(stream);
  _obMicAnalyser = _obMicCtx.createAnalyser();
  _obMicAnalyser.fftSize = 256;
  _obMicSource.connect(_obMicAnalyser);
  const data = new Uint8Array(_obMicAnalyser.frequencyBinCount);
  const loop = () => {
    if (!_obMicAnalyser) return;
    _obMicAnalyser.getByteFrequencyData(data);
    let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
    const level = sum / data.length / 255;
    if (meterFill) meterFill.style.width = Math.min(100, Math.round(level * 260)) + '%';
    if (level > 0.045 && !onboardingMicVerified) {
      onboardingMicVerified = true;
      if (statusEl) { statusEl.textContent = 'Mic is working ✓'; statusEl.classList.add('ok'); }
      updateOnboardingNavGate();
    }
    _obMicRaf = requestAnimationFrame(loop);
  };
  loop();
}

function stopOnboardingMicMeter() {
  if (_obMicRaf) cancelAnimationFrame(_obMicRaf);
  _obMicRaf = null;
  try { if (_obMicSource) _obMicSource.disconnect(); } catch (e) {}
  try { if (_obMicStream) _obMicStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { if (_obMicCtx) _obMicCtx.close(); } catch (e) {}
  _obMicSource = null; _obMicStream = null; _obMicAnalyser = null; _obMicCtx = null;
}

// ===== Onboarding "meet your voice" carousel (live preview via 14-onboarding-voice.js) =====
function getOnboardingVoiceIndex() {
  const cur = (onboardingVoice && onboardingVoice.value) || voiceName || 'Leda';
  let idx = GEMINI_VOICE_OPTIONS.findIndex(v => v.name === cur);
  if (idx < 0) idx = GEMINI_VOICE_OPTIONS.findIndex(v => v.name === 'Leda');
  return idx < 0 ? 0 : idx;
}

function renderOnboardingVoiceLabel() {
  const v = GEMINI_VOICE_OPTIONS[getOnboardingVoiceIndex()] || { name: 'Leda', style: '' };
  const nameEl = document.getElementById('onboarding-voice-name');
  const styleEl = document.getElementById('onboarding-voice-style');
  if (nameEl) nameEl.textContent = v.name;
  if (styleEl) styleEl.textContent = v.style || '';
}

function setOnboardingOrbState(state) {
  const orb = document.getElementById('onboarding-voice-orb');
  const hint = document.getElementById('onboarding-voice-hint');
  if (orb) {
    orb.classList.remove('state-connecting', 'state-listening', 'state-speaking', 'state-error');
    orb.classList.add('state-' + state);
  }
  if (hint) {
    hint.textContent = state === 'connecting' ? 'Connecting…'
      : state === 'listening' ? 'Say hi — talk to it 👋'
      : state === 'speaking' ? 'Speaking…'
      : state === 'error' ? "Couldn't reach the voice — you can still continue."
      : '';
  }
}

function startOnboardingVoiceCarousel() {
  renderOnboardingVoiceLabel();
  setOnboardingOrbState('connecting');
  if (typeof startOnboardingVoicePreview !== 'function') return;
  startOnboardingVoicePreview({
    voice: (onboardingVoice && onboardingVoice.value) || voiceName || 'Leda',
    name: (onboardingAssistantName && onboardingAssistantName.value.trim()) || (typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow'),
    accent: (onboardingAccent && onboardingAccent.value) || accent || 'neutral',
    micDeviceId: (typeof selectedMicDeviceId === 'string') ? selectedMicDeviceId : '',
    onState: setOnboardingOrbState
  });
}

function cycleOnboardingVoice(dir) {
  let idx = getOnboardingVoiceIndex();
  idx = (idx + dir + GEMINI_VOICE_OPTIONS.length) % GEMINI_VOICE_OPTIONS.length;
  const v = GEMINI_VOICE_OPTIONS[idx];
  if (onboardingVoice) onboardingVoice.value = v.name;
  renderOnboardingVoiceLabel();
  setOnboardingOrbState('connecting');
  if (typeof switchOnboardingVoice === 'function') switchOnboardingVoice(v.name);
}

// ===== Onboarding forced subagent connection test =====
async function runOnboardingSubagentTest() {
  const statusEl = document.getElementById('onboarding-subagent-test-status');
  const btn = document.getElementById('btn-onboarding-test-subagent');
  const prov = onboardingSubagentProvider ? onboardingSubagentProvider.value : 'gemini';
  if (statusEl) { statusEl.textContent = 'Testing…'; statusEl.classList.remove('ok'); }
  if (btn) btn.disabled = true;
  try {
    // Apply the current onboarding subagent selection so the test exercises exactly what will be saved.
    if (typeof applyOnboardingSubagentChoice === 'function') await applyOnboardingSubagentChoice();
    if (prov === 'gemini') {
      onboardingSubagentTested = true;
      if (statusEl) { statusEl.textContent = 'Gemini subagents ready ✓'; statusEl.classList.add('ok'); }
    } else if (typeof runSubagentPromptRefinement === 'function') {
      const result = await runSubagentPromptRefinement({ kind: 'spawn', text: 'Connectivity check — reply with the single word OK.' });
      const ok = result && typeof result.text === 'string' && result.text.trim();
      onboardingSubagentTested = !!ok;
      if (statusEl) {
        if (ok) { statusEl.textContent = 'Connected ✓'; statusEl.classList.add('ok'); }
        else { statusEl.textContent = 'No response from the model — check the key/model and retry.'; statusEl.classList.remove('ok'); }
      }
    } else {
      onboardingSubagentTested = true; // can't test in this build; don't block
      if (statusEl) statusEl.textContent = 'Ready.';
    }
  } catch (e) {
    onboardingSubagentTested = false;
    if (statusEl) { statusEl.textContent = `Failed: ${(e && e.message) ? e.message : e}`; statusEl.classList.remove('ok'); }
  } finally {
    if (btn) btn.disabled = false;
    updateOnboardingNavGate();
  }
}

// Show/hide the endpoint, key, Codex login, and model controls for the selected provider,
// and populate the model dropdown (cloned for fixed providers, fetched for local ones).
function updateOnboardingSubagentUI() {
  if (!onboardingSubagentProvider) return;
  const prov = onboardingSubagentProvider.value;
  const cfg = ONBOARDING_PROVIDER_CONFIG[prov] || {};
  const isCodex = prov === 'openai_codex';
  const isCustom = prov === 'custom_openai';
  const isLocal = isCustom;

  if (onboardingSubagentEndpointGroup) {
    onboardingSubagentEndpointGroup.classList.toggle('hidden', !cfg.endpoint);
    if (cfg.endpoint && onboardingSubagentEndpoint && !onboardingSubagentEndpoint.value.trim() && cfg.endpointDefault) {
      onboardingSubagentEndpoint.value = cfg.endpointDefault;
    }
  }
  if (onboardingSubagentKeyGroup) {
    onboardingSubagentKeyGroup.classList.toggle('hidden', !cfg.key);
    if (cfg.key && onboardingSubagentKeyLabel) onboardingSubagentKeyLabel.textContent = cfg.keyLabel || 'API key';
  }

  // Codex one-time sign-in.
  if (onboardingCodexGroup) onboardingCodexGroup.classList.toggle('hidden', !isCodex);
  if (isCodex) checkOnboardingCodexStatus();

  // Model selection: a dropdown for fixed providers, a free-text field for custom.
  if (onboardingModelGroup) onboardingModelGroup.classList.remove('hidden');
  if (onboardingSubagentModel) onboardingSubagentModel.classList.toggle('hidden', isCustom);
  if (onboardingSubagentModelText) onboardingSubagentModelText.classList.toggle('hidden', !isCustom);
  if (onboardingDetectRow) onboardingDetectRow.classList.toggle('hidden', !isLocal);

  if (!isCustom && onboardingSubagentModel) {
    const src = getOnboardingModelSourceSelect(prov);
    if (src) onboardingSubagentModel.innerHTML = src.innerHTML;
    const want = (subagentProvider === prov && subagentModel) ? subagentModel : (cfg.defaultModel || '');
    if (want) onboardingSubagentModel.value = want;
  }
  if (isCustom && onboardingSubagentModelText) {
    onboardingSubagentModelText.value = (subagentProvider === 'custom_openai' && subagentModel) ? subagentModel : '';
  }

  setOnboardingModelStatus('', false);
  if (onboardingSubagentInfo) onboardingSubagentInfo.textContent = cfg.info || '';

  // Auto-detect models for local providers when an endpoint is already filled in — but only for a
  // localhost endpoint or when a key is present. Auto-pinging a remote keyed endpoint (e.g.
  // api.openai.com) with no key just 502s and spams the console; the user can still click "Detect
  // models" manually, which surfaces a clean status message instead of a raw network error.
  if (isLocal && onboardingSubagentEndpoint && onboardingSubagentEndpoint.value.trim()) {
    const ep = onboardingSubagentEndpoint.value.trim();
    const isLocalhostEndpoint = /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(ep);
    const hasKey = !!(onboardingSubagentKey && onboardingSubagentKey.value.trim());
    if (isLocalhostEndpoint || hasKey) onboardingDetectModels();
  }
}

function setOnboardingModelStatus(msg, isError) {
  if (!onboardingModelStatus) return;
  onboardingModelStatus.textContent = msg || '';
  onboardingModelStatus.style.color = isError ? '#ff6b6b' : '';
}

// Fetch the full model list from a local model-list endpoint (best effort, returns []).
async function onboardingFetchModels(url) {
  try {
    const res = await fetchLocalApiWithTimeout(url, {}, LOCAL_API_TIMEOUT_MS);
    const data = await readBootResponseJsonWithTimeout(res, LOCAL_API_TIMEOUT_MS);
    return (data && Array.isArray(data.models)) ? data.models : [];
  } catch (e) {
    return [];
  }
}

async function onboardingFetchFirstModel(url) {
  const models = await onboardingFetchModels(url);
  return models.length ? models[0] : '';
}

// Detect available models for the selected local provider and populate the model control.
async function onboardingDetectModels() {
  const prov = onboardingSubagentProvider ? onboardingSubagentProvider.value : '';
  if (prov === 'custom_openai') {
    const endpoint = (onboardingSubagentEndpoint && onboardingSubagentEndpoint.value.trim()) || '';
    if (!endpoint) { setOnboardingModelStatus('Enter the server URL first.', true); return; }
    const key = (onboardingSubagentKey && onboardingSubagentKey.value.trim()) || '';
    setOnboardingModelStatus('Fetching models...', false);
    const models = await onboardingFetchModels(`/api/openai-compat/models?endpoint=${encodeURIComponent(endpoint)}${key ? `&key=${encodeURIComponent(key)}` : ''}`);
    if (onboardingCustomModelsDatalist) {
      onboardingCustomModelsDatalist.innerHTML = '';
      for (const name of models) {
        const opt = document.createElement('option');
        opt.value = name;
        onboardingCustomModelsDatalist.appendChild(opt);
      }
    }
    if (models.length && onboardingSubagentModelText && !onboardingSubagentModelText.value.trim()) {
      onboardingSubagentModelText.value = models[0];
    }
    setOnboardingModelStatus(models.length ? `Found ${models.length} model(s).` : 'No models returned - type the model name.', !models.length);
  }
}

// ----- Onboarding Codex sign-in (reuses the same /api/codex endpoints as Settings) -----
function updateOnboardingCodexUI(status = {}) {
  const connected = Boolean(status.connected);
  if (onboardingCodexBadge) {
    onboardingCodexBadge.classList.toggle('integration-connected', connected);
    onboardingCodexBadge.classList.toggle('integration-disconnected', !connected);
  }
  if (onboardingCodexStatusText) onboardingCodexStatusText.textContent = connected ? 'Logged in' : 'Disconnected';
  if (onboardingCodexDetails) {
    onboardingCodexDetails.textContent = status.detail || (connected
      ? 'Codex is connected — GPT subagents are ready.'
      : 'Opens a browser sign-in — complete it and come back; status updates automatically.');
  }
  if (btnOnboardingCodexLogin) btnOnboardingCodexLogin.classList.toggle('hidden', connected);
}

async function checkOnboardingCodexStatus() {
  try {
    const res = await fetchLocalApiWithTimeout('/api/codex/status', {}, LOCAL_API_TIMEOUT_MS);
    const data = res.ok ? await readBootResponseJsonWithTimeout(res, LOCAL_API_TIMEOUT_MS) : { connected: false };
    updateOnboardingCodexUI(data);
    return data;
  } catch (e) {
    updateOnboardingCodexUI({ connected: false });
    return { connected: false };
  }
}

async function triggerOnboardingCodexLogin() {
  if (!btnOnboardingCodexLogin) return;
  const codexTimeout = (typeof CODEX_AUTH_API_TIMEOUT_MS !== 'undefined') ? CODEX_AUTH_API_TIMEOUT_MS : 120000;
  btnOnboardingCodexLogin.disabled = true;
  btnOnboardingCodexLogin.textContent = 'Opening...';
  try {
    const res = await fetchLocalApiWithTimeout('/api/codex/login', { method: 'POST' }, codexTimeout);
    const data = await readBootResponseJsonWithTimeout(res, codexTimeout).catch(() => ({}));
    if (!res.ok || data.status === 'error') throw new Error(data.error || `HTTP ${res.status}`);
    updateOnboardingCodexUI({ connected: false, detail: data.message || 'Complete the Codex login in your browser; status updates automatically.' });
    let pollCount = 0;
    const pollTimer = setInterval(async () => {
      pollCount++;
      const status = await checkOnboardingCodexStatus();
      if (status.connected || pollCount > 150) clearInterval(pollTimer);
    }, 2000);
  } catch (err) {
    if (onboardingCodexDetails) onboardingCodexDetails.textContent = `Could not start Codex login: ${err.message}`;
  } finally {
    btnOnboardingCodexLogin.disabled = false;
    btnOnboardingCodexLogin.textContent = 'Login with Codex';
  }
}

// Apply the step-3 subagent provider + model choice to state + localStorage.
async function applyOnboardingSubagentChoice() {
  const prov = onboardingSubagentProvider ? onboardingSubagentProvider.value : 'gemini';
  const cfg = ONBOARDING_PROVIDER_CONFIG[prov] || {};
  subagentProvider = prov;

  let chosenModel = '';
  if (prov === 'custom_openai') {
    chosenModel = (onboardingSubagentModelText && onboardingSubagentModelText.value.trim()) || '';
  } else if (onboardingSubagentModel) {
    chosenModel = onboardingSubagentModel.value || '';
  }
  subagentModel = chosenModel || cfg.defaultModel || '';

  if (prov === 'custom_openai') {
    customEndpoint = (onboardingSubagentEndpoint && onboardingSubagentEndpoint.value.trim()) || '';
    customApiKey = (onboardingSubagentKey && onboardingSubagentKey.value.trim()) || '';
    localStorage.setItem('shadow_custom_endpoint', customEndpoint);
    localStorage.setItem('shadow_custom_api_key', customApiKey);
    if (!subagentModel && customEndpoint) {
      const m = await onboardingFetchFirstModel(`/api/openai-compat/models?endpoint=${encodeURIComponent(customEndpoint)}${customApiKey ? `&key=${encodeURIComponent(customApiKey)}` : ''}`);
      if (m) subagentModel = m;
    }
  } else if (prov === 'ollama') {
    ollamaApiKey = (onboardingSubagentKey && onboardingSubagentKey.value.trim()) || '';
    localStorage.setItem('shadow_ollama_key', ollamaApiKey);
  } else if (prov === 'minimax') {
    minimaxApiKey = (onboardingSubagentKey && onboardingSubagentKey.value.trim()) || '';
    localStorage.setItem('shadow_minimax_key', minimaxApiKey);
  } else if (prov === 'moonshot') {
    moonshotApiKey = (onboardingSubagentKey && onboardingSubagentKey.value.trim()) || '';
    localStorage.setItem('shadow_moonshot_key', moonshotApiKey);
  }

  localStorage.setItem('shadow_subagent_provider', subagentProvider);
  localStorage.setItem('shadow_subagent_model', subagentModel);

  // Reflect the onboarding choices in the Settings UI immediately. The Settings fields are populated
  // once at boot (before onboarding runs), so without this the provider/keys/model look empty when the
  // user opens Settings in the same session — even though they're saved in state + config.
  try {
    if (inputApiKey) inputApiKey.value = apiKey || '';
    if (inputMinimaxKey) inputMinimaxKey.value = minimaxApiKey || '';
    if (inputMoonshotKey) inputMoonshotKey.value = moonshotApiKey || '';
    if (inputOllamaKey) inputOllamaKey.value = ollamaApiKey || '';
    if (inputCustomEndpoint) inputCustomEndpoint.value = customEndpoint || '';
    if (inputCustomApiKey) inputCustomApiKey.value = customApiKey || '';
    if (prov === 'custom_openai') { if (inputCustomModel) inputCustomModel.value = subagentModel || ''; }
    else if (prov === 'gemini' && selectSubagentModelGemini) selectSubagentModelGemini.value = subagentModel || 'models/gemini-3.1-flash-lite';
    else if (prov === OPENAI_CODEX_PROVIDER && selectSubagentModelOpenaiCodex) selectSubagentModelOpenaiCodex.value = subagentModel || 'gpt-5.5';
    else if (prov === 'minimax' && selectSubagentModelMinimax) selectSubagentModelMinimax.value = subagentModel || 'minimax-m2.7';
    else if (prov === 'moonshot' && selectSubagentModelMoonshot) selectSubagentModelMoonshot.value = subagentModel || 'moonshotai/kimi-k2.6';
    else if (prov === 'ollama' && selectSubagentModelOllama) selectSubagentModelOllama.value = subagentModel || 'deepseek-v3.1:671b-cloud';
    // Set the provider dropdown last + fire change so the correct key/endpoint group is shown.
    if (selectSubagentProvider) { selectSubagentProvider.value = subagentProvider; selectSubagentProvider.dispatchEvent(new Event('change')); }
  } catch (e) { /* non-fatal: keys are already saved to state + config */ }
}

// Show the actionable "add your key" popup for a recognized credential. Debounced so a
// burst of failures (e.g. retries) does not reopen the same prompt repeatedly.
function showCredentialPrompt(credentialKey, reason = '') {
  const config = typeof getCredentialPromptConfig === 'function'
    ? getCredentialPromptConfig(credentialKey)
    : null;
  if (!config || typeof credentialModal === 'undefined' || !credentialModal) return false;

  const now = Date.now();
  if (lastCredentialPromptKey === credentialKey && (now - lastCredentialPromptAt) < 15000) return false;
  lastCredentialPromptAt = now;
  lastCredentialPromptKey = credentialKey;

  if (credentialModalTitle) credentialModalTitle.textContent = config.title;
  if (credentialModalMessage) {
    credentialModalMessage.textContent = config.getKeyUrl
      ? `${config.label} isn't set yet, so that action couldn't run. Get a key from the provider, then open Settings to paste it in.`
      : `${config.label} isn't set yet, so that action couldn't run. Open Settings to add it.`;
  }
  if (typeof btnCredentialGetKey !== 'undefined' && btnCredentialGetKey) {
    if (config.getKeyUrl) {
      btnCredentialGetKey.href = config.getKeyUrl;
      btnCredentialGetKey.textContent = config.getKeyLabel || 'Get your key →';
      btnCredentialGetKey.classList.remove('hidden');
    } else {
      btnCredentialGetKey.classList.add('hidden');
      btnCredentialGetKey.removeAttribute('href');
    }
  }
  credentialModal.dataset.fieldId = config.fieldId || '';
  credentialModal.dataset.subagentProvider = config.subagentProvider || '';
  credentialModal.classList.remove('hidden');
  return true;
}

// Voice preview: synthesize a short sample in the selected Gemini voice and play it, so users can
// HEAR a voice instead of guessing from its one-word style label. Uses Gemini's TTS model (its
// prebuilt voice names match our list) and the existing 24kHz AudioPlayer. Triggered by a click (a
// user gesture), so the browser allows the AudioContext to start.
let _voicePreviewPlayer = null;
let _voicePreviewInFlight = false;
async function previewVoice(voice, btn, sampleName) {
  if (_voicePreviewInFlight) return;
  let key = (typeof apiKey === 'string' && apiKey.trim()) ? apiKey.trim() : '';
  if (!key && typeof onboardingApiKey !== 'undefined' && onboardingApiKey && onboardingApiKey.value) {
    key = onboardingApiKey.value.trim();
  }
  if (!key) { addSystemMessage('Add your Gemini API key first to preview a voice.'); return; }
  const voiceName = String(voice || 'Leda');
  // Use the name the user is CURRENTLY typing (onboarding/Settings field) so the preview reflects it
  // immediately — not the last saved name. Falls back to the saved assistant name.
  const rawName = (typeof sampleName === 'string' && sampleName.trim())
    ? sampleName.trim()
    : (typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow');
  const assistantLabel = (typeof normalizeAssistantName === 'function') ? normalizeAssistantName(rawName) : rawName;
  _voicePreviewInFlight = true;
  if (btn) { btn.disabled = true; btn.classList.add('previewing'); }
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Hi, I'm ${assistantLabel}.` }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } } }
        }
      })
    });
    const json = await readBootResponseJsonWithTimeout(res, LOCAL_API_TIMEOUT_MS);
    if (!res.ok) throw new Error((json && json.error && json.error.message) || `HTTP ${res.status}`);
    const part = json && json.candidates && json.candidates[0] && json.candidates[0].content
      && json.candidates[0].content.parts && json.candidates[0].content.parts[0];
    const b64 = part && part.inlineData && part.inlineData.data;
    if (!b64) throw new Error('No audio was returned for this voice.');
    // Gemini TTS returns 24kHz 16-bit PCM — exactly what AudioPlayer expects.
    if (!_voicePreviewPlayer) _voicePreviewPlayer = new AudioPlayer(24000);
    _voicePreviewPlayer.stop();
    _voicePreviewPlayer.reset();
    _voicePreviewPlayer.playChunk(b64);
  } catch (err) {
    addSystemMessage(`Voice preview failed: ${err && err.message ? err.message : err}`);
  } finally {
    _voicePreviewInFlight = false;
    if (btn) { btn.disabled = false; btn.classList.remove('previewing'); }
  }
}

// --- Initialization & UI Binding ---
window.addEventListener('DOMContentLoaded', async () => {
  // Load settings into inputs
  loadFavoriteVoices();
  populateGeminiVoiceSelect(selectVoice);
  const normalizedVoiceName = normalizeGeminiVoiceName(voiceName);
  if (normalizedVoiceName && normalizedVoiceName !== voiceName) {
    voiceName = normalizedVoiceName;
    localStorage.setItem('shadow_voice', voiceName);
  }
  if (!normalizedVoiceName) {
    voiceName = DEFAULT_GEMINI_VOICE;
    localStorage.setItem('shadow_voice', voiceName);
  }
  inputApiKey.value = apiKey;
  if (inputAssistantName) inputAssistantName.value = getAssistantName();
  if (inputUserName) inputUserName.value = getUserName();
  if (typeof syncMemoryGraphAssistantLabels === 'function') syncMemoryGraphAssistantLabels();
  selectVoice.value = voiceName;
  selectedModel = normalizeLiveModel(selectedModel);
  localStorage.setItem('shadow_model', selectedModel);
  selectModel.value = selectedModel;
  liveThinkingLevel = migrateLiveThinkingDefault(liveThinkingLevel);
  localStorage.setItem('shadow_live_thinking_level', liveThinkingLevel);
  if (selectLiveThinkingLevel) {
    selectLiveThinkingLevel.value = liveThinkingLevel;
  }
  normalizeProactiveProfile();
  syncProactiveControls();

  function loadMemoryBackupSettings() {
    const savedEnabled = localStorage.getItem('shadow_memory_backup_enabled');
    memoryBackupEnabled = savedEnabled === 'true';
    const savedInterval = localStorage.getItem('shadow_memory_backup_interval');
    memoryBackupIntervalMinutes = savedInterval ? parseInt(savedInterval, 10) : 60;
    initMemoryBackupScheduler();
  }

  function getMemoryBackupScheduleKey() {
    const interval = parseInt(memoryBackupIntervalMinutes, 10);
    const active = Boolean(memoryBackupEnabled && interval > 0);
    return `${active ? 'enabled' : 'disabled'}:${active ? interval : 0}`;
  }

  function initMemoryBackupScheduler() {
    if (memoryBackupTimer) {
      clearInterval(memoryBackupTimer);
      memoryBackupTimer = null;
    }
    memoryBackupScheduleKey = getMemoryBackupScheduleKey();
    if (!memoryBackupEnabled || !memoryBackupIntervalMinutes || memoryBackupIntervalMinutes <= 0) {
      return;
    }
    const intervalMs = memoryBackupIntervalMinutes * 60 * 1000;
    memoryBackupTimer = setInterval(async () => {
      try {
        const res = await fetchLocalApiWithTimeout('/api/memories/backup', { method: 'POST' }, MEMORY_BACKUP_TIMEOUT_MS);
        const data = await readBootResponseJsonWithTimeout(res, MEMORY_BACKUP_TIMEOUT_MS);
        if (data.status === 'success') {
          console.log('[Memory Backup] Automated backup created:', data.backupFile);
        } else if (data.status === 'no_memories_file' || data.status === 'no_memories' || data.status === 'empty') {
          console.debug('[Memory Backup] Nothing to back up yet.');
        } else {
          console.warn('[Memory Backup] Backup skipped:', data);
        }
      } catch (e) {
        console.error('[Memory Backup] Backup error:', e);
      }
    }, intervalMs);
    console.log(`[Memory Backup] Scheduler started with interval: ${memoryBackupIntervalMinutes} minutes`);
  }

  function stopMemoryBackupScheduler() {
    if (memoryBackupTimer) {
      clearInterval(memoryBackupTimer);
      memoryBackupTimer = null;
      console.log('[Memory Backup] Scheduler stopped');
    }
  }

  function syncMemoryBackupScheduler() {
    const nextScheduleKey = getMemoryBackupScheduleKey();
    if (nextScheduleKey === memoryBackupScheduleKey) return;
    stopMemoryBackupScheduler();
    initMemoryBackupScheduler();
  }

  function syncMemoryBackupUI() {
    if (inputMemoryBackupEnabled) {
      inputMemoryBackupEnabled.checked = memoryBackupEnabled;
    }
    if (selectMemoryBackupInterval) {
      const intervalStr = String(memoryBackupIntervalMinutes);
      const optionExists = [...selectMemoryBackupInterval.options].some(o => o.value === intervalStr);
      if (optionExists) {
        selectMemoryBackupInterval.value = intervalStr;
        memoryBackupCustomGroup.classList.add('hidden');
      } else {
        selectMemoryBackupInterval.value = 'custom';
        memoryBackupCustomGroup.classList.remove('hidden');
        if (inputMemoryBackupCustomMinutes) {
          inputMemoryBackupCustomMinutes.value = memoryBackupIntervalMinutes;
        }
      }
    }
  }

  function updateMemoryBackupCustomVisibility() {
    if (selectMemoryBackupInterval && memoryBackupCustomGroup) {
      if (selectMemoryBackupInterval.value === 'custom') {
        memoryBackupCustomGroup.classList.remove('hidden');
      } else {
        memoryBackupCustomGroup.classList.add('hidden');
      }
    }
  }

  selectSubagentProvider.value = subagentProvider;
  if (subagentProvider === 'gemini') selectSubagentModelGemini.value = subagentModel || 'models/gemini-3.1-flash-lite';
  if (subagentProvider === OPENAI_CODEX_PROVIDER) selectSubagentModelOpenaiCodex.value = subagentModel || 'gpt-5.5';
  if (subagentProvider === 'minimax') selectSubagentModelMinimax.value = subagentModel || 'minimax-m2.7';
  if (subagentProvider === 'moonshot') selectSubagentModelMoonshot.value = subagentModel || 'moonshotai/kimi-k2.6';
  if (subagentProvider === 'ollama') selectSubagentModelOllama.value = subagentModel || 'deepseek-v3.1:671b-cloud';
  if (selectSubagentReasoningMode) {
    selectSubagentReasoningMode.value = OPENAI_CODEX_REASONING_MODES.has(subagentReasoningMode) ? subagentReasoningMode : 'medium';
  }
  if (inputSmartMainRoutingEnabled) inputSmartMainRoutingEnabled.checked = smartMainRoutingEnabled;
  inputMinimaxKey.value = minimaxApiKey;
  inputMoonshotKey.value = moonshotApiKey;
  inputOllamaKey.value = ollamaApiKey;
  if (inputSearxngSearchUrl) inputSearxngSearchUrl.value = searxngSearchUrl;
  if (inputSearxngSearchPort) inputSearxngSearchPort.value = searxngSearchPort;

  function isCodexReasoningVisible() {
    return selectSubagentProvider.value === OPENAI_CODEX_PROVIDER &&
      OPENAI_CODEX_REASONING_MODELS.has(selectSubagentModelOpenaiCodex.value);
  }

  function updateCodexReasoningUI() {
    if (!groupSubagentReasoningMode) return;
    groupSubagentReasoningMode.style.display = isCodexReasoningVisible() ? 'flex' : 'none';
  }

  function updateCodexAuthUI(status = {}) {
    const connected = Boolean(status.connected);
    if (openaiCodexStatusBadge) {
      openaiCodexStatusBadge.classList.toggle('integration-connected', connected);
      openaiCodexStatusBadge.classList.toggle('integration-disconnected', !connected);
    }
    if (openaiCodexStatusText) {
      openaiCodexStatusText.textContent = connected ? 'Logged in' : 'Logged out';
    }
    if (openaiCodexStatusDetails) {
      openaiCodexStatusDetails.textContent = status.detail || (connected
        ? 'Codex OAuth credentials are available for GPT subagents.'
        : 'Login with Codex to use GPT-5.5 or GPT-5.4 subagents.');
    }
    if (btnOpenaiCodexLogin) btnOpenaiCodexLogin.classList.toggle('hidden', connected);
    if (btnOpenaiCodexLogout) btnOpenaiCodexLogout.classList.toggle('hidden', !connected);
  }

  async function checkOpenaiCodexStatus() {
    try {
      const res = await fetchLocalApiWithTimeout('/api/codex/status', {}, LOCAL_API_TIMEOUT_MS);
      const data = res.ok ? await readBootResponseJsonWithTimeout(res, LOCAL_API_TIMEOUT_MS) : { connected: false, detail: `Status check failed: HTTP ${res.status}` };
      updateCodexAuthUI(data);
      return data;
    } catch (err) {
      updateCodexAuthUI({ connected: false, detail: `Status check failed: ${err.message}` });
      return { connected: false, error: err.message };
    }
  }

  function setCustomStatus(msg, isError) {
    if (!customStatus) return;
    customStatus.textContent = msg;
    customStatus.style.color = isError ? '#ff6b6b' : 'rgba(255,255,255,0.6)';
  }

  // Auto-fetch models from any OpenAI-compatible endpoint (llama.cpp, vLLM, etc.) if it exposes
  // /models; otherwise the user types the model name manually.
  async function refreshCustomModels() {
    const endpoint = (inputCustomEndpoint && inputCustomEndpoint.value.trim()) || customEndpoint || '';
    if (!endpoint) { setCustomStatus('Enter the API base URL first.', true); return; }
    const key = (inputCustomApiKey && inputCustomApiKey.value.trim()) || customApiKey || '';
    const datalist = document.getElementById('datalist-custom-models');
    setCustomStatus('Fetching models…', false);
    try {
      const url = `/api/openai-compat/models?endpoint=${encodeURIComponent(endpoint)}${key ? `&key=${encodeURIComponent(key)}` : ''}`;
      const res = await fetchLocalApiWithTimeout(url, {}, LOCAL_API_TIMEOUT_MS);
      const data = await readBootResponseJsonWithTimeout(res, LOCAL_API_TIMEOUT_MS);
      const models = (data && Array.isArray(data.models)) ? data.models : [];
      if (datalist) datalist.innerHTML = '';
      if (!models.length) {
        setCustomStatus((data && data.error) ? data.error : 'No models returned — type the model name manually.', true);
        return;
      }
      if (datalist) {
        for (const name of models) {
          const opt = document.createElement('option');
          opt.value = name;
          datalist.appendChild(opt);
        }
      }
      if (inputCustomModel && !inputCustomModel.value && models.length) inputCustomModel.value = models[0];
      setCustomStatus(`Found ${models.length} model${models.length === 1 ? '' : 's'} — pick a suggestion or type one.`, false);
    } catch (err) {
      setCustomStatus('Could not reach the endpoint. You can still type the model name manually.', true);
    }
  }

  function updateProviderUI() {
    groupMinimaxKey.style.display = 'none';
    groupMoonshotKey.style.display = 'none';
    groupOllamaSettings.style.display = 'none';
    if (groupCustomSettings) groupCustomSettings.style.display = 'none';
    groupOpenaiCodexAuth.style.display = 'none';
    selectSubagentModelGemini.style.display = 'none';
    selectSubagentModelOpenaiCodex.style.display = 'none';
    selectSubagentModelMinimax.style.display = 'none';
    selectSubagentModelMoonshot.style.display = 'none';
    selectSubagentModelOllama.style.display = 'none';

    const prov = selectSubagentProvider.value;
    if (prov === 'gemini') selectSubagentModelGemini.style.display = 'block';
    if (prov === OPENAI_CODEX_PROVIDER) {
      groupOpenaiCodexAuth.style.display = 'flex';
      selectSubagentModelOpenaiCodex.style.display = 'block';
      checkOpenaiCodexStatus();
    }
    if (prov === 'minimax') { groupMinimaxKey.style.display = 'block'; selectSubagentModelMinimax.style.display = 'block'; }
    if (prov === 'moonshot') { groupMoonshotKey.style.display = 'block'; selectSubagentModelMoonshot.style.display = 'block'; }
    if (prov === 'ollama') { groupOllamaSettings.style.display = 'block'; selectSubagentModelOllama.style.display = 'block'; }
    if (prov === 'custom_openai') {
      if (groupCustomSettings) groupCustomSettings.style.display = 'block';
      if (inputCustomEndpoint) inputCustomEndpoint.value = customEndpoint;
      if (inputCustomApiKey) inputCustomApiKey.value = customApiKey;
      if (inputCustomModel && subagentProvider === 'custom_openai' && subagentModel) inputCustomModel.value = subagentModel;
      if (customEndpoint) refreshCustomModels();
    }
    updateCodexReasoningUI();
  }
  updateProviderUI();
  selectSubagentProvider.addEventListener('change', updateProviderUI);
  if (btnRefreshCustomModels) {
    btnRefreshCustomModels.addEventListener('click', () => {
      if (inputCustomEndpoint) customEndpoint = inputCustomEndpoint.value.trim();
      if (inputCustomApiKey) customApiKey = inputCustomApiKey.value.trim();
      refreshCustomModels();
    });
  }
  if (selectSubagentModelOpenaiCodex) {
    selectSubagentModelOpenaiCodex.addEventListener('change', updateCodexReasoningUI);
  }

  if (selectMemoryBackupInterval) {
    selectMemoryBackupInterval.addEventListener('change', updateMemoryBackupCustomVisibility);
  }

  // Initialize Canvas dimensions
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Load from backend config if exists
  await loadConfigFromServer();
  if (typeof recoverOrphanedActiveSubagentSnapshots === 'function') {
    recoverOrphanedActiveSubagentSnapshots();
  }
  loadMemoryBackupSettings();
  startBackendHealthMonitor();
  checkGoogleStatus();
  maybeCheckForUpdate();

  // Show onboarding if no key is saved
  if (!apiKey) {
    initOnboardingWizard();
    onboardingModal.classList.remove('hidden');
  }

  // Open external links in the user's DEFAULT browser. The app runs in a borderless Chromium app
  // window, where target=_blank links would otherwise spawn a stray browser window; route them
  // through the backend's ShellExecute instead.
  window.openExternalUrl = function (url) {
    if (!/^https?:\/\//i.test(url || '')) return false;
    fetchLocalApiWithTimeout('/api/open-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url }) }, 8000).catch(function () {});
    return true;
  };
  document.addEventListener('click', function (ev) {
    const a = ev.target && ev.target.closest ? ev.target.closest('a[target="_blank"]') : null;
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) { ev.preventDefault(); window.openExternalUrl(href); }
  }, true);

  // Remember real {deviceId: label} pairs whenever we manage to read them (after priming or during a
  // live call), so the Settings picker can show real names even later when no stream is active and the
  // browser has re-hidden labels.
  function cacheMicLabels(mics) {
    try {
      const map = JSON.parse(localStorage.getItem('shadow_mic_labels') || '{}');
      let changed = false;
      (mics || []).forEach(function (d) {
        if (d && d.deviceId && d.label && map[d.deviceId] !== d.label) { map[d.deviceId] = d.label; changed = true; }
      });
      if (changed) localStorage.setItem('shadow_mic_labels', JSON.stringify(map));
    } catch (e) {}
  }
  function getCachedMicLabel(deviceId) {
    try { return (JSON.parse(localStorage.getItem('shadow_mic_labels') || '{}'))[deviceId] || ''; } catch (e) { return ''; }
  }
  window.cacheMicLabels = cacheMicLabels;

  // Microphone device picker: list input devices, persist the choice, use it in getUserMedia.
  // Browsers hide real device NAMES + the full device list until the page has been granted mic access.
  // When prime=true (e.g. opening Settings), briefly open a mic stream (auto-accepted in the app window)
  // to unlock the real names + every device, then stop it immediately.
  async function populateMicDevices(prime) {
    if (!selectMicDevice || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      let mics = devices.filter(function (d) { return d.kind === 'audioinput'; });
      const labelsHidden = mics.length <= 1 || mics.every(function (d) { return !d.label; });
      if (prime && labelsHidden && navigator.mediaDevices.getUserMedia) {
        try {
          // Open a real-device stream to unlock labels + the full device list. Race a timeout so a
          // stuck/blocked permission can never hang Settings. Enumerate WHILE the stream is alive
          // (an auto-accept grant can re-hide labels the instant the track stops), then stop it.
          const tmp = await Promise.race([
            navigator.mediaDevices.getUserMedia({ audio: true }),
            new Promise(function (_, rej) { setTimeout(function () { rej(new Error('mic-prime-timeout')); }, 4000); })
          ]);
          devices = await navigator.mediaDevices.enumerateDevices();
          mics = devices.filter(function (d) { return d.kind === 'audioinput'; });
          if (tmp && tmp.getTracks) tmp.getTracks().forEach(function (t) { t.stop(); });
        } catch (e) {}
      }
      cacheMicLabels(mics);
      // Drop Windows' "default"/"communications" alias entries — we already offer "Default
      // microphone", and the aliases just duplicate a real device under a generic name.
      const realMics = mics.filter(function (d) {
        return d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications';
      });
      const listMics = realMics.length ? realMics : mics;
      selectMicDevice.innerHTML = '<option value="">Default microphone</option>';
      listMics.forEach(function (d, i) {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        // Prefer the live label, then a previously-cached real name, then a generic fallback.
        opt.textContent = d.label || getCachedMicLabel(d.deviceId) || ('Microphone ' + (i + 1));
        selectMicDevice.appendChild(opt);
      });
      // Keep the saved choice if it's still present; otherwise fall back to Default.
      const has = Array.prototype.some.call(selectMicDevice.options, function (o) { return o.value === (selectedMicDeviceId || ''); });
      selectMicDevice.value = has ? (selectedMicDeviceId || '') : '';
    } catch (e) {}
  }
  window.populateMicDevices = populateMicDevices;
  if (selectMicDevice) {
    selectMicDevice.addEventListener('change', function () {
      selectedMicDeviceId = selectMicDevice.value || '';
      try { localStorage.setItem('shadow_mic_device', selectedMicDeviceId); } catch (e) {}
      // If a call is in progress, switch the live mic immediately instead of waiting for reconnect.
      if (typeof isConnected !== 'undefined' && isConnected &&
          typeof audioRecorder !== 'undefined' && audioRecorder &&
          typeof audioRecorder.switchDevice === 'function') {
        audioRecorder.switchDevice();
      }
    });
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    try { navigator.mediaDevices.addEventListener('devicechange', populateMicDevices); } catch (e) {}
  }
  populateMicDevices();

  // ---- Push-to-talk wiring ----
  // Human-readable label for a KeyboardEvent at bind time (the Settings window is focused, so the
  // browser delivers keydown even for F13-F24 mapped from a mouse button).
  function pttLabelFromEvent(e) {
    const code = e.code || '';
    if (/^F\d{1,2}$/.test(code)) return code;                  // F1..F24
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);         // KeyA -> A
    if (/^Digit\d$/.test(code)) return code.slice(5);          // Digit5 -> 5
    if (/^Numpad/.test(code)) return code.replace('Numpad', 'Num ');
    const named = {
      Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backquote: '`',
      ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
      AltLeft: 'Left Alt', AltRight: 'Right Alt',
      ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift'
    };
    if (named[code]) return named[code];
    if (e.key && e.key.length === 1) return e.key.toUpperCase();
    return code || ('Key ' + (e.keyCode || 0));
  }

  function renderPttBinding() {
    if (inputPttEnabled) inputPttEnabled.checked = !!pushToTalkEnabled;
    if (pttKeyLabel) {
      if (pushToTalkEnabled && !pushToTalkVk) {
        pttKeyLabel.textContent = 'No key set — click “Set key”';
      } else if (pushToTalkVk) {
        pttKeyLabel.textContent = 'Bound to: ' + (pushToTalkKeyLabel || ('Key ' + pushToTalkVk));
      } else {
        pttKeyLabel.textContent = 'No key set';
      }
    }
  }

  // Tell the server which key to watch globally (and whether PTT is on). Safe to call often.
  async function applyPttConfigToServer() {
    try {
      const res = await fetchLocalApiWithTimeout('/api/ptt/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: pttIsArmed(), vk: pushToTalkVk || 0 })
      }, LOCAL_API_TIMEOUT_MS);
      const data = await readBootResponseJsonWithTimeout(res, LOCAL_API_TIMEOUT_MS);
      return !!(data && data.supported);
    } catch (e) { return false; }
  }

  function persistPttSettings() {
    try {
      localStorage.setItem('shadow_ptt_enabled', pushToTalkEnabled ? 'true' : 'false');
      localStorage.setItem('shadow_ptt_vk', String(pushToTalkVk || 0));
      localStorage.setItem('shadow_ptt_key_label', pushToTalkKeyLabel || '');
    } catch (e) {}
    if (typeof saveConfigToServer === 'function') saveConfigToServer();
  }

  // Single place that flips the held state (used by both the global poll and the focused fallback).
  function setPttHeld(held) {
    if (held === pushToTalkActive) return;
    pushToTalkActive = held;
    if (!held) pttLastReleaseAt = Date.now();
  }

  // Global long-poll: learn of press/release edges from the server's key poll with ~15-30ms latency,
  // even when Shadow isn't the focused window.
  let pttWaitRunning = false;
  let pttWaitAbort = null;
  async function pttWaitLoop() {
    if (pttWaitRunning) return;
    pttWaitRunning = true;
    let since = -1;
    try {
      const sres = await fetchLocalApiWithTimeout('/api/ptt/state', {}, LOCAL_API_TIMEOUT_MS);
      const s = await readBootResponseJsonWithTimeout(sres, LOCAL_API_TIMEOUT_MS);
      if (s && s.status === 'success') { since = s.seq; setPttHeld(!!s.held); }
    } catch (e) {}
    while (pttWaitRunning && pttIsArmed()) {
      try {
        pttWaitAbort = new AbortController();
        // The wait endpoint blocks up to ~25s (heartbeat), so the fetch timeout must exceed that.
        const wres = await fetchLocalApiWithTimeout('/api/ptt/wait?since=' + since, { signal: pttWaitAbort.signal }, 30000);
        const d = await readBootResponseJsonWithTimeout(wres, LOCAL_API_TIMEOUT_MS);
        if (d && d.status === 'success') { since = d.seq; setPttHeld(!!d.held); }
      } catch (e) {
        if (!pttIsArmed()) break;
        await new Promise(res => setTimeout(res, 600));   // brief backoff on a network hiccup
      }
    }
    pttWaitRunning = false;
  }
  function stopPttWaitLoop() {
    pttWaitRunning = false;
    if (pttWaitAbort) { try { pttWaitAbort.abort(); } catch (e) {} }
  }

  // Apply the current PTT settings everywhere: UI, server arm, and the edge long-poll. Exposed so
  // loadConfigFromServer() can re-apply after restoring settings from config.json on boot.
  function onPttSettingsChanged() {
    renderPttBinding();
    applyPttConfigToServer();
    if (pttIsArmed()) pttWaitLoop();
    else { stopPttWaitLoop(); setPttHeld(false); }
  }
  window.onPttSettingsChanged = onPttSettingsChanged;

  if (inputPttEnabled) {
    inputPttEnabled.addEventListener('change', function () {
      pushToTalkEnabled = inputPttEnabled.checked;
      persistPttSettings();
      onPttSettingsChanged();
    });
  }

  // "Set key": capture the next key the user presses. keyCode is the Windows virtual-key the server
  // poll watches. Esc cancels.
  let pttCapturing = false;
  if (btnPttCapture) {
    btnPttCapture.addEventListener('click', function () {
      if (pttCapturing) return;
      pttCapturing = true;
      const prevText = btnPttCapture.textContent;
      btnPttCapture.textContent = 'Press a key…';
      if (pttKeyLabel) pttKeyLabel.textContent = 'Listening — press any key (Esc to cancel)';
      const onKey = function (e) {
        e.preventDefault();
        e.stopPropagation();
        window.removeEventListener('keydown', onKey, true);
        pttCapturing = false;
        btnPttCapture.textContent = prevText;
        if (e.keyCode === 27) { renderPttBinding(); return; }   // Esc cancels
        pushToTalkVk = e.keyCode || 0;
        pushToTalkKeyLabel = pttLabelFromEvent(e);
        persistPttSettings();
        onPttSettingsChanged();
      };
      window.addEventListener('keydown', onKey, true);
    });
  }

  // Focused-window fallback: drives PTT whenever Shadow has focus, so it still works if the global
  // poll is ever unavailable (Add-Type blocked). Harmless to run alongside the global poll.
  window.addEventListener('keydown', function (e) {
    if (pttCapturing || !pttIsArmed()) return;
    if (e.keyCode === pushToTalkVk && !e.repeat) setPttHeld(true);
  });
  window.addEventListener('keyup', function (e) {
    if (!pttIsArmed()) return;
    if (e.keyCode === pushToTalkVk) setPttHeld(false);
  });

  // Arm the server with the saved binding on boot so PTT works on the very first call.
  onPttSettingsChanged();

  // Setup Event Listeners
  btnSettings.addEventListener('click', () => {
    inputApiKey.value = apiKey;
    populateMicDevices(true);
    renderPttBinding();
    if (updateCheckStatus) updateCheckStatus.textContent = '';
    if (inputUserName) inputUserName.value = getUserName();
    selectVoice.value = voiceName;
    selectAccent.value = accent;
    selectModel.value = selectedModel;
    if (selectLiveThinkingLevel) selectLiveThinkingLevel.value = liveThinkingLevel;
    if (inputSmartMainRoutingEnabled) inputSmartMainRoutingEnabled.checked = smartMainRoutingEnabled;
    if (inputAutoUpdateCheck) inputAutoUpdateCheck.checked = autoUpdateCheckEnabled;
    selectSubagentProvider.value = subagentProvider;
    if (subagentProvider === 'gemini') selectSubagentModelGemini.value = subagentModel || 'models/gemini-3.1-flash-lite';
    if (subagentProvider === OPENAI_CODEX_PROVIDER) selectSubagentModelOpenaiCodex.value = subagentModel || 'gpt-5.5';
    if (subagentProvider === 'minimax') selectSubagentModelMinimax.value = subagentModel || 'minimax-m2.7';
    if (subagentProvider === 'moonshot') selectSubagentModelMoonshot.value = subagentModel || 'moonshotai/kimi-k2.6';
    if (subagentProvider === 'ollama') selectSubagentModelOllama.value = subagentModel || 'deepseek-v3.1:671b-cloud';
    if (selectSubagentReasoningMode) selectSubagentReasoningMode.value = subagentReasoningMode;
    if (inputSearxngSearchUrl) inputSearxngSearchUrl.value = searxngSearchUrl;
    if (inputSearxngSearchPort) inputSearxngSearchPort.value = searxngSearchPort;
    updateProviderUI();
    syncProactiveControls();
    syncMemoryBackupUI();
    settingsModal.classList.remove('hidden');
  });

  if (btnDiagnostics && diagnosticsPanel) {
    btnDiagnostics.addEventListener('click', () => {
      diagnosticsPanel.classList.toggle('hidden');
      updateDiagnosticsPanel();
    });
  }

  btnCloseSettings.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  // Missing-credential popup wiring
  if (btnCloseCredential && credentialModal) {
    btnCloseCredential.addEventListener('click', () => credentialModal.classList.add('hidden'));
  }
  if (btnCredentialOpenSettings) {
    btnCredentialOpenSettings.addEventListener('click', () => {
      const fieldId = credentialModal ? (credentialModal.dataset.fieldId || '') : '';
      const provider = credentialModal ? (credentialModal.dataset.subagentProvider || '') : '';
      if (credentialModal) credentialModal.classList.add('hidden');
      openSettingsToField(fieldId, provider);
    });
  }

  // Update-available toast wiring. "Update" opens the download in the browser (handled by
  // the anchor's href + target=_blank); we just dismiss the toast. "Later" hides it and
  // remembers this version so we don't nag again until a newer one appears.
  if (btnUpdateNow && updateToast) {
    btnUpdateNow.addEventListener('click', () => {
      updateToast.classList.add('hidden');
    });
  }
  if (btnUpdateLater && updateToast) {
    btnUpdateLater.addEventListener('click', () => {
      updateToast.classList.add('hidden');
      const v = updateToast.dataset.latestVersion || '';
      if (v) {
        updateDismissedVersion = v;
        try { localStorage.setItem('shadow_update_dismissed_version', v); } catch (e) {}
      }
    });
  }
  if (btnCheckUpdates) {
    btnCheckUpdates.addEventListener('click', () => { manualCheckForUpdate(); });
  }

  if (selectVoice) {
    selectVoice.addEventListener('change', syncFavoriteVoiceButton);
  }

  const btnPreviewVoice = document.getElementById('btn-preview-voice');
  if (btnPreviewVoice && selectVoice) {
    btnPreviewVoice.addEventListener('click', () => previewVoice(selectVoice.value, btnPreviewVoice, inputAssistantName ? inputAssistantName.value : ''));
  }
  const btnOnboardingPreviewVoice = document.getElementById('btn-onboarding-preview-voice');
  if (btnOnboardingPreviewVoice && onboardingVoice) {
    btnOnboardingPreviewVoice.addEventListener('click', () => previewVoice(onboardingVoice.value, btnOnboardingPreviewVoice, onboardingAssistantName ? onboardingAssistantName.value : ''));
  }

  if (btnFavoriteVoice) {
    btnFavoriteVoice.addEventListener('click', () => {
      toggleCurrentVoiceFavorite();
      saveConfigToServer().then(saved => {
        if (!saved) addSystemMessage('Favorite voices saved locally. Server config sync is queued and will retry automatically.');
      });
    });
  }

  btnSaveSettings.addEventListener('click', async () => {
    const oldApiKey = apiKey;
    const oldAssistantName = getAssistantName();
    const oldVoice = voiceName;
    const oldModel = selectedModel;
    const oldLiveThinkingLevel = liveThinkingLevel;
    const oldSmartMainRoutingEnabled = smartMainRoutingEnabled;
    btnSaveSettings.disabled = true;
    btnSaveSettings.textContent = 'Saving...';

    try {
      apiKey = inputApiKey.value.trim();
      if (inputAssistantName) assistantName = normalizeAssistantName(inputAssistantName.value);
      if (inputUserName) userName = normalizeUserName(inputUserName.value);
      voiceName = selectVoice.value;
      selectedModel = selectModel.value;
      if (selectLiveThinkingLevel) {
        liveThinkingLevel = normalizeLiveThinkingLevel(selectLiveThinkingLevel.value);
      }
      if (inputSmartMainRoutingEnabled) {
        smartMainRoutingEnabled = inputSmartMainRoutingEnabled.checked;
      }
      const oldProactiveEnabled = proactiveEnabled;
      if (inputProactiveEnabled) {
        proactiveEnabled = inputProactiveEnabled.checked;
      }
      const oldProactiveProfile = proactiveProfile;
      if (selectProactiveProfile) {
        proactiveProfile = normalizeProactiveProfile(selectProactiveProfile.value);
      } else {
        normalizeProactiveProfile();
      }
      const oldAccent = accent;
      accent = selectAccent.value;

      localStorage.setItem('shadow_api_key', apiKey);
      localStorage.setItem('shadow_assistant_name', assistantName);
      if (inputAssistantName) inputAssistantName.value = assistantName;
      localStorage.setItem('shadow_user_name', userName);
      if (inputUserName) inputUserName.value = userName;
      if (typeof syncMemoryGraphAssistantLabels === 'function') syncMemoryGraphAssistantLabels();
      // Rewrite the actual 'user'/'shadow' graph nodes so a rename shows up in memories.
      if (typeof apiSyncIdentityNodes === 'function') apiSyncIdentityNodes();
      localStorage.setItem('shadow_voice', voiceName);
      localStorage.setItem('shadow_model', selectedModel);
      localStorage.setItem('shadow_live_thinking_level', liveThinkingLevel);
      localStorage.setItem('shadow_smart_main_routing_enabled', smartMainRoutingEnabled ? 'true' : 'false');
      if (inputAutoUpdateCheck) {
        autoUpdateCheckEnabled = inputAutoUpdateCheck.checked;
        localStorage.setItem('shadow_auto_update_check', autoUpdateCheckEnabled ? 'true' : 'false');
      }
      localStorage.setItem('shadow_accent', accent);
      localStorage.setItem('shadow_proactive_enabled', proactiveEnabled ? 'true' : 'false');
      localStorage.setItem('shadow_proactive_profile', proactiveProfile);
      syncProactiveControls();
      if (!proactiveEnabled && oldProactiveEnabled) {
        stopProactiveAttention();
      }
      if (proactiveEnabled && (!oldProactiveEnabled || oldProactiveProfile !== proactiveProfile)) {
        signalProactiveAttention('settings_changed');
      }

      subagentProvider = selectSubagentProvider.value;
      if (subagentProvider === 'gemini') subagentModel = selectSubagentModelGemini.value;
      else if (subagentProvider === OPENAI_CODEX_PROVIDER) subagentModel = selectSubagentModelOpenaiCodex.value;
      else if (subagentProvider === 'minimax') subagentModel = selectSubagentModelMinimax.value;
      else if (subagentProvider === 'moonshot') subagentModel = selectSubagentModelMoonshot.value;
      else if (subagentProvider === 'ollama') subagentModel = selectSubagentModelOllama.value;
      else if (subagentProvider === 'custom_openai') subagentModel = inputCustomModel ? inputCustomModel.value.trim() : '';
      else subagentModel = '';
      if (inputCustomEndpoint) {
        customEndpoint = inputCustomEndpoint.value.trim();
      }
      if (inputCustomApiKey) {
        customApiKey = inputCustomApiKey.value.trim();
      }
      if (selectSubagentReasoningMode) {
        const requestedReasoningMode = selectSubagentReasoningMode.value;
        subagentReasoningMode = OPENAI_CODEX_REASONING_MODES.has(requestedReasoningMode) ? requestedReasoningMode : 'medium';
      }

      minimaxApiKey = inputMinimaxKey.value.trim();
      moonshotApiKey = inputMoonshotKey.value.trim();
      ollamaApiKey = inputOllamaKey.value.trim();
      searxngSearchUrl = inputSearxngSearchUrl ? inputSearxngSearchUrl.value.trim() : searxngSearchUrl;
      searxngSearchPort = inputSearxngSearchPort ? inputSearxngSearchPort.value.trim() : searxngSearchPort;
      if (!searxngSearchUrl) searxngSearchUrl = 'http://127.0.0.1/search';
      if (!searxngSearchPort) searxngSearchPort = '8888';

      localStorage.setItem('shadow_subagent_provider', subagentProvider);
      localStorage.setItem('shadow_subagent_model', subagentModel);
      localStorage.setItem('shadow_subagent_reasoning_mode', subagentReasoningMode);
      localStorage.setItem('shadow_minimax_key', minimaxApiKey);
      localStorage.setItem('shadow_moonshot_key', moonshotApiKey);

      localStorage.setItem('shadow_ollama_key', ollamaApiKey);
      localStorage.setItem('shadow_custom_endpoint', customEndpoint);
      localStorage.setItem('shadow_custom_api_key', customApiKey);
      localStorage.setItem('shadow_searxng_url', searxngSearchUrl);
      localStorage.setItem('shadow_searxng_port', searxngSearchPort);

      if (inputMemoryBackupEnabled) {
        memoryBackupEnabled = inputMemoryBackupEnabled.checked;
        localStorage.setItem('shadow_memory_backup_enabled', memoryBackupEnabled ? 'true' : 'false');
      }
      if (selectMemoryBackupInterval) {
        let intervalVal = selectMemoryBackupInterval.value;
        if (intervalVal === 'custom') {
          intervalVal = parseInt(inputMemoryBackupCustomMinutes?.value || '60', 10);
          if (isNaN(intervalVal) || intervalVal <= 0) intervalVal = 60;
        }
        memoryBackupIntervalMinutes = parseInt(intervalVal, 10);
        localStorage.setItem('shadow_memory_backup_interval', String(memoryBackupIntervalMinutes));
      }
      syncMemoryBackupScheduler();

      settingsModal.classList.add('hidden');
      addSystemMessage(`Settings saved locally. Subagents will use ${subagentProvider}${subagentModel ? ` / ${subagentModel}` : ''} for newly spawned agents.`);

      const voiceChanged = oldVoice !== voiceName;
      const assistantNameChanged = oldAssistantName !== getAssistantName();
      const liveThinkingChanged = oldLiveThinkingLevel !== liveThinkingLevel;
      const smartMainRoutingChanged = oldSmartMainRoutingEnabled !== smartMainRoutingEnabled;
      const accentChanged = oldAccent !== accent;
      if (shouldStartFreshVoiceSession(oldVoice, voiceName)) {
        clearLiveSessionResumptionToken();
      }
      if (liveThinkingChanged) {
        clearLiveSessionResumptionToken();
      }
      if (smartMainRoutingChanged) {
        clearLiveSessionResumptionToken();
      }
      if (assistantNameChanged) {
        clearLiveSessionResumptionToken();
        if (isGraphOpen && updateGraphVisualization) updateGraphVisualization();
        if (typeof refreshIdleAssistantName === 'function') refreshIdleAssistantName();
      }

      saveConfigToServer().then(saved => {
        if (!saved) addSystemMessage('Settings saved locally. Server config sync is queued and will retry automatically.');
      });

      // If currently connected and important voice-call settings changed, perform a clean reconnect.
      // Subagent provider/model changes are intentionally applied without reconnecting.
      if (isConnected && (oldApiKey !== apiKey || assistantNameChanged || voiceChanged || oldModel !== selectedModel || liveThinkingChanged || smartMainRoutingChanged || accentChanged)) {
        const changedWhat = [];
        if (oldApiKey !== apiKey) changedWhat.push('API key');
        if (assistantNameChanged) changedWhat.push('assistant name');
        if (voiceChanged) changedWhat.push('voice');
        if (oldModel !== selectedModel) changedWhat.push('voice model');
        if (liveThinkingChanged) changedWhat.push('voice reasoning');
        if (smartMainRoutingChanged) changedWhat.push('subagent prompt brain');
        if (accentChanged) changedWhat.push('accent');
        addSystemMessage(`${changedWhat.join(' / ')} changed. Reconnecting to apply new voice configuration...`);

        disconnect();
        setTimeout(() => {
          connect();
        }, 1000);
      }
    } catch (err) {
      console.error('Failed to save settings:', err);
      addSystemMessage(`Settings save failed: ${err.message}`);
    } finally {
      btnSaveSettings.disabled = false;
      btnSaveSettings.textContent = 'Save Changes';
    }
  });

  // Onboarding wizard navigation
  if (btnOnboardNext) {
    btnOnboardNext.addEventListener('click', () => {
      if (onboardingCurrentStep === 1) {
        const key = (onboardingApiKey.value || '').trim();
        if (!key) {
          onboardingApiKey.classList.add('field-attention');
          onboardingApiKey.focus();
          setTimeout(() => onboardingApiKey.classList.remove('field-attention'), 2200);
          return;
        }
      }
      goToOnboardingStep(Math.min(onboardingCurrentStep + 1, 4));
    });
  }
  if (btnOnboardBack) {
    btnOnboardBack.addEventListener('click', () => {
      goToOnboardingStep(Math.max(onboardingCurrentStep - 1, 1));
    });
  }

  // Mic-check device picker: switching device restarts the live meter on the new device.
  const onboardingMicDevice = document.getElementById('onboarding-mic-device');
  if (onboardingMicDevice) {
    onboardingMicDevice.addEventListener('change', () => {
      selectedMicDeviceId = onboardingMicDevice.value || '';
      try { localStorage.setItem('shadow_mic_device', selectedMicDeviceId); } catch (e) {}
      if (onboardingCurrentStep === 2) startOnboardingMicMeter();
    });
  }

  // Voice carousel: arrows cycle voices live; name/accent changes re-greet in the new voice.
  const btnVoicePrev = document.getElementById('btn-voice-prev');
  const btnVoiceNext = document.getElementById('btn-voice-next');
  if (btnVoicePrev) btnVoicePrev.addEventListener('click', () => cycleOnboardingVoice(-1));
  if (btnVoiceNext) btnVoiceNext.addEventListener('click', () => cycleOnboardingVoice(1));
  if (onboardingAssistantName) {
    onboardingAssistantName.addEventListener('change', () => { if (onboardingCurrentStep === 3) startOnboardingVoiceCarousel(); });
  }
  if (onboardingAccent) {
    onboardingAccent.addEventListener('change', () => { if (onboardingCurrentStep === 3) startOnboardingVoiceCarousel(); });
  }

  // Forced subagent connection test.
  const btnTestSubagent = document.getElementById('btn-onboarding-test-subagent');
  if (btnTestSubagent) btnTestSubagent.addEventListener('click', runOnboardingSubagentTest);

  if (onboardingSubagentProvider) {
    onboardingSubagentProvider.addEventListener('change', () => {
      updateOnboardingSubagentUI();
      // A new provider needs its own test before finishing.
      onboardingSubagentTested = false;
      const st = document.getElementById('onboarding-subagent-test-status');
      if (st) { st.textContent = ''; st.classList.remove('ok'); }
      updateOnboardingNavGate();
    });
  }
  if (btnOnboardingDetectModels) {
    btnOnboardingDetectModels.addEventListener('click', onboardingDetectModels);
  }
  if (btnOnboardingCodexLogin) {
    btnOnboardingCodexLogin.addEventListener('click', triggerOnboardingCodexLogin);
  }
  if (onboardingSubagentEndpoint) {
    onboardingSubagentEndpoint.addEventListener('change', () => {
      const prov = onboardingSubagentProvider ? onboardingSubagentProvider.value : '';
      if (prov === 'custom_openai') onboardingDetectModels();
    });
  }

  btnGetStarted.addEventListener('click', async () => {
    // Always tear down the live voice preview + mic meter before finishing (no lingering socket/mic).
    if (typeof stopOnboardingVoicePreview === 'function') stopOnboardingVoicePreview();
    stopOnboardingMicMeter();
    const key = (onboardingApiKey.value || '').trim();
    if (!key) {
      goToOnboardingStep(1);
      onboardingApiKey.classList.add('field-attention');
      onboardingApiKey.focus();
      setTimeout(() => onboardingApiKey.classList.remove('field-attention'), 2200);
      return;
    }
    btnGetStarted.disabled = true;
    btnGetStarted.textContent = 'Setting up...';
    try {
      apiKey = key;
      localStorage.setItem('shadow_api_key', apiKey);

      // Personalization (step 2)
      if (onboardingUserName) {
        userName = normalizeUserName(onboardingUserName.value);
        localStorage.setItem('shadow_user_name', userName);
      }
      if (onboardingAssistantName) {
        assistantName = normalizeAssistantName(onboardingAssistantName.value);
        localStorage.setItem('shadow_assistant_name', assistantName);
      }
      if (onboardingVoice && onboardingVoice.value) {
        voiceName = onboardingVoice.value;
        localStorage.setItem('shadow_voice', voiceName);
      }
      if (onboardingAccent && onboardingAccent.value) {
        accent = onboardingAccent.value;
        localStorage.setItem('shadow_accent', accent);
      }
      if (onboardingThinking && onboardingThinking.value) {
        liveThinkingLevel = normalizeLiveThinkingLevel(onboardingThinking.value);
        localStorage.setItem('shadow_live_thinking_level', liveThinkingLevel);
      }

      // Subagent provider (step 3)
      await applyOnboardingSubagentChoice();

      await saveConfigToServer();

      onboardingModal.classList.add('hidden');
      if (typeof refreshIdleAssistantName === 'function') refreshIdleAssistantName();
      addSystemMessage(`Welcome${userName ? `, ${userName}` : ''}! Setup complete. Subagents will use ${subagentProvider}${subagentModel ? ` / ${subagentModel}` : ''}.`);
    } catch (err) {
      console.error('Onboarding finish failed:', err);
      addSystemMessage(`Setup hit an error: ${err.message}. Your key was saved — you can finish configuring in Settings.`);
      onboardingModal.classList.add('hidden');
    } finally {
      btnGetStarted.disabled = false;
      btnGetStarted.textContent = 'Initialize Shadow';
    }
  });

  btnToggleKeyVisibility.addEventListener('click', () => {
    // The key field is type="text" + .masked-input (never type="password", to avoid Chrome's
    // save-password prompt). Show/Hide toggles the masking class, not the input type.
    if (inputApiKey.classList.contains('masked-input')) {
      inputApiKey.classList.remove('masked-input');
      btnToggleKeyVisibility.textContent = 'Hide';
    } else {
      inputApiKey.classList.add('masked-input');
      btnToggleKeyVisibility.textContent = 'Show';
    }
  });

  if (btnOpenaiCodexLogin) {
    btnOpenaiCodexLogin.addEventListener('click', async () => {
      btnOpenaiCodexLogin.disabled = true;
      btnOpenaiCodexLogin.textContent = 'Opening...';
      try {
        const res = await fetchLocalApiWithTimeout('/api/codex/login', { method: 'POST' }, CODEX_AUTH_API_TIMEOUT_MS);
        const data = await readBootResponseJsonWithTimeout(res, CODEX_AUTH_API_TIMEOUT_MS).catch(() => ({}));
        if (!res.ok || data.status === 'error') {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        updateCodexAuthUI({ connected: false, detail: data.message || 'Complete the Codex login in your browser, then status will update automatically.' });
        addSystemMessage('Codex login opened. Complete the browser login flow, then return to Shadow.');

        let pollCount = 0;
        const pollTimer = setInterval(async () => {
          pollCount++;
          const status = await checkOpenaiCodexStatus();
          if (status.connected || pollCount > 150) {
            clearInterval(pollTimer);
            if (status.connected) addSystemMessage('OpenAI Codex login is connected.');
          }
        }, 2000);
      } catch (err) {
        console.error('Codex login failed:', err);
        alert(`Could not start Codex login: ${err.message}`);
      } finally {
        btnOpenaiCodexLogin.disabled = false;
        btnOpenaiCodexLogin.textContent = 'Login with Codex';
      }
    });
  }

  if (btnOpenaiCodexLogout) {
    btnOpenaiCodexLogout.addEventListener('click', async () => {
      btnOpenaiCodexLogout.disabled = true;
      btnOpenaiCodexLogout.textContent = 'Logging out...';
      try {
        const res = await fetchLocalApiWithTimeout('/api/codex/logout', { method: 'POST' }, CODEX_AUTH_API_TIMEOUT_MS);
        const data = await readBootResponseJsonWithTimeout(res, CODEX_AUTH_API_TIMEOUT_MS).catch(() => ({}));
        if (!res.ok || data.status === 'error') {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        await checkOpenaiCodexStatus();
        addSystemMessage('OpenAI Codex login disconnected.');
      } catch (err) {
        console.error('Codex logout failed:', err);
        alert(`Could not log out of Codex: ${err.message}`);
      } finally {
        btnOpenaiCodexLogout.disabled = false;
        btnOpenaiCodexLogout.textContent = 'Logout';
      }
    });
  }

  btnConnect.addEventListener('click', toggleConnection);
  btnToggleMic.addEventListener('click', toggleMute);
  let interruptPointerHandled = false;
  btnInterrupt.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    interruptPointerHandled = true;
    event.preventDefault();
    manualInterrupt({ sendToServer: true });
  });
  btnInterrupt.addEventListener('click', (event) => {
    event.preventDefault();
    if (interruptPointerHandled) {
      interruptPointerHandled = false;
      return;
    }
    manualInterrupt({ sendToServer: true });
  });

  if (btnNewSession) {
    btnNewSession.addEventListener('click', () => {
      showCustomConfirm(
        'Confirm New Session',
        'Are you sure you want to clear session history and start a fresh conversation?',
        async () => {
          clearLiveSessionResumptionToken();
          localStorage.setItem('shadow_is_whispering', 'false');
          await saveConfigToServer();

          // Clear the UI and all tracking variables
          if (transcriptFeed) transcriptFeed.innerHTML = '';
          currentAITranscript = '';
          currentUserTranscript = '';
          recentAIOutputForEcho = '';
          lastOutputTranscriptionText = '';
          currentAITranscriptHasModelText = false;
          aiSpeechStartTime = 0;
          clearRecentDialogueTurns();

          addSystemMessage('Clearing session history and starting a fresh conversation...');
          updateSessionButtonVisibility();
          if (isConnected) {
            disconnect();
            setTimeout(async () => {
              await connect();
            }, 500);
          } else {
            await connect();
          }
        }
      );
    });
  }

  // Memory Graph DOM bindings and initialization
  const btnMemory = document.getElementById('btn-memory');
  const memoryModal = document.getElementById('memory-modal');
  const btnCloseMemory = document.getElementById('btn-close-memory');
  const btnResetMemories = document.getElementById('btn-reset-memories');
  const btnFactoryReset = document.getElementById('btn-factory-reset');
  const memoryCanvas = document.getElementById('memory-graph-canvas');
  const graphTooltip = document.getElementById('graph-tooltip');

  let sim = null;
  if (memoryCanvas && graphTooltip) {
    sim = new MemoryGraphSimulation(memoryCanvas, graphTooltip);
    updateGraphVisualization = () => {
      if (sim) sim.loadGraph();
    };
  }

  if (btnMemory && memoryModal) {
    btnMemory.addEventListener('click', async () => {
      isGraphOpen = true;
      if (typeof syncMemoryGraphAssistantLabels === 'function') syncMemoryGraphAssistantLabels();
      // Heal stale identity-node labels (e.g. an old "You") before rendering.
      if (typeof apiSyncIdentityNodes === 'function') { try { await apiSyncIdentityNodes(); } catch (e) {} }
      memoryModal.classList.remove('hidden');
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (sim) sim.start();
        }, 100);
      });
    });
  }

  // Skills manager (list / view / delete self-learned skills)
  const btnSkills = document.getElementById('btn-skills');
  const skillsModal = document.getElementById('skills-modal');
  const btnCloseSkills = document.getElementById('btn-close-skills');
  const skillsListEl = document.getElementById('skills-list');
  const btnWipeSkills = document.getElementById('btn-wipe-skills');

  async function renderSkillsList() {
    if (!skillsListEl) return;
    skillsListEl.innerHTML = '';
    let skills = [];
    try {
      const res = await fetchLocalApiWithTimeout('/api/skills/all', {}, LOCAL_API_TIMEOUT_MS);
      const data = await readBootResponseJsonWithTimeout(res, LOCAL_API_TIMEOUT_MS);
      skills = Array.isArray(data.skills) ? data.skills : (data.skills ? [data.skills] : []);
    } catch (err) {
      const e = document.createElement('div');
      e.className = 'skills-empty';
      e.textContent = 'Could not load skills: ' + (err && err.message ? err.message : 'unknown error');
      skillsListEl.appendChild(e);
      return;
    }
    if (!skills.length) {
      const e = document.createElement('div');
      e.className = 'skills-empty';
      e.textContent = 'No self-learned skills yet. Shadow saves reusable workflows here as it learns them.';
      skillsListEl.appendChild(e);
      return;
    }
    for (const skill of skills) {
      const name = String(skill.name || '');
      const details = document.createElement('details');
      details.className = 'skill-item';
      const summary = document.createElement('summary');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'skill-name';
      nameSpan.textContent = name;
      const delBtn = document.createElement('button');
      delBtn.className = 'danger-button skill-delete';
      delBtn.type = 'button';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!confirm(`Delete the skill "${name}"? This cannot be undone.`)) return;
        try {
          await fetchLocalApiWithTimeout('/api/skills/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skill_name: name })
          }, LOCAL_API_TIMEOUT_MS);
        } catch (err) {
          alert('Failed to delete skill: ' + (err && err.message ? err.message : 'unknown error'));
          return;
        }
        renderSkillsList();
      });
      summary.appendChild(nameSpan);
      summary.appendChild(delBtn);
      details.appendChild(summary);
      const instr = document.createElement('div');
      instr.className = 'skill-instructions';
      instr.textContent = String(skill.instructions || '(no instructions saved)');
      details.appendChild(instr);
      skillsListEl.appendChild(details);
    }
  }

  if (btnSkills && skillsModal) {
    btnSkills.addEventListener('click', () => {
      skillsModal.classList.remove('hidden');
      renderSkillsList();
    });
  }
  if (btnCloseSkills && skillsModal) {
    btnCloseSkills.addEventListener('click', () => skillsModal.classList.add('hidden'));
  }
  if (btnWipeSkills) {
    btnWipeSkills.addEventListener('click', async () => {
      if (!confirm('Delete ALL self-learned skills? This cannot be undone.')) return;
      try {
        await fetchLocalApiWithTimeout('/api/skills/all', { method: 'DELETE' }, LOCAL_API_TIMEOUT_MS);
      } catch (err) {
        alert('Failed to wipe skills: ' + (err && err.message ? err.message : 'unknown error'));
        return;
      }
      renderSkillsList();
    });
  }

  if (btnCloseMemory && memoryModal) {
    btnCloseMemory.addEventListener('click', () => {
      isGraphOpen = false;
      memoryModal.classList.add('hidden');
      if (sim) sim.stop();
    });
  }

  if (btnResetMemories) {
    btnResetMemories.addEventListener('click', () => {
      showCustomConfirm(
        'Confirm Memory Wipe',
        "Are you absolutely sure you want to wipe Shadow's entire long-term memory? This cannot be undone! (An automatic backup of your current memories will be made.)",
        async () => {
          // Perform automatic backup before wiping
          try {
            const backupRes = await fetchLocalApiWithTimeout('/api/memories/backup', { method: 'POST' }, MEMORY_BACKUP_TIMEOUT_MS);
            const backupData = await readBootResponseJsonWithTimeout(backupRes, MEMORY_BACKUP_TIMEOUT_MS);
            if (backupData.status === 'success') {
              console.log('Automated memories backup created successfully:', backupData.backupFile);
            }
          } catch (e) {
            console.error('Failed to create memories backup:', e);
          }

          const defaultJson = {
            nodes: [
              { id: "user", label: getUserName() || 'You', type: "person", description: getUserName() ? `The user, ${getUserName()} (you)` : 'The user (you)' },
              { id: "shadow", label: getAssistantName(), type: "ai", description: `${getAssistantName()}, your AI companion` }
            ],
            links: [
              { source: "shadow", target: "user", type: "COMPANION_OF" }
            ]
          };
          await fetchLocalApiWithTimeout('/api/memories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(defaultJson)
          }, LOCAL_API_TIMEOUT_MS);
          addSystemMessage("Long-term memories wiped. Backup saved to server.");
          if (sim) sim.loadGraph();
        }
      );
    });
  }

  if (btnFactoryReset) {
    btnFactoryReset.addEventListener('click', () => {
      showCustomConfirm(
        'Factory Reset Ã¢â‚¬â€ Delete EVERYTHING',
        "This will permanently delete ALL memories and skills, returning ShadowMac to a clean slate. This CANNOT be undone! Are you absolutely sure?",
        async () => {
          // A true factory reset: wipe EVERYTHING the app persists — memories, skills,
          // the server config (Gemini + provider API keys and all saved settings), the
          // Google connection (tokens), and all local client state (name, voice, accent,
          // preferences, resumption tokens, favorites). Each step is independent so one
          // failure does not abort the rest; then reload into a genuine first-run state.
          const problems = [];

          try {
            const defaultMemories = {
              nodes: [
                { id: "user", label: getUserName() || 'You', type: "person", description: getUserName() ? `The user, ${getUserName()} (you)` : 'The user (you)' },
                { id: "shadow", label: getAssistantName(), type: "ai", description: `${getAssistantName()}, your AI companion` }
              ],
              links: [
                { source: "shadow", target: "user", type: "COMPANION_OF" }
              ]
            };
            await fetchLocalApiWithTimeout('/api/memories', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(defaultMemories)
            }, LOCAL_API_TIMEOUT_MS);
          } catch (e) { problems.push('memories'); }

          try {
            const skillsReset = await fetchLocalApiWithTimeout('/api/skills/all', { method: 'DELETE' }, SKILLS_RESET_TIMEOUT_MS);
            const skillsResetJson = await readBootResponseJsonWithTimeout(skillsReset, SKILLS_RESET_TIMEOUT_MS).catch(() => ({}));
            if (!skillsReset.ok || skillsResetJson.status !== 'success') problems.push('skills');
          } catch (e) { problems.push('skills'); }

          // Server config: clears the saved Gemini/provider API keys and every saved setting.
          try {
            await fetchLocalApiWithTimeout('/api/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}'
            }, LOCAL_API_TIMEOUT_MS);
          } catch (e) { problems.push('config'); }

          // Google connection: deletes stored OAuth tokens (no-op if not connected).
          try {
            await fetchLocalApiWithTimeout('/api/google/disconnect', { method: 'POST' }, GOOGLE_AUTH_API_TIMEOUT_MS);
          } catch (e) { /* not connected; ignore */ }

          // OpenAI Codex: log out so the OAuth session is cleared too (no-op if not logged in).
          try {
            await fetchLocalApiWithTimeout('/api/codex/logout', { method: 'POST' }, CODEX_AUTH_API_TIMEOUT_MS);
          } catch (e) { /* not logged in; ignore */ }

          // All local client state in one shot (covers every shadow_* key + favorites + tokens).
          try { localStorage.clear(); } catch (e) {}

          addSystemMessage(problems.length
            ? ('Factory reset finished, but these could not be cleared: ' + problems.join(', ') + '. Reloading into a clean slate...')
            : 'Factory reset complete — memories, skills, keys, settings, and Google connection wiped. Reloading into a clean slate...');
          setTimeout(() => { try { location.reload(); } catch (e) {} }, 1400);
        }
      );
    });
  }

  // Integrations Event Listeners
  if (btnIntegrations && integrationsModal) {
    btnIntegrations.addEventListener('click', () => {
      checkGoogleStatus();
      integrationsModal.classList.remove('hidden');
    });
  }

  if (btnCloseIntegrations && integrationsModal) {
    btnCloseIntegrations.addEventListener('click', () => {
      integrationsModal.classList.add('hidden');
    });
  }

  if (btnConnectGoogle) {
    btnConnectGoogle.addEventListener('click', async () => {
      try {
        const statusRes = await fetchLocalApiWithTimeout('/api/google/status', {}, GOOGLE_AUTH_API_TIMEOUT_MS);
        const statusData = statusRes.ok ? await readBootResponseJsonWithTimeout(statusRes, GOOGLE_AUTH_API_TIMEOUT_MS).catch(() => ({})) : {};
        if (statusData && statusData.credentialsConfigured === false) {
          const redirect = statusData.redirectUri ? `\n\nRedirect URL: ${statusData.redirectUri}` : '';
          throw new Error(`${statusData.credentialsError || 'Google OAuth credentials are missing.'}${redirect}`);
        }

        const res = await fetchLocalApiWithTimeout('/api/google/auth-url', {}, GOOGLE_AUTH_API_TIMEOUT_MS);
        if (!res.ok) {
          const errData = await readBootResponseJsonWithTimeout(res, GOOGLE_AUTH_API_TIMEOUT_MS).catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }
        const data = await readBootResponseJsonWithTimeout(res, GOOGLE_AUTH_API_TIMEOUT_MS);
        if (data.status === 'success' && data.url) {
          window.openExternalUrl(data.url);

          let pollCount = 0;
          const interval = setInterval(async () => {
            pollCount++;
            await checkGoogleStatus();

            if (googleStatusBadge && googleStatusBadge.classList.contains('integration-connected')) {
              clearInterval(interval);
              addSystemMessage('Successfully connected to Google Workspace integrations!');
            } else if (pollCount > 150) {
              clearInterval(interval);
              console.warn('Google authentication polling timed out.');
            }
          }, 2000);
        } else {
          throw new Error(data.error || 'Failed to get auth URL');
        }
      } catch (err) {
        console.error('Google auth url error:', err);
        alert(`Google Workspace is not ready to connect: ${err.message}`);
      }
    });
  }

  if (btnCopyRedirectUri && googleRedirectUriDisplay) {
    btnCopyRedirectUri.addEventListener('click', async () => {
      const value = googleRedirectUriDisplay.value || '';
      if (!value || value === 'loading…') return;
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        // Clipboard API can be unavailable; fall back to selecting the field for manual copy.
        googleRedirectUriDisplay.focus();
        googleRedirectUriDisplay.select();
      }
      const original = btnCopyRedirectUri.textContent;
      btnCopyRedirectUri.textContent = 'Copied!';
      setTimeout(() => { btnCopyRedirectUri.textContent = original; }, 1500);
    });
  }

  if (btnSaveGoogleCredentials && inputGoogleClientId && inputGoogleClientSecret) {
    btnSaveGoogleCredentials.addEventListener('click', async () => {
      const clientId = inputGoogleClientId.value.trim();
      const clientSecret = inputGoogleClientSecret.value.trim();
      if (!clientId || !clientSecret) {
        alert('Enter both the Client ID and the Client secret.');
        return;
      }
      const original = btnSaveGoogleCredentials.textContent;
      btnSaveGoogleCredentials.disabled = true;
      btnSaveGoogleCredentials.textContent = 'Saving...';
      try {
        const res = await fetchLocalApiWithTimeout('/api/google/set-credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret })
        }, GOOGLE_AUTH_API_TIMEOUT_MS);
        const data = await readBootResponseJsonWithTimeout(res, GOOGLE_AUTH_API_TIMEOUT_MS).catch(() => ({}));
        if (data.status === 'error' || data.error) throw new Error(data.error || 'Failed to save credentials.');
        inputGoogleClientSecret.value = '';
        if (typeof checkGoogleStatus === 'function') checkGoogleStatus();
        alert('Google credentials saved. Now click "Connect Google Account" to sign in.');
      } catch (err) {
        alert('Failed to save Google credentials: ' + (err && err.message ? err.message : 'unknown error'));
      } finally {
        btnSaveGoogleCredentials.disabled = false;
        btnSaveGoogleCredentials.textContent = original;
      }
    });
  }

  if (btnImportGoogleCredentials && inputGoogleCredentialsFile) {
    btnImportGoogleCredentials.addEventListener('click', () => {
      inputGoogleCredentialsFile.click();
    });

    inputGoogleCredentialsFile.addEventListener('change', async () => {
      const file = inputGoogleCredentialsFile.files && inputGoogleCredentialsFile.files[0];
      inputGoogleCredentialsFile.value = '';
      if (!file) return;

      try {
        const text = await file.text();
        JSON.parse(text);

        const res = await fetchLocalApiWithTimeout('/api/google/set-credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: text
        }, GOOGLE_AUTH_API_TIMEOUT_MS);

        const data = await readBootResponseJsonWithTimeout(res, GOOGLE_AUTH_API_TIMEOUT_MS).catch(() => ({}));
        if (!res.ok || data.status !== 'success') {
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        addSystemMessage('Google OAuth credentials imported.');
        await checkGoogleStatus();
        alert('Google credentials imported. You can now click Connect Google Account.');
      } catch (err) {
        console.error('Google credentials import failed:', err);
        alert(`Could not import Google credentials: ${err.message}`);
      }
    });
  }

  if (btnDisconnectGoogle) {
    btnDisconnectGoogle.addEventListener('click', async () => {
      try {
        const res = await fetchLocalApiWithTimeout('/api/google/disconnect', { method: 'POST' }, GOOGLE_AUTH_API_TIMEOUT_MS);
        if (res.ok) {
          addSystemMessage('Disconnected from Google Workspace.');
          await checkGoogleStatus();
        } else {
          alert('Failed to disconnect Google account.');
        }
      } catch (err) {
        console.error('Error disconnecting Google:', err);
        alert(`Error: ${err.message}`);
      }
    });
  }

  // Handle outside click to close integrations modal
  window.addEventListener('click', (event) => {
    if (event.target === integrationsModal) {
      integrationsModal.classList.add('hidden');
    }
  });

  // Screen Sharing Logic
  btnShareScreen.addEventListener('click', async () => {
    if (screenStream) {
      stopScreenShare();
    } else {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 } });
        screenVideo.srcObject = screenStream;
        btnShareScreen.classList.add('active');

        // Listen for native "stop sharing" button click
        screenStream.getVideoTracks()[0].onended = () => {
          stopScreenShare();
        };

        // Start capture loop Ã¢â‚¬â€ 1 frame per second
        screenCaptureInterval = setInterval(captureAndSendFrame, 1000);
        addSystemMessage('Screen sharing started. Shadow can now see your screen.');
        signalProactiveAttention('screen_started');
      } catch (err) {
        console.error("Error sharing screen:", err);
        addSystemMessage('Screen sharing cancelled or denied.');
      }
    }
  });

  initWakeWordListener();

  // Show the idle status line with the user's chosen assistant name from the very first frame
  // (the static HTML says "Shadow"; this swaps in the real name once it's loaded).
  if (typeof refreshIdleAssistantName === 'function') refreshIdleAssistantName();

  // Start Scheduler Poller
  startSchedulerPoller();

  // Focus-independent safety net: recover a stuck turn even when the window is backgrounded
  // (the rAF visualizer loop below throttles/pauses when the app window is unfocused or minimized).
  if (typeof startIdleVisualizerRecoveryTicker === 'function') startIdleVisualizerRecoveryTicker();

  // Start Visualizer Loop
  requestAnimationFrame(visualizerLoop);
});
