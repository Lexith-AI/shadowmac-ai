/**
 * ShadowMac - screen sharing, config sync, settings updates, and confirmation modal.
 * Split from the original monolithic app.js; loaded as an ordered classic script.
 */

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  pauseScreenCapture();
  screenVideo.srcObject = null;
  btnShareScreen.classList.remove('active');
  addSystemMessage('Screen sharing stopped.');
  signalProactiveAttention('screen_stopped');
}

function pauseScreenCapture() {
  if (screenCaptureInterval) {
    clearInterval(screenCaptureInterval);
    screenCaptureInterval = null;
  }
}

function captureAndSendFrame() {
  if (!isConnected || !socket || socket.readyState !== WebSocket.OPEN) return;
  if (!screenVideo || screenVideo.videoWidth === 0 || screenVideo.videoHeight === 0) return;

  try {
    const maxW = 800;
    const maxH = 450;
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

    const dataUrl = screenCanvas.toDataURL('image/jpeg', 0.55);
    const base64Data = dataUrl.split(',')[1];

    if (!base64Data || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Data)) return;
    if (base64Data.length > 500000) return;
    signalProactiveAttention('screen_frame', { noveltyScore: lastProactiveContext.screenDiff || 0 });

    const payload = {
      realtimeInput: {
        video: {
          mimeType: "image/jpeg",
          data: base64Data
        }
      }
    };
    socket.send(JSON.stringify(payload));
  } catch (err) {
    console.warn('[ScreenShare] Frame capture failed:', err);
  }
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

function updateSessionButtonVisibility() {
  if (btnNewSession) {
    if (isConnected || activeResumptionToken || recentDialogueTurns.length > 0) {
      btnNewSession.classList.remove('hidden');
    } else {
      btnNewSession.classList.add('hidden');
    }
  }
}

// --- Manual-only voice connection shims ---
const WAKE_WORD_CONNECT_ENABLED = false;

function shouldRunWakeWordListener() {
  return WAKE_WORD_CONNECT_ENABLED;
}

async function queueWakeWordConnect() {
  return false;
}

function initWakeWordListener() {
  return false;
}

function startWakeWordListener() {
  return false;
}

function stopWakeWordListener() {
  return Promise.resolve();
}

function getNormalizedProactiveProfile(value = proactiveProfile) {
  const profile = String(value || 'balanced').toLowerCase().trim();
  const aliases = {
    movie: 'immersive',
    cinema: 'immersive',
    cinematic: 'immersive',
    max: 'immersive',
    maximum: 'immersive',
    // 20x/50x (insane/overdrive) were removed: their sub-second eval cadence was below the cloud
    // evaluator's round-trip time, so they only produced 429 rate-limit backoff and erratic behavior.
    // Migrate any saved value (and the old internal names) to the new top mode, unhinged (5x).
    '20x': 'unhinged',
    twentyx: 'unhinged',
    'twenty times': 'unhinged',
    insane: 'unhinged',
    '50x': 'unhinged',
    fiftyx: 'unhinged',
    'fifty times': 'unhinged',
    overdrive: 'unhinged',
    chatty: 'lively'
  };
  const normalized = aliases[profile] || profile;
  return PROACTIVE_PROFILES[normalized] ? normalized : 'balanced';
}

function normalizeProactiveProfile(value = proactiveProfile) {
  proactiveProfile = getNormalizedProactiveProfile(value);
  return proactiveProfile;
}

function isProactiveProfileAtLeast(profile, baseline) {
  const profileIndex = PROACTIVE_PROFILE_ORDER.indexOf(profile);
  const baselineIndex = PROACTIVE_PROFILE_ORDER.indexOf(baseline);
  if (profileIndex < 0 || baselineIndex < 0) return false;
  return profileIndex >= baselineIndex;
}

function syncProactiveControls() {
  if (inputProactiveEnabled) {
    inputProactiveEnabled.checked = proactiveEnabled;
  }
  if (selectProactiveProfile) {
    selectProactiveProfile.value = proactiveProfile;
  }
}

function setProactiveProfile(value) {
  const normalized = normalizeProactiveProfile(value);
  localStorage.setItem('shadow_proactive_profile', normalized);
  syncProactiveControls();
  return normalized;
}

function getAdjustedProactiveProfile(direction, current = proactiveProfile) {
  const normalizedCurrent = normalizeProactiveProfile(current);
  const currentIndex = Math.max(0, PROACTIVE_PROFILE_ORDER.indexOf(normalizedCurrent));
  const normalizedDirection = String(direction || '').toLowerCase().trim();
  if (normalizedDirection === 'more') {
    return PROACTIVE_PROFILE_ORDER[Math.min(PROACTIVE_PROFILE_ORDER.length - 1, currentIndex + 1)];
  }
  if (normalizedDirection === 'less') {
    return PROACTIVE_PROFILE_ORDER[Math.max(0, currentIndex - 1)];
  }
  return normalizedCurrent;
}

// --- Local Config Sync Helpers ---
function cancelConfigResponseBody(response) {
  try {
    if (response && response.body && typeof response.body.cancel === 'function') {
      response.body.cancel().catch(() => {});
    }
  } catch {}
}

async function readConfigResponseTextWithTimeout(response, timeoutMs = CONFIG_SYNC_TIMEOUT_MS) {
  let timeoutId = null;
  const bodyPromise = response.text();
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      cancelConfigResponseBody(response);
      reject(new Error(`Response body timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([bodyPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function loadConfigFromServer() {
  try {
    const res = await fetchWithTimeout('/api/config', {}, 5000);
    const rawConfig = await readConfigResponseTextWithTimeout(res, 5000);
    const config = rawConfig.trim() ? JSON.parse(rawConfig) : {};

    const keyVal = config.shadow_api_key || config.shadow_api_key;
    if (keyVal) {
      apiKey = keyVal;
      localStorage.setItem('shadow_api_key', apiKey);
      inputApiKey.value = apiKey;
    }
    if (config.shadow_assistant_name !== undefined) {
      assistantName = normalizeAssistantName(config.shadow_assistant_name);
      localStorage.setItem('shadow_assistant_name', assistantName);
      if (inputAssistantName) inputAssistantName.value = assistantName;
      if (typeof refreshIdleAssistantName === 'function') refreshIdleAssistantName();
    }
    if (config.shadow_user_name !== undefined) {
      userName = normalizeUserName(config.shadow_user_name);
      localStorage.setItem('shadow_user_name', userName);
    }
    const voiceVal = config.shadow_voice || config.shadow_voice;
    if (voiceVal) {
      const normalizedVoiceVal = normalizeGeminiVoiceName(voiceVal);
      if (normalizedVoiceVal) {
        voiceName = normalizedVoiceVal;
        localStorage.setItem('shadow_voice', voiceName);
        selectVoice.value = voiceName;
        syncFavoriteVoiceButton();
      }
    }
    if (config.shadow_favorite_voices !== undefined) {
      favoriteVoiceNames = normalizeGeminiVoiceList(config.shadow_favorite_voices);
      saveFavoriteVoices();
      populateGeminiVoiceSelect(selectVoice);
      selectVoice.value = voiceName;
      syncFavoriteVoiceButton();
    }
    const accentVal = config.shadow_accent || config.shadow_accent;
    if (accentVal) {
      accent = accentVal;
      localStorage.setItem('shadow_accent', accent);
      selectAccent.value = accent;
    }
    const modelVal = config.shadow_model || config.shadow_model;
    if (modelVal) {
      selectedModel = normalizeLiveModel(modelVal);
      localStorage.setItem('shadow_model', selectedModel);
      selectModel.value = selectedModel;
    }
    if (config.shadow_live_thinking_level !== undefined) {
      liveThinkingLevel = migrateLiveThinkingDefault(config.shadow_live_thinking_level);
      localStorage.setItem('shadow_live_thinking_level', liveThinkingLevel);
      if (selectLiveThinkingLevel) selectLiveThinkingLevel.value = liveThinkingLevel;
    }
    if (config.shadow_smart_main_routing_enabled !== undefined) {
      smartMainRoutingEnabled = config.shadow_smart_main_routing_enabled === true || config.shadow_smart_main_routing_enabled === 'true';
      localStorage.setItem('shadow_smart_main_routing_enabled', smartMainRoutingEnabled ? 'true' : 'false');
      if (inputSmartMainRoutingEnabled) inputSmartMainRoutingEnabled.checked = smartMainRoutingEnabled;
    }
    if (config.shadow_proactive_enabled !== undefined) {
      proactiveEnabled = config.shadow_proactive_enabled !== false && config.shadow_proactive_enabled !== 'false';
      localStorage.setItem('shadow_proactive_enabled', proactiveEnabled ? 'true' : 'false');
      syncProactiveControls();
    }
    if (config.shadow_proactive_profile) {
      setProactiveProfile(config.shadow_proactive_profile);
    }
    if (config.shadow_memory_backup_enabled !== undefined) {
      memoryBackupEnabled = config.shadow_memory_backup_enabled !== false && config.shadow_memory_backup_enabled !== 'false';
      localStorage.setItem('shadow_memory_backup_enabled', memoryBackupEnabled ? 'true' : 'false');
      if (inputMemoryBackupEnabled) inputMemoryBackupEnabled.checked = memoryBackupEnabled;
    }
    if (config.shadow_memory_backup_interval !== undefined) {
      const backupInterval = parseInt(config.shadow_memory_backup_interval, 10);
      if (!isNaN(backupInterval) && backupInterval > 0) {
        memoryBackupIntervalMinutes = backupInterval;
        localStorage.setItem('shadow_memory_backup_interval', String(memoryBackupIntervalMinutes));
        if (inputMemoryBackupCustomMinutes) inputMemoryBackupCustomMinutes.value = memoryBackupIntervalMinutes;
      }
    }
    const tokenVal = config.shadow_resumption_token || config.shadow_resumption_token;
    if (tokenVal) {
      activeResumptionToken = tokenVal;
      localStorage.setItem('shadow_resumption_token', activeResumptionToken);
      if (config.shadow_resumption_token_saved_at) {
        localStorage.setItem('shadow_resumption_token_saved_at', String(config.shadow_resumption_token_saved_at));
      } else {
        localStorage.removeItem('shadow_resumption_token_saved_at');
      }
      updateSessionButtonVisibility();
    }
    if (config.shadow_resumption_token_model) {
      localStorage.setItem('shadow_resumption_token_model', config.shadow_resumption_token_model);
    }
    if (config.shadow_resumption_token_voice) {
      localStorage.setItem('shadow_resumption_token_voice', config.shadow_resumption_token_voice);
    }
    if (config.shadow_session_context_version) {
      localStorage.setItem('shadow_session_context_version', config.shadow_session_context_version);
    }
    if (clearExpiredLiveSessionResumptionToken('server config')) {
      saveConfigToServer({ scheduleRetry: false }).catch(err => console.warn('Failed to save cleared stale resumption token:', err));
    }

    // Restore subagent provider, model, and API keys
    if (config.shadow_subagent_provider) {
      subagentProvider = config.shadow_subagent_provider;
      localStorage.setItem('shadow_subagent_provider', subagentProvider);
      selectSubagentProvider.value = subagentProvider;
    }
    if (config.shadow_subagent_model) {
      subagentModel = config.shadow_subagent_model;
      localStorage.setItem('shadow_subagent_model', subagentModel);
      // Set the correct provider-specific dropdown
      if (subagentProvider === 'gemini') selectSubagentModelGemini.value = subagentModel;
      else if (subagentProvider === OPENAI_CODEX_PROVIDER) selectSubagentModelOpenaiCodex.value = subagentModel;
      else if (subagentProvider === 'minimax') selectSubagentModelMinimax.value = subagentModel;
      else if (subagentProvider === 'moonshot') selectSubagentModelMoonshot.value = subagentModel;
      else if (subagentProvider === 'ollama') selectSubagentModelOllama.value = subagentModel;
    }
    if (config.shadow_subagent_reasoning_mode) {
      subagentReasoningMode = OPENAI_CODEX_REASONING_MODES.has(config.shadow_subagent_reasoning_mode) ? config.shadow_subagent_reasoning_mode : 'medium';
      localStorage.setItem('shadow_subagent_reasoning_mode', subagentReasoningMode);
      if (selectSubagentReasoningMode) selectSubagentReasoningMode.value = subagentReasoningMode;
    }
    if (config.shadow_minimax_key) {
      minimaxApiKey = config.shadow_minimax_key;
      localStorage.setItem('shadow_minimax_key', minimaxApiKey);
      inputMinimaxKey.value = minimaxApiKey;
    }
    if (config.shadow_moonshot_key) {
      moonshotApiKey = config.shadow_moonshot_key;
      localStorage.setItem('shadow_moonshot_key', moonshotApiKey);
      inputMoonshotKey.value = moonshotApiKey;
    }
    if (config.shadow_ollama_key) {
      ollamaApiKey = config.shadow_ollama_key;
      localStorage.setItem('shadow_ollama_key', ollamaApiKey);
      inputOllamaKey.value = ollamaApiKey;
    }
    if (config.shadow_custom_endpoint !== undefined) {
      customEndpoint = config.shadow_custom_endpoint || '';
      localStorage.setItem('shadow_custom_endpoint', customEndpoint);
      if (inputCustomEndpoint) inputCustomEndpoint.value = customEndpoint;
    }
    if (config.shadow_custom_api_key !== undefined) {
      customApiKey = config.shadow_custom_api_key || '';
      localStorage.setItem('shadow_custom_api_key', customApiKey);
      if (inputCustomApiKey) inputCustomApiKey.value = customApiKey;
    }
    if (config.shadow_searxng_url !== undefined) {
      searxngSearchUrl = config.shadow_searxng_url || 'http://127.0.0.1/search';
      localStorage.setItem('shadow_searxng_url', searxngSearchUrl);
      if (inputSearxngSearchUrl) inputSearxngSearchUrl.value = searxngSearchUrl;
    }
    if (config.shadow_searxng_port !== undefined) {
      searxngSearchPort = String(config.shadow_searxng_port || '8888');
      localStorage.setItem('shadow_searxng_port', searxngSearchPort);
      if (inputSearxngSearchPort) inputSearxngSearchPort.value = searxngSearchPort;
    }
    if (config.shadow_auto_update_check !== undefined) {
      autoUpdateCheckEnabled = config.shadow_auto_update_check !== false && config.shadow_auto_update_check !== 'false';
      localStorage.setItem('shadow_auto_update_check', autoUpdateCheckEnabled ? 'true' : 'false');
      if (inputAutoUpdateCheck) inputAutoUpdateCheck.checked = autoUpdateCheckEnabled;
    }
    if (config.shadow_mic_device !== undefined) {
      selectedMicDeviceId = config.shadow_mic_device || '';
      localStorage.setItem('shadow_mic_device', selectedMicDeviceId);
      if (typeof selectMicDevice !== 'undefined' && selectMicDevice) {
        const present = Array.prototype.some.call(selectMicDevice.options, function (o) { return o.value === selectedMicDeviceId; });
        if (present) selectMicDevice.value = selectedMicDeviceId;
      }
    }
    if (config.shadow_is_whispering !== undefined) {
      localStorage.setItem('shadow_is_whispering', (config.shadow_is_whispering === true || config.shadow_is_whispering === 'true') ? 'true' : 'false');
    }
    let pttRestored = false;
    if (config.shadow_ptt_enabled !== undefined) {
      pushToTalkEnabled = (config.shadow_ptt_enabled === true || config.shadow_ptt_enabled === 'true');
      localStorage.setItem('shadow_ptt_enabled', pushToTalkEnabled ? 'true' : 'false');
      pttRestored = true;
    }
    if (config.shadow_ptt_vk !== undefined) {
      pushToTalkVk = parseInt(config.shadow_ptt_vk, 10) || 0;
      localStorage.setItem('shadow_ptt_vk', String(pushToTalkVk));
      pttRestored = true;
    }
    if (config.shadow_ptt_key_label !== undefined) {
      pushToTalkKeyLabel = config.shadow_ptt_key_label || '';
      localStorage.setItem('shadow_ptt_key_label', pushToTalkKeyLabel);
      pttRestored = true;
    }
    // Re-apply to the UI, arm the server-side key poll, and (re)start the edge long-poll.
    if (pttRestored && typeof window.onPttSettingsChanged === 'function') {
      window.onPttSettingsChanged();
    }

    // Re-run provider UI visibility after restoring settings
    selectSubagentProvider.dispatchEvent(new Event('change'));

    console.log('Loaded config from server:', config);
  } catch (e) {
    console.error('Failed to load config from server:', e);
  }
}

function scheduleConfigSyncRetry() {
  if (configSyncRetryTimer) return;
  configSyncRetryTimer = setTimeout(async () => {
    configSyncRetryTimer = null;
    const saved = await saveConfigToServer({ scheduleRetry: false });
    if (!saved) scheduleConfigSyncRetry();
  }, CONFIG_SYNC_RETRY_MS);
}

function scheduleResumptionTokenSave() {
  if (resumptionTokenSaveTimer) return;
  resumptionTokenSaveTimer = setTimeout(() => {
    resumptionTokenSaveTimer = null;
    saveConfigToServer().catch(err => console.warn('Failed to save resumption token:', err));
  }, 5000);
}

async function saveConfigToServer(options = {}) {
  const { scheduleRetry = true } = options;
  try {
    const config = {
      shadow_api_key: apiKey,
      shadow_assistant_name: getAssistantName(),
      shadow_user_name: getUserName(),
      shadow_voice: voiceName,
      shadow_favorite_voices: favoriteVoiceNames,
      shadow_accent: accent,
      shadow_model: selectedModel,
      shadow_live_thinking_level: liveThinkingLevel,
      shadow_smart_main_routing_enabled: smartMainRoutingEnabled,
      shadow_proactive_enabled: proactiveEnabled,
      shadow_proactive_profile: proactiveProfile,
      shadow_memory_backup_enabled: memoryBackupEnabled,
      shadow_memory_backup_interval: memoryBackupIntervalMinutes,
      shadow_resumption_token: activeResumptionToken,
      shadow_resumption_token_model: localStorage.getItem('shadow_resumption_token_model') || selectedModel,
      shadow_resumption_token_voice: localStorage.getItem('shadow_resumption_token_voice') || voiceName,
      shadow_resumption_token_saved_at: localStorage.getItem('shadow_resumption_token_saved_at') || '',
      shadow_session_context_version: SESSION_CONTEXT_VERSION,
      shadow_subagent_provider: subagentProvider,
      shadow_subagent_model: subagentModel,
      shadow_subagent_reasoning_mode: subagentReasoningMode,
      shadow_minimax_key: minimaxApiKey,
      shadow_moonshot_key: moonshotApiKey,
      shadow_ollama_key: ollamaApiKey,
      shadow_custom_endpoint: customEndpoint,
      shadow_custom_api_key: customApiKey,
      shadow_searxng_url: searxngSearchUrl,
      shadow_searxng_port: searxngSearchPort,
      shadow_auto_update_check: autoUpdateCheckEnabled,
      shadow_mic_device: (typeof selectedMicDeviceId === 'string') ? selectedMicDeviceId : '',
      shadow_ptt_enabled: !!pushToTalkEnabled,
      shadow_ptt_vk: pushToTalkVk || 0,
      shadow_ptt_key_label: pushToTalkKeyLabel || '',
      shadow_is_whispering: localStorage.getItem('shadow_is_whispering') === 'true',
      shadow_config_saved_at: Date.now()
    };
    const res = await fetchWithTimeout('/api/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(config)
    }, CONFIG_SYNC_TIMEOUT_MS);
    if (res.ok) {
      if (configSyncRetryTimer) {
        clearTimeout(configSyncRetryTimer);
        configSyncRetryTimer = null;
      }
      return true;
    }
    if (scheduleRetry) scheduleConfigSyncRetry();
    return false;
  } catch (e) {
    console.error('Failed to save config to server:', e);
    if (scheduleRetry) scheduleConfigSyncRetry();
    return false;
  }
}

function getSelectValues(selectEl) {
  if (!selectEl) return [];
  return Array.from(selectEl.options || []).map(option => option.value);
}

function normalizeGeminiVoiceName(value) {
  const requested = String(value || '').trim();
  return GEMINI_VOICE_NAMES.find(name => name.toLowerCase() === requested.toLowerCase()) || '';
}

function normalizeGeminiVoiceList(values) {
  const normalized = [];
  (Array.isArray(values) ? values : []).forEach(value => {
    const voice = normalizeGeminiVoiceName(value);
    if (voice && !normalized.includes(voice)) normalized.push(voice);
  });
  return normalized;
}

function loadFavoriteVoices() {
  try {
    favoriteVoiceNames = normalizeGeminiVoiceList(JSON.parse(localStorage.getItem('shadow_favorite_voices') || '[]'));
  } catch (e) {
    favoriteVoiceNames = [];
  }
  localStorage.setItem('shadow_favorite_voices', JSON.stringify(favoriteVoiceNames));
  return favoriteVoiceNames;
}

function saveFavoriteVoices() {
  favoriteVoiceNames = normalizeGeminiVoiceList(favoriteVoiceNames);
  localStorage.setItem('shadow_favorite_voices', JSON.stringify(favoriteVoiceNames));
}

function getGeminiVoiceLabel(name) {
  const voice = GEMINI_VOICE_OPTIONS.find(item => item.name === name);
  return voice ? `${voice.name} (${voice.style})` : name;
}

function appendGeminiVoiceOption(parent, name) {
  const option = document.createElement('option');
  option.value = name;
  option.textContent = getGeminiVoiceLabel(name);
  parent.appendChild(option);
}

function populateGeminiVoiceSelect(selectEl) {
  if (!selectEl) return;
  const currentValue = normalizeGeminiVoiceName(selectEl.value || voiceName) || DEFAULT_GEMINI_VOICE;
  selectEl.innerHTML = '';
  const favorites = normalizeGeminiVoiceList(favoriteVoiceNames);
  if (favorites.length) {
    const favoriteGroup = document.createElement('optgroup');
    favoriteGroup.label = 'Favorite voices';
    favorites.forEach(name => appendGeminiVoiceOption(favoriteGroup, name));
    selectEl.appendChild(favoriteGroup);
  }
  const allVoicesGroup = favorites.length ? document.createElement('optgroup') : selectEl;
  if (favorites.length) allVoicesGroup.label = 'All voices';
  GEMINI_VOICE_NAMES
    .filter(name => !favorites.includes(name))
    .forEach(name => appendGeminiVoiceOption(allVoicesGroup, name));
  if (favorites.length) selectEl.appendChild(allVoicesGroup);
  selectEl.value = currentValue;
  syncFavoriteVoiceButton();
}

function syncFavoriteVoiceButton() {
  if (!btnFavoriteVoice || !selectVoice) return;
  const currentVoice = normalizeGeminiVoiceName(selectVoice.value);
  const isFavorite = currentVoice ? favoriteVoiceNames.includes(currentVoice) : false;
  btnFavoriteVoice.classList.toggle('active', isFavorite);
  btnFavoriteVoice.title = isFavorite ? 'Unpin voice from top' : 'Pin voice to top';
  btnFavoriteVoice.setAttribute('aria-label', btnFavoriteVoice.title);
  btnFavoriteVoice.setAttribute('aria-pressed', isFavorite ? 'true' : 'false');
  const icon = btnFavoriteVoice.querySelector('span');
  if (icon) icon.textContent = isFavorite ? '\u2605' : '\u2606';
}

function toggleCurrentVoiceFavorite() {
  if (!selectVoice) return;
  const currentVoice = normalizeGeminiVoiceName(selectVoice.value);
  if (!currentVoice) return;
  if (favoriteVoiceNames.includes(currentVoice)) {
    favoriteVoiceNames = favoriteVoiceNames.filter(name => name !== currentVoice);
  } else {
    favoriteVoiceNames = [currentVoice, ...favoriteVoiceNames.filter(name => name !== currentVoice)];
  }
  saveFavoriteVoices();
  populateGeminiVoiceSelect(selectVoice);
  selectVoice.value = currentVoice;
  syncFavoriteVoiceButton();
}

function resolveRequestedFavoriteVoice(value) {
  const requested = String(value || '').trim();
  if (!requested || requested.toLowerCase() === 'current') return voiceName;
  return normalizeGeminiVoiceName(requested);
}

function valueOrCurrent(value, current) {
  return value === undefined || value === null || value === '' ? current : String(value).trim();
}

const LOCKED_VOICE_CONTROL_SETTING_KEYS = Object.freeze([
  'voice',
  'favorite_voice',
  'unfavorite_voice',
  'model',
  'live_thinking_level',
  'shadow_live_thinking_level',
  'smart_main_routing_enabled',
  'shadow_smart_main_routing_enabled',
  'proactive_enabled',
  'proactive_profile',
  'proactive_adjustment',
  'subagent_provider',
  'subagent_model',
  'subagent_reasoning_mode'
]);

function sanitizeVoiceControlledSettingsUpdate(args = {}, warnings = []) {
  const sanitized = { ...args };
  const locked = LOCKED_VOICE_CONTROL_SETTING_KEYS.filter(key =>
    Object.prototype.hasOwnProperty.call(sanitized, key)
  );
  locked.forEach(key => delete sanitized[key]);
  if (locked.length) {
    warnings.push(`Locked voice-control settings ignored: ${locked.join(', ')}.`);
  }
  return sanitized;
}

function shouldStartFreshVoiceSession(oldVoice, nextVoice) {
  return normalizeGeminiVoiceName(oldVoice) !== normalizeGeminiVoiceName(nextVoice);
}

function getLiveSessionResumptionTokenSavedAt() {
  const value = Number(localStorage.getItem('shadow_resumption_token_saved_at') || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isLiveSessionResumptionTokenFresh(now = Date.now()) {
  if (!activeResumptionToken) return false;
  const savedAt = getLiveSessionResumptionTokenSavedAt();
  if (!savedAt) return false;
  const ageMs = now - savedAt;
  return ageMs >= 0 && ageMs <= LIVE_RESUMPTION_HANDLE_MAX_AGE_MS;
}

function persistLiveSessionResumptionToken(token, model, voice, savedAt = Date.now()) {
  activeResumptionToken = token;
  localStorage.setItem('shadow_resumption_token', activeResumptionToken);
  localStorage.setItem('shadow_resumption_token_model', model);
  localStorage.setItem('shadow_resumption_token_voice', voice);
  localStorage.setItem('shadow_resumption_token_saved_at', String(savedAt));
}

function clearExpiredLiveSessionResumptionToken(source = 'local storage') {
  if (!activeResumptionToken || isLiveSessionResumptionTokenFresh()) return false;
  console.warn(`Clearing expired Live resumption handle from ${source}.`);
  clearLiveSessionResumptionToken();
  updateSessionButtonVisibility();
  return true;
}

function clearLiveSessionResumptionToken() {
  activeResumptionToken = null;
  localStorage.removeItem('shadow_resumption_token');
  localStorage.removeItem('shadow_resumption_token_model');
  localStorage.removeItem('shadow_resumption_token_voice');
  localStorage.removeItem('shadow_resumption_token_saved_at');
}

function getCurrentShadowSettings() {
  return {
    assistant_name: getAssistantName(),
    voice: voiceName,
    favorite_voices: [...favoriteVoiceNames],
    accent,
    model: selectedModel,
    live_thinking_level: liveThinkingLevel,
    smart_main_routing_enabled: smartMainRoutingEnabled,
    proactive_enabled: proactiveEnabled,
    proactive_profile: proactiveProfile,
    subagent_provider: subagentProvider,
    subagent_model: subagentModel || '',
    subagent_reasoning_mode: subagentReasoningMode,
    searxng_url: searxngSearchUrl,
    searxng_port: searxngSearchPort ? String(searxngSearchPort) : '8888'
  };
}

async function applyShadowSettingsUpdate(args = {}) {
  const oldAssistantName = getAssistantName();
  const oldVoice = voiceName;
  const oldModel = selectedModel;
  const oldAccent = accent;
  const changed = [];
  const warnings = [];
  const requestedArgs = sanitizeVoiceControlledSettingsUpdate(args, warnings);

  const requestedVoice = valueOrCurrent(requestedArgs.voice, voiceName);
  const nextVoice = normalizeGeminiVoiceName(requestedVoice);
  if (nextVoice !== voiceName) {
    if (nextVoice && getSelectValues(selectVoice).includes(nextVoice)) {
      voiceName = nextVoice;
      localStorage.setItem('shadow_voice', voiceName);
      if (selectVoice) selectVoice.value = voiceName;
      changed.push('voice');
    } else {
      warnings.push(`Unknown voice "${requestedVoice}".`);
    }
  }

  if (requestedArgs.favorite_voice !== undefined) {
    const favoriteVoice = resolveRequestedFavoriteVoice(requestedArgs.favorite_voice);
    if (favoriteVoice) {
      if (!favoriteVoiceNames.includes(favoriteVoice)) {
        favoriteVoiceNames = [favoriteVoice, ...favoriteVoiceNames.filter(name => name !== favoriteVoice)];
        saveFavoriteVoices();
        populateGeminiVoiceSelect(selectVoice);
        if (selectVoice) selectVoice.value = voiceName;
        changed.push('favorite voices');
      }
    } else {
      warnings.push(`Unknown favorite voice "${requestedArgs.favorite_voice}".`);
    }
  }

  if (requestedArgs.unfavorite_voice !== undefined) {
    const unfavoriteVoice = resolveRequestedFavoriteVoice(requestedArgs.unfavorite_voice);
    if (unfavoriteVoice) {
      if (favoriteVoiceNames.includes(unfavoriteVoice)) {
        favoriteVoiceNames = favoriteVoiceNames.filter(name => name !== unfavoriteVoice);
        saveFavoriteVoices();
        populateGeminiVoiceSelect(selectVoice);
        if (selectVoice) selectVoice.value = voiceName;
        changed.push('favorite voices');
      }
    } else {
      warnings.push(`Unknown favorite voice "${requestedArgs.unfavorite_voice}".`);
    }
  }

  syncFavoriteVoiceButton();

  if (requestedArgs.assistant_name !== undefined || requestedArgs.name !== undefined) {
    const requestedName = valueOrCurrent(requestedArgs.assistant_name !== undefined ? requestedArgs.assistant_name : requestedArgs.name, assistantName);
    const nextAssistantName = normalizeAssistantName(requestedName);
    if (nextAssistantName !== assistantName) {
      assistantName = nextAssistantName;
      localStorage.setItem('shadow_assistant_name', assistantName);
      if (inputAssistantName) inputAssistantName.value = assistantName;
      if (typeof syncMemoryGraphAssistantLabels === 'function') syncMemoryGraphAssistantLabels();
      if (isGraphOpen && updateGraphVisualization) updateGraphVisualization();
      changed.push('assistant name');
    }
  }

  const nextAccent = valueOrCurrent(requestedArgs.accent, accent);
  if (nextAccent !== accent) {
    if (ACCENT_DESCRIPTIONS[nextAccent] !== undefined) {
      accent = nextAccent;
      localStorage.setItem('shadow_accent', accent);
      if (selectAccent) selectAccent.value = accent;
      changed.push('accent');
    } else {
      warnings.push(`Unknown accent "${nextAccent}".`);
    }
  }

  const requestedModel = valueOrCurrent(requestedArgs.model, selectedModel);
  const nextModel = normalizeLiveModel(requestedModel);
  if (nextModel !== selectedModel) {
    if (getSelectValues(selectModel).includes(nextModel)) {
      selectedModel = nextModel;
      localStorage.setItem('shadow_model', selectedModel);
      if (selectModel) selectModel.value = selectedModel;
      changed.push('main model');
    } else {
      warnings.push(`Unknown main model "${requestedModel}".`);
    }
  }

  if (requestedArgs.proactive_enabled !== undefined) {
    const nextEnabled = Boolean(requestedArgs.proactive_enabled);
    if (nextEnabled !== proactiveEnabled) {
      proactiveEnabled = nextEnabled;
      localStorage.setItem('shadow_proactive_enabled', proactiveEnabled ? 'true' : 'false');
      syncProactiveControls();
      changed.push('proactive mode');
      if (proactiveEnabled) {
        signalProactiveAttention('settings_changed');
      } else {
        stopProactiveAttention();
      }
    }
  }

  const proactiveAdjustment = valueOrCurrent(requestedArgs.proactive_adjustment, '').toLowerCase();
  if (proactiveAdjustment && !['more', 'less'].includes(proactiveAdjustment)) {
    warnings.push(`Unknown proactive adjustment "${proactiveAdjustment}".`);
  }
  if (['more', 'less'].includes(proactiveAdjustment) && !proactiveEnabled) {
    proactiveEnabled = true;
    localStorage.setItem('shadow_proactive_enabled', 'true');
    syncProactiveControls();
    changed.push('proactive mode');
  }

  const requestedProfile = valueOrCurrent(requestedArgs.proactive_profile, '');
  const nextProfile = requestedProfile
    ? getNormalizedProactiveProfile(requestedProfile)
    : (['more', 'less'].includes(proactiveAdjustment) ? getAdjustedProactiveProfile(proactiveAdjustment) : proactiveProfile);
  if (nextProfile !== proactiveProfile) {
    if (PROACTIVE_PROFILES[nextProfile]) {
      setProactiveProfile(nextProfile);
      changed.push('proactive profile');
      if (proactiveEnabled) signalProactiveAttention('settings_changed');
    } else {
      warnings.push(`Unknown proactive profile "${nextProfile}".`);
    }
  }

  const nextProvider = valueOrCurrent(requestedArgs.subagent_provider, subagentProvider).toLowerCase();
  if (nextProvider !== subagentProvider) {
    if (['gemini', OPENAI_CODEX_PROVIDER, 'minimax', 'moonshot', 'ollama', 'custom_openai'].includes(nextProvider)) {
      subagentProvider = nextProvider;
      localStorage.setItem('shadow_subagent_provider', subagentProvider);
      if (selectSubagentProvider) {
        selectSubagentProvider.value = subagentProvider;
        selectSubagentProvider.dispatchEvent(new Event('change'));
      }
      changed.push('subagent provider');
    } else {
      warnings.push(`Unknown subagent provider "${nextProvider}".`);
    }
  }

  const nextSubagentModel = valueOrCurrent(requestedArgs.subagent_model, subagentModel);
  if (nextSubagentModel !== subagentModel) {
    subagentModel = nextSubagentModel;
    localStorage.setItem('shadow_subagent_model', subagentModel);
    if (subagentProvider === 'gemini' && selectSubagentModelGemini) selectSubagentModelGemini.value = subagentModel;
    else if (subagentProvider === OPENAI_CODEX_PROVIDER && selectSubagentModelOpenaiCodex) selectSubagentModelOpenaiCodex.value = subagentModel;
    else if (subagentProvider === 'minimax' && selectSubagentModelMinimax) selectSubagentModelMinimax.value = subagentModel;
    else if (subagentProvider === 'moonshot' && selectSubagentModelMoonshot) selectSubagentModelMoonshot.value = subagentModel;
    else if (subagentProvider === 'ollama' && selectSubagentModelOllama) selectSubagentModelOllama.value = subagentModel;
    else if (subagentProvider === 'custom_openai' && inputCustomModel) inputCustomModel.value = subagentModel;
    changed.push('subagent model');
  }

  const nextReasoningMode = valueOrCurrent(requestedArgs.subagent_reasoning_mode, subagentReasoningMode).toLowerCase();
  if (nextReasoningMode !== subagentReasoningMode) {
    if (OPENAI_CODEX_REASONING_MODES.has(nextReasoningMode)) {
      subagentReasoningMode = nextReasoningMode;
      localStorage.setItem('shadow_subagent_reasoning_mode', subagentReasoningMode);
      if (selectSubagentReasoningMode) selectSubagentReasoningMode.value = subagentReasoningMode;
      changed.push('subagent reasoning mode');
    } else {
      warnings.push(`Unknown subagent reasoning mode "${nextReasoningMode}".`);
    }
  }

  const nextSearxngSearchUrl = valueOrCurrent(requestedArgs.searxng_url, searxngSearchUrl);
  if (nextSearxngSearchUrl !== searxngSearchUrl) {
    searxngSearchUrl = nextSearxngSearchUrl || 'http://127.0.0.1/search';
    localStorage.setItem('shadow_searxng_url', searxngSearchUrl);
    if (inputSearxngSearchUrl) inputSearxngSearchUrl.value = searxngSearchUrl;
    changed.push('SearXNG URL');
  }

  if (requestedArgs.searxng_port !== undefined) {
    const nextSearxngSearchPort = String(requestedArgs.searxng_port || '8888').trim();
    if (nextSearxngSearchPort !== searxngSearchPort) {
      if (/^\d+$/.test(nextSearxngSearchPort) && Number(nextSearxngSearchPort) >= 1 && Number(nextSearxngSearchPort) <= 65535) {
        searxngSearchPort = nextSearxngSearchPort;
        localStorage.setItem('shadow_searxng_port', searxngSearchPort);
        if (inputSearxngSearchPort) inputSearxngSearchPort.value = searxngSearchPort;
        changed.push('SearXNG port');
      } else {
        warnings.push(`Invalid SearXNG port "${nextSearxngSearchPort}".`);
      }
    }
  }

  if (shouldStartFreshVoiceSession(oldVoice, voiceName)) {
    clearLiveSessionResumptionToken();
  }
  if (oldAssistantName !== getAssistantName()) {
    clearLiveSessionResumptionToken();
  }

  await saveConfigToServer();

  const reconnectRequired = isConnected && (oldAssistantName !== getAssistantName() || oldVoice !== voiceName || oldModel !== selectedModel || oldAccent !== accent);
  if (reconnectRequired) {
    scheduleSettingsReconnect();
  }

  return {
    status: warnings.length ? 'partial' : 'success',
    changed,
    warnings,
    reconnect_required: reconnectRequired,
    settings: getCurrentShadowSettings()
  };
}

function scheduleSettingsReconnect() {
  pendingSettingsReconnect = true;
  if (settingsReconnectTimer) return;
  settingsReconnectTimer = setTimeout(() => {
    settingsReconnectTimer = null;
    attemptSettingsReconnect();
  }, 3000);
}

function attemptSettingsReconnect() {
  if (!pendingSettingsReconnect || !isConnected) return;
  if (suppressInterruptedTurnAudio || turnInProgress || currentVisualizerState === 'speaking' || currentVisualizerState === 'thinking' || currentVisualizerState === 'interrupting') {
    settingsReconnectTimer = setTimeout(() => {
      settingsReconnectTimer = null;
      attemptSettingsReconnect();
    }, 1000);
    return;
  }
  pendingSettingsReconnect = false;
  addSystemMessage('Reconnecting to apply voice session settings...');
  disconnect('', { preserveScreenShare: true, reconnecting: true, silent: true });
  setTimeout(() => connect(), 600);
}

// --- Custom Confirmation Modal Helper ---
function showCustomConfirm(title, message, onConfirm) {
  const confirmModal = document.getElementById('confirm-modal');
  const confirmTitle = document.getElementById('confirm-title');
  const confirmMessage = document.getElementById('confirm-message');
  const btnClose = document.getElementById('btn-close-confirm');
  const btnCancel = document.getElementById('btn-confirm-cancel');
  const btnOk = document.getElementById('btn-confirm-ok');

  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmModal.classList.remove('hidden');

  const close = () => {
    confirmModal.classList.add('hidden');
    btnOk.onclick = null;
    btnCancel.onclick = null;
    btnClose.onclick = null;
  };

  btnOk.onclick = () => {
    close();
    onConfirm();
  };

  btnCancel.onclick = close;
  btnClose.onclick = close;
}
