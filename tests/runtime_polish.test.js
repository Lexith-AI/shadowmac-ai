import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { createVoiceSessionReplay, parseVoiceSessionLog } from './helpers/voice_replay_harness.js';

function extractFunctionSource(source, functionName) {
  let start = source.indexOf(`function ${functionName}(`);
  if (start < 0) throw new Error(`Missing function ${functionName}`);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const signatureEnd = source.indexOf(') {', start);
  const bodyStart = source.indexOf('{', signatureEnd > -1 ? signatureEnd : start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not parse function ${functionName}`);
}

function loadFunctions(filesAndNames, context = {}) {
  const sandbox = vm.createContext({
    console,
    Date,
    WebSocket: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
    ...context
  });
  const chunks = [];
  for (const [file, names] of filesAndNames) {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', file), 'utf8');
    chunks.push(names.map(name => extractFunctionSource(source, name)).join('\n\n'));
  }
  const allNames = filesAndNames.flatMap(([, names]) => names);
  const exportsSource = `\nresult = { ${allNames.map(name => `${name}: ${name}`).join(', ')} };`;
  vm.runInContext(`${chunks.join('\n\n')}${exportsSource}`, sandbox);
  return sandbox.result;
}

function createNotificationContext() {
  return {
    pendingNotifications: [],
    notificationSequence: 0,
    notificationSeenKeys: new Map(),
    deliveredNotificationIds: new Set(),
    notificationDeliveryHistory: [],
    NOTIFICATION_DEDUPE_TTL_MS: 600000,
    NOTIFICATION_CACHE_LIMIT: 240,
    NOTIFICATION_LANE_PRIORITY: {
      critical: 0,
      reminder: 1,
      subagent: 2,
      scheduler: 3,
      memory: 4,
      proactive: 5,
      default: 6
    },
    userSpeechSeq: 1,
    updateDiagnosticsPanel: () => {},
    tryDeliverPendingNotifications: () => {}
  };
}

describe('runtime notification queue', () => {
  it('deduplicates notices by generated content key', () => {
    const context = createNotificationContext();
    const { queueSchedulerMessage } = loadFunctions([
      ['01-state-dom.js', ['normalizeNotificationLane', 'normalizeNotificationTextForKey', 'pruneNotificationCaches']],
      ['10-scheduler-proactive.js', ['queueSchedulerMessage']]
    ], context);

    const firstId = queueSchedulerMessage('[SYSTEM NOTICE] Background task finished.', { lane: 'subagent' });
    const secondId = queueSchedulerMessage('[SYSTEM NOTICE] Background task finished.', { lane: 'subagent' });

    expect(firstId).toBe('notice_1');
    expect(secondId).toBeNull();
    expect(context.pendingNotifications).toHaveLength(1);
  });

  it('selects higher-priority lanes before lower-priority lanes', () => {
    const context = createNotificationContext();
    const { queueSchedulerMessage, getNextPendingNotification } = loadFunctions([
      ['01-state-dom.js', [
        'normalizeNotificationLane',
        'normalizeNotificationTextForKey',
        'pruneNotificationCaches',
        'getNextPendingNotification'
      ]],
      ['10-scheduler-proactive.js', ['queueSchedulerMessage', 'normalizePendingNotification']]
    ], context);

    queueSchedulerMessage('[PROACTIVE ATTENTION] Say hi.', { lane: 'proactive' });
    queueSchedulerMessage('[SYSTEM NOTICE] Subagent finished.', { lane: 'subagent' });

    const next = getNextPendingNotification();
    expect(next.item.lane).toBe('subagent');
  });

  it('preserves explicit lanes even when a notice is critical', () => {
    const context = createNotificationContext();
    const { queueSchedulerMessage } = loadFunctions([
      ['01-state-dom.js', ['normalizeNotificationLane', 'normalizeNotificationTextForKey', 'pruneNotificationCaches']],
      ['10-scheduler-proactive.js', ['queueSchedulerMessage']]
    ], context);

    queueSchedulerMessage('Reminder text', { lane: 'reminder', critical: true });

    expect(context.pendingNotifications[0].lane).toBe('reminder');
    expect(context.pendingNotifications[0].critical).toBe(true);
  });

  it('queues subagent notices even while the voice socket is disconnected', () => {
    const context = createNotificationContext();
    context.isConnected = false;
    context.socket = null;
    context.currentVisualizerState = 'disconnected';
    context.subagentDeferredNotifications = [];
    context.redactSensitiveText = text => String(text || '');
    const { notifyModelOfSubagentUpdate } = loadFunctions([
      ['01-state-dom.js', ['normalizeNotificationLane', 'normalizeNotificationTextForKey', 'pruneNotificationCaches']],
      ['10-scheduler-proactive.js', ['queueSchedulerMessage']],
      ['12-subagents-notifications.js', ['notifyModelOfSubagentUpdate', '_sendSubagentNotification', 'flushDeferredSubagentNotifications']]
    ], context);

    notifyModelOfSubagentUpdate('[Subagent Done] Task finished.');

    expect(context.pendingNotifications).toHaveLength(1);
    expect(context.pendingNotifications[0]).toMatchObject({
      lane: 'subagent',
      critical: true,
      ttlMs: 10 * 60 * 1000
    });
    expect(context.pendingNotifications[0].text).toContain('[SYSTEM NOTICE - DO NOT READ VERBATIM]');
    expect(context.pendingNotifications[0].text).toContain('Do not repeat internal task prompts');
  });

  it('keeps subagent failure notices from exposing delegated task prompts to speech', () => {
    const context = createNotificationContext();
    context.subagentDeferredNotifications = [];
    context.redactSensitiveText = text => String(text || '');
    context.addSystemMessage = () => {};
    context.playNotificationChime = () => {};
    context.scrollTranscript = () => {};
    const { notifyVoiceSessionOfFailure } = loadFunctions([
      ['01-state-dom.js', ['normalizeNotificationLane', 'normalizeNotificationTextForKey', 'pruneNotificationCaches']],
      ['10-scheduler-proactive.js', ['queueSchedulerMessage']],
      ['12-subagents-notifications.js', ['notifyVoiceSessionOfFailure', 'notifyModelOfSubagentUpdate', '_sendSubagentNotification', 'flushDeferredSubagentNotifications']]
    ], context);

    notifyVoiceSessionOfFailure('Investigate and disable internal secret deployment prompt', 'Could not restart service.', 'subagent_1');

    expect(context.pendingNotifications).toHaveLength(1);
    expect(context.pendingNotifications[0].text).not.toContain('Investigate and disable internal secret deployment prompt');
    expect(context.pendingNotifications[0].text).toContain('I could not finish the background work');
    expect(context.pendingNotifications[0].text).toContain('Do not repeat the internal task prompt');
  });

  it('holds queued notices after recent user speech or voice interruption', () => {
    const now = Date.now();
    const context = {
      isConnected: true,
      socket: { readyState: 1 },
      systemNoticeInFlight: false,
      suppressInterruptedTurnAudio: false,
      turnInProgress: false,
      userTurnActive: false,
      currentVisualizerState: 'listening',
      lastUserAudioDetectedTime: now - 1000,
      lastVoiceInterruptTime: 0,
      lastAITurnCompleteTime: 0,
      NOTIFICATION_COOLDOWN_MS: 1000,
      SYSTEM_NOTICE_RECENT_USER_AUDIO_COOLDOWN_MS: 6000,
      SYSTEM_NOTICE_AFTER_INTERRUPT_COOLDOWN_MS: 8000
    };
    const {
      isSafeToInjectSystemNotice,
      getPendingNotificationBlockReason,
      getSystemNoticeRetryDelay
    } = loadFunctions([
      ['10-scheduler-proactive.js', [
        'isSubagentPromptRefinementActive',
        'isSafeToInjectSystemNotice',
        'getPendingNotificationBlockReason',
        'getSystemNoticeRetryDelay'
      ]]
    ], context);

    expect(isSafeToInjectSystemNotice()).toBe(false);
    expect(getPendingNotificationBlockReason()).toBe('recent user audio');
    expect(getSystemNoticeRetryDelay()).toBeGreaterThan(4500);

    const interruptContext = {
      ...context,
      lastUserAudioDetectedTime: now - 7000,
      lastVoiceInterruptTime: now - 1000
    };
    const interruptGate = loadFunctions([
      ['10-scheduler-proactive.js', [
        'isSubagentPromptRefinementActive',
        'isSafeToInjectSystemNotice',
        'getPendingNotificationBlockReason',
        'getSystemNoticeRetryDelay'
      ]]
    ], interruptContext);
    expect(interruptGate.isSafeToInjectSystemNotice()).toBe(false);
    expect(interruptGate.getPendingNotificationBlockReason()).toBe('recent voice interruption');
    expect(interruptGate.getSystemNoticeRetryDelay()).toBeGreaterThan(6500);

    const readyContext = {
      ...context,
      lastUserAudioDetectedTime: now - 7000,
      lastVoiceInterruptTime: now - 9000
    };
    const readyGate = loadFunctions([
      ['10-scheduler-proactive.js', [
        'isSubagentPromptRefinementActive',
        'isSafeToInjectSystemNotice',
        'getPendingNotificationBlockReason'
      ]]
    ], readyContext);
    expect(readyGate.isSafeToInjectSystemNotice()).toBe(true);
    expect(readyGate.getPendingNotificationBlockReason()).toBe('ready');

    const promptRefinementGate = loadFunctions([
      ['10-scheduler-proactive.js', [
        'isSafeToInjectSystemNotice',
        'getPendingNotificationBlockReason',
        'getSystemNoticeRetryDelay',
        'isSubagentPromptRefinementActive'
      ]]
    ], {
      ...readyContext,
      subagentPromptRefinementInProgress: true
    });
    expect(promptRefinementGate.isSubagentPromptRefinementActive()).toBe(true);
    expect(promptRefinementGate.isSafeToInjectSystemNotice()).toBe(false);
    expect(promptRefinementGate.getPendingNotificationBlockReason()).toBe('subagent prompt refinement active');
    expect(promptRefinementGate.getSystemNoticeRetryDelay()).toBe(1000);
  });
});

describe('turn and transcript helpers', () => {
  it('updates turn phase through explicit state helpers', () => {
    const context = {
      shadowTurnState: { phase: 'idle', reason: 'startup', updatedAt: 0 },
      lastUserAudioDetectedTime: 0,
      userTurnActive: false,
      turnInProgress: false,
      lastAITurnCompleteTime: 0,
      updateDiagnosticsPanel: () => {}
    };
    const { markUserAudioActivity, markModelTurnStarted, markTurnIdle, getShadowTurnStateSnapshot } = loadFunctions([
      ['01-state-dom.js', ['setShadowTurnState', 'getShadowTurnStateSnapshot', 'markUserAudioActivity', 'markModelTurnStarted', 'markTurnIdle']]
    ], context);

    markUserAudioActivity('test mic');
    expect(getShadowTurnStateSnapshot().phase).toBe('user_speaking');
    expect(getShadowTurnStateSnapshot().userTurnActive).toBe(true);

    markModelTurnStarted('test model');
    expect(getShadowTurnStateSnapshot().phase).toBe('model_turn');
    expect(getShadowTurnStateSnapshot().turnInProgress).toBe(true);

    markTurnIdle('done', { completed: true });
    expect(getShadowTurnStateSnapshot().phase).toBe('idle');
    expect(getShadowTurnStateSnapshot().turnInProgress).toBe(false);
    expect(getShadowTurnStateSnapshot().lastAITurnCompleteTime).toBeGreaterThan(0);
  });

  it('filters tiny ASR transcript revisions before side effects', () => {
    const { isTinyUserTranscriptRevision } = loadFunctions([
      ['01-state-dom.js', ['isTinyUserTranscriptRevision']]
    ]);

    expect(isTinyUserTranscriptRevision('check on the age', 'check on the ag')).toBe(true);
    expect(isTinyUserTranscriptRevision('check on the agent please', 'check on the ag')).toBe(false);
  });

  it('waits for a usable barge-in transcript instead of interrupting on a tiny partial', () => {
    let interrupted = 0;
    const context = {
      pendingBargeInTimer: 'timer',
      pendingBargeInMicLevel: 0.2,
      MIN_BARGE_IN_TRANSCRIPT_CHARS: 4,
      manualInterrupt: () => { interrupted += 1; },
      resetLocalBargeInDetection: () => {},
      clearTimeout: () => {},
      btnInterrupt: { classList: { remove: () => {} } },
      audioPlayer: null,
      MIC_LEVEL_THRESHOLD: 0.025,
      suppressInterruptedTurnAudio: false,
      isLikelyEchoTranscript: () => false
    };
    const { confirmPendingBargeIn } = loadFunctions([
      ['05-live-connection.js', ['confirmPendingBargeIn']]
    ], context);

    expect(confirmPendingBargeIn('uh')).toBe(false);
    expect(interrupted).toBe(0);
    expect(context.pendingBargeInTimer).toBe('timer');
    expect(context.pendingBargeInMicLevel).toBe(0.2);
  });

  it('keeps a bounded local barge-in mic pre-roll and clears it on reset', () => {
    const context = {
      localBargeInSpeechFrames: 2,
      localBargeInStartedAt: 123,
      localBargeInActive: true,
      localBargeInPrerollChunks: [],
      LOCAL_BARGE_IN_PREROLL_MAX_CHUNKS: 3,
      LOCAL_BARGE_IN_PREROLL_MAX_AGE_MS: 1600
    };
    const {
      queueLocalBargeInPrerollChunk,
      consumeLocalBargeInPrerollChunks,
      resetLocalBargeInDetection
    } = loadFunctions([
      ['01-state-dom.js', [
        'queueLocalBargeInPrerollChunk',
        'consumeLocalBargeInPrerollChunks',
        'resetLocalBargeInDetection'
      ]]
    ], context);

    queueLocalBargeInPrerollChunk('chunk1');
    queueLocalBargeInPrerollChunk('chunk2');
    queueLocalBargeInPrerollChunk('chunk3');
    queueLocalBargeInPrerollChunk('chunk4');

    expect(consumeLocalBargeInPrerollChunks()).toEqual(['chunk2', 'chunk3', 'chunk4']);
    expect(consumeLocalBargeInPrerollChunks()).toEqual([]);

    queueLocalBargeInPrerollChunk('chunk5');
    resetLocalBargeInDetection({ preservePreroll: true });
    expect(consumeLocalBargeInPrerollChunks()).toEqual(['chunk5']);

    queueLocalBargeInPrerollChunk('chunk6');
    resetLocalBargeInDetection();
    expect(consumeLocalBargeInPrerollChunks()).toEqual([]);
  });

  it('uses a lower rolling pre-roll gate before the high-confidence barge-in cut', () => {
    const audio = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '04-audio.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');

    expect(liveConnection).toContain('function getLocalBargeInCandidateThreshold');
    expect(liveConnection).toContain('function isLiveWorkActiveForVoiceBargeIn');
    expect(liveConnection).toContain('LOCAL_BARGE_IN_PREROLL_GATE_MULTIPLIER');
    expect(audio).toContain('const candidateThreshold = typeof getLocalBargeInCandidateThreshold');
    expect(audio).toContain('const micAboveCandidateThreshold = micLevel >= candidateThreshold');
    expect(audio).toContain('if (activeWorkForBargeIn && micAboveCandidateThreshold)');
    expect(audio).toContain('echoProtected: playbackActiveForBargeIn ? micAboveThreshold : true');
    expect(audio).toContain('resetLocalBargeInDetection({');
    expect(audio).toContain('preservePreroll: activeWorkForBargeIn');
    // Pre-roll is buffered only when there is something to buffer; the branch no longer early-returns
    // (it falls through to stream silence) so a stuck barge-in gate can't wedge the server VAD.
    expect(audio).toContain('if (activeWorkForBargeIn && shouldBufferLocalBargeInAudio) {');
    expect(audio).toContain('queueLocalBargeInPrerollChunk(this.base64ArrayBuffer(bufferedPcm16.buffer))');
    expect(audio).toContain('const prerollChunks = consumeLocalBargeInPrerollChunks()');
    expect(audio.indexOf('for (const chunk of prerollChunks)')).toBeLessThan(audio.indexOf('this.onAudioChunk(base64);'));
    expect(liveConnection).toContain('manualInterrupt({ sendToServer: false, preserveLocalBargeIn: true })');
    expect(audio.indexOf('this.onAudioChunk(base64);')).toBeLessThan(audio.indexOf("sendServerInterruptSignal('local barge-in after mic pre-roll')"));
  });

  it('starts barge-in timing on soft candidate speech but requires echo-protected confirmation before cutting', () => {
    let now = 10000;
    const interrupts = [];
    const context = {
      localBargeInActive: false,
      localBargeInSpeechFrames: 0,
      localBargeInDynamicFrames: 0,
      localBargeInStartedAt: 0,
      lastLocalBargeInTime: 0,
      LOCAL_BARGE_IN_REQUIRED_FRAMES: 4,
      LOCAL_BARGE_IN_DYNAMIC_CONFIRM_FRAMES: 2,
      LOCAL_BARGE_IN_MIN_SPEECH_MS: 260,
      LOCAL_BARGE_IN_MIN_INTERVAL_MS: 900,
      MIN_PLAYBACK_BARGE_IN_GATE_MULTIPLIER: 0.18,
      LOCAL_BARGE_IN_PREROLL_GATE_MULTIPLIER: 0.05,
      MIC_LEVEL_THRESHOLD: 0.025,
      isPlaybackActiveForBargeIn: () => true,
      activeLiveBackendCommandIds: new Set(),
      activeLiveToolCallEpochs: new Map(),
      currentLiveToolAbortSignal: null,
      toolResponseFollowupPending: false,
      currentVisualizerState: 'speaking',
      manualInterrupt: options => interrupts.push(options),
      Date: { now: () => now }
    };
    const {
      getDynamicMicThreshold,
      getLocalBargeInCandidateThreshold,
      maybeTriggerLocalBargeIn
    } = loadFunctions([
      ['05-live-connection.js', [
        'getDynamicMicThreshold',
        'getLocalBargeInCandidateThreshold',
        'isLiveWorkActiveForVoiceBargeIn',
        'maybeTriggerLocalBargeIn'
      ]]
    ], context);

    expect(getLocalBargeInCandidateThreshold(0.5)).toBeLessThan(getDynamicMicThreshold(0.5, { protectPlayback: true }));

    for (let i = 0; i < 3; i++) {
      expect(maybeTriggerLocalBargeIn(0.05, 0.11, { echoProtected: false })).toBe(false);
      now += 100;
    }
    expect(maybeTriggerLocalBargeIn(0.12, 0.11, { echoProtected: true })).toBe(false);
    now += 100;
    expect(maybeTriggerLocalBargeIn(0.12, 0.11, { echoProtected: true })).toBe(true);
    expect(interrupts).toEqual([{ sendToServer: false, preserveLocalBargeIn: true }]);
  });

  it('preserves the in-progress user correction transcript during local barge-in cleanup', () => {
    const stopped = [];
    const states = [];
    const transcriptClears = [];
    const context = {
      isConnected: true,
      pendingBargeInTimer: 'timer',
      pendingBargeInMicLevel: 0.2,
      clearTimeout: () => {},
      cancelActiveSmartConsult: () => {},
      cancelLiveBackendCommands: () => {},
      cancelWorkspaceBackendRequests: () => {},
      resetLocalBargeInDetection: () => {},
      suppressInterruptedTurnAudio: false,
      interruptedUserSpeechConfirmed: false,
      currentAITranscript: '',
      currentUserTranscript: 'no wait, I meant the other window',
      document: {
        querySelector: selector => {
          transcriptClears.push(selector);
          return { classList: { remove: () => {} } };
        }
      },
      isPlaybackActiveForBargeIn: () => true,
      activeLiveBackendCommandIds: new Set(),
      activeLiveToolCallEpochs: new Map(),
      currentLiveToolAbortSignal: null,
      toolResponseFollowupPending: false,
      turnInProgress: true,
      currentVisualizerState: 'speaking',
      invalidateLiveToolOperations: () => {},
      sendServerInterruptSignal: () => true,
      audioPlayer: { stop: () => stopped.push('stop'), reset: () => {} },
      markTurnInterrupting: () => {},
      clearSystemNoticeInFlight: () => {},
      setVisualizerState: state => states.push(state),
      btnInterrupt: { classList: { add: () => {}, remove: () => {} } },
      scheduleInterruptedTurnFallback: () => {},
      aiTranscriptFinalized: false,
      lastAITurnCompleteTime: 0,
      lastVoiceInterruptTime: 0,
      Date
    };
    const { isTurnActiveForManualInterrupt, manualInterrupt } = loadFunctions([
      ['05-live-connection.js', [
        'isPlaybackActiveForBargeIn',
        'isLiveWorkActiveForVoiceBargeIn',
        'isTurnActiveForManualInterrupt',
        'manualInterrupt'
      ]]
    ], context);

    expect(isTurnActiveForManualInterrupt()).toBe(true);
    manualInterrupt({ sendToServer: true, preserveLocalBargeIn: true });

    expect(transcriptClears).toEqual([]);
    expect(stopped).toEqual(['stop']);
    expect(states).toContain('interrupting');
  });

  it('treats server interrupted events as acknowledgements after a local cut', () => {
    let manualInterrupts = 0;
    let resetCalls = 0;
    const context = {
      suppressInterruptedTurnAudio: true,
      serverInterruptPending: true,
      serverInterruptReason: 'local barge-in after mic pre-roll',
      localBargeInActive: true,
      interruptedUserSpeechConfirmed: false,
      currentAITranscript: '',
      currentVisualizerState: 'interrupting',
      audioPlayer: { activeSources: [], getVolume: () => 0 },
      resetLocalBargeInDetection: () => { resetCalls += 1; },
      manualInterrupt: () => { manualInterrupts += 1; }
    };
    const { handleServerInterruptedEvent, isLocalBargeInServerInterruptPending } = loadFunctions([
      ['05-live-connection.js', [
        'clearServerInterruptPending',
        'isLocalBargeInServerInterruptPending',
        'handleServerInterruptedEvent'
      ]]
    ], context);

    expect(handleServerInterruptedEvent(0)).toBe(true);
    expect(isLocalBargeInServerInterruptPending()).toBe(false);
    expect(manualInterrupts).toBe(0);
    expect(resetCalls).toBe(0);
  });

  it('defers reconnect fallback while local barge-in audio is still recent', () => {
    const context = {
      serverInterruptPending: true,
      serverInterruptReason: 'local barge-in after mic pre-roll',
      suppressInterruptedTurnAudio: true,
      localBargeInActive: true,
      interruptedUserSpeechConfirmed: false,
      lastUserAudioDetectedTime: 9000,
      interruptedAudioHoldStartedAt: 9400,
      INTERRUPTED_USER_AUDIO_SETTLE_MS: 900,
      INTERRUPTED_USER_AUDIO_MAX_HOLD_MS: 2500
    };
    const { shouldDeferServerInterruptFallbackForUserAudio, shouldHoldInterruptedAudioForUserSpeech } = loadFunctions([
      ['05-live-connection.js', [
        'isLocalBargeInServerInterruptPending',
        'shouldHoldInterruptedAudioForUserSpeech',
        'shouldDeferServerInterruptFallbackForUserAudio'
      ]]
    ], context);

    expect(shouldHoldInterruptedAudioForUserSpeech(9800)).toBe(true);
    expect(shouldHoldInterruptedAudioForUserSpeech(12000)).toBe(false);
    expect(shouldDeferServerInterruptFallbackForUserAudio(9800)).toBe(true);
    expect(shouldDeferServerInterruptFallbackForUserAudio(12000)).toBe(false);

    const manualContext = {
      ...context,
      serverInterruptReason: 'manual'
    };
    const manual = loadFunctions([
      ['05-live-connection.js', [
        'isLocalBargeInServerInterruptPending',
        'shouldHoldInterruptedAudioForUserSpeech',
        'shouldDeferServerInterruptFallbackForUserAudio'
      ]]
    ], manualContext);
    expect(manual.shouldDeferServerInterruptFallbackForUserAudio(10000)).toBe(false);
  });
});

describe('voice audio flow simulation', () => {
  it('resets stale idle playback scheduling before the next spoken turn', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '04-audio.js'), 'utf8');
    const startedSources = [];
    class FakeAudioContext {
      constructor() {
        this.currentTime = 10;
        this.state = 'running';
        this.destination = {};
      }
      createGain() { return { connect: () => {} }; }
      createAnalyser() {
        return {
          fftSize: 0,
          frequencyBinCount: 0,
          connect: () => {},
          getByteFrequencyData: () => {}
        };
      }
      createBuffer(_channels, length, sampleRate) {
        return {
          duration: length / sampleRate,
          copyToChannel: () => {}
        };
      }
      createBufferSource() {
        const sourceNode = {
          connect: () => {},
          start: time => { this.lastStartTime = time; },
          stop: () => {},
          onended: null
        };
        startedSources.push(sourceNode);
        return sourceNode;
      }
      resume() {}
      close() {}
    }
    const context = vm.createContext({
      console,
      window: { AudioContext: FakeAudioContext },
      atob: value => Buffer.from(value, 'base64').toString('binary'),
      Uint8Array,
      Int16Array,
      Float32Array,
      Date,
      turnInProgress: false,
      currentVisualizerState: 'listening',
      setVisualizerState: () => {}
    });
    vm.runInContext(`${source}\nresult = { AudioPlayer };`, context);
    const player = new context.result.AudioPlayer();
    player.nextPlayTime = 1;
    player.underrunCount = 3;
    player.lastUnderrunLogAt = 123;

    player.reset();

    expect(player.nextPlayTime).toBe(0);
    expect(player.underrunCount).toBe(0);
    expect(player.lastUnderrunLogAt).toBe(0);

    const pcm = Buffer.from(new Int16Array([0, 2000, -2000, 0]).buffer).toString('base64');
    player.playChunk(pcm);
    expect(player.audioContext.lastStartTime).toBeCloseTo(10.14, 2);
    expect(player.underrunCount).toBe(0);

    player.nextPlayTime = 4;
    player.underrunCount = 2;
    player.lastUnderrunLogAt = 456;
    startedSources[0].onended();
    expect(player.activeSources).toEqual([]);
    expect(player.nextPlayTime).toBe(0);
    expect(player.underrunCount).toBe(0);
    expect(player.lastUnderrunLogAt).toBe(0);
  });

  it('marks a stalled spoken turn as thinking and keeps waiting without a server interrupt', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '04-audio.js'), 'utf8');
    const startedSources = [];
    const scheduledDelays = [];
    const scheduledCallbacks = [];
    let recoveredTurns = 0;
    let softStalls = 0;
    class FakeAudioContext {
      constructor() {
        this.currentTime = 20;
        this.state = 'running';
        this.destination = {};
      }
      createGain() { return { connect: () => {} }; }
      createAnalyser() {
        return {
          fftSize: 0,
          frequencyBinCount: 0,
          connect: () => {},
          getByteFrequencyData: () => {}
        };
      }
      createBuffer(_channels, length, sampleRate) {
        return {
          duration: length / sampleRate,
          copyToChannel: () => {}
        };
      }
      createBufferSource() {
        const sourceNode = {
          connect: () => {},
          start: time => { this.lastStartTime = time; },
          stop: () => {},
          onended: null
        };
        startedSources.push(sourceNode);
        return sourceNode;
      }
      resume() {}
      close() {}
    }
    const context = vm.createContext({
      console,
      window: { AudioContext: FakeAudioContext },
      atob: value => Buffer.from(value, 'base64').toString('binary'),
      Uint8Array,
      Int16Array,
      Float32Array,
      Date,
      setTimeout: (callback, delay) => {
        scheduledCallbacks.push(callback);
        scheduledDelays.push(delay);
        return `stall-timer-${scheduledCallbacks.length}`;
      },
      clearTimeout: () => {},
      turnInProgress: true,
      currentVisualizerState: 'speaking',
      setVisualizerState: () => {},
      handleOutputAudioSoftStall: () => { softStalls += 1; },
      handleOutputAudioRecoveryStall: () => { recoveredTurns += 1; }
    });
    vm.runInContext(`${source}\nresult = { AudioPlayer };`, context);
    const player = new context.result.AudioPlayer();
    const pcm = Buffer.from(new Int16Array([0, 1000, -1000, 0]).buffer).toString('base64');

    player.playChunk(pcm);
    startedSources[0].onended();

    expect(scheduledDelays[0]).toBe(2200);
    expect(typeof scheduledCallbacks[0]).toBe('function');
    scheduledCallbacks[0]();
    expect(softStalls).toBe(1);
    expect(recoveredTurns).toBe(0);
    expect(scheduledDelays[1]).toBe(5800);
    scheduledCallbacks[1]();
    expect(recoveredTurns).toBe(1);
  });

  it('recovers silent output by waiting in thinking state instead of interrupting the Live turn', () => {
    const states = [];
    const interrupts = [];
    const stopped = [];
    const context = {
      OUTPUT_AUDIO_STALL_RECOVERY_MS: 8000,
      isConnected: true,
      suppressInterruptedTurnAudio: false,
      turnInProgress: true,
      currentVisualizerState: 'speaking',
      setVisualizerState: state => {
        states.push(state);
        context.currentVisualizerState = state;
      },
      sendServerInterruptSignal: reason => interrupts.push(reason),
      audioPlayer: { stop: () => stopped.push('stop') },
      Date
    };
    const { handleOutputAudioRecoveryStall } = loadFunctions([
      ['05-live-connection.js', [
        'isOutputAudioStallWatchdogState',
        'handleOutputAudioRecoveryStall'
      ]]
    ], context);

    expect(handleOutputAudioRecoveryStall()).toBe(true);
    expect(states).toEqual(['thinking']);
    expect(context.suppressInterruptedTurnAudio).toBe(false);
    expect(interrupts).toEqual([]);
    expect(stopped).toEqual([]);
  });

  it('clears stale output stall timers even when queued audio is still ending', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '04-audio.js'), 'utf8');
    let clearedTimer = null;
    const context = vm.createContext({
      console,
      window: { AudioContext: class {} },
      clearTimeout: timer => { clearedTimer = timer; },
      turnInProgress: false,
      currentVisualizerState: 'listening'
    });
    vm.runInContext(`${source}\nresult = { AudioPlayer };`, context);
    const player = new context.result.AudioPlayer();
    player.outputStallTimer = 'stale-stall';
    player.activeSources = [{ node: { stop: () => {} } }];

    player.reset();

    expect(clearedTimer).toBe('stale-stall');
    expect(player.outputStallTimer).toBeNull();
  });
});

describe('Live prompt stability', () => {
  it('compiles Live setup instructions from prioritized sections below the normal target', async () => {
    const {
      getLiveBaseSystemInstruction,
      getCompiledSystemInstruction
    } = loadFunctions([
      ['08-memory.js', [
        'truncateTextToChars',
        'getLiveBaseSystemInstruction',
        'appendCompiledInstructionSection',
        'getCompiledSystemInstruction'
      ]]
    ], {
      MAX_COMPILED_SYSTEM_INSTRUCTION_CHARS: 22000,
      TARGET_COMPILED_SYSTEM_INSTRUCTION_CHARS: 16000,
      LIVE_BASE_SYSTEM_INSTRUCTION_BUDGET_CHARS: 9500,
      SYSTEM_INSTRUCTION_TRUNCATION_NOTICE: '\n\n[SYSTEM: Optional context was shortened to fit the Live session setup limit.]',
      CRITICAL_PREFERENCE_PROMPT_BUDGET_CHARS: 900,
      MEMORY_PROMPT_BUDGET_CHARS: 1400,
      SKILLS_PROMPT_BUDGET_CHARS: 700,
      RECENT_HISTORY_PROMPT_BUDGET_CHARS: 800,
      LIVE_OPTIONAL_SECTION_MIN_CHARS: 220,
      COMPACT_LIVE_BASE_SYSTEM_INSTRUCTION: 'Compact realtime base instruction.\n'.repeat(120),
      systemInstruction: `${'Verbose base. '.repeat(2200)}\n\nSCHEDULED TASKS & REMINDERS\n${'example '.repeat(1000)}`,
      getAssistantName: () => 'Nova',
      getProactiveConfig: () => ({ label: 'Balanced', description: 'normal cadence' }),
      proactiveEnabled: true,
      smartMainRoutingEnabled: true,
      accent: 'neutral',
      ACCENT_DESCRIPTIONS: {},
      localStorage: { getItem: () => 'false' },
      loadMemoryGraph: async () => ({ nodes: [] }),
      buildCriticalPreferenceSummaryText: () => '',
      buildMemorySummaryText: () => `\n\n=== LONG MEMORY ===\n${'memory '.repeat(900)}`,
      buildUpcomingCalendarPromptSnapshot: async () => `\n\n=== CALENDAR ===\n${'calendar '.repeat(500)}`,
      getSkillsText: async () => `\n\n=== SKILLS ===\n${'skill '.repeat(600)}`,
      activeSubagents: [{
        id: 'subagent_1',
        status: 'running',
        task: 'Research a long thing'.repeat(40),
        startedAt: new Date().toISOString(),
        step: 12,
        failedToolCount: 0,
        lastMessage: 'Searching'.repeat(40)
      }],
      buildRecentConversationHistoryText: () => `\n\n=== RECENT ===\n${'dialogue '.repeat(600)}`
    });

    expect(getLiveBaseSystemInstruction('x'.repeat(12000))).toContain('Compact realtime base instruction');
    const compiled = await getCompiledSystemInstruction();
    // Other sections stay within the 16k target; recent dialogue (the reconnect safety net) gets up to
    // its 3k budget of dedicated headroom on top, so the compiled prompt stays <= 19k (under the 22k cap).
    expect(compiled.length).toBeLessThanOrEqual(19000);
    expect(compiled).toContain('Compact realtime base instruction');
    expect(compiled).toContain('ASSISTANT NAME');
    expect(compiled).toContain('WEB SEARCH');
  });

  it('prioritizes durable preferences and makes symbolic unit memories searchable', () => {
    const {
      buildCriticalPreferenceSummaryText,
      buildRelevantUnitPreferenceContext,
      buildMemorySummaryText,
      memoryRecallTokens,
      scoreMemoryForQuery
    } = loadFunctions([
      ['08-memory.js', [
        'truncateTextToChars',
        'getMemoryPriority',
        'isUserPreferenceMemoryNode',
        'getPreferencePromptPriority',
        'orderMemoryNodesForPrompt',
        'orderMemoryNodesByImportance',
        'buildCriticalPreferenceSummaryText',
        'getUnitPreferenceDomainsForText',
        'getUnitPreferenceDomainsForNode',
        'getRelevantUnitPreferenceNodes',
        'buildRelevantUnitPreferenceContext',
        'buildMemorySummaryText',
        'normalizeMemorySearchText',
        'memoryRecallTokens',
        'scoreMemoryForQuery'
      ]]
    ], {
      CRITICAL_PREFERENCE_PROMPT_BUDGET_CHARS: 900,
      MEMORY_PROMPT_BUDGET_CHARS: 1400,
      getAssistantName: () => 'Nova',
      formatMemoryNodeLine: node => `[id="${node.id}"] ${node.label} (${node.type}): ${node.description}`
    });
    const graph = {
      nodes: [
        { id: 'user_fact_gpu', label: 'GPU', type: 'fact', description: 'Dylan owns a GPU.' },
        { id: 'user_prefers_coffee', label: 'Coffee Preference', type: 'preference', description: 'Dylan prefers coffee.' },
        { id: 'user_prefers_speed_units', label: 'Speed Unit Preference', type: 'preference', description: 'Dylan prefers kilometers per hour instead of miles per hour for speed units.' },
        { id: 'user_project_shadow', label: 'Shadow Project', type: 'interest', description: 'Dylan works on Shadow AI.' }
      ]
    };

    const summary = buildMemorySummaryText(graph, 4, 1400);
    expect(summary).toContain('Apply preference memories automatically whenever relevant');
    // The general memory summary leads with important FACTS (promises, identity, etc.);
    // preferences have their own dedicated sections, so they rank after facts here.
    expect(summary.indexOf('GPU')).toBeLessThan(summary.indexOf('Coffee Preference'));
    expect(summary.indexOf('Shadow Project')).toBeLessThan(summary.indexOf('Speed Unit Preference'));
    expect(summary).toContain('Speed Unit Preference');

    const critical = buildCriticalPreferenceSummaryText(graph, 900);
    expect(critical).toContain('override language/locale defaults');
    expect(critical).toContain('Speed Unit Preference');
    expect(critical).not.toContain('Coffee Preference');

    const turnContext = buildRelevantUnitPreferenceContext(graph, 'what is the wind speed right now?');
    // The query is never mutated with unit words (that polluted weather searches and
    // returned wrong values); the preference is delivered as a convert-in-answer instruction.
    expect(turnContext.searchSuffix).toBeUndefined();
    expect(turnContext.instruction).toContain('conversion math');
    expect(turnContext.instruction).toContain('Speed Unit Preference');
    expect(turnContext.instruction).not.toContain('Coffee Preference');

    const tokens = memoryRecallTokens('do you have any memories related to km/h?');
    expect(tokens).toContain('kmh');
    expect(tokens).toContain('speed');
    const speedPreference = graph.nodes.find(node => node.id === 'user_prefers_speed_units');
    expect(scoreMemoryForQuery(speedPreference, tokens)).toBeGreaterThan(scoreMemoryForQuery(graph.nodes[0], tokens));
  });

  it('rejects second-person / assistant-referential auto-memory candidates', () => {
    const { isAssistantReferentialMemoryValue } = loadFunctions([
      ['08-memory.js', ['isAssistantReferentialMemoryValue']]
    ], {
      getAssistantName: () => 'Nova'
    });

    // Conversational complaints aimed at the assistant must NOT be saved as user facts.
    expect(isAssistantReferentialMemoryValue('you have broken memories that yeah')).toBe(true);
    expect(isAssistantReferentialMemoryValue('your voice is annoying')).toBe(true);
    expect(isAssistantReferentialMemoryValue('Nova keeps forgetting things')).toBe(true);
    expect(isAssistantReferentialMemoryValue('Shadow is too slow')).toBe(true);

    // Genuine first-person user facts/preferences must pass through.
    expect(isAssistantReferentialMemoryValue('kilometers per hour instead of miles per hour')).toBe(false);
    expect(isAssistantReferentialMemoryValue('coffee with no sugar')).toBe(false);
    expect(isAssistantReferentialMemoryValue('lives in Oss, Netherlands')).toBe(false);
  });

  it('always surfaces loosely-worded unit preferences even when crowded by behavioral ones', () => {
    const {
      getPreferencePromptPriority,
      buildUnitPreferenceDirective,
      buildRelevantUnitPreferenceContext
    } = loadFunctions([
      ['08-memory.js', [
        'truncateTextToChars',
        'getMemoryPriority',
        'isUserPreferenceMemoryNode',
        'getUnitPreferenceDomainsForNode',
        'getPreferencePromptPriority',
        'orderMemoryNodesForPrompt',
        'getUnitPreferenceDomainsForText',
        'getRelevantUnitPreferenceNodes',
        'getUnitPreferenceNodes',
        'buildUnitPreferenceDirective',
        'buildRelevantUnitPreferenceContext',
        'normalizeMemorySearchText'
      ]]
    ], {
      UNIT_PREFERENCE_PROMPT_BUDGET_CHARS: 1400,
      formatMemoryNodeLine: node => `[id="${node.id}"] ${node.label} (${node.type}): ${node.description}`
    });

    // Phrased loosely: "temperatures" (plural) and the unit name "Celsius" — neither
    // matched the old keyword list, so this dropped to priority 3 and never reached the prompt.
    const celsius = {
      id: 'user_prefers_celsius',
      label: 'Celsius Preference',
      type: 'preference',
      description: 'Dylan prefers/likes Celsius when we are talking about temperatures opposed to Fahrenheit.'
    };
    const graph = {
      nodes: [
        celsius,
        { id: 'b1', label: 'Realness', type: 'preference', description: 'Always be real and never sugarcoat things.' },
        { id: 'b2', label: 'Banter', type: 'preference', description: 'Always fight back in banter, never back down.' },
        { id: 'b3', label: 'Assumptions', type: 'preference', description: 'Never make assumptions about tasks.' }
      ]
    };

    expect(getPreferencePromptPriority(celsius)).toBeLessThanOrEqual(1);

    const directive = buildUnitPreferenceDirective(graph);
    expect(directive).toContain('Celsius Preference');
    expect(directive).toContain('ALWAYS ENFORCE');
    expect(directive).not.toContain('Realness');

    const turnContext = buildRelevantUnitPreferenceContext(graph, "what's the temperature outside right now?");
    expect(turnContext.instruction).toContain('Celsius Preference');
    expect(turnContext.instruction).toContain('read the real, current value');
  });
});

describe('diagnostics panel evidence', () => {
  it('shows latest subagent evidence and timeline without pending notices', () => {
    const textNodes = {
      turn: { textContent: '' },
      socket: { textContent: '' },
      queue: { textContent: '' },
      next: { textContent: '' },
      subagents: { textContent: '' },
      lastTool: { textContent: '' },
      reason: { textContent: '' }
    };
    const context = {
      diagnosticsPanel: { classList: { contains: () => false } },
      diagTurnState: textNodes.turn,
      diagSocketState: textNodes.socket,
      diagNoticeQueue: textNodes.queue,
      diagNextNotice: textNodes.next,
      diagSubagents: textNodes.subagents,
      diagLastTool: textNodes.lastTool,
      diagNoticeReason: textNodes.reason,
      pendingNotifications: [],
      activeSubagents: [{
        lastToolName: 'web_search',
        lastToolStatus: 'success',
        timeline: [{ type: 'tool_success', detail: 'web_search: 4 result(s)' }]
      }],
      shadowTurnState: { phase: 'idle', reason: 'test' },
      currentVisualizerState: 'listening',
      socket: null,
      getActiveSubagentDisplayCount: () => 1,
      getSubagentEvidenceSummary: () => 'web_search: 4 result(s)',
      getPendingNotificationBlockReason: () => 'none'
    };
    const { updateDiagnosticsPanel } = loadFunctions([
      ['01-state-dom.js', [
        'normalizeNotificationLane',
        'getSocketDiagnosticState',
        'getNextPendingNotification',
        'updateDiagnosticsPanel'
      ]]
    ], context);

    updateDiagnosticsPanel();

    expect(textNodes.subagents.textContent).toBe('1 active / 1 total');
    expect(textNodes.lastTool.textContent).toContain('web_search:success');
    expect(textNodes.lastTool.textContent).toContain('web_search: 4 result(s)');
    expect(textNodes.reason.textContent).toContain('Latest subagent event: tool_success');
  });
});

describe('deterministic subagent supervisor', () => {
  it('assesses failed tools and stalls without model polling', () => {
    const now = Date.now();
    const context = {
      SUBAGENT_STALL_MS: 120000,
      SUBAGENT_LONG_TOOL_STALL_MS: 600000,
      isSubagentCancelled: record => Boolean(record.cancelRequested || record.status === 'cancelled')
    };
    const { getSubagentSupervisorAssessment } = loadFunctions([
      ['09-subagents-core.js', [
        'isSubagentInterrupted',
        'getSubagentProgressSignature',
        'refreshSubagentProgressState',
        'getSubagentSupervisorAssessment'
      ]]
    ], context);

    const failed = {
      status: 'running',
      step: 4,
      lastMessage: 'Tool failed',
      failedToolCount: 2,
      lastProgressAt: now
    };
    expect(getSubagentSupervisorAssessment(failed, now).reason).toBe('2 failed tool calls');

    const stalled = {
      status: 'running',
      step: 1,
      lastMessage: 'Waiting',
      failedToolCount: 0,
      supervisorLastSignature: 'running|1|Waiting|||||',
      lastProgressAt: now - 130000
    };
    expect(getSubagentSupervisorAssessment(stalled, now).reason).toContain('no progress');

    const longTool = {
      status: 'running',
      step: 2,
      lastMessage: 'Executing tool: run_powershell_command',
      failedToolCount: 0,
      supervisorLastSignature: 'running|2|Executing tool: run_powershell_command|||||',
      lastProgressAt: now - 130000
    };
    expect(getSubagentSupervisorAssessment(longTool, now)).toBeNull();
  });

  it('fails and cleans up subagents after repeated supervisor recovery attempts', () => {
    const now = Date.now();
    const events = [];
    const messages = [];
    const notices = [];
    const failures = [];
    const cancelledRuns = [];
    const cancelledRequests = [];
    const aborted = [];
    const record = {
      id: 'subagent_supervisor',
      task: 'long flaky task',
      status: 'running',
      step: 9,
      lastMessage: 'Tool failed',
      failedToolCount: 2,
      supervisorActionCount: 3,
      lastSupervisorNoticeAt: 0,
      lastProgressAt: now,
      activeCommandIds: ['cmd_1'],
      activeRequestIds: ['req_1'],
      abortController: { abort: () => aborted.push('aborted') }
    };
    const context = {
      activeSubagents: [record],
      SUBAGENT_STALL_MS: 120000,
      SUBAGENT_LONG_TOOL_STALL_MS: 600000,
      SUBAGENT_SUPERVISOR_NOTICE_COOLDOWN_MS: 90000,
      SUBAGENT_SUPERVISOR_MAX_RECOVERIES: 3,
      isSubagentCancelled: item => Boolean(item.cancelRequested || item.status === 'cancelled'),
      cancelSubagentBackendRuns: item => cancelledRuns.push(item.id),
      cancelSubagentBackendRequests: (item, reason) => cancelledRequests.push({ id: item.id, reason }),
      failSubagentRecord: (item, reason) => {
        item.status = 'failed';
        item.lastError = reason;
      },
      appendSubagentTimelineEvent: (item, type, detail) => events.push({ id: item.id, type, detail }),
      addSubagentMessage: message => messages.push(message),
      notifyModelOfSubagentUpdate: notice => notices.push(notice),
      notifyVoiceSessionOfFailure: (...args) => failures.push(args),
      updateDiagnosticsPanel: () => {}
    };
    const { runSubagentSupervisorPass } = loadFunctions([
      ['09-subagents-core.js', [
        'isSubagentInterrupted',
        'getSubagentProgressSignature',
        'refreshSubagentProgressState',
        'getSubagentSupervisorAssessment',
        'runSubagentSupervisorPass'
      ]]
    ], context);

    const actions = runSubagentSupervisorPass(now);

    expect(record.status).toBe('failed');
    expect(record.lastError).toContain('Supervisor stopped repeated recovery after 3 corrective attempts');
    expect(cancelledRuns).toEqual(['subagent_supervisor']);
    expect(cancelledRequests[0].reason).toContain('2 failed tool calls');
    expect(aborted).toEqual(['aborted']);
    expect(events).toContainEqual({ id: 'subagent_supervisor', type: 'supervisor_failed', detail: '2 failed tool calls' });
    expect(messages[0]).toContain('failed after repeated recovery attempts');
    expect(notices[0]).toContain('[SUBAGENT SUPERVISOR]');
    expect(failures[0][1]).toContain('Supervisor stopped repeated recovery');
    expect(actions).toEqual([{ subagentId: 'subagent_supervisor', reason: '2 failed tool calls', status: 'failed' }]);
  });

  it('uses a long hard subagent cap with an earlier loop checkpoint instead of a short hidden task timeout', () => {
    const stateDom = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const runner = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
    const { getSubagentTimeoutAssessment } = loadFunctions([
      ['11-subagents-runner.js', ['getSubagentTimeoutAssessment']]
    ], {
      SUBAGENT_TASK_HARD_TIMEOUT_MS: 6 * 60 * 60 * 1000
    });
    const now = Date.now();

    expect(stateDom).toContain('const SUBAGENT_TASK_HARD_TIMEOUT_MS = 6 * 60 * 60 * 1000');
    expect(stateDom).toContain('const SUBAGENT_MAX_LOOPS = 1000');
    expect(stateDom).toContain('const SUBAGENT_LOOP_WARNING_THRESHOLD = 300');
    expect(stateDom).toContain('const SUBAGENT_SUPERVISOR_MAX_RECOVERIES = 3');
    expect(runner).not.toContain('const maxLoops = 300');
    expect(runner).toContain('Loop checkpoint reached at');
    expect(getSubagentTimeoutAssessment({ startedAt: new Date(now - 61 * 60 * 1000).toISOString() }, now)).toBeNull();
    expect(getSubagentTimeoutAssessment({ startedAt: new Date(now - 7 * 60 * 60 * 1000).toISOString() }, now)).toMatchObject({
      timedOut: true,
      kind: 'hard'
    });
  });

  it('routes blocked and unknown tool results into subagent failure tracking', () => {
    const runner = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
    const core = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '09-subagents-core.js'), 'utf8');

    expect(core).toContain('function isSubagentToolFailureStatus');
    expect(core).toContain("'blocked'");
    expect(core).toContain("status === 'unknown'");
    expect(runner).toContain('isSubagentToolFailureStatus(responseStatus, responseData)');
    expect(runner).not.toContain("if (responseStatus === 'error' || (responseData && responseData.error))");
  });
});

describe('backend command runner reliability', () => {
  it('uses server-side timeouts for /api/run and passes tool timeouts from clients', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const subagentRunner = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
    const memory = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '08-memory.js'), 'utf8');

    expect(launcher).toContain('function Invoke-ShadowCommandWithTimeout');
    expect(launcher).toContain('function Stop-ShadowProcessTree');
    expect(launcher).toContain('$proc.WaitForExit(250)');
    expect(launcher).toContain('Stop-ShadowRunProcessForCancellation -CommandId $CommandId -FallbackProcessId $proc.Id');
    expect(launcher).toContain('Get-ShadowRunTimeoutMilliseconds -JsonBody $json');
    expect(launcher).toContain('timedOut = $timedOut');
    expect(launcher).toContain('for ($i = 0; $i -lt 8; $i++)');
    expect(liveConnection).toContain('runLivePowerShellCommand(command, 25000, 25000');
    expect(liveConnection).toContain('timeout_ms: commandTimeoutMs');
    expect(liveConnection).toContain('timedOut: Boolean(json.timedOut)');
    expect(subagentRunner).toContain('runNormalizedSubagentPowerShellCommand(subagentRecord, execCmd, commandTimeoutMs');
    expect(subagentRunner).toContain('timedOut: Boolean(cmdJson.timedOut)');
    expect(memory).toContain('timeout_ms: 15000');
  });

  it('launches a bundled SearXNG only when present and degrades gracefully otherwise', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');
    const gitignore = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8');
    const prepare = fs.readFileSync(path.join(process.cwd(), 'tools', 'prepare-searxng.ps1'), 'utf8');

    // Gated on the bundled payload, so source checkouts are unaffected. Prefers the
    // installer's bundled Python, falling back to a dev venv.
    expect(launcher).toContain('$bundledPythonExe');
    expect(launcher).toContain('Join-Path $searxngHome "venv\\Scripts\\python.exe"');
    expect(launcher).toContain("Test-Path (Join-Path $searxngApp \"searx\\webapp.py\")");
    expect(launcher).toContain("Start-Process -FilePath $searxngPy -ArgumentList '-m', 'searx.webapp'");
    expect(launcher).toContain('$env:SEARXNG_SETTINGS_PATH = $searxngSettings');
    // JSON format enabled + limiter off in the generated settings.
    expect(launcher).toContain('formats:');
    expect(launcher).toContain('limiter: false');
    // Cleaned up on shutdown.
    expect(launcher).toContain('Stop-Process -Id $searxngProc.Id -Force');
    // Generated payload is ignored; prepare script applies the Windows workarounds.
    expect(gitignore).toContain('/searxng/');
    expect(prepare).toContain('import pwd  # POSIX-only');
    expect(prepare).toContain('sparse-checkout');
  });

  it('guards skill saving against junk and avoids duplicate-append bloat', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');

    // Quality guard rejects trivial/test/creative/date-stamped non-procedures.
    expect(launcher).toContain('$skillRejectReason');
    expect(launcher).toContain('too short to be a reusable multi-step procedure');
    expect(launcher).toContain('throwaway test');
    expect(launcher).toContain('creative content generation is a one-off');
    expect(launcher).toContain('status = "skipped"');
    // Merge is containment-aware (no endless --- Updated --- bloat on re-saves).
    expect(launcher).toContain('left unchanged.');
    expect(launcher).toMatch(/Contains\(\$normInstr\.ToLower\(\)\)/);
    // Tool description steers the model away from low-value saves.
    expect(liveConnection).toContain('DO NOT save: one-off tasks, trivial single commands');
  });

  it('exposes a skills manager UI backed by a GET list endpoint', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'index.html'), 'utf8');
    const bootUi = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '02-boot-ui.js'), 'utf8');

    // GET /api/skills/all lists skills with their instructions for the UI.
    expect(launcher).toContain('if ($request.HttpMethod -eq "GET") {');
    expect(launcher).toContain('instructions = [string]$content');
    expect(launcher).toContain('skills = @($list)');
    // Modal + open button exist.
    expect(indexHtml).toContain('id="skills-modal"');
    expect(indexHtml).toContain('id="btn-skills"');
    expect(indexHtml).toContain('id="btn-wipe-skills"');
    // Wiring: list render, per-skill delete, wipe-all. Instructions rendered as text (no innerHTML injection).
    expect(bootUi).toContain('/api/skills/all');
    expect(bootUi).toContain("body: JSON.stringify({ skill_name: name })");
    expect(bootUi).toContain('instr.textContent = String(skill.instructions');
  });

  it('ships no hardcoded developer infrastructure in src (public-release guard)', () => {
    const srcDir = path.join(process.cwd(), 'src');
    function walk(dir) {
      let files = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) files = files.concat(walk(full));
        else files.push(full);
      }
      return files;
    }
    const offenders = [];
    for (const file of walk(srcDir)) {
      const text = fs.readFileSync(file, 'utf8');
      // The developer's private infra must never be baked into shipped client code.
      if (/91\.98\.135\.72/.test(text) || /shadowdog\.cat/.test(text) || /SSH alias/i.test(text)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('credits shadowdog as the creator and fully wipes on factory reset', () => {
    const memory = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '08-memory.js'), 'utf8');
    const stateDom = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const bootUi = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '02-boot-ui.js'), 'utf8');
    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');

    // Creator attribution (allowed — it's not infra access).
    expect(memory).toContain('created by shadowdog');
    expect(stateDom).toContain('created by shadowdog');

    // Personal-use media downloads are explicitly permitted (no over-refusal/lecturing).
    expect(memory).toContain('Personal media and downloads');
    expect(stateDom).toContain('PERSONAL MEDIA & DOWNLOADS');

    // Vision: can see only while screen sharing — don't flatly claim blindness.
    expect(memory).toContain('only while screen sharing is active');
    expect(stateDom).toContain('only while screen sharing is active');

    // Voice filenames are fuzzy-matched; file ops verified before claiming failure.
    expect(memory).toContain('your FIRST move');
    expect(stateDom).toContain('your FIRST step');
    expect(memory).toContain('File-operation verification');
    expect(stateDom).toContain('FILE-OPERATION VERIFICATION');

    // Memory delete also matches description + fuzzy-scores (so users can remove a bad
    // memory by describing it), and disfluency filler is rejected from auto-save.
    expect(memory).toContain('n.description && n.description.toLowerCase().includes(idLower)');
    expect(memory).toContain("status: 'ambiguous'");
    expect(memory).toContain('function isDisfluentOrLowQualityMemoryValue');

    // "remember" saves immediately; weather forecasts route to get_weather; the scheduler
    // create-body schema is spelled out so the model stops guessing field names.
    expect(memory).toContain('Remembering on request');
    expect(memory).toContain('never "task" or "due"');

    // get_weather returns a daily forecast (run.ps1) and advertises it.
    expect(launcher).toContain('daily=weather_code,precipitation_probability_max');
    expect(launcher).toContain('forecast_summary');
    expect(launcher).toContain('thunderstorm_expected');

    // Command runner: suppress benign progress noise and treat a null/0 exit code as success
    // (Start-Process -PassThru can report a null ExitCode after a clean exit, which used to
    // make successful file ops like Set-Content/Remove-Item look like errors).
    expect(launcher).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(launcher).toContain('($null -eq $proc.ExitCode) -or ($proc.ExitCode -eq 0)');

    // Factory reset clears everything, not just memories/skills.
    expect(bootUi).toContain('localStorage.clear()');
    expect(bootUi).toContain("'/api/google/disconnect'");
    expect(bootUi).toContain("body: '{}'"); // resets server config (API keys + settings)
    expect(bootUi).toContain('location.reload()');

    // Skill guard rejects vague-intention names; SearXNG output is redirected to a log file.
    expect(launcher).toContain('reads as a vague intention');
    expect(launcher).toContain('RedirectStandardError $searxngErrLog');

    // Factory reset also logs out of OpenAI Codex.
    expect(bootUi).toContain("'/api/codex/logout'");
  });

  it('defaults Gemini subagents to 3.1 Flash Lite (best free limits), not 2.5 Pro', () => {
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'index.html'), 'utf8');
    const bootUi = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '02-boot-ui.js'), 'utf8');
    const subagentRunner = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');

    expect(indexHtml).not.toContain('models/gemini-2.5-pro');
    expect(indexHtml).toContain('<option value="models/gemini-3.1-flash-lite" selected>');
    expect(bootUi).toContain("subagentModel || 'models/gemini-3.1-flash-lite'");
    expect(subagentRunner).toContain("'models/gemini-3.1-flash-lite'");
  });

  it('prefers bundled runtimes and ships an installer build pipeline', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');
    const build = fs.readFileSync(path.join(process.cwd(), 'tools', 'build-installer.ps1'), 'utf8');
    const iss = fs.readFileSync(path.join(process.cwd(), 'installer', 'shadow-ai.iss'), 'utf8');

    // run.ps1 uses bundled node/python when the installer provides them, else PATH/venv.
    expect(launcher).toContain('runtime\\node\\node.exe');
    expect(launcher).toContain('$nodeCmd = if (Test-Path $bundledNodeExe)');
    expect(launcher).toContain('Start-Process -FilePath $nodeCmd -ArgumentList $schedulerPath');
    // Build script bundles relocatable Python (+ SearXNG reqs) and Node.
    expect(build).toContain('python-build-standalone');
    expect(build).toContain('install_only');
    expect(build).toContain('nodejs.org/dist/index.json');
    expect(build).toContain('pip install -r');
    // Installer: per-user, writable location (not Program Files), Windows-only.
    expect(iss).toContain('PrivilegesRequired=lowest');
    expect(iss).toContain('{localappdata}\\Programs\\ShadowAI');
    expect(iss).toContain('OutputBaseFilename=ShadowAI-Setup');
  });

  it('cancels backend command processes when subagents are cancelled', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');
    const core = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '09-subagents-core.js'), 'utf8');
    const subagentRunner = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');

    expect(launcher).toContain('function Request-ShadowRunCancellation');
    expect(launcher).toContain('function Set-ShadowRunProcessMarker');
    expect(launcher).toContain('function Stop-ShadowRunProcessForCancellation');
    expect(launcher).toContain('if ($urlPath -eq "/api/run/cancel")');
    expect(launcher).toContain('Get-ShadowRunCancelPath $CommandId');
    expect(launcher).toContain('Test-Path -LiteralPath $cancelPath -PathType Leaf');
    expect(launcher).toContain('Set-ShadowRunProcessMarker -CommandId $CommandId -Process $proc');
    expect(launcher).toContain('Stop-ShadowRunProcessForCancellation -CommandId $CommandId -FallbackProcessId $proc.Id');
    expect(launcher).toContain('Wait-ShadowProcessExit -Process $proc');
    expect(launcher).toContain('if ($cancelPath -and (Test-Path -LiteralPath $cancelPath -PathType Leaf))');
    expect(launcher).toContain('process_killed = [bool]$processKilled');
    expect(launcher).toContain('Clear-ShadowRunCancellation $CommandId');
    expect(launcher).toContain('$staleCancelCutoff = [DateTime]::UtcNow.AddHours(-12)');
    expect(launcher).toContain('Where-Object { ($_.Name -like "*.cancel" -or $_.Name -like "*.pid") -and $_.LastWriteTimeUtc -lt $staleCancelCutoff }');
    expect(launcher).toContain('status = "cancelled"');
    expect(launcher).toContain('cancelled = $cancelled');
    expect(core).toContain('activeCommandIds: []');
    expect(core).toContain('function cancelShadowBackendCommand');
    expect(core).toContain('function cancelSubagentBackendRuns');
    expect(core).toContain("fetchLocalApiWithTimeout('/api/run/cancel'");
    expect(core).toContain('cancelSubagentBackendRuns(subagentRecord, reason)');
    expect(subagentRunner).toContain('function runSubagentPowerShellCommand');
    expect(subagentRunner).toContain('command_id: commandId');
    expect(subagentRunner).toContain('trackSubagentBackendCommand(subagentRecord, commandId)');
    expect(subagentRunner).toContain('await cancelShadowBackendCommand(commandId, reason)');
    expect(subagentRunner).toContain('untrackSubagentBackendCommand(subagentRecord, commandId)');
  });

  it('cancels subagent backend commands when the frontend request aborts or times out', async () => {
    const calls = [];
    const record = { activeCommandIds: [] };
    const { runSubagentPowerShellCommand } = loadFunctions([
      ['11-subagents-runner.js', ['runSubagentPowerShellCommand']]
    ], {
      createSubagentBackendCommandId: () => 'cmd_timeout',
      trackSubagentBackendCommand: (item, commandId) => {
        calls.push(['track', commandId]);
        item.activeCommandIds.push(commandId);
      },
      untrackSubagentBackendCommand: (item, commandId) => {
        calls.push(['untrack', commandId]);
        item.activeCommandIds = item.activeCommandIds.filter(id => id !== commandId);
      },
      fetchWithTimeout: async () => {
        throw new Error('Request timed out after 1s.');
      },
      readFetchResponseJsonWithTimeout: async () => ({}),
      cancelShadowBackendCommand: async (commandId, reason) => {
        calls.push(['cancel', commandId, reason]);
        return true;
      }
    });

    await expect(runSubagentPowerShellCommand(record, 'Start-Sleep -Seconds 30', 1000, 'tool')).rejects.toThrow(/timed out/);

    expect(calls[0]).toEqual(['track', 'cmd_timeout']);
    expect(calls[1][0]).toBe('cancel');
    expect(calls[1][1]).toBe('cmd_timeout');
    expect(calls[1][2]).toContain('timed out');
    expect(calls[2]).toEqual(['untrack', 'cmd_timeout']);
    expect(record.activeCommandIds).toEqual([]);
  });

  it('cancels backend model proxy requests when subagents or smart consults are interrupted', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');
    const core = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '09-subagents-core.js'), 'utf8');
    const subagentRunner = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');

    expect(launcher).toContain('if ($urlPath -eq "/api/request/cancel")');
    expect(launcher).toContain('function Request-ShadowRequestCancellation');
    expect(launcher).toContain('status = "ignored"');
    expect(launcher).toContain('reason = "missing_request_id"');
    expect(launcher).toContain('function Get-ShadowHttpWebResponseWithCancellation');
    expect(launcher).toContain('function Read-ShadowResponseBodyWithCancellation');
    expect(launcher).toContain('Get-ShadowHttpWebResponseWithCancellation -WebRequest $webReq -TimeoutMilliseconds $requestTimeoutMs -RequestId $requestId');
    expect(launcher).toContain('Read-ShadowResponseBodyWithCancellation -WebRequest $webReq -WebResponse $webResp -TimeoutMilliseconds $requestTimeoutMs -RequestId $requestId');
    expect(launcher).toContain('Read-ShadowResponseBodyWithCancellation -WebRequest $webReq -WebResponse $webEx.Response -TimeoutMilliseconds $requestTimeoutMs -RequestId $requestId');
    expect(launcher).toContain('Read-ShadowResponseBodyWithCancellation -WebRequest $webReq -WebResponse $_.Exception.Response -TimeoutMilliseconds $requestTimeoutMs -RequestId $requestId');
    expect(launcher).toContain('if ($webResp) { try { $webResp.Close() } catch {} }');
    expect(launcher).toContain('while (-not $readTask.Wait(250))');
    expect(launcher).toContain('Get-ShadowProxyTimeoutMilliseconds -JsonBody $codexReq -DefaultTimeoutMilliseconds 180000');
    expect(launcher).toContain('Get-ShadowProxyTimeoutMilliseconds -JsonBody $proxyReq -DefaultTimeoutMilliseconds 120000');
    expect((launcher.match(/Clear-ShadowRequestCancellation \$requestId/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(core).toContain('activeRequestIds: []');
    expect(core).toContain('function cancelShadowBackendRequest');
    expect(core).toContain("fetchLocalApiWithTimeout('/api/request/cancel'");
    expect(core).toContain('console.debug(`[Shadow] Backend request cancel ${cleanId} was ignored');
    expect(core).toContain('cancelSubagentBackendRequests(subagentRecord, reason)');
    expect(subagentRunner).toContain('function fetchSubagentBackendModelRequest');
    expect(subagentRunner).toContain('body.request_id = requestId');
    expect(subagentRunner).toContain('body.timeout_ms = timeoutMs');
    expect(subagentRunner).toContain('cancelShadowBackendRequest(activeSmartConsultRecord.requestId || activeSmartConsultRecord.id, reason)');
    expect(subagentRunner).toContain('fetchSubagentBackendModelRequest(subagentRecord, \'/api/codex/responses\'');
    expect(subagentRunner).toContain('fetchSubagentBackendModelRequest(subagentRecord, \'/api/proxy\'');
  });

  it('cancels foreground voice backend commands on interrupt or disconnect', () => {
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');

    expect(liveConnection).toContain('const activeLiveBackendCommandIds = new Set()');
    expect(liveConnection).toContain('function invalidateLiveToolOperations');
    expect(liveConnection).toContain('function getLiveToolAbortSignal');
    expect(liveConnection).toContain('signal: getLiveToolAbortSignal(call.id)');
    expect(liveConnection).toContain('function cancelLiveBackendCommands');
    expect(liveConnection).toContain('function cancelLiveBackendCommand');
    expect(liveConnection).toContain("fetchLocalApiWithTimeout('/api/run/cancel'");
    expect(liveConnection).toContain('async function runLivePowerShellCommand');
    expect(liveConnection).toContain('command_id: commandId');
    expect(liveConnection).toContain('await cancelLiveBackendCommand(commandId, reason)');
    expect(liveConnection).toContain('const rawJson = await runLivePowerShellCommand(command, 25000, 25000');
    expect(liveConnection).toContain('const json = normalizeLivePowerShellCommandResult(command, rawJson)');
    expect(liveConnection).toContain("runLivePowerShellCommand(psCmd, 15000, 15000, 'read_file')");
    expect(liveConnection).toContain("runLivePowerShellCommand(psCmd, 15000, 15000, 'list_directory')");
    expect(liveConnection).toContain("runLivePowerShellCommand(cmd, 15000, 18000, 'desktop')");
    expect(liveConnection).toContain("cancelActiveLiveWork('voice session disconnected')");
    expect(liveConnection).toContain('cancelLiveBackendCommands(reason)');
    expect(liveConnection).toContain("cancelLiveBackendCommands('manual interrupt')");
    expect(liveConnection).toContain('activeLiveBackendCommandIds.size > 0');
  });

  it('cancels foreground backend commands when a Live tool command fetch aborts', async () => {
    const calls = [];
    const { runLivePowerShellCommand } = loadFunctions([
      ['05-live-connection.js', ['runLivePowerShellCommand']]
    ], {
      createLiveBackendCommandId: () => 'voice_timeout',
      trackLiveBackendCommand: commandId => calls.push(['track', commandId]),
      untrackLiveBackendCommand: commandId => calls.push(['untrack', commandId]),
      fetchWithTimeout: async () => {
        throw new Error('The operation was aborted.');
      },
      readLiveResponseJsonWithTimeout: async () => ({}),
      cancelLiveBackendCommand: async (commandId, reason) => {
        calls.push(['cancel', commandId, reason]);
        return true;
      }
    });

    await expect(runLivePowerShellCommand('Start-Sleep -Seconds 30', 60000, 1000, 'voice')).rejects.toThrow(/aborted/);

    expect(calls[0]).toEqual(['track', 'voice_timeout']);
    expect(calls[1][0]).toBe('cancel');
    expect(calls[1][1]).toBe('voice_timeout');
    expect(calls[1][2]).toContain('aborted');
    expect(calls[2]).toEqual(['untrack', 'voice_timeout']);
  });

  it('routes model-visible subagent status through the shared rich status payload', () => {
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const proactive = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '10-scheduler-proactive.js'), 'utf8');
    const core = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '09-subagents-core.js'), 'utf8');

    expect(core).toContain('function getSubagentStatusPayload');
    expect(core).toContain('function getSubagentStatusList');
    expect(core).toContain('recentToolEvents');
    expect(core).toContain('recentTimeline');
    expect(core).toContain('activeCommandCount');
    expect(core).toContain('idleSeconds');
    expect(core).toContain('activityState');
    expect(core).toContain('modelInstruction');
    expect(liveConnection).toContain('getSubagentStatusList(20)');
    expect(liveConnection).toContain('active_subagents');
    expect(liveConnection).toContain('No background subagents are currently doing work');
    expect(proactive).toContain('function getProactiveRelevantSubagentStatus');
    expect(proactive).toContain('Completed, partial, failed, and cancelled subagents are historical');
  });

  it('bounds and safely quotes desktop-controller command calls', () => {
    const stateDom = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const subagentRunner = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');

    expect(stateDom).toContain('function quotePowerShellSingleQuotedString');
    expect(stateDom).toContain('function normalizeDesktopCoordinate');
    expect(liveConnection).not.toContain("fetch('/api/run'");
    expect(liveConnection).not.toContain('-Action "${action}"');
    expect(subagentRunner).not.toContain('-Action "${action}"');
    expect(liveConnection).toContain('const safeAction = quotePowerShellSingleQuotedString(action ||');
    expect(liveConnection).toContain('const safeX = normalizeDesktopCoordinate(x)');
    expect(liveConnection).toContain("runLivePowerShellCommand(cmd, 15000, 18000, 'desktop')");
    expect(subagentRunner).toContain('const safeText = quotePowerShellSingleQuotedString(text ||');
    expect(subagentRunner).toContain('const safeY = normalizeDesktopCoordinate(y)');
  });
});

describe('search proxy reliability', () => {
  it('keeps frontend and backend search timeout windows aligned', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');
    const stateDom = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const subagentRunner = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');

    expect(stateDom).toContain('const SUBAGENT_SEARCH_PROXY_TIMEOUT_MS = 22000');
    expect(stateDom).toContain('const MAIN_SEARCH_PROXY_TIMEOUT_MS = 15000');
    expect(stateDom).toContain('const SUBAGENT_SEARCH_TIMEOUT_MS = SUBAGENT_SEARCH_PROXY_TIMEOUT_MS + 3000');
    expect(stateDom).toContain('const MAIN_SEARCH_TIMEOUT_MS = MAIN_SEARCH_PROXY_TIMEOUT_MS + 3000');
    expect(launcher).toContain('function Get-ShadowSearchTimeoutMilliseconds');
    expect(launcher).toContain('function Get-ShadowSearchAttemptTimeoutMilliseconds');
    expect(launcher).toContain('Get-ShadowSearchTimeoutMilliseconds -JsonBody $searchReq');
    expect(launcher).toContain('$webReq.Timeout = $attemptTimeoutMs');
    expect(liveConnection).toContain('timeout_ms: MAIN_SEARCH_PROXY_TIMEOUT_MS');
    expect(subagentRunner).toContain('timeout_ms: SUBAGENT_SEARCH_PROXY_TIMEOUT_MS');
    expect(subagentRunner).toContain('search_error_detail');
  });
});

describe('local API request reliability', () => {
  it('bounds boot, auth, memory, and scheduler local API calls', () => {
    const stateDom = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const bootUi = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '02-boot-ui.js'), 'utf8');
    const scheduler = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '10-scheduler-proactive.js'), 'utf8');
    const workspace = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '13-google-workspace.js'), 'utf8');

    expect(stateDom).toContain('async function fetchLocalApiWithTimeout');
    expect(stateDom).toContain('const MEMORY_BACKUP_TIMEOUT_MS = 30000');
    expect(stateDom).toContain('const CODEX_AUTH_API_TIMEOUT_MS = 25000');
    expect(stateDom).toContain('const SCHEDULER_NOTIFICATION_TIMEOUT_MS = 5000');
    expect(bootUi).not.toContain("fetch('/api/");
    expect(bootUi).toContain("fetchLocalApiWithTimeout('/api/codex/status'");
    expect(bootUi).toContain("fetchLocalApiWithTimeout('/api/memories/backup'");
    expect(bootUi).toContain("fetchLocalApiWithTimeout('/api/google/auth-url'");
    expect(scheduler).not.toContain("fetch('/api/scheduler");
    expect(scheduler).toContain('let schedulerPollInFlight = false');
    expect(scheduler).toContain('if (schedulerPollInFlight) return');
    expect(scheduler).toContain('SCHEDULER_NOTIFICATION_TIMEOUT_MS');
    expect(workspace).toContain('fetchLocalApiWithTimeout(url, requestOptions, timeoutMs)');
  });

  it('uses a bounded backend scheduler proxy instead of unbounded WebClient calls', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');

    expect(launcher).toContain('function Invoke-ShadowSchedulerProxyRequest');
    expect(launcher).toContain('$webReq.Timeout = $TimeoutMilliseconds');
    expect(launcher).toContain('$webReq.ReadWriteTimeout = $TimeoutMilliseconds');
    expect(launcher).toContain('Invoke-ShadowSchedulerProxyRequest -Method $request.HttpMethod -Url $fullUrl -Body $bodyString -TimeoutMilliseconds 10000');
    expect(launcher).toContain('Scheduler proxy failed:');
    expect(launcher).toContain('The proxy times out after 10s');
    expect(launcher).not.toContain('New-Object System.Net.WebClient');
    expect(launcher).not.toContain('DownloadString($fullUrl)');
    expect(launcher).not.toContain('UploadString("http://127.0.0.1:9333$schedulerPath"');
  });

  it('bounds every backend HttpWebRequest stream read', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');
    const createPattern = /\[System\.Net\.HttpWebRequest\]::Create\([^\r\n]+\)/g;
    const creates = [...launcher.matchAll(createPattern)];
    const missingReadWriteTimeout = creates
      .map(match => {
        const nextCreateIndex = launcher.indexOf('[System.Net.HttpWebRequest]::Create', match.index + match[0].length);
        const requestBlock = launcher.slice(match.index, nextCreateIndex === -1 ? launcher.length : nextCreateIndex);
        return requestBlock.includes('.ReadWriteTimeout') ? null : match[0];
      })
      .filter(Boolean);

    expect(creates.length).toBeGreaterThan(0);
    expect(missingReadWriteTimeout).toEqual([]);
    expect(launcher).toContain('$webReq.ReadWriteTimeout = $requestTimeoutMs');
    expect(launcher).toContain('$tokenReq.ReadWriteTimeout = 15000');
    expect(launcher).toContain('$refreshReq.ReadWriteTimeout = 30000');
  });

  it('makes local Google Drive uploads cancellable across frontend and backend', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');
    const workspace = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '13-google-workspace.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const subagentRunner = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'index.html'), 'utf8');

    expect(launcher).toContain('function Get-ShadowGoogleUploadTimeoutMilliseconds');
    expect(launcher).toContain('$requestId = Normalize-ShadowRequestId ([string]$argsObj.request_id)');
    expect(launcher).toContain('$uploadTask = $httpClient.PostAsync($uploadUrl, $multipart, $cts.Token)');
    expect(launcher).toContain('Test-ShadowRequestCancellation $requestId');
    expect(launcher).toContain('Clear-ShadowRequestCancellation $requestId');
    expect(launcher).toContain('request_id = $requestId');
    expect(workspace).toContain('const activeWorkspaceBackendRequestIds = new Set()');
    expect(workspace).toContain('function cancelWorkspaceBackendRequests');
    expect(workspace).toContain("cancelShadowBackendRequest(requestId, reason)");
    expect(workspace).toContain('request_id: requestId');
    expect(workspace).toContain('timeout_ms: GOOGLE_DRIVE_LOCAL_UPLOAD_TIMEOUT_MS');
    // A barge-in must not abort a committed upload (the file already reached Google),
    // otherwise the model is stranded on "thinking" and believes the upload failed.
    expect(liveConnection).toContain("cancelWorkspaceBackendRequests('manual interrupt', { includeCommitted: false })");
    expect(liveConnection).toContain('cancelWorkspaceBackendRequests(reason)');
    expect(workspace).toContain('nonInterruptibleWorkspaceBackendRequestIds');
    expect(workspace).toContain('trackWorkspaceBackendRequest(requestId, { interruptible: false })');
    expect(liveConnection).toContain('markLiveToolCallCommitted(call.id)');
    expect(liveConnection).toContain('committedLiveToolCallIds');
    expect(subagentRunner).toContain('const workspaceOptions = { subagentRecord }');
    expect(subagentRunner).toContain('gmailListMessages(call.args || {}, workspaceOptions)');
    expect(subagentRunner).toContain('googleContactsList(call.args || {}, workspaceOptions)');
    expect(subagentRunner).toContain("googleDriveUploadLocalFile(call.args || {}, { subagentRecord, label: 'drive_upload' })");
    expect(indexHtml).toContain('13-google-workspace.js?v=upload-resilience-20260529');
  });

  it('bounds response body reads after subagent fetches', async () => {
    const runner = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
    const core = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '09-subagents-core.js'), 'utf8');
    const { fetchWithTimeout, readFetchResponseTextWithTimeout } = loadFunctions([
      ['09-subagents-core.js', ['fetchWithTimeout', 'cancelFetchResponseBody', 'readFetchResponseTextWithTimeout']]
    ], {
      setTimeout,
      clearTimeout,
      AbortController,
      fetch: (url, options = {}) => new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      })
    });
    let bodyCancelled = false;
    const response = {
      body: {
        cancel: () => {
          bodyCancelled = true;
          return Promise.resolve();
        }
      },
      text: () => new Promise(() => {})
    };

    const abortController = new AbortController();
    const fetchPromise = fetchWithTimeout('/slow', { signal: abortController.signal }, 1000);
    abortController.abort();
    await expect(fetchPromise).rejects.toThrow(/Task cancelled by user/);
    await expect(readFetchResponseTextWithTimeout(response, 5)).rejects.toThrow(/Response body timed out/);
    expect(bodyCancelled).toBe(true);
    expect(core).toContain('const optionSignal = options && options.signal');
    expect(core).toContain('async function readFetchResponseTextWithTimeout');
    expect(core).toContain('async function readFetchResponseJsonWithTimeout');
    expect(core).toContain('cancelFetchResponseBody(response)');
    expect(runner).toContain('readFetchResponseTextWithTimeout(response, SUBAGENT_MODEL_TIMEOUT_MS, subagentRecord)');
    expect(runner).toContain('readFetchResponseJsonWithTimeout(response, SUBAGENT_MODEL_TIMEOUT_MS, subagentRecord)');
    expect(runner).toContain('readFetchResponseJsonWithTimeout(proxyRes, SUBAGENT_SEARCH_TIMEOUT_MS, subagentRecord)');
    expect(runner).not.toContain('const sseText = await response.text();');
    expect(runner).not.toContain('json = await response.json();');
  });

  it('uses bounded response body reads for foreground fetches', () => {
    const bootUi = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '02-boot-ui.js'), 'utf8');
    const screenConfig = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '03-screen-config.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const memory = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '08-memory.js'), 'utf8');
    const scheduler = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '10-scheduler-proactive.js'), 'utf8');
    const workspace = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '13-google-workspace.js'), 'utf8');
    const core = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '09-subagents-core.js'), 'utf8');

    expect(core).toContain('async function readFetchResponseArrayBufferWithTimeout');
    expect(bootUi).toContain('async function readBootResponseJsonWithTimeout');
    expect(bootUi).toContain('readBootResponseJsonWithTimeout(res, MEMORY_BACKUP_TIMEOUT_MS)');
    expect(bootUi).toContain('readBootResponseJsonWithTimeout(skillsReset, SKILLS_RESET_TIMEOUT_MS)');
    expect(bootUi).not.toContain('await res.json()');
    expect(bootUi).not.toContain('await backupRes.json()');
    expect(screenConfig).toContain('async function readConfigResponseTextWithTimeout');
    expect(screenConfig).toContain('const rawConfig = await readConfigResponseTextWithTimeout(res, 5000)');
    expect(liveConnection).toContain('async function readLiveResponseJsonWithTimeout');
    expect(liveConnection).toContain('return await readFetchResponseJsonWithTimeout(response, timeoutMs)');
    expect(liveConnection).toContain('const json = await readLiveResponseJsonWithTimeout(res, fetchTimeoutMs)');
    expect(liveConnection).toContain('const searchResult = await readLiveResponseJsonWithTimeout(res, MAIN_SEARCH_TIMEOUT_MS)');
    expect(memory).toContain('async function readMemoryResponseJsonWithTimeout');
    expect(memory).toContain('const cmdJson = await readMemoryResponseJsonWithTimeout(cmdRes, 15000)');
    expect(memory).toContain('const text = await readMemoryResponseTextWithTimeout(res, 15000)');
    expect(scheduler).toContain('async function readSchedulerResponseJsonWithTimeout');
    expect(scheduler).toContain('return await readSchedulerResponseJsonWithTimeout(res, SCHEDULER_API_TIMEOUT_MS)');
    expect(scheduler).toContain('const data = await readSchedulerResponseJsonWithTimeout(res, PROACTIVE_EVALUATOR_TIMEOUT_MS)');
    expect(scheduler).toContain('const data = await readSchedulerResponseJsonWithTimeout(res, SCHEDULER_NOTIFICATION_TIMEOUT_MS)');
    expect(workspace).toContain('async function readWorkspaceResponseJson');
    expect(workspace).toContain('async function readWorkspaceResponseText');
    expect(workspace).toContain('async function readWorkspaceResponseArrayBuffer');
    expect(workspace).toContain('async function readWorkspaceResponseBodyWithTimeout');
    expect(workspace).toContain('Promise.race([bodyPromise, timeoutPromise])');
    expect(workspace).toContain('readWorkspaceResponseJson(response, GOOGLE_API_TIMEOUT_MS)');
    expect(workspace).toContain('readWorkspaceResponseText(response, GOOGLE_DRIVE_DOWNLOAD_TIMEOUT_MS)');
    expect(workspace).toContain('readWorkspaceResponseArrayBuffer(response, GOOGLE_DRIVE_DOWNLOAD_TIMEOUT_MS)');
  });
});

describe('voice session replay harness', () => {
  it('parses and replays turn-complete and queued-notice log lines', () => {
    const log = [
      '05-live-connection.js:2053 Turn complete',
      '10-scheduler-proactive.js:944 [Scheduler] Delivered queued notification (subagent notice_2): [SYSTEM NOTICE] [Subagent Done]',
      '05-live-connection.js:873 Received tool calls: [{...}]'
    ].join('\n');

    const events = parseVoiceSessionLog(log);
    expect(events.map(event => event.type)).toEqual(['turnComplete', 'noticeDelivered', 'toolCalls']);

    const replay = createVoiceSessionReplay();
    const state = replay.replay(events);
    expect(state.turnCompletes).toBe(1);
    expect(state.deliveredNotices).toHaveLength(1);
    expect(state.toolCallBursts).toBe(1);
  });
});

describe('missing-credential prompt', () => {
  function loadCredentialFns() {
    return loadFunctions([
      ['12-subagents-notifications.js', ['detectMissingCredentialFromReason', 'getCredentialPromptConfig']]
    ]);
  }

  it('maps missing-key failure reasons to the right credential', () => {
    const { detectMissingCredentialFromReason } = loadCredentialFns();
    expect(detectMissingCredentialFromReason('Ollama Cloud API key is missing. Add it in Settings before using Ollama for subagents.')).toBe('ollama');
    expect(detectMissingCredentialFromReason('MiniMax API key is missing. Add it in Settings before using MiniMax for subagents.')).toBe('minimax');
    expect(detectMissingCredentialFromReason('Canopy Wave API key is missing. Add it in Settings before using Canopy Wave for subagents.')).toBe('moonshot');
    expect(detectMissingCredentialFromReason('Gemini API key is required.')).toBe('gemini');
  });

  it('does not raise a prompt for unrelated or generic auth failures', () => {
    const { detectMissingCredentialFromReason } = loadCredentialFns();
    expect(detectMissingCredentialFromReason('HTTP 500 internal server error')).toBe('');
    expect(detectMissingCredentialFromReason('Request timed out after 60s')).toBe('');
    // A generic invalid-key auth error must not deep-link to a guessed field.
    expect(detectMissingCredentialFromReason('HTTP 401 invalid api key')).toBe('');
    expect(detectMissingCredentialFromReason('')).toBe('');
  });

  it('provides deep-link config with verified get-key URLs only', () => {
    const { getCredentialPromptConfig } = loadCredentialFns();
    const gemini = getCredentialPromptConfig('gemini');
    expect(gemini.fieldId).toBe('input-api-key');
    expect(gemini.subagentProvider).toBe('');
    expect(gemini.getKeyUrl).toContain('aistudio.google.com');

    const ollama = getCredentialPromptConfig('ollama');
    expect(ollama.fieldId).toBe('input-ollama-key');
    expect(ollama.subagentProvider).toBe('ollama');
    expect(ollama.getKeyUrl).toContain('ollama.com');

    // Providers without a verified key page expose the field but no external link.
    const minimax = getCredentialPromptConfig('minimax');
    expect(minimax.fieldId).toBe('input-minimax-key');
    expect(minimax.subagentProvider).toBe('minimax');
    expect(minimax.getKeyUrl).toBe('');

    expect(getCredentialPromptConfig('nope')).toBeNull();
  });
});
