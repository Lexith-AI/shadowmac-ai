import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Pure function simulating the rolling maximum volume logic we want to implement
function getRollingMaxVolume(history, currentVol, now, windowMs = 800) {
  history.push({ time: now, vol: currentVol });
  
  // Purge old entries
  const cutoff = now - windowMs;
  while (history.length > 0 && history[0].time < cutoff) {
    history.shift();
  }
  
  // Find max volume
  let maxVol = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].vol > maxVol) {
      maxVol = history[i].vol;
    }
  }
  return maxVol;
}

// Pure function simulating dynamic threshold calculation
function getDynamicThreshold(micLevelThreshold, playVolume, multiplier = 0.0, protectPlayback = false) {
  const effectiveMultiplier = protectPlayback ? Math.max(multiplier, 0.18) : multiplier;
  return micLevelThreshold + (playVolume * effectiveMultiplier);
}

// Pure function simulating the server interruption gate.
function getInterruptedEventAction({
  micLevel = 0,
  playVolume = 0,
  multiplier = 0.0,
  timeSinceAiSpeech = 1000,
  micLevelThreshold = 0.025,
  cooldownMs = 750,
  serverInterruptPending = false,
  localBargeInActive = false,
  interruptedUserSpeechConfirmed = false
}) {
  const dynamicThreshold = getDynamicThreshold(micLevelThreshold, playVolume, multiplier, true);
  const hasExplicitEvidence = serverInterruptPending || localBargeInActive || interruptedUserSpeechConfirmed;

  if (hasExplicitEvidence) return 'interrupt';
  if (micLevel < micLevelThreshold) return 'defer';
  if (timeSinceAiSpeech < cooldownMs) return 'defer';
  if (micLevel < dynamicThreshold) return 'defer';
  return 'interrupt';
}

function shouldTriggerLocalBargeIn({
  playbackActive,
  localBargeInActive = false,
  speechFrames,
  now = 1000,
  lastCutAt = 0,
  requiredFrames = 4,
  minIntervalMs = 900
}) {
  if (!playbackActive || localBargeInActive) return false;
  if (speechFrames < requiredFrames) return false;
  if (now - lastCutAt < minIntervalMs) return false;
  return true;
}

function shouldTreatAsInterruptiblePlayback({
  audioPlaying = false,
  toolResponseFollowupPending = false,
  turnInProgress = false,
  visualizerState = 'listening'
}) {
  return Boolean(audioPlaying || visualizerState === 'speaking');
}

function shouldTreatAsVoiceWorkBargeIn({
  audioPlaying = false,
  toolResponseFollowupPending = false,
  activeToolCalls = 0,
  activeBackendCommands = 0,
  activeToolAbortSignal = false,
  visualizerState = 'listening'
}) {
  return Boolean(
    audioPlaying ||
    visualizerState === 'speaking' ||
    toolResponseFollowupPending ||
    activeToolCalls > 0 ||
    activeBackendCommands > 0 ||
    activeToolAbortSignal ||
    visualizerState === 'thinking' ||
    visualizerState === 'interrupting'
  );
}

function shouldTreatAsManualInterruptibleTurn({
  audioPlaying = false,
  toolResponseFollowupPending = false,
  turnInProgress = false,
  visualizerState = 'listening'
}) {
  return Boolean(audioPlaying || toolResponseFollowupPending || turnInProgress || visualizerState === 'thinking' || visualizerState === 'interrupting' || visualizerState === 'speaking');
}

function shouldSignalServerForLocalBargeIn({ toolResponseFollowupPending = false }) {
  return Boolean(toolResponseFollowupPending);
}

function shouldPassPlaybackMicAudio({ micAboveThreshold, confirmationRequested, localBargeInActive }) {
  if (!micAboveThreshold) return false;
  return Boolean(confirmationRequested || localBargeInActive);
}

function shouldSuppressModelTurnAudio({ suppressInterruptedTurnAudio, interruptedThisMessage }) {
  return Boolean(suppressInterruptedTurnAudio);
}

function shouldResumeInterruptedAudioForConfirmedSpeech({
  suppressInterruptedTurnAudio,
  interruptedUserSpeechConfirmed,
  userAudioQuiet = true
}) {
  return Boolean(suppressInterruptedTurnAudio && interruptedUserSpeechConfirmed && userAudioQuiet);
}

function shouldResetAudioOnVisualizerStateChange({ previousState, nextState }) {
  return previousState === 'speaking' && nextState !== 'speaking' && nextState !== 'interrupting';
}

// Pure function simulating whisper detection state toggle
function detectWhisperStateChange(text, currentIsWhispering) {
  const lower = text.toLowerCase();
  
  // Indicators for disabling whisper
  const stopWhisperIndicators = [
    'stop whispering',
    'stop whisper',
    'dont whisper',
    "don't whisper",
    'speak normally',
    'speak normal',
    'normal voice',
    'talk normal',
    'disable whisper',
    'no whisper'
  ];
  
  for (const indicator of stopWhisperIndicators) {
    if (lower.includes(indicator)) {
      return false;
    }
  }
  
  // Indicators for enabling whisper
  if (lower.includes('whisper') || lower.includes('whispering')) {
    return true;
  }
  
  return currentIsWhispering;
}

function normalizeTranscriptCompare(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

function isHeavyLocalProcessingText(text) {
  const lower = String(text || '').toLowerCase();
  const heavyAction = /\b(compress|transcode|encode|convert|resize|downscale|extract audio|burn subtitles|trim|cut|merge|mux|remux|render)\b/.test(lower);
  const mediaTarget = /\b(video|audio|mp4|mov|mkv|webm|avi|wav|mp3|ffmpeg|handbrake)\b|\.(mp4|mov|mkv|webm|avi|wav|mp3)\b/.test(lower);
  return heavyAction && mediaTarget;
}

function isGoogleDriveUploadDelegationTask(task) {
  const lower = String(task || '').toLowerCase();
  if (!lower) return false;
  const uploadIntent = /\b(upload|copy|send|put|move)\b/.test(lower);
  const driveTarget = /\b(google\s*drive|drive folder|drive)\b/.test(lower);
  const largeLocalFile = /\.(mp4|mov|mkv|webm|avi|zip|7z|rar|wav|mp3)\b/.test(lower);
  const heavyProcessing = isHeavyLocalProcessingText(lower);
  return uploadIntent && (driveTarget || largeLocalFile) && !heavyProcessing;
}

function shouldDelegateHeavyLocalProcessingCommand(command) {
  const lower = String(command || '').toLowerCase();
  if (!/\b(ffmpeg|handbrakecli)\b/.test(lower)) return false;
  if (/\b(-version|-h|--help|-encoders|-decoders|-formats|-probe|-show_streams|-show_format)\b/.test(lower)) return false;
  return /\b-i\b|\.mp4\b|\.mov\b|\.mkv\b|\.webm\b|\.avi\b|\.wav\b|\.mp3\b/.test(lower);
}

const proactiveProfileOrder = ['quiet', 'balanced', 'engaged', 'lively', 'immersive', 'hyper', 'unhinged'];

function isProactiveProfileAtLeast(profile, baseline) {
  const profileIndex = proactiveProfileOrder.indexOf(profile);
  const baselineIndex = proactiveProfileOrder.indexOf(baseline);
  if (profileIndex < 0 || baselineIndex < 0) return false;
  return profileIndex >= baselineIndex;
}

function getProactiveSignalScore(reason, profile = 'balanced', noveltyScore = 0) {
  if (reason === 'screen_frame') {
    if (isProactiveProfileAtLeast(profile, 'immersive')) return Math.max(9, noveltyScore);
    if (isProactiveProfileAtLeast(profile, 'lively')) return Math.max(8, noveltyScore);
    if (isProactiveProfileAtLeast(profile, 'engaged')) return Math.max(5, noveltyScore);
    return Math.max(2, noveltyScore);
  }
  if (reason === 'screen_started') return 8;
  return Math.max(1, noveltyScore);
}

function getNoScreenPresenceScore({ profile = 'balanced', trigger = 'idle_reflection', hasTextContext = false, screenActive = false, contextScore = 0, minContextScore = 6 }) {
  if (screenActive) return 0;
  const noScreenTriggers = ['session_ready', 'screen_stopped', 'settings_changed', 'idle_reflection', 'deferred'];
  if (trigger === 'ai_turn_complete' && hasTextContext) {
    return Math.max(minContextScore, 1);
  }
  if (!noScreenTriggers.includes(trigger)) return 0;
  if (hasTextContext) {
    return Math.max(minContextScore, contextScore || 1);
  }
  if (isProactiveProfileAtLeast(profile, 'unhinged')) {
    return Math.max(minContextScore, 1);
  }
  return 0;
}

function shouldEvaluateProactiveContext({ contextChanged, signalScore, minContextScore, trigger, noScreenPresenceScore = 0 }) {
  const triggerWorthEvaluating = signalScore >= minContextScore ||
    noScreenPresenceScore >= minContextScore ||
    ['screen_started', 'screen_stopped', 'session_ready', 'subagent_update', 'settings_changed'].includes(trigger);
  return (contextChanged || triggerWorthEvaluating) && signalScore + noScreenPresenceScore >= minContextScore;
}

function getNoScreenHeartbeatSignal({ profile = 'balanced', hasTextContext = false, timeSinceLastCheck = 0, idleReflectionAfterMs = 60000, minContextScore = 6 }) {
  if (timeSinceLastCheck <= idleReflectionAfterMs / 2) return { changed: false, score: 0 };
  if (hasTextContext) {
    return {
      changed: true,
      score: Math.max(minContextScore, isProactiveProfileAtLeast(profile, 'lively') ? 3 : 1)
    };
  }
  if (isProactiveProfileAtLeast(profile, 'unhinged')) {
    return { changed: true, score: Math.max(minContextScore, 1) };
  }
  return { changed: false, score: 0 };
}

function shouldUseNoScreenFallback({ profile = 'balanced', hasTextContext = false, transient = true }) {
  if (!transient) return false;
  if (hasTextContext && isProactiveProfileAtLeast(profile, 'lively')) return true;
  if (isProactiveProfileAtLeast(profile, 'unhinged')) return true;
  return false;
}

function getMemoryBackupScheduleKey({ enabled = false, intervalMinutes = 0 }) {
  const interval = parseInt(intervalMinutes, 10);
  const active = Boolean(enabled && interval > 0);
  return `${active ? 'enabled' : 'disabled'}:${active ? interval : 0}`;
}

function shouldRestartMemoryBackupScheduler({ currentScheduleKey = '', enabled = false, intervalMinutes = 0 }) {
  return getMemoryBackupScheduleKey({ enabled, intervalMinutes }) !== currentScheduleKey;
}

describe('Rolling Max Volume Tracking (Peak Hold)', () => {
  it('should return the current volume when history is empty', () => {
    const history = [];
    const max = getRollingMaxVolume(history, 0.5, 1000);
    expect(max).toBe(0.5);
  });

  it('should return the peak volume even if the current volume drops to 0', () => {
    const history = [];
    getRollingMaxVolume(history, 0.8, 1000); // peak
    getRollingMaxVolume(history, 0.4, 1100);
    const max = getRollingMaxVolume(history, 0.0, 1200); // current drops to 0
    expect(max).toBe(0.8);
  });

  it('should decay peak volume after the time window passes', () => {
    const history = [];
    getRollingMaxVolume(history, 0.9, 1000); // old peak
    getRollingMaxVolume(history, 0.3, 1100);
    
    // 900ms later (at 1900), the 1000ms peak should be purged (window = 800ms)
    const max = getRollingMaxVolume(history, 0.1, 1900);
    expect(max).toBe(0.3); // 0.9 was purged, so 0.3 is the new max
  });
});

describe('Interruption Finalization Guard', () => {
  it('should ignore manual interrupts when there is no active response to cut off', () => {
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const idleGuard = liveConnection.indexOf('if (!hadActiveResponse)');
    const interruptingState = liveConnection.indexOf("markTurnInterrupting('manual interrupt')");

    expect(idleGuard).toBeGreaterThan(-1);
    expect(interruptingState).toBeGreaterThan(idleGuard);
    expect(liveConnection.slice(idleGuard, interruptingState)).toContain("markTurnIdle('manual interrupt ignored because no active response')");
    expect(liveConnection.slice(idleGuard, interruptingState)).toContain("setVisualizerState('listening')");
    expect(liveConnection.slice(idleGuard, interruptingState)).toContain('return;');
  });

  it('should defer server interrupted events when local mic metering is quiet', () => {
    expect(getInterruptedEventAction({ micLevel: 0, playVolume: 0.4 })).toBe('defer');
    expect(getInterruptedEventAction({ micLevel: 0.01, playVolume: 0.4 })).toBe('defer');
  });

  it('should defer early interrupted events during playback startup unless confirmed', () => {
    expect(getInterruptedEventAction({
      micLevel: 0.5,
      playVolume: 0.1,
      timeSinceAiSpeech: 250
    })).toBe('defer');
  });

  it('should defer likely playback echo until user speech is confirmed', () => {
    expect(getInterruptedEventAction({
      micLevel: 0.05,
      playVolume: 0.3,
      multiplier: 0.0
    })).toBe('defer');
  });

  it('should immediately cut audio for clear user speech well above the protected playback threshold', () => {
    expect(getInterruptedEventAction({
      micLevel: 0.3,
      playVolume: 0.2,
      multiplier: 0.0
    })).toBe('interrupt');
  });

  it('should always honor the manual interrupt button even without mic evidence', () => {
    expect(getInterruptedEventAction({
      micLevel: 0,
      playVolume: 0.4,
      serverInterruptPending: true
    })).toBe('interrupt');
  });

  it('should honor already-confirmed local barge-in evidence', () => {
    expect(getInterruptedEventAction({
      micLevel: 0.03,
      playVolume: 0.4,
      localBargeInActive: true
    })).toBe('interrupt');
    expect(getInterruptedEventAction({
      micLevel: 0.03,
      playVolume: 0.4,
      interruptedUserSpeechConfirmed: true
    })).toBe('interrupt');
  });
});

describe('Local Barge-In Trigger', () => {
  it('should trigger local interruption after consecutive confident speech frames', () => {
    expect(shouldTriggerLocalBargeIn({
      playbackActive: true,
      speechFrames: 4,
      now: 2000,
      lastCutAt: 0
    })).toBe(true);
  });

  it('should not request confirmation for a single noisy frame', () => {
    expect(shouldTriggerLocalBargeIn({
      playbackActive: true,
      speechFrames: 1,
      now: 2000,
      lastCutAt: 0
    })).toBe(false);
  });

  it('should not repeatedly request confirmation during the same barge-in', () => {
    expect(shouldTriggerLocalBargeIn({
      playbackActive: true,
      localBargeInActive: true,
      speechFrames: 4,
      now: 2000,
      lastCutAt: 0
    })).toBe(false);
  });

  it('should not treat a silent post-tool follow-up as audible playback for local barge-in', () => {
    expect(shouldTreatAsInterruptiblePlayback({
      audioPlaying: false,
      toolResponseFollowupPending: true,
      turnInProgress: false,
      visualizerState: 'thinking'
    })).toBe(false);
  });

  it('should still let the manual interrupt button stop a silent post-tool follow-up', () => {
    expect(shouldTreatAsManualInterruptibleTurn({
      audioPlaying: false,
      toolResponseFollowupPending: true,
      turnInProgress: false,
      visualizerState: 'thinking'
    })).toBe(true);
  });

  it('should treat silent tool and thinking work as voice-barge-in targets', () => {
    expect(shouldTreatAsVoiceWorkBargeIn({
      toolResponseFollowupPending: true,
      visualizerState: 'thinking'
    })).toBe(true);
    expect(shouldTreatAsVoiceWorkBargeIn({
      activeToolCalls: 1,
      visualizerState: 'listening'
    })).toBe(true);
  });

  it('should send a real server interrupt for confirmed local speech during a post-tool follow-up', () => {
    expect(shouldSignalServerForLocalBargeIn({
      toolResponseFollowupPending: true
    })).toBe(true);
    expect(shouldSignalServerForLocalBargeIn({
      toolResponseFollowupPending: false
    })).toBe(false);
  });
});

describe('Playback Mic Gate', () => {
  it('should not pass a single above-threshold playback spike to server VAD', () => {
    expect(shouldPassPlaybackMicAudio({
      micAboveThreshold: true,
      confirmationRequested: false,
      localBargeInActive: false
    })).toBe(false);
  });

  it('should pass mic audio once local barge-in has consecutive-frame confidence', () => {
    expect(shouldPassPlaybackMicAudio({
      micAboveThreshold: true,
      confirmationRequested: true,
      localBargeInActive: true
    })).toBe(true);
  });
});

describe('Interrupted Audio Suppression', () => {
  it('should keep suppressing late chunks from an already interrupted turn', () => {
    expect(shouldSuppressModelTurnAudio({
      suppressInterruptedTurnAudio: true,
      interruptedThisMessage: false
    })).toBe(true);
  });

  it('should suppress audio when the server marks the same message interrupted', () => {
    expect(shouldSuppressModelTurnAudio({
      suppressInterruptedTurnAudio: true,
      interruptedThisMessage: true
    })).toBe(true);
  });

  it('should resume audio for the follow-up answer once interrupted user speech is confirmed and quiet', () => {
    expect(shouldResumeInterruptedAudioForConfirmedSpeech({
      suppressInterruptedTurnAudio: true,
      interruptedUserSpeechConfirmed: true,
      userAudioQuiet: true
    })).toBe(true);
  });

  it('should not resume interrupted audio while the user is still speaking', () => {
    expect(shouldResumeInterruptedAudioForConfirmedSpeech({
      suppressInterruptedTurnAudio: true,
      interruptedUserSpeechConfirmed: true,
      userAudioQuiet: false
    })).toBe(false);
  });

  it('should not resume interrupted audio before user speech is confirmed', () => {
    expect(shouldResumeInterruptedAudioForConfirmedSpeech({
      suppressInterruptedTurnAudio: true,
      interruptedUserSpeechConfirmed: false
    })).toBe(false);
  });

  it('should not request confirmation for only two noisy playback frames', () => {
    expect(shouldTriggerLocalBargeIn({
      playbackActive: true,
      speechFrames: 2,
      now: 2000,
      lastCutAt: 0
    })).toBe(false);
  });

  it('should not reset the audio player while entering the interrupting UI state', () => {
    expect(shouldResetAudioOnVisualizerStateChange({
      previousState: 'speaking',
      nextState: 'interrupting'
    })).toBe(false);
  });

  it('should reset the audio player on normal speaking-to-listening transitions', () => {
    expect(shouldResetAudioOnVisualizerStateChange({
      previousState: 'speaking',
      nextState: 'listening'
    })).toBe(true);
  });
});

describe('Dynamic Echo Gate Threshold Calculation', () => {
  const multipliers = {
    headphones: 0.0,
    speaker_low: 0.2,
    speaker_medium: 0.45,
    speaker_high: 0.8
  };

  it('should compute the dynamic threshold for Headphones Mode (multiplier = 0.0)', () => {
    const micLevelThreshold = 0.025;
    const playVolume = 0.5;
    const threshold = getDynamicThreshold(micLevelThreshold, playVolume, multipliers.headphones);
    expect(threshold).toBeCloseTo(0.025);
  });

  it('should apply a small playback-protection gate while the model is speaking', () => {
    const micLevelThreshold = 0.025;
    const playVolume = 0.5;
    const threshold = getDynamicThreshold(micLevelThreshold, playVolume, multipliers.headphones, true);
    expect(threshold).toBeCloseTo(0.025 + 0.5 * 0.18);
  });

  it('should compute the dynamic threshold for Speaker Mode (Low) (multiplier = 0.2)', () => {
    const micLevelThreshold = 0.025;
    const playVolume = 0.5;
    const threshold = getDynamicThreshold(micLevelThreshold, playVolume, multipliers.speaker_low);
    expect(threshold).toBeCloseTo(0.025 + 0.5 * 0.2);
  });

  it('should compute the dynamic threshold for Speaker Mode (Medium) (multiplier = 0.45)', () => {
    const micLevelThreshold = 0.025;
    const playVolume = 0.5;
    const threshold = getDynamicThreshold(micLevelThreshold, playVolume, multipliers.speaker_medium);
    expect(threshold).toBeCloseTo(0.025 + 0.5 * 0.45);
  });

  it('should compute the dynamic threshold for Speaker Mode (High) (multiplier = 0.8)', () => {
    const micLevelThreshold = 0.025;
    const playVolume = 0.5;
    const threshold = getDynamicThreshold(micLevelThreshold, playVolume, multipliers.speaker_high);
    expect(threshold).toBeCloseTo(0.025 + 0.5 * 0.8);
  });
});

describe('Whisper State Toggle Detection', () => {
  it('should activate whisper mode if whisper keywords are detected', () => {
    expect(detectWhisperStateChange('can you please whisper now?', false)).toBe(true);
    expect(detectWhisperStateChange('start whispering', false)).toBe(true);
  });

  it('should deactivate whisper mode if disable keywords are detected', () => {
    expect(detectWhisperStateChange('stop whispering', true)).toBe(false);
    expect(detectWhisperStateChange("don't whisper anymore", true)).toBe(false);
    expect(detectWhisperStateChange('speak normally', true)).toBe(false);
  });

  it('should preserve the current state if no keywords are matched', () => {
    expect(detectWhisperStateChange('how are you doing today?', true)).toBe(true);
    expect(detectWhisperStateChange('how are you doing today?', false)).toBe(false);
  });

  it('should deactivate whisper mode even if text contains whisper if a negation is also present', () => {
    expect(detectWhisperStateChange('please stop whispering', true)).toBe(false);
  });
});

describe('User Transcript Display Corrections', () => {
  it('should correct the hamantaschen mis-transcript in gemeente Oss context', () => {
    const corrected = applyUserTranscriptDisplayCorrections(
      "No, it's it's actually called hamentashen.",
      "The gemeente mailed the waste pass for Oss."
    );
    expect(corrected).toBe("No, it's actually called gemeente Oss.");
  });

  it('should not correct hamantaschen in food context', () => {
    const corrected = applyUserTranscriptDisplayCorrections(
      'I bought hamantaschen at the bakery.',
      'We were talking about cookies and dessert.'
    );
    expect(corrected).toBe('I bought hamantaschen at the bakery.');
  });
});

describe('Delegation Routing Guards', () => {
  it('should block subagent delegation for plain Drive upload of an existing large file', () => {
    expect(isGoogleDriveUploadDelegationTask('upload C:\\Users\\Dylan\\Desktop\\testvideo.mp4 to Google Drive')).toBe(true);
  });

  it('should allow subagent delegation for video compression before upload', () => {
    expect(isGoogleDriveUploadDelegationTask('compress C:\\Users\\Dylan\\Desktop\\testvideo.mp4 and then upload the result to Google Drive')).toBe(false);
    expect(isHeavyLocalProcessingText('compress C:\\Users\\Dylan\\Desktop\\testvideo.mp4')).toBe(true);
  });

  it('should block direct ffmpeg processing in the voice session', () => {
    expect(shouldDelegateHeavyLocalProcessingCommand('ffmpeg -i input.mp4 -vcodec libx264 output.mp4')).toBe(true);
  });

  it('should allow ffmpeg version probes directly', () => {
    expect(shouldDelegateHeavyLocalProcessingCommand('ffmpeg -version')).toBe(false);
  });
});

describe('Subagent Correction Interrupts', () => {
  it('should mark the spawned subagent summary as an interruptible follow-up', () => {
    const root = process.cwd();
    const stateDom = fs.readFileSync(path.join(root, 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(root, 'src', 'scripts', '05-live-connection.js'), 'utf8');

    expect(stateDom).toContain('toolResponseFollowupPending');
    expect(stateDom).toContain('TOOL_RESPONSE_FOLLOWUP_TIMEOUT_MS');
    expect(liveConnection).toContain("markToolResponseFollowupPending('spawn_background_agent')");
    expect(liveConnection).toContain('function isTurnActiveForManualInterrupt()');
    expect(liveConnection).toContain('Ignoring server interrupted event because no Shadow audio is currently playing.');
    expect(liveConnection).toContain('manualInterrupt({ sendToServer: false, preserveLocalBargeIn: true })');
  });

  it('should interrupt the current step while preserving subagent context', () => {
    const root = process.cwd();
    const stateDom = fs.readFileSync(path.join(root, 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const core = fs.readFileSync(path.join(root, 'src', 'scripts', '09-subagents-core.js'), 'utf8');
    const runner = fs.readFileSync(path.join(root, 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(root, 'src', 'scripts', '05-live-connection.js'), 'utf8');

    expect(liveConnection).toContain('preserves its conversation context');
    expect(liveConnection).toContain('resolveControllableSubagentReference(requestedSubagentId)');
    // Steering interrupts immediately with the raw correction (no blocking on a slow refine),
    // then refines in the background — so the voice is not stuck while a local model refines.
    expect(liveConnection).toContain("interruptSubagentWithFeedback(subagent, feedback, 'Tool correction received.')");
    expect(liveConnection).toContain('refineSubagentSteeringFeedbackWithSelectedModel(');
    expect(core).toContain('function interruptSubagentWithFeedback');
    expect(core).toContain('function interruptSubagentWithSelectedModelFeedback');
    expect(core).toContain('refineSubagentInstructionWithSelectedModel(\'steer\'');
    expect(core).toContain('subagentRecord.steerQueue.push(cleanFeedback)');
    expect(core).toContain('cancelSubagentBackendRuns(subagentRecord, reason)');
    expect(core).toContain('subagentRecord.abortController.abort()');
    expect(runner).toContain('consumeSubagentInterrupt(subagentRecord)');
    expect(runner).toContain('[USER CORRECTION/FEEDBACK]');
    expect(stateDom).toContain('preserves the subagent\\\'s existing context');
  });

  it('should not replace the subagent record for corrections', () => {
    const root = process.cwd();
    const core = fs.readFileSync(path.join(root, 'src', 'scripts', '09-subagents-core.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(root, 'src', 'scripts', '05-live-connection.js'), 'utf8');

    expect(core).not.toContain('replaceSubagentWithDirectPrompt');
    expect(core).not.toContain('buildReplacementSubagentTask');
    expect(liveConnection).not.toContain('replacement_subagent_id');
    expect(liveConnection).not.toContain("status: 'replaced'");
  });
});

describe('Proactive Attention Modes', () => {
  it('should rank lively and immersive above engaged', () => {
    expect(isProactiveProfileAtLeast('lively', 'engaged')).toBe(true);
    expect(isProactiveProfileAtLeast('immersive', 'lively')).toBe(true);
    expect(isProactiveProfileAtLeast('balanced', 'engaged')).toBe(false);
  });

  it('should rank unhinged as the most active profile', () => {
    expect(isProactiveProfileAtLeast('unhinged', 'hyper')).toBe(true);
    expect(isProactiveProfileAtLeast('unhinged', 'immersive')).toBe(true);
    expect(isProactiveProfileAtLeast('hyper', 'unhinged')).toBe(false);
  });

  it('should let high proactive modes trigger screen-frame evaluation without a large pixel diff', () => {
    const minContextScore = 3;
    expect(getProactiveSignalScore('screen_frame', 'immersive', 0)).toBe(9);
    expect(getProactiveSignalScore('screen_frame', 'hyper', 0)).toBe(9);
    expect(getProactiveSignalScore('screen_frame', 'unhinged', 0)).toBe(9);
    expect(shouldEvaluateProactiveContext({
      contextChanged: false,
      signalScore: getProactiveSignalScore('screen_frame', 'immersive', 0),
      minContextScore,
      trigger: 'screen_frame'
    })).toBe(true);
  });

  it('should no longer expose the removed 20x/50x profiles in settings UI', () => {
    const root = process.cwd();
    const indexHtml = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
    expect(indexHtml).toContain('value="unhinged"');
    expect(indexHtml).not.toContain('value="insane"');
    expect(indexHtml).not.toContain('value="overdrive"');
  });

  it('should block direct natural-language proactive settings changes', () => {
    const root = process.cwd();
    const subagentsCore = fs.readFileSync(path.join(root, 'src', 'scripts', '09-subagents-core.js'), 'utf8');
    expect(subagentsCore).toContain('Proactive mode settings are locked from voice control.');
    expect(subagentsCore).not.toContain('Proactive attention adjusted immediately');
  });

  it('should expose SearXNG settings and route web search through the shared proxy', () => {
    const root = process.cwd();
    const indexHtml = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
    const stateDom = fs.readFileSync(path.join(root, 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(root, 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const subagentsRunner = fs.readFileSync(path.join(root, 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
    expect(indexHtml).toContain('input-searxng-search-url');
    expect(indexHtml).toContain('input-searxng-search-port');
    expect(indexHtml).toContain('SearXNG URL');
    expect(stateDom).toContain('shadow_searxng_url');
    expect(liveConnection).toContain('/api/search');
    expect(subagentsRunner).toContain('/api/search');
  });

  it('should not advertise managed browser automation tools', () => {
    const root = process.cwd();
    const liveConnection = fs.readFileSync(path.join(root, 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const subagentsRunner = fs.readFileSync(path.join(root, 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
    const launcher = fs.readFileSync(path.join(root, 'run.ps1'), 'utf8');

    expect(liveConnection).not.toContain("name: 'run_browser_action'");
    expect(subagentsRunner).not.toContain("name: 'run_browser_action'");
    expect(subagentsRunner).not.toContain("name: 'request_user_auth_checkpoint'");
    expect(launcher).toContain('Managed browser controller disabled.');
    expect(launcher).toContain('Browser automation is disabled. Use search_web/web_search through SearXNG');
    expect(launcher).not.toContain('browser_controller.js');
  });

  it('should evaluate no-screen dialogue heartbeats for balanced mode', () => {
    const signal = getNoScreenHeartbeatSignal({
      profile: 'balanced',
      hasTextContext: true,
      timeSinceLastCheck: 130000,
      idleReflectionAfterMs: 240000,
      minContextScore: 6
    });
    expect(signal.changed).toBe(true);
    expect(signal.score).toBe(6);
    expect(shouldEvaluateProactiveContext({
      contextChanged: signal.changed,
      signalScore: signal.score,
      minContextScore: 6,
      trigger: 'idle_reflection'
    })).toBe(true);
  });

  it('should evaluate no-screen extreme presence even before dialogue exists', () => {
    const signal = getNoScreenHeartbeatSignal({
      profile: 'unhinged',
      hasTextContext: false,
      timeSinceLastCheck: 2000,
      idleReflectionAfterMs: 2400,
      minContextScore: 1
    });
    expect(signal.changed).toBe(true);
    expect(signal.score).toBe(1);
  });

  it('should wake a clean no-screen extreme session without a prior screen event', () => {
    const noScreenPresenceScore = getNoScreenPresenceScore({
      profile: 'unhinged',
      trigger: 'session_ready',
      hasTextContext: false,
      minContextScore: 1
    });
    expect(noScreenPresenceScore).toBe(1);
    expect(shouldEvaluateProactiveContext({
      contextChanged: false,
      signalScore: 0,
      minContextScore: 1,
      trigger: 'session_ready',
      noScreenPresenceScore
    })).toBe(true);
  });

  it('should wake a clean no-screen session when dialogue history exists', () => {
    const noScreenPresenceScore = getNoScreenPresenceScore({
      profile: 'balanced',
      trigger: 'session_ready',
      hasTextContext: true,
      minContextScore: 6
    });
    expect(noScreenPresenceScore).toBe(6);
    expect(shouldEvaluateProactiveContext({
      contextChanged: false,
      signalScore: 0,
      minContextScore: 6,
      trigger: 'session_ready',
      noScreenPresenceScore
    })).toBe(true);
  });

  it('should not wake a clean balanced no-screen session without dialogue', () => {
    const noScreenPresenceScore = getNoScreenPresenceScore({
      profile: 'balanced',
      trigger: 'session_ready',
      hasTextContext: false,
      minContextScore: 6
    });
    expect(noScreenPresenceScore).toBe(0);
    expect(shouldEvaluateProactiveContext({
      contextChanged: false,
      signalScore: 0,
      minContextScore: 6,
      trigger: 'session_ready',
      noScreenPresenceScore
    })).toBe(false);
  });

  it('should allow no-screen fallback for active profiles when the evaluator is transiently unavailable', () => {
    expect(shouldUseNoScreenFallback({ profile: 'lively', hasTextContext: true })).toBe(true);
    expect(shouldUseNoScreenFallback({ profile: 'unhinged', hasTextContext: false })).toBe(true);
    expect(shouldUseNoScreenFallback({ profile: 'balanced', hasTextContext: true })).toBe(false);
  });

  it('should not restart memory backup scheduler when settings save leaves backup timing unchanged', () => {
    const currentScheduleKey = getMemoryBackupScheduleKey({ enabled: true, intervalMinutes: 60 });
    expect(shouldRestartMemoryBackupScheduler({
      currentScheduleKey,
      enabled: true,
      intervalMinutes: 60
    })).toBe(false);
  });

  it('should restart memory backup scheduler only when backup enabled state or interval changes', () => {
    const currentScheduleKey = getMemoryBackupScheduleKey({ enabled: true, intervalMinutes: 60 });
    expect(shouldRestartMemoryBackupScheduler({
      currentScheduleKey,
      enabled: true,
      intervalMinutes: 120
    })).toBe(true);
    expect(shouldRestartMemoryBackupScheduler({
      currentScheduleKey,
      enabled: false,
      intervalMinutes: 60
    })).toBe(true);
  });
});
