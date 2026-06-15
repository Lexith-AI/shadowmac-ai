import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

function extractFunctionSource(source, functionName) {
  const asyncStart = source.indexOf(`async function ${functionName}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${functionName}(`);
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

function loadVoiceSettingFunctions() {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '03-screen-config.js'), 'utf8');
  const functionNames = [
    'normalizeGeminiVoiceName',
    'shouldStartFreshVoiceSession',
    'getLiveSessionResumptionTokenSavedAt',
    'isLiveSessionResumptionTokenFresh',
    'persistLiveSessionResumptionToken',
    'clearExpiredLiveSessionResumptionToken',
    'clearLiveSessionResumptionToken'
  ];
  const storage = new Map([
    ['shadow_resumption_token', 'handle'],
    ['shadow_resumption_token_model', 'models/gemini-3.1-flash-live-preview'],
    ['shadow_resumption_token_voice', 'Puck'],
    ['shadow_resumption_token_saved_at', '1000']
  ]);
  const sandbox = vm.createContext({
    GEMINI_VOICE_NAMES: Object.freeze(['Puck', 'Aoede', 'Kore']),
    LIVE_RESUMPTION_HANDLE_MAX_AGE_MS: 90 * 60 * 1000,
    activeResumptionToken: 'handle',
    storage,
    console: { warn: () => {} },
    updateSessionButtonVisibility: () => {},
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    }
  });
  const functionSource = functionNames.map(name => extractFunctionSource(source, name)).join('\n\n');
  const exportsSource = '\nresult = { ' +
    functionNames.map(name => `${name}: ${name}`).join(', ') +
    ', getActiveResumptionToken: () => activeResumptionToken' +
    ', getStoredResumptionKeys: () => Array.from(storage.keys())' +
    ', getStoredValue: key => storage.get(key)' +
    ' };';
  vm.runInContext(`${functionSource}${exportsSource}`, sandbox);
  return sandbox.result;
}

function loadLiveModelFunctions(initialModel = 'models/gemini-3.1-flash-live-preview', initialThinkingLevel = null) {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '01-state-dom.js'), 'utf8');
  const functionNames = [
    'normalizeLiveModel',
    'normalizeLiveThinkingLevel',
    'supportsLiveThinkingLevel',
    'getLiveGenerationThinkingConfig',
    'getSmartConsultWorkRoutingReason',
    'shouldRouteSmartConsultToBackgroundAgent'
  ];
  const storage = new Map([
    ['shadow_model', initialModel]
  ]);
  if (initialThinkingLevel !== null) {
    storage.set('shadow_live_thinking_level', initialThinkingLevel);
  }
  const sandbox = vm.createContext({
    storage,
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    Set
  });
  const prefix = source.slice(
    source.indexOf('const DEFAULT_LIVE_MODEL'),
    source.indexOf('let subagentProvider')
  );
  const functionSource = functionNames.map(name => extractFunctionSource(source, name)).join('\n\n');
  const exportsSource = '\nresult = { ' +
    functionNames.map(name => `${name}: ${name}`).join(', ') +
    ', DEFAULT_LIVE_MODEL' +
    ', FALLBACK_LIVE_MODEL' +
    ', selectedModel' +
    ', liveThinkingLevel' +
    ', getStoredModel: () => storage.get("shadow_model")' +
    ', getStoredThinkingLevel: () => storage.get("shadow_live_thinking_level")' +
    ' };';
  vm.runInContext(`${prefix}\n${functionSource}${exportsSource}`, sandbox);
  return sandbox.result;
}

function loadLiveSocketSendFunctions() {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
  const functionNames = [
    'isCurrentLiveSocket',
    'sendLiveSocketJson',
    'invalidateLiveToolOperations',
    'cancelActiveLiveWork',
    'registerLiveToolCall',
    'unregisterLiveToolCall',
    'markLiveToolCallCommitted',
    'getLiveToolCallName',
    'getLiveToolAbortSignal',
    'isLiveToolCallCurrent',
    'isCurrentLiveToolBatch',
    'sendLiveToolResponse',
    'sendLiveToolOutputFromOperation'
  ];
  const sent = [];
  const cancelledSmartConsults = [];
  const cancelledBackendCommands = [];
  const cancelledWorkspaceRequests = [];
  const activeSocket = {
    readyState: 1,
    send: payload => sent.push(payload)
  };
  const staleSocket = {
    readyState: 1,
    send: payload => sent.push(`stale:${payload}`)
  };
  const sandbox = vm.createContext({
    socket: activeSocket,
    connectionAttemptId: 7,
    liveToolOperationEpoch: 0,
    activeLiveToolCallEpochs: new Map(),
    activeLiveToolCallNames: new Map(),
    activeLiveToolAbortControllers: new Map(),
    committedLiveToolCallIds: new Set(),
    currentLiveToolAbortSignal: null,
    cancelActiveSmartConsult: reason => cancelledSmartConsults.push(reason),
    cancelLiveBackendCommands: reason => cancelledBackendCommands.push(reason),
    cancelWorkspaceBackendRequests: reason => cancelledWorkspaceRequests.push(reason),
    AbortController,
    WebSocket: { OPEN: 1 },
    console: { debug: () => {}, warn: () => {} },
    sent,
    cancelledSmartConsults,
    cancelledBackendCommands,
    cancelledWorkspaceRequests,
    activeSocket,
    staleSocket
  });
  const functionSource = functionNames.map(name => extractFunctionSource(source, name)).join('\n\n');
  const exportsSource = '\nresult = { ' +
    functionNames.map(name => `${name}: ${name}`).join(', ') +
    ', sent' +
    ', cancelledSmartConsults' +
    ', cancelledBackendCommands' +
    ', cancelledWorkspaceRequests' +
    ', activeSocket' +
    ', staleSocket' +
    ', getLiveToolOperationEpoch: () => liveToolOperationEpoch' +
    ', getRegisteredToolEpoch: callId => activeLiveToolCallEpochs.get(callId)' +
    ', getRegisteredToolName: callId => activeLiveToolCallNames.get(callId)' +
    ', closeActiveSocket: () => { activeSocket.readyState = 3; }' +
    ', replaceActiveSocket: () => { socket = { readyState: 1, send: payload => sent.push(`new:${payload}`) }; }' +
    ' };';
  vm.runInContext(`${functionSource}${exportsSource}`, sandbox);
  return sandbox.result;
}

function loadLiveCommandResultFunctions() {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
  const functionNames = [
    'isExpectedDisconnectPowerShellCommand',
    'stringifyPowerShellResultField',
    'getPowerShellResultDiagnosticText',
    'looksLikeExpectedRemoteDisconnectOutput',
    'normalizeLivePowerShellCommandResult',
    'rememberAssumedDisruptiveCommand',
    'getRecentAssumedDisruptiveCommandBlock'
  ];
  const sandbox = vm.createContext({
    console: { warn: () => {}, debug: () => {} },
    Date
  });
  const prefix = 'const ASSUMED_DISRUPTIVE_COMMAND_SPAWN_BLOCK_MS = 30000; let lastAssumedDisruptiveCommandResult = null;';
  const functionSource = functionNames.map(name => extractFunctionSource(source, name)).join('\n\n');
  const exportsSource = `\nresult = { ${functionNames.map(name => `${name}: ${name}`).join(', ')} };`;
  vm.runInContext(`${prefix}\n${functionSource}${exportsSource}`, sandbox);
  return sandbox.result;
}

describe('voice setting session behavior', () => {
  it('starts a fresh Live session only when the selected voice changes', () => {
    const { shouldStartFreshVoiceSession } = loadVoiceSettingFunctions();

    expect(shouldStartFreshVoiceSession('Puck', 'Puck')).toBe(false);
    expect(shouldStartFreshVoiceSession('puck', 'Puck')).toBe(false);
    expect(shouldStartFreshVoiceSession('Puck', 'Aoede')).toBe(true);
  });

  it('clears all stored resumption metadata for a fresh voice session', () => {
    const {
      clearLiveSessionResumptionToken,
      getActiveResumptionToken,
      getStoredResumptionKeys
    } = loadVoiceSettingFunctions();

    clearLiveSessionResumptionToken();

    expect(getActiveResumptionToken()).toBe(null);
    expect(getStoredResumptionKeys()).toEqual([]);
  });

  it('persists voice metadata with Live resumption handles', () => {
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');

    expect(liveConnection).toContain('persistLiveSessionResumptionToken(update.newHandle, activeModel, voiceName)');
    expect(liveConnection).toContain('shouldStartFreshVoiceSession(lastResumptionVoice, voiceName)');
  });

  it('expires old Live resumption handles before connection setup', () => {
    const {
      isLiveSessionResumptionTokenFresh,
      clearExpiredLiveSessionResumptionToken,
      persistLiveSessionResumptionToken,
      getActiveResumptionToken,
      getStoredValue
    } = loadVoiceSettingFunctions();

    expect(isLiveSessionResumptionTokenFresh(1000 + (30 * 60 * 1000))).toBe(true);
    expect(isLiveSessionResumptionTokenFresh(1000 + (91 * 60 * 1000))).toBe(false);
    expect(clearExpiredLiveSessionResumptionToken('test')).toBe(true);
    expect(getActiveResumptionToken()).toBe(null);

    persistLiveSessionResumptionToken('new-handle', 'models/gemini-3.1-flash-live-preview', 'Aoede', 5000);
    expect(getActiveResumptionToken()).toBe('new-handle');
    expect(getStoredValue('shadow_resumption_token_saved_at')).toBe('5000');
  });

  it('keeps Gemini 3.1 Flash Live as the supported default model', () => {
    const {
      normalizeLiveModel,
      DEFAULT_LIVE_MODEL,
      FALLBACK_LIVE_MODEL,
      selectedModel,
      getStoredModel
    } = loadLiveModelFunctions('models/gemini-3.1-flash-live-preview');

    expect(DEFAULT_LIVE_MODEL).toBe('models/gemini-3.1-flash-live-preview');
    expect(FALLBACK_LIVE_MODEL).toBe('models/gemini-2.5-flash-native-audio-preview-12-2025');
    expect(selectedModel).toBe(DEFAULT_LIVE_MODEL);
    expect(getStoredModel()).toBe(DEFAULT_LIVE_MODEL);
    expect(normalizeLiveModel('models/gemini-3-flash-live-preview')).toBe(DEFAULT_LIVE_MODEL);
    expect(normalizeLiveModel('models/gemini-2.5-flash-native-audio-preview-09-2025')).toBe(FALLBACK_LIVE_MODEL);
    expect(normalizeLiveModel('models/unknown-live-model')).toBe(DEFAULT_LIVE_MODEL);
  });

  it('normalizes voice reasoning levels and defaults to medium', () => {
    const {
      DEFAULT_LIVE_MODEL,
      FALLBACK_LIVE_MODEL,
      liveThinkingLevel,
      getStoredThinkingLevel,
      normalizeLiveThinkingLevel,
      supportsLiveThinkingLevel,
      getLiveGenerationThinkingConfig
    } = loadLiveModelFunctions('models/gemini-3.1-flash-live-preview', 'medium');

    // 'medium' is not a former forced default, so a deliberate medium is preserved (and it is also the default).
    expect(liveThinkingLevel).toBe('medium');
    expect(getStoredThinkingLevel()).toBe('medium');
    // Selector is back: known levels are honored, unknown input falls back to the medium default.
    expect(normalizeLiveThinkingLevel('LOW')).toBe('low');
    expect(normalizeLiveThinkingLevel('high')).toBe('high');
    expect(normalizeLiveThinkingLevel('bad')).toBe('medium');
    expect(supportsLiveThinkingLevel(DEFAULT_LIVE_MODEL)).toBe(true);
    expect(supportsLiveThinkingLevel(FALLBACK_LIVE_MODEL)).toBe(false);
    expect(getLiveGenerationThinkingConfig(DEFAULT_LIVE_MODEL, 'high')).toEqual({ thinkingLevel: 'high' });
    expect(getLiveGenerationThinkingConfig(DEFAULT_LIVE_MODEL, 'auto')).toBe(null);
    expect(getLiveGenerationThinkingConfig(FALLBACK_LIVE_MODEL, 'high')).toBe(null);
  });

  it('migrates former default voice reasoning levels (high/low/minimal) to the current default (medium)', () => {
    const fromHigh = loadLiveModelFunctions('models/gemini-3.1-flash-live-preview', 'high');
    expect(fromHigh.liveThinkingLevel).toBe('medium');

    const fromLow = loadLiveModelFunctions('models/gemini-3.1-flash-live-preview', 'low');
    expect(fromLow.liveThinkingLevel).toBe('medium');

    // v1.8.1-v1.8.3 forced 'minimal' as the default and it hallucinated more; re-migrate those users up to 'medium'.
    const fromMinimal = loadLiveModelFunctions('models/gemini-3.1-flash-live-preview', 'minimal');
    expect(fromMinimal.liveThinkingLevel).toBe('medium');
  });

  it('routes executable work away from foreground smart consults', () => {
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const {
      getSmartConsultWorkRoutingReason,
      shouldRouteSmartConsultToBackgroundAgent
    } = loadLiveModelFunctions();

    expect(getSmartConsultWorkRoutingReason('Brainstorm voice architecture options.')).toBe('');
    expect(shouldRouteSmartConsultToBackgroundAgent('Compare the tradeoffs of Gemini Live versus a smart backend model.')).toBe(false);
    expect(shouldRouteSmartConsultToBackgroundAgent('Fix the voice routing code and run npm test.')).toBe(true);
    expect(shouldRouteSmartConsultToBackgroundAgent('Check my Gmail for replies.')).toBe(true);
    expect(shouldRouteSmartConsultToBackgroundAgent('Download it.')).toBe(true);
    expect(shouldRouteSmartConsultToBackgroundAgent('Do it.')).toBe(true);
    expect(shouldRouteSmartConsultToBackgroundAgent('Make it happen.')).toBe(true);
    expect(getSmartConsultWorkRoutingReason('Please inspect the repo and update the settings UI.')).toContain('spawn_background_agent');
    expect(shouldRouteSmartConsultToBackgroundAgent('Plan a vacation for me to Portugal next week under 1000 euros.')).toBe(true);
    expect(shouldRouteSmartConsultToBackgroundAgent('Bring the website down on my VPS.')).toBe(true);
    expect(shouldRouteSmartConsultToBackgroundAgent('Disable app.example.com on prod.')).toBe(true);
    expect(shouldRouteSmartConsultToBackgroundAgent('Portugal next week under \u20ac1000.')).toBe(true);
    expect(shouldRouteSmartConsultToBackgroundAgent('Find me the best GPU in stock under 700 euros in the Netherlands.')).toBe(true);
    expect(shouldRouteSmartConsultToBackgroundAgent('Find an apartment near me under 1500 euros with good reviews.')).toBe(true);
    expect(getSmartConsultWorkRoutingReason('Plan a vacation for me to Portugal next week under 1000 euros.')).toContain('Current source-backed research');
    expect(liveConnection).toContain('Foreground smart consult was executable work; started background routing instead.');
    expect(liveConnection).toContain('Do not continue direct voice web searches for this request.');
    expect(liveConnection).toContain('Use this instead of ask_smart_model whenever the user asks Shadow to do work');
    expect(liveConnection).not.toContain('finish a novel task');
  });

  it('treats expected remote reboot disconnects as initiated success instead of recovery failures', () => {
    const {
      isExpectedDisconnectPowerShellCommand,
      normalizeLivePowerShellCommandResult,
      rememberAssumedDisruptiveCommand,
      getRecentAssumedDisruptiveCommandBlock
    } = loadLiveCommandResultFunctions();

    const command = 'ssh prod "sudo reboot"';
    expect(isExpectedDisconnectPowerShellCommand(command)).toBe(true);
    expect(isExpectedDisconnectPowerShellCommand('ssh prod "sudo shutdown -r now"')).toBe(true);
    expect(isExpectedDisconnectPowerShellCommand('ssh prod "sudo -S shutdown -r now"')).toBe(true);

    const result = normalizeLivePowerShellCommandResult(command, {
      status: 'error',
      output: 'Connection to 203.0.113.10 closed by remote host.',
      exitCode: 255,
      timedOut: false,
      cancelled: false,
      command_id: 'voice_1'
    });

    expect(result.status).toBe('success');
    expect(result.assumed_success).toBe(true);
    expect(result.output).toContain('Remote disruptive command initiated successfully');
    expect(result.output).not.toContain('255');
    expect(result.instruction).toContain('Do not call spawn_background_agent');

    rememberAssumedDisruptiveCommand(command, result);
    expect(getRecentAssumedDisruptiveCommandBlock('recover from the failed sudo reboot command')).toContain('successfully initiated');

    const timedOut = normalizeLivePowerShellCommandResult(command, {
      status: 'error',
      output: 'Response body timed out after 25s.',
      error: 'Response body timed out after 25s.'
    });
    expect(timedOut.status).toBe('success');
    expect(timedOut.assumed_success).toBe(true);
    expect(timedOut.output).not.toMatch(/timed out|failed|error/i);

    const shutdownResult = normalizeLivePowerShellCommandResult('ssh prod "sudo shutdown -r now"', {
      status: 'error',
      output: '',
      stderr: 'client_loop: send disconnect: Broken pipe',
      message: 'Process exited with code 255.',
      exitCode: 255,
      timedOut: false,
      cancelled: false
    });
    expect(shutdownResult.status).toBe('success');
    expect(shutdownResult.assumed_success).toBe(true);
    expect(shutdownResult.diagnostic_output).toContain('Broken pipe');

    const scheduled = normalizeLivePowerShellCommandResult('ssh prod "sudo shutdown -r now"', {
      status: 'error',
      output: 'Shutdown scheduled for Thu 2026-05-28 13:40:00 CEST, use shutdown -c to cancel.',
      exitCode: 1
    });
    expect(scheduled.status).toBe('success');
    expect(scheduled.assumed_success).toBe(true);

    const denied = normalizeLivePowerShellCommandResult(command, {
      status: 'error',
      output: 'Permission denied (publickey).',
      exitCode: 255
    });
    expect(denied.status).toBe('error');
    expect(denied.assumed_success).not.toBe(true);

    const refused = normalizeLivePowerShellCommandResult('ssh prod "sudo shutdown -r now"', {
      status: 'error',
      output: 'ssh: connect to host 203.0.113.10 port 22: Connection refused',
      exitCode: 255
    });
    expect(refused.status).toBe('error');
    expect(refused.assumed_success).not.toBe(true);
  });

  it('offers Gemini 3.1 Flash Live, the 2.5 fallback, and the voice reasoning selector in settings', () => {
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'index.html'), 'utf8');

    expect(indexHtml).toContain('models/gemini-3.1-flash-live-preview');
    expect(indexHtml).toContain('models/gemini-2.5-flash-native-audio-preview-12-2025');
    // Selector is back (defaulting to minimal).
    expect(indexHtml).toContain('select-live-thinking-level');
    expect(indexHtml).toContain('input-smart-main-routing-enabled');
    expect(indexHtml).toContain('input-assistant-name');
    expect(indexHtml).toContain('Subagent Prompt Brain');
    expect(indexHtml).toContain('Refine subagent prompts and steering with the selected subagent model');
    expect(indexHtml).toContain('01-state-dom.js?v=release150b-20260530');
    expect(indexHtml).toContain('11-subagents-runner.js?v=ctx-overflow-recovery-20260530');
  });

  it('offers LM Studio + custom OpenAI-compatible subagent providers, with local Ollama removed', () => {
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'index.html'), 'utf8');
    const runner = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
    const runPs1 = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');

    // Local Ollama was removed: on consumer GPUs Ollama offloaded big models to the CPU
    // (~20W, unusably slow) regardless of Shadow's request. LM Studio / custom endpoints stay.
    expect(indexHtml).not.toContain('value="ollama_local"');
    expect(runner).not.toContain("'ollama_local'");
    expect(runPs1).not.toContain('/api/ollama/local/');

    // On-device LM Studio (Local) was removed; the custom OpenAI-compatible endpoint stays (paid/cloud).
    expect(indexHtml).not.toContain('lmstudio_local');
    expect(indexHtml).not.toContain('input-lmstudio-endpoint');
    expect(runner).not.toContain('getLmstudioBase');
    expect(runPs1).not.toContain('/api/lmstudio/models');
    expect(indexHtml).toContain('<option value="custom_openai">Custom (OpenAI-compatible)</option>');
    expect(indexHtml).toContain('input-custom-endpoint');
    expect(indexHtml).toContain('input-custom-model');
    expect(runner).toContain("subagentProvider === 'custom_openai'");
    expect(runner).toContain('getCustomOpenAiBase()');
    expect(runPs1).toContain('/api/openai-compat/models');

    // Context-window exhaustion is handled gracefully (trim+continue, then finish) — not a crash.
    expect(runner).toContain('looksLikeContextOverflowError');
    expect(runner).toContain('contextTrims');
  });

  it('wires Subagent Prompt Brain refinement through settings and the selected subagent model', () => {
    const stateDom = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const memory = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '08-memory.js'), 'utf8');
    const bootUi = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '02-boot-ui.js'), 'utf8');
    const screenConfig = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '03-screen-config.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const subagentRunner = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');

    expect(stateDom).toContain('shadow_assistant_name');
    expect(memory).toContain('Your current personal name is');
    expect(memory).toContain('normalizeAssistantMemoryGraph');
    expect(bootUi).toContain('inputAssistantName.value = getAssistantName()');
    expect(screenConfig).toContain('shadow_assistant_name: getAssistantName()');
    expect(screenConfig).toContain('assistant_name: getAssistantName()');
    expect(screenConfig).toContain('requestedArgs.assistant_name');
    expect(liveConnection).toContain('assistant_name');
    expect(stateDom).toContain("let smartMainRoutingEnabled = localStorage.getItem('shadow_smart_main_routing_enabled') === 'true'");
    expect(stateDom).toContain('SUBAGENT PROMPT BRAIN');
    expect(stateDom).toContain('Normal voice conversation stays direct through Gemini Live');
    expect(stateDom).toContain('MEDICAL TONE');
    expect(stateDom).toContain('Do not give generic medical disclaimers');
    expect(stateDom).toContain('durable memory explicitly says the user wants conservative medical referrals');
    expect(memory).toContain('Medical tone');
    expect(memory).toContain('do not automatically tell the user to contact a medical provider');
    expect(memory).toContain('memory explicitly says the user wants conservative medical referrals');
    expect(memory).toContain('REMEMBERED UNIT/FORMAT PREFERENCES FOR THIS TURN');
    expect(memory).toContain('do the conversion math yourself');
    expect(liveConnection).toContain('getRelevantUnitPreferenceContext');
    expect(liveConnection).toContain('unit_preference_instruction');
    // The search query must stay clean — appending unit words returned wrong values.
    expect(liveConnection).not.toContain('effectiveQuery');
    expect(memory).toContain('Subagent Prompt Brain is ON');
    expect(memory).toContain('Ordinary voice conversation stays direct');
    expect(memory).toContain('The app refines those prompts through the selected subagent model');
    expect(bootUi).toContain('oldSmartMainRoutingEnabled');
    expect(bootUi).toContain("changedWhat.push('subagent prompt brain')");
    expect(screenConfig).toContain('shadow_smart_main_routing_enabled: smartMainRoutingEnabled');
    expect(screenConfig).toContain('smart_main_routing_enabled: smartMainRoutingEnabled');
    expect(liveConnection).toContain('getSmartConsultProvider');
    expect(liveConnection).toContain('Refining subagent prompt.');
    expect(liveConnection).toContain('Subagent prompt refined.');
    expect(liveConnection).toContain('observeSmartMainToolBatch');
    expect(liveConnection).toContain('startSmartMainBackgroundAgentFromTranscript');
    expect(liveConnection).toContain('refineSubagentInstructionWithSelectedModel');
    expect(liveConnection).toContain('Foreground smart consult was executable work; started background routing instead.');
    expect(liveConnection).toContain('Do not continue direct voice web searches for this request.');
    expect(liveConnection).toContain('Smart consulting is disabled for ordinary voice conversation');
    expect(liveConnection).toContain('Do not repeat the internal task prompt');
    expect(liveConnection).toContain('Say this in first person');
    expect(liveConnection).toContain('transport_error_interpreted');
    expect(liveConnection).toContain("status: 'success',\n                  no_action: true");
    expect(liveConnection).not.toContain('successfully spawned for task');
    expect(subagentRunner).toContain('runSubagentPromptRefinement');
    expect(subagentRunner).toContain('runNormalizedSubagentPowerShellCommand');
    expect(subagentRunner).toContain('assumed_success: Boolean(cmdJson.assumed_success)');
    expect(subagentRunner).toContain('If run_powershell_command returns assumed_success=true');
    expect(subagentRunner).toContain('buildSubagentPromptRefinementInstructions');
    expect(subagentRunner).toContain("if (provider === 'gemini')");
    expect(subagentRunner).toContain('createGeminiSmartConsultPayload');
    expect(subagentRunner).toContain('createChatSmartConsultPayload');
    expect(subagentRunner).toContain('createOllamaSmartConsultPayload');
    expect(subagentRunner).toContain('https://ollama.com/api/chat');
    expect(subagentRunner).toContain('USER AUTHORIZATION CONTEXT');
    // Generic, config/memory-driven authorization — no hardcoded developer infra.
    expect(subagentRunner).toContain('the user owns specific infrastructure');
    expect(subagentRunner).toContain('authorized infrastructure maintenance that needs a background subagent');
    expect(subagentRunner).toContain("scoped to the user's own declared assets");
  });

  it('instructs the voice model on tool speech timing (quiet for quick tools, heads-up for slow ones)', () => {
    const stateDom = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '01-state-dom.js'), 'utf8');

    expect(stateDom).toContain('For QUICK tools, call them silently first');
    expect(stateDom).toContain('pause for tool results');
    // Slow actions get a spoken heads-up first so the user is not left in silence.
    expect(stateDom).toContain('say a brief natural heads-up FIRST');
  });

  it('allows Shadow source maintenance through background subagents instead of refusing self-modification', () => {
    const stateDom = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const subagentRunner = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');

    expect(stateDom).toContain('SELF-MAINTENANCE: You may inspect and modify Shadow AI');
    expect(stateDom).toContain('Do NOT refuse solely because the target is Shadow AI');
    expect(stateDom).not.toContain('Self-Protection: You MUST NEVER modify Shadow AI');
    expect(subagentRunner).toContain('SELF-MAINTENANCE: If the task is explicitly about fixing');
    expect(subagentRunner).not.toContain('NON-OVERRIDABLE SELF-PROTECTION');
    expect(subagentRunner).not.toContain('isShadowSelfModificationCommand(call.args.command)');
    expect(liveConnection).toContain('Shadow source modification must run in a background subagent.');
    expect(liveConnection).not.toContain('Blocked subagent self-modification request');
    expect(launcher).toContain('Shadow may maintain its own source');
    expect(launcher).not.toContain("would modify Shadow AI's own source code or configuration");
    expect(launcher).not.toContain('Push-Location $env:USERPROFILE');
  });

  it('fetches live weather from a real data source instead of guessing from search snippets', () => {
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const memory = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '08-memory.js'), 'utf8');
    const launcher = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');

    // A dedicated get_weather tool backed by the /api/weather proxy.
    expect(liveConnection).toContain("name: 'get_weather'");
    expect(liveConnection).toContain("call.name === 'get_weather'");
    expect(liveConnection).toContain("'/api/weather'");
    // search_web no longer advertises weather, and warns the model off snippet temps.
    expect(liveConnection).toContain('weather_tool_hint');
    // System prompt routes ALL weather (incl. forecasts) to get_weather and forbids guessing.
    expect(memory).toContain('ALWAYS call get_weather');
    expect(memory).toContain('web-search snippet');
    // Backend proxy uses the free Open-Meteo API and returns Celsius + km/h.
    expect(launcher).toContain('/api/weather');
    expect(launcher).toContain('api.open-meteo.com');
    expect(launcher).toContain('temperature_unit=celsius');
    expect(launcher).toContain('wind_speed_unit=kmh');
  });

  it('lets the model recall any stored memory on demand instead of only what fits the prompt', () => {
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const memory = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '08-memory.js'), 'utf8');

    // On-demand recall tool wired to the existing scoring functions.
    expect(liveConnection).toContain("name: 'recall_memory'");
    expect(liveConnection).toContain("call.name === 'recall_memory'");
    expect(liveConnection).toContain('scoreMemoryForQuery');
    expect(liveConnection).toContain('memoryRecallTokens');
    // System prompt tells the model to recall instead of giving up or reading the file.
    expect(memory).toContain('call recall_memory to search your full long-term memory');
    expect(memory).toContain('Never read the memory file manually');
    // Importance-first ordering for the in-prompt cache, leaving preference ordering intact.
    expect(memory).toContain('orderMemoryNodesByImportance');
  });

  it('parameterizes the user name instead of hardcoding "Dylan" (multi-user groundwork)', () => {
    const stateDom = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const memory = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '08-memory.js'), 'utf8');
    const bootUi = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '02-boot-ui.js'), 'utf8');
    const screenConfig = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '03-screen-config.js'), 'utf8');

    // Configurable user name mirroring the assistant-name pattern.
    expect(stateDom).toContain('function getUserName()');
    expect(stateDom).toContain("localStorage.getItem('shadow_user_name')");
    expect(screenConfig).toContain('config.shadow_user_name');
    expect(screenConfig).toContain('shadow_user_name: getUserName()');
    // Public default is neutral (empty), with a grammatical fallback for prompt/memory text.
    expect(stateDom).toContain("const DEFAULT_USER_NAME = ''");
    expect(stateDom).toContain('function getUserLabel()');
    // Memory templates fall back to "the user" when no name is set (never hardcoded Dylan).
    expect(memory).not.toContain("getUserName() : 'Dylan'");
    expect(memory).toContain('about ${userLabel} and ${assistantLabel}');
    expect(memory).not.toContain('Dylan has ${years}');
    expect(bootUi).toContain('label: getUserName()');
    expect(bootUi).not.toContain('label: "Dylan"');
  });

  it('exposes a Your Name settings field wired to load and save', () => {
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'index.html'), 'utf8');
    const stateDom = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const bootUi = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '02-boot-ui.js'), 'utf8');

    expect(indexHtml).toContain('id="input-user-name"');
    expect(stateDom).toContain("getElementById('input-user-name')");
    // Saved on Save, populated on open/init.
    expect(bootUi).toContain('userName = normalizeUserName(inputUserName.value)');
    expect(bootUi).toContain("localStorage.setItem('shadow_user_name', userName)");
    expect(bootUi).toContain('inputUserName.value = getUserName()');
  });

  it('provides a guided, skippable Google setup wizard with deep-links and a copyable redirect URI', () => {
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'index.html'), 'utf8');
    const googleWs = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '13-google-workspace.js'), 'utf8');
    const bootUi = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '02-boot-ui.js'), 'utf8');

    // Wizard scaffold + deep-links to the exact Google Cloud console pages.
    expect(indexHtml).toContain('id="google-setup-wizard"');
    expect(indexHtml).toContain('console.cloud.google.com/projectcreate');
    expect(indexHtml).toContain('console.cloud.google.com/apis/credentials/consent');
    expect(indexHtml).toContain('console.cloud.google.com/apis/credentials');
    // Each integration the app supports has an enable-API deep-link, Drive included.
    expect(indexHtml).toContain('console.cloud.google.com/apis/library/gmail.googleapis.com');
    expect(indexHtml).toContain('console.cloud.google.com/apis/library/calendar-json.googleapis.com');
    expect(indexHtml).toContain('console.cloud.google.com/apis/library/people.googleapis.com');
    expect(indexHtml).toContain('console.cloud.google.com/apis/library/drive.googleapis.com');
    // Copyable redirect URI field + the unverified-app heads-up.
    expect(indexHtml).toContain('id="google-redirect-uri-display"');
    expect(indexHtml).toContain("Google hasn't verified this app");
    // It must read as optional/skippable.
    expect(indexHtml).toMatch(/Google features are <strong>optional<\/strong>/);
    // Wiring: status populates the redirect URI; the copy button is hooked up.
    expect(googleWs).toContain('googleRedirectUriDisplay.value = data.redirectUri');
    expect(bootUi).toContain('btnCopyRedirectUri.addEventListener');
  });

  it('can set Drive link sharing (anyone-with-link) and return the shareable link', () => {
    const googleWs = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '13-google-workspace.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');

    expect(googleWs).toContain('async function googleDriveSetSharing');
    expect(googleWs).toContain("type: 'anyone'");
    expect(liveConnection).toContain("name: 'google_drive_set_link_sharing'");
    expect(liveConnection).toContain('googleDriveSetSharing(call.args)');
  });

  it('uses the raw WebSocket setup wrapper for Live connections', () => {
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');

    expect(liveConnection).toContain('setup: {');
    expect(liveConnection).toContain('generationConfig: {');
    expect(liveConnection).toContain("responseModalities: ['AUDIO']");
    expect(liveConnection).toContain("activityHandling: 'NO_INTERRUPTION'");
    expect(liveConnection).toContain('generationConfig.thinkingConfig');
    expect(liveConnection).toContain('setupMessage.setup.sessionResumption.handle');
    expect(liveConnection).not.toContain('setupMessage.config');
    // Sliding-window context compression keeps the session from hitting the duration cap and dropping
    // (the main cause of periodic 1006 disconnects), now with explicit token bounds so latency stays
    // flat over long calls instead of growing with accumulated context.
    expect(liveConnection).toContain('contextWindowCompression');
    expect(liveConnection).toContain('triggerTokens');
    expect(liveConnection).toContain('slidingWindow: { targetTokens:');
  });

  it('guards Live tool responses against stale sockets', async () => {
    const {
      isCurrentLiveSocket,
      registerLiveToolCall,
      unregisterLiveToolCall,
      getRegisteredToolName,
      sendLiveToolResponse,
      sendLiveToolOutputFromOperation,
      sent,
      activeSocket,
      staleSocket,
      closeActiveSocket,
      replaceActiveSocket
    } = loadLiveSocketSendFunctions();

    expect(isCurrentLiveSocket(activeSocket, 7)).toBe(true);
    expect(isCurrentLiveSocket(staleSocket, 7)).toBe(false);
    expect(sendLiveToolResponse(activeSocket, 7, 'call_1', { status: 'success' })).toBe(true);
    expect(JSON.parse(sent[0])).toEqual({
      toolResponse: {
        functionResponses: [
          {
            response: { status: 'success' },
            id: 'call_1'
          }
        ]
      }
    });

    registerLiveToolCall('call_named', 0, 'get_active_subagents');
    expect(getRegisteredToolName('call_named')).toBe('get_active_subagents');
    expect(sendLiveToolResponse(activeSocket, 7, 'call_named', { status: 'success' })).toBe(true);
    expect(JSON.parse(sent[1])).toEqual({
      toolResponse: {
        functionResponses: [
          {
            response: { status: 'success' },
            id: 'call_named',
            name: 'get_active_subagents'
          }
        ]
      }
    });
    unregisterLiveToolCall('call_named');
    expect(getRegisteredToolName('call_named')).toBeUndefined();

    expect(await sendLiveToolOutputFromOperation(activeSocket, 7, 'call_2', async () => 'ok')).toBe(true);
    expect(JSON.parse(sent[2])).toEqual({
      toolResponse: {
        functionResponses: [
          {
            response: { output: 'ok', status: 'success' },
            id: 'call_2'
          }
        ]
      }
    });

    expect(await sendLiveToolOutputFromOperation(activeSocket, 7, 'call_3', async () => {
      throw new Error('boom');
    })).toBe(true);
    expect(JSON.parse(sent[3])).toEqual({
      toolResponse: {
        functionResponses: [
          {
            response: { output: 'boom', status: 'error' },
            id: 'call_3'
          }
        ]
      }
    });

    expect(sendLiveToolResponse(activeSocket, 6, 'call_old', { status: 'error' })).toBe(false);
    expect(sendLiveToolResponse(staleSocket, 7, 'call_stale', { status: 'error' })).toBe(false);
    expect(await sendLiveToolOutputFromOperation(activeSocket, 7, 'call_stale_after_wait', async () => {
      replaceActiveSocket();
      return 'late';
    })).toBe(false);
    closeActiveSocket();
    expect(sendLiveToolResponse(activeSocket, 7, 'call_closed', { status: 'error' })).toBe(false);
    expect(sendLiveToolResponse(activeSocket, 7, 'call_replaced', { status: 'error' })).toBe(false);
    expect(sent).toHaveLength(4);
  });

  it('invalidates outstanding Live tool responses after interruption', async () => {
    const {
      invalidateLiveToolOperations,
      registerLiveToolCall,
      unregisterLiveToolCall,
      getLiveToolAbortSignal,
      isLiveToolCallCurrent,
      isCurrentLiveToolBatch,
      sendLiveToolResponse,
      sendLiveToolOutputFromOperation,
      getLiveToolOperationEpoch,
      getRegisteredToolEpoch,
      sent,
      activeSocket
    } = loadLiveSocketSendFunctions();

    const initialEpoch = getLiveToolOperationEpoch();
    registerLiveToolCall('call_interrupted', initialEpoch);
    expect(isLiveToolCallCurrent('call_interrupted')).toBe(true);
    expect(isCurrentLiveToolBatch(activeSocket, 7, initialEpoch)).toBe(true);
    expect(getLiveToolAbortSignal('call_interrupted').aborted).toBe(false);

    invalidateLiveToolOperations('manual interrupt');

    expect(getLiveToolOperationEpoch()).toBe(initialEpoch + 1);
    expect(getRegisteredToolEpoch('call_interrupted')).toBe(initialEpoch);
    expect(isLiveToolCallCurrent('call_interrupted')).toBe(false);
    expect(isCurrentLiveToolBatch(activeSocket, 7, initialEpoch)).toBe(false);
    expect(getLiveToolAbortSignal('call_interrupted').aborted).toBe(true);
    expect(sendLiveToolResponse(activeSocket, 7, 'call_interrupted', { status: 'success' })).toBe(false);
    expect(await sendLiveToolOutputFromOperation(activeSocket, 7, 'call_interrupted', async () => 'late')).toBe(false);
    expect(sent).toHaveLength(0);

    registerLiveToolCall('call_current', getLiveToolOperationEpoch());
    expect(getLiveToolAbortSignal('call_current').aborted).toBe(false);
    expect(sendLiveToolResponse(activeSocket, 7, 'call_current', { status: 'success' })).toBe(true);
    unregisterLiveToolCall('call_current');
    expect(sent).toHaveLength(1);
  });

  it('keeps committed side-effect tool calls (Drive upload) alive through a barge-in', async () => {
    const {
      invalidateLiveToolOperations,
      registerLiveToolCall,
      markLiveToolCallCommitted,
      unregisterLiveToolCall,
      getLiveToolAbortSignal,
      isLiveToolCallCurrent,
      sendLiveToolResponse,
      getLiveToolOperationEpoch,
      sent,
      activeSocket
    } = loadLiveSocketSendFunctions();

    const initialEpoch = getLiveToolOperationEpoch();
    registerLiveToolCall('call_upload', initialEpoch, 'google_drive_upload_local_file');
    markLiveToolCallCommitted('call_upload');
    expect(getLiveToolAbortSignal('call_upload').aborted).toBe(false);

    // A barge-in (interrupt) bumps the epoch, but the committed upload must NOT be
    // aborted and its success result must STILL be delivered — otherwise the model is
    // stranded on "thinking" believing the upload failed even though it reached Google.
    invalidateLiveToolOperations('manual interrupt');

    expect(getLiveToolOperationEpoch()).toBe(initialEpoch + 1);
    expect(getLiveToolAbortSignal('call_upload').aborted).toBe(false);
    expect(isLiveToolCallCurrent('call_upload')).toBe(true);
    expect(sendLiveToolResponse(activeSocket, 7, 'call_upload', { output: { id: 'file123' }, status: 'success' })).toBe(true);
    expect(sent).toHaveLength(1);

    // Once the call is unregistered, it is no longer treated as committed.
    unregisterLiveToolCall('call_upload');
    expect(isLiveToolCallCurrent('call_upload')).toBe(true); // unknown id defaults to current
  });

  it('suppresses late helper operation output after interruption even without pre-registration', async () => {
    const {
      invalidateLiveToolOperations,
      sendLiveToolOutputFromOperation,
      getRegisteredToolEpoch,
      sent,
      activeSocket
    } = loadLiveSocketSendFunctions();

    let signalDuringOperation = null;
    const sentResult = await sendLiveToolOutputFromOperation(activeSocket, 7, 'call_temp_operation', async signal => {
      signalDuringOperation = signal;
      invalidateLiveToolOperations('interrupt while helper operation is running');
      expect(signal.aborted).toBe(true);
      return 'late output';
    });

    expect(sentResult).toBe(false);
    expect(signalDuringOperation.aborted).toBe(true);
    expect(getRegisteredToolEpoch('call_temp_operation')).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('cancels active Live work immediately when a reconnect path starts', async () => {
    const {
      cancelActiveLiveWork,
      registerLiveToolCall,
      getLiveToolAbortSignal,
      isLiveToolCallCurrent,
      sendLiveToolResponse,
      getLiveToolOperationEpoch,
      cancelledSmartConsults,
      cancelledBackendCommands,
      cancelledWorkspaceRequests,
      sent,
      activeSocket
    } = loadLiveSocketSendFunctions();

    const initialEpoch = getLiveToolOperationEpoch();
    registerLiveToolCall('call_reconnect', initialEpoch);
    const signal = getLiveToolAbortSignal('call_reconnect');
    expect(signal.aborted).toBe(false);

    cancelActiveLiveWork('voice settings soft reconnect');

    expect(getLiveToolOperationEpoch()).toBe(initialEpoch + 1);
    expect(signal.aborted).toBe(true);
    expect(isLiveToolCallCurrent('call_reconnect')).toBe(false);
    expect(cancelledSmartConsults).toEqual(['voice settings soft reconnect']);
    expect(cancelledBackendCommands).toEqual(['voice settings soft reconnect']);
    expect(cancelledWorkspaceRequests).toEqual(['voice settings soft reconnect']);
    expect(sendLiveToolResponse(activeSocket, 7, 'call_reconnect', { status: 'success' })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('uses sustained local speech for playback interruption instead of server auto-cutoff', () => {
    const stateDom = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const audio = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '04-audio.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');

    expect(stateDom).toContain('const BARGE_IN_COOLDOWN_MS = 300');
    expect(stateDom).toContain('const BARGE_IN_CONFIRMATION_WINDOW_MS = 700');
    expect(stateDom).toContain('const LOCAL_BARGE_IN_REQUIRED_FRAMES = 4');
    expect(stateDom).toContain('const LOCAL_BARGE_IN_DYNAMIC_CONFIRM_FRAMES = 2');
    expect(stateDom).toContain('const LOCAL_BARGE_IN_MIN_SPEECH_MS = 260');
    expect(stateDom).toContain('const LOCAL_BARGE_IN_MIN_INTERVAL_MS = 900');
    expect(stateDom).toContain('const LOCAL_BARGE_IN_PREROLL_GATE_MULTIPLIER = 0.05');
    expect(stateDom).toContain('const LOCAL_BARGE_IN_PREROLL_MAX_CHUNKS = 24');
    expect(stateDom).toContain('const LOCAL_BARGE_IN_PREROLL_MAX_AGE_MS = 1600');
    expect(stateDom).toContain('const INTERRUPTED_USER_AUDIO_SETTLE_MS = 900');
    expect(stateDom).toContain('const INTERRUPTED_USER_AUDIO_MAX_HOLD_MS = 2500');
    expect(liveConnection).toContain('function getLocalBargeInCandidateThreshold');
    expect(liveConnection).toContain('function isLiveWorkActiveForVoiceBargeIn');
    expect(liveConnection).toContain('function shouldHoldInterruptedAudioForUserSpeech');
    expect(liveConnection).toContain('function shouldDeferServerInterruptFallbackForUserAudio');
    expect(liveConnection).toContain('Holding model audio while interrupted user speech is still active.');
    expect(audio).toContain('queueLocalBargeInPrerollChunk');
    expect(audio).toContain('consumeLocalBargeInPrerollChunks');
    expect(audio).toContain('micAboveCandidateThreshold');
    expect(audio).toContain('echoProtected: playbackActiveForBargeIn ? micAboveThreshold : true');
    expect(audio).toContain('preservePreroll: activeWorkForBargeIn');
    expect(liveConnection).toContain('LOCAL_BARGE_IN_MIN_SPEECH_MS');
    expect(liveConnection).toContain('manualInterrupt({ sendToServer: false, preserveLocalBargeIn: true })');
    expect(audio).toContain("sendServerInterruptSignal('local barge-in after mic pre-roll')");
    expect(liveConnection).toContain('The user is already speaking in the live audio stream');
  });

  it('buffers output audio and avoids sending gated silence while Shadow speaks', () => {
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'index.html'), 'utf8');
    const audio = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '04-audio.js'), 'utf8');

    expect(audio).toContain('const OUTPUT_AUDIO_JITTER_BUFFER_SEC = 0.14');
    expect(audio).toContain('const OUTPUT_AUDIO_STALL_THINKING_MS = 2200');
    expect(audio).toContain('const OUTPUT_AUDIO_STALL_RECOVERY_MS = 8000');
    expect(audio).not.toContain('const OUTPUT_AUDIO_STALL_ABORT_MS = 8000');
    expect(audio).not.toContain('const OUTPUT_AUDIO_STALL_ABORT_MS = 1800');
    expect(audio).toContain('Output underrun');
    expect(audio).toContain('if (this.activeSources.length === 0)');
    expect(audio).toContain('this.nextPlayTime = 0');
    expect(audio).toContain('handleOutputAudioSoftStall()');
    expect(audio).toContain('handleOutputAudioRecoveryStall()');
    expect(audio).toContain("['speaking', 'thinking'].includes(currentVisualizerState)");
    expect(indexHtml).toContain('04-audio.js?v=audio-stall-recovery-20260528');
    expect(indexHtml).not.toContain('04-audio.js?v=interrupt-settle-20260527');
    expect(indexHtml).not.toContain('04-audio.js?v=prompt-stall-20260528');
    expect(indexHtml).not.toContain('04-audio.js?v=audio-stall-two-stage-20260528');
  });

  it('announces partial subagent results without calling them failures', () => {
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'index.html'), 'utf8');
    const runner = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
    const notifications = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '12-subagents-notifications.js'), 'utf8');

    expect(runner).toContain('notifyVoiceSessionOfPartial(task');
    expect(notifications).toContain('[Subagent${subagentId ? ` (${subagentId})` : \'\'} Partial]');
    expect(indexHtml).toContain('12-subagents-notifications.js?v=cred-prompt-20260529');
  });

  it('keeps voice connection manual-only without a wake-word listener', () => {
    const root = process.cwd();
    const indexHtml = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
    const bootUi = fs.readFileSync(path.join(root, 'src', 'scripts', '02-boot-ui.js'), 'utf8');
    const screenConfig = fs.readFileSync(path.join(root, 'src', 'scripts', '03-screen-config.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(root, 'src', 'scripts', '05-live-connection.js'), 'utf8');

    expect(screenConfig).toContain('const WAKE_WORD_CONNECT_ENABLED = false');
    expect(screenConfig).not.toContain('webkitSpeechRecognition');
    expect(screenConfig).not.toContain('hey shadow');
    expect(bootUi).not.toContain('startWakeWordListener();');
    expect(liveConnection).not.toContain('startWakeWordListener();');
    expect(indexHtml).toContain('02-boot-ui.js?v=release150b-20260530');
    expect(indexHtml).toContain('03-screen-config.js?v=remove-ollama-local-20260530');
    expect(indexHtml).toContain('05-live-connection.js?v=remove-ollama-local-20260530');
    expect(indexHtml).toContain('08-memory.js?v=steer-not-cancel-20260530');
    expect(indexHtml).toContain('10-scheduler-proactive.js?v=reboot-truth-20260528');
  });

  it('clears expired Live resumption handles when Gemini closes the socket', () => {
    const root = process.cwd();
    const liveConnection = fs.readFileSync(path.join(root, 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const functionSource = extractFunctionSource(liveConnection, 'isResumptionSocketClose');
    const sandbox = vm.createContext({});

    vm.runInContext(`${functionSource}\nresult = { isResumptionSocketClose };`, sandbox);

    expect(sandbox.result.isResumptionSocketClose({
      code: 1008,
      reason: 'BidiGenerateContent session expired'
    })).toBe(true);
    expect(sandbox.result.isResumptionSocketClose({
      code: 1008,
      reason: 'API key invalid'
    })).toBe(false);
    expect(liveConnection).toContain('retryWithoutResumptionHandle(formatSocketCloseMessage(event');
    expect(liveConnection).toContain('clearLiveSessionResumptionToken();');
  });

  it('treats one-off Live 1007 invalid realtime payload closes as reconnectable', () => {
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');
    const functionSource = [
      extractFunctionSource(liveConnection, 'isInvalidRealtimePayloadSocketClose'),
      extractFunctionSource(liveConnection, 'noteInvalidRealtimePayloadSocketClose'),
      extractFunctionSource(liveConnection, 'isPermanentSocketClose'),
      extractFunctionSource(liveConnection, 'isTransientSocketClose')
    ].join('\n\n');
    const sandbox = vm.createContext({
      TRANSIENT_SOCKET_CLOSE_CODES: new Set([1001, 1006, 1007, 1011, 1012, 1013, 1014]),
      INVALID_REALTIME_PAYLOAD_RECONNECT_WINDOW_MS: 30000,
      invalidRealtimePayloadCloseTimes: []
    });

    vm.runInContext(`${functionSource}\nresult = { isInvalidRealtimePayloadSocketClose, noteInvalidRealtimePayloadSocketClose, isPermanentSocketClose, isTransientSocketClose };`, sandbox);

    const invalidRealtimePayload = {
      code: 1007,
      reason: 'Request contains an invalid argument.'
    };
    expect(sandbox.result.isInvalidRealtimePayloadSocketClose(invalidRealtimePayload)).toBe(true);
    expect(sandbox.result.isPermanentSocketClose(invalidRealtimePayload)).toBe(false);
    expect(sandbox.result.isTransientSocketClose(invalidRealtimePayload)).toBe(true);
    expect(sandbox.result.noteInvalidRealtimePayloadSocketClose(1000)).toBe(1);
    expect(sandbox.result.noteInvalidRealtimePayloadSocketClose(2000)).toBe(2);
    expect(sandbox.result.noteInvalidRealtimePayloadSocketClose(40000)).toBe(1);
    expect(sandbox.result.isPermanentSocketClose({
      code: 1008,
      reason: 'API key invalid'
    })).toBe(true);
    expect(liveConnection).toContain('clearPendingSystemNotifications');
    expect(liveConnection).toContain('Stopped reconnect loop after repeated invalid realtime payload closes');
  });

  it('invalidates active Live work before direct socket-close reconnects', () => {
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');

    expect(liveConnection).toContain("cancelActiveLiveWork('voice channel setup timed out')");
    expect(liveConnection).toContain("cancelActiveLiveWork('Live API requested reconnect')");
    expect(liveConnection).toContain("cancelActiveLiveWork('voice settings soft reconnect')");
    expect(liveConnection).toContain("cancelActiveLiveWork('voice session disconnected')");
  });

  it('locks voice, model, subagent, and proactive settings from voice updates', () => {
    const screenConfig = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '03-screen-config.js'), 'utf8');
    const liveConnection = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '05-live-connection.js'), 'utf8');

    [
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
    ].forEach(key => expect(screenConfig).toContain(`'${key}'`));

    expect(screenConfig).toContain('sanitizeVoiceControlledSettingsUpdate(args, warnings)');
    expect(liveConnection).not.toContain('Main voice name.');
    expect(liveConnection).not.toContain('Main Live model.');
    expect(liveConnection).not.toContain('Proactive profile.');
    expect(liveConnection).not.toContain('Provider-specific subagent model value.');
  });

  it('exposes an in-app auto-update check (backend endpoint, toast, settings toggle)', () => {
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'index.html'), 'utf8');
    const runPs1 = fs.readFileSync(path.join(process.cwd(), 'run.ps1'), 'utf8');
    const stateDom = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const bootUi = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '02-boot-ui.js'), 'utf8');

    // Backend: compares installed version to the latest GitHub release.
    expect(runPs1).toContain('/api/update-check');
    expect(runPs1).toContain('releases/latest');
    expect(runPs1).toContain('update_available');

    // UI: toast + settings toggle.
    expect(indexHtml).toContain('id="update-toast"');
    expect(indexHtml).toContain('id="btn-update-now"');
    expect(indexHtml).toContain('id="btn-update-later"');
    expect(indexHtml).toContain('input-auto-update-check');

    // State default: check ON unless explicitly disabled.
    expect(stateDom).toContain("let autoUpdateCheckEnabled = localStorage.getItem('shadow_auto_update_check') !== 'false'");

    // Boot wiring + render, using the timeout-wrapped reader (never raw res.json()).
    expect(bootUi).toContain('maybeCheckForUpdate()');
    expect(bootUi).toContain('function showUpdateToast');
    expect(bootUi).toContain("fetchLocalApiWithTimeout('/api/update-check'");
    expect(bootUi).toContain('shadow_update_dismissed_version');
  });

  it('runs a multi-step onboarding wizard covering personalization + subagent setup', () => {
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'index.html'), 'utf8');
    const bootUi = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '02-boot-ui.js'), 'utf8');

    // Wizard scaffolding: step dots + three steps + nav.
    expect(indexHtml).toContain('id="onboarding-steps"');
    expect(indexHtml).toContain('class="onboarding-step-dot active" data-step="1"');
    expect(indexHtml).toContain('data-step="3"');
    expect(indexHtml).toContain('id="btn-onboard-next"');
    expect(indexHtml).toContain('id="btn-onboard-back"');

    // Personalization fields.
    expect(indexHtml).toContain('id="onboarding-user-name"');
    expect(indexHtml).toContain('id="onboarding-assistant-name"');
    expect(indexHtml).toContain('id="onboarding-voice"');
    expect(indexHtml).toContain('id="onboarding-accent"');

    // 4 steps now: mic-check step + live "meet your voice" carousel + forced subagent connection test.
    expect(indexHtml).toContain('data-step="4"');
    expect(indexHtml).toContain('id="onboarding-mic-device"');
    expect(indexHtml).toContain('id="onboarding-mic-meter-fill"');
    expect(indexHtml).toContain('id="onboarding-voice-orb"');
    expect(indexHtml).toContain('id="btn-voice-prev"');
    expect(indexHtml).toContain('id="btn-voice-next"');
    expect(indexHtml).toContain('id="btn-onboarding-test-subagent"');

    // Subagent setup step: provider, endpoint, key, per-provider model, and Codex sign-in.
    expect(indexHtml).toContain('id="onboarding-subagent-provider"');
    expect(indexHtml).toContain('id="onboarding-subagent-endpoint"');
    expect(indexHtml).toContain('id="onboarding-subagent-key"');
    expect(indexHtml).toContain('id="onboarding-subagent-model"');
    expect(indexHtml).toContain('id="onboarding-subagent-model-text"');
    expect(indexHtml).toContain('id="btn-onboarding-detect-models"');
    expect(indexHtml).toContain('id="onboarding-codex-group"');
    expect(indexHtml).toContain('id="btn-onboarding-codex-login"');

    // Wizard logic in boot.
    expect(bootUi).toContain('function initOnboardingWizard');
    expect(bootUi).toContain('function goToOnboardingStep');
    expect(bootUi).toContain('async function applyOnboardingSubagentChoice');
    expect(bootUi).toContain('function getOnboardingModelSourceSelect');
    expect(bootUi).toContain('async function onboardingDetectModels');
    expect(bootUi).toContain('async function triggerOnboardingCodexLogin');
    expect(bootUi).toContain("fetchLocalApiWithTimeout('/api/codex/login'");
    expect(bootUi).toContain('initOnboardingWizard();');
    // The custom endpoint auto-detects a model so it is never left with a broken model id.
    expect(bootUi).toContain('/api/openai-compat/models?endpoint=');

    // Mic check, live voice carousel, and the forced subagent connection test.
    expect(bootUi).toContain('function startOnboardingMicMeter');
    expect(bootUi).toContain('function startOnboardingVoiceCarousel');
    expect(bootUi).toContain('function runOnboardingSubagentTest');
    expect(bootUi).toContain('function updateOnboardingNavGate');
    const onboardingVoiceModule = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '14-onboarding-voice.js'), 'utf8');
    expect(onboardingVoiceModule).toContain('function startOnboardingVoicePreview');
    expect(onboardingVoiceModule).toContain('function stopOnboardingVoicePreview');
    expect(onboardingVoiceModule).toContain("responseModalities: ['AUDIO']");
  });
});
