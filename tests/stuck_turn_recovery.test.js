import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

// Regression coverage for the "voice randomly stops replying / stuck purple thinking circle" freeze.
//
// Root cause: while currentVisualizerState === 'thinking', the mic input gate
// (isLiveWorkActiveForVoiceBargeIn) is CLOSED, so normal-volume speech is gated behind barge-in and
// never reaches Gemini. A turn can end without a turnComplete (so the thorough reset never runs),
// leaving the visualizer stuck on 'thinking'. The only general recovery -- maybeRecoverIdleVisualizerState
// -- used to run ONLY from the rAF visualizer loop, which the browser throttles/pauses when the app
// window is backgrounded (the normal state for hands-free voice). The fix runs the same recovery on a
// focus-independent setInterval and force-recovers the stuck turn (reopening the mic) when genuinely idle.

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  if (start < 0) throw new Error(`Missing function ${functionName}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not parse function ${functionName}`);
}

const transcriptSource = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '06-transcript.js'), 'utf8');
const recoveryFnSource = extractFunctionSource(transcriptSource, 'maybeRecoverIdleVisualizerState');

const NOW = 1_000_000;

function runRecovery(overrides = {}) {
  const calls = { forceRecover: [], setVisualizerState: [], markTurnIdle: [] };
  const ctx = {
    currentVisualizerState: 'thinking',
    _idleVisualizerCheckAt: 0,
    _thinkingEnteredAt: NOW - 20000, // entered "thinking" 20s ago -> past the 14s stuck threshold
    VISUALIZER_THINKING_STUCK_MS: 14000,
    isConnected: true,
    turnInProgress: true, // a stuck flag keeps fullyIdle false so we reach the ultimate guard
    userTurnActive: false,
    toolResponseFollowupPending: false,
    systemNoticeInFlight: false,
    serverInterruptPending: false,
    audioPlayer: { activeSources: [] },
    activeLiveBackendCommandIds: new Set(),
    activeLiveToolCallEpochs: new Map(),
    subagentPromptRefinementInProgress: false,
    forceRecoverStuckLiveTurn: reason => calls.forceRecover.push(reason),
    markTurnIdle: reason => calls.markTurnIdle.push(reason),
    setVisualizerState: state => calls.setVisualizerState.push(state),
    Date: { now: () => NOW },
    ...overrides
  };
  const sandbox = vm.createContext(ctx);
  vm.runInContext(`${recoveryFnSource}\nmaybeRecoverIdleVisualizerState();`, sandbox);
  return calls;
}

describe('stuck-turn idle recovery (the "stops replying" freeze)', () => {
  it('force-recovers a turn stuck on "thinking" past the threshold so the mic gate reopens', () => {
    const calls = runRecovery();
    expect(calls.forceRecover).toEqual(['stuck-thinking watchdog']);
  });

  it('does NOT force-recover while a real backend command is in flight (slow tool, not stuck)', () => {
    const calls = runRecovery({ activeLiveBackendCommandIds: new Set(['cmd1']) });
    expect(calls.forceRecover).toHaveLength(0);
  });

  it('does NOT force-recover while a live tool-call epoch is in flight', () => {
    const calls = runRecovery({ activeLiveToolCallEpochs: new Map([['call1', 1]]) });
    expect(calls.forceRecover).toHaveLength(0);
  });

  it('does NOT force-recover while a subagent prompt refinement is in progress', () => {
    const calls = runRecovery({ subagentPromptRefinementInProgress: true });
    expect(calls.forceRecover).toHaveLength(0);
  });

  it('does NOT force-recover while audio is actually playing (legitimately speaking)', () => {
    const calls = runRecovery({ audioPlayer: { activeSources: [{ node: {} }] } });
    expect(calls.forceRecover).toHaveLength(0);
  });

  it('snaps straight to listening (no force-recover) when fully idle on "thinking"', () => {
    const calls = runRecovery({ turnInProgress: false });
    expect(calls.setVisualizerState).toEqual(['listening']);
    expect(calls.forceRecover).toHaveLength(0);
  });

  it('is a no-op when not on the "thinking" state', () => {
    const calls = runRecovery({ currentVisualizerState: 'speaking' });
    expect(calls.forceRecover).toHaveLength(0);
    expect(calls.setVisualizerState).toHaveLength(0);
    expect(calls.markTurnIdle).toHaveLength(0);
  });

  it('is a no-op when disconnected', () => {
    const calls = runRecovery({ isConnected: false });
    expect(calls.forceRecover).toHaveLength(0);
    expect(calls.setVisualizerState).toHaveLength(0);
  });

  it('does NOT recover before the stuck threshold elapses', () => {
    const calls = runRecovery({ _thinkingEnteredAt: NOW - 5000 }); // only 5s in
    expect(calls.forceRecover).toHaveLength(0);
  });
});

describe('stuck-turn recovery wiring', () => {
  const boot = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '02-boot-ui.js'), 'utf8');
  const live = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
  const audio = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '04-audio.js'), 'utf8');

  it('runs recovery on a focus-independent setInterval (not just requestAnimationFrame)', () => {
    expect(transcriptSource).toContain('function startIdleVisualizerRecoveryTicker(');
    expect(transcriptSource).toMatch(/setInterval\([\s\S]*maybeRecoverIdleVisualizerState/);
  });

  it('starts the focus-independent recovery ticker at boot', () => {
    expect(boot).toContain('startIdleVisualizerRecoveryTicker()');
  });

  it('defines forceRecoverStuckLiveTurn to reopen the mic gate', () => {
    expect(live).toContain('function forceRecoverStuckLiveTurn(');
    expect(live).toContain('reopening the mic input gate');
  });

  it('streams silence instead of dropping mic frames during active work (keeps Gemini VAD alive)', () => {
    // The defense-in-depth fix removed the early `return` in the active-work branch so a stuck gate
    // can never wedge the server VAD. Guard that the VAD-keepalive rationale is documented in place.
    expect(audio).toContain('Streaming silence keeps the VAD alive');
  });

  it('drives the mic barge-in gate off real playback/backend work, NOT the stuck-prone thinking state', () => {
    // Primary fix: the mic gate must NOT depend on the visualizer "thinking"/"interrupting" state
    // (which can get stuck), so the user is always heard immediately when no audio is playing.
    expect(audio).toContain('const realBackendWorkActive');
    expect(audio).toContain('const activeWorkForBargeIn = inputGateClosed');
    expect(audio).toContain('(playbackActiveForBargeIn || realBackendWorkActive)');
    // The gate no longer consults the broad visualizer-state-based work flag anywhere in the audio path.
    expect(audio).not.toContain('isLiveWorkActiveForVoiceBargeIn');
  });
});
