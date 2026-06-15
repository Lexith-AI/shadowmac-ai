/**
 * ShadowMac - Gemini Live websocket connection, reconnection, mute, and interruption handling.
 * Split from the original monolithic app.js; loaded as an ordered classic script.
 */

// --- WebSocket Connection Management ---
const activeLiveBackendCommandIds = new Set();
const ASSUMED_DISRUPTIVE_COMMAND_SPAWN_BLOCK_MS = 10 * 60 * 1000;
const INVALID_REALTIME_PAYLOAD_RECONNECT_WINDOW_MS = 30 * 1000;
const MAX_INVALID_REALTIME_PAYLOAD_RECONNECTS = 1;
let lastAssumedDisruptiveCommandResult = null;
let invalidRealtimePayloadCloseTimes = [];

function waitForNextFrame() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isCurrentLiveSocket(targetSocket, attemptId = connectionAttemptId) {
  return Boolean(
    targetSocket &&
    targetSocket === socket &&
    attemptId === connectionAttemptId &&
    typeof WebSocket !== 'undefined' &&
    targetSocket.readyState === WebSocket.OPEN
  );
}

function sendLiveSocketJson(targetSocket, attemptId, payload, label = 'Live socket message') {
  if (!isCurrentLiveSocket(targetSocket, attemptId)) {
    console.debug(`${label} skipped because the Live socket is no longer current/open.`);
    return false;
  }
  try {
    targetSocket.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn(`${label} failed to send:`, err);
    return false;
  }
}

function invalidateLiveToolOperations(reason = 'cancelled') {
  liveToolOperationEpoch++;
  for (const [callId, controller] of activeLiveToolAbortControllers.entries()) {
    // Never abort a committed side-effect operation (e.g. an in-flight Drive upload)
    // just because the AI was interrupted — the action is already happening remotely.
    if (committedLiveToolCallIds.has(callId)) continue;
    try {
      controller.abort();
    } catch {}
  }
  console.debug(`Invalidated outstanding Live tool operations (${liveToolOperationEpoch}): ${reason}`);
}

function cancelActiveLiveWork(reason = 'voice session interrupted') {
  invalidateLiveToolOperations(reason);
  if (typeof cancelActiveSmartConsult === 'function') {
    cancelActiveSmartConsult(reason);
  }
  cancelLiveBackendCommands(reason);
  if (typeof cancelWorkspaceBackendRequests === 'function') {
    cancelWorkspaceBackendRequests(reason);
  }
}

function registerLiveToolCall(callId, epoch = liveToolOperationEpoch, toolName = '') {
  if (!callId) return;
  activeLiveToolCallEpochs.set(callId, epoch);
  const normalizedToolName = String(toolName || '').trim();
  if (normalizedToolName) activeLiveToolCallNames.set(callId, normalizedToolName);
  if (typeof AbortController !== 'undefined' && !activeLiveToolAbortControllers.has(callId)) {
    activeLiveToolAbortControllers.set(callId, new AbortController());
  }
}

function unregisterLiveToolCall(callId) {
  if (callId) activeLiveToolCallEpochs.delete(callId);
  if (callId) activeLiveToolCallNames.delete(callId);
  if (callId) activeLiveToolAbortControllers.delete(callId);
  if (callId) committedLiveToolCallIds.delete(callId);
}

// Mark a tool call as a committed side effect: its result will still be delivered
// even after a barge-in/interrupt bumps the tool epoch (see committedLiveToolCallIds).
function markLiveToolCallCommitted(callId) {
  if (callId) committedLiveToolCallIds.add(callId);
}

function getLiveToolCallName(callId) {
  return callId ? activeLiveToolCallNames.get(callId) || '' : '';
}

function getLiveToolAbortSignal(callId) {
  const controller = callId ? activeLiveToolAbortControllers.get(callId) : null;
  return controller ? controller.signal : null;
}

function isLiveToolCallCurrent(callId) {
  if (!callId || !activeLiveToolCallEpochs.has(callId)) return true;
  // Committed side-effect operations always deliver their result (socket currency is
  // still enforced separately in sendLiveSocketJson), so a barge-in can't strand them.
  if (committedLiveToolCallIds.has(callId)) return true;
  return activeLiveToolCallEpochs.get(callId) === liveToolOperationEpoch;
}

function isCurrentLiveToolBatch(targetSocket, attemptId, epoch) {
  return isCurrentLiveSocket(targetSocket, attemptId) && epoch === liveToolOperationEpoch;
}

function sendLiveToolResponse(targetSocket, attemptId, callId, response, toolName = '') {
  if (!isLiveToolCallCurrent(callId)) {
    console.debug(`Live tool response ${callId || ''} skipped because the tool operation was interrupted or superseded.`);
    return false;
  }
  const functionResponse = {
    response,
    id: callId
  };
  const responseToolName = String(toolName || getLiveToolCallName(callId) || '').trim();
  if (responseToolName) functionResponse.name = responseToolName;
  return sendLiveSocketJson(targetSocket, attemptId, {
    toolResponse: {
      functionResponses: [
        functionResponse
      ]
    }
  }, 'Live tool response');
}

function normalizeSmartMainTextForHeuristic(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function isTrivialSmartMainBypassText(text) {
  const normalized = normalizeSmartMainTextForHeuristic(text).toLowerCase();
  if (!normalized) return true;
  if (normalized.length <= 10) return true;
  return /^(ok|okay|yes|yeah|yep|no|nope|thanks|thank you|stop|cancel|interrupt|pause|resume|hello|hi|hey)\b/.test(normalized);
}

function resetSmartMainTurnDiagnostics(firstTranscriptChunk = '') {
  if (!smartMainRoutingEnabled) return;
  smartMainTurnSequence++;
  smartMainConsultInCurrentTurn = false;
  smartMainRoutingToolInCurrentTurn = false;
  smartMainBypassLoggedForTurn = false;
  smartMainLastUserTranscript = normalizeSmartMainTextForHeuristic(firstTranscriptChunk);
  console.debug('[Smart] New voice turn observed.', {
    turn: smartMainTurnSequence,
    provider: typeof getSmartConsultProvider === 'function' ? getSmartConsultProvider() : subagentProvider,
    model: typeof getSmartConsultModel === 'function' ? getSmartConsultModel() : subagentModel
  });
}

function appendSmartMainUserTranscript(text) {
  if (!smartMainRoutingEnabled) return;
  const chunk = normalizeSmartMainTextForHeuristic(text);
  if (!chunk) return;
  smartMainLastUserTranscript = normalizeSmartMainTextForHeuristic(`${smartMainLastUserTranscript} ${chunk}`);
}

function noteSmartMainRoutingTool(toolName) {
  if (!smartMainRoutingEnabled) return;
  smartMainRoutingToolInCurrentTurn = true;
  console.debug('[Smart] Routing tool used for voice turn.', {
    turn: smartMainTurnSequence,
    tool: toolName
  });
}

function observeSmartMainToolBatch(toolNames) {
  if (!smartMainRoutingEnabled) return;
  console.debug('[Smart] Live tool batch observed.', {
    turn: smartMainTurnSequence,
    tools: Array.isArray(toolNames) ? toolNames : []
  });
}

function noteSmartMainConsultStarted(provider, model, prompt) {
  if (!smartMainRoutingEnabled) return Date.now();
  smartMainConsultInCurrentTurn = true;
  smartMainRoutingToolInCurrentTurn = true;
  smartMainLastConsultStartedAt = Date.now();
  console.log('[Smart] Consulting selected subagent model.', {
    turn: smartMainTurnSequence,
    provider,
    model,
    promptChars: String(prompt || '').length
  });
  return smartMainLastConsultStartedAt;
}

function noteSmartMainConsultFinished(provider, model, startedAt, result) {
  if (!smartMainRoutingEnabled) return;
  const durationMs = startedAt ? Date.now() - startedAt : 0;
  console.log('[Smart] Consult completed.', {
    turn: smartMainTurnSequence,
    provider,
    model,
    durationMs,
    answerChars: String((result && result.answer) || '').length
  });
  addSystemMessage(`[Smart] Consulted ${provider} / ${model} in ${(durationMs / 1000).toFixed(1)}s.`);
}

function noteSmartMainConsultFailed(provider, model, startedAt, err) {
  if (!smartMainRoutingEnabled) return;
  const durationMs = startedAt ? Date.now() - startedAt : 0;
  console.warn('[Smart] Consult failed.', {
    turn: smartMainTurnSequence,
    provider,
    model,
    durationMs,
    error: err && err.message ? err.message : String(err)
  });
}

async function refineSubagentInstructionWithSelectedModel(kind, text, context = {}) {
  const rawText = String(text || '').trim();
  if (!rawText) throw new Error('Subagent instruction is empty.');
  if (!smartMainRoutingEnabled || typeof runSubagentPromptRefinement !== 'function') return rawText;

  // Refine the prompt with the user's SELECTED subagent model — that's the whole point (they chose it
  // because it prompts better than the realtime voice model). Retry once on an empty result, and if it
  // still comes back empty the caller falls back to the original task so the spawn is never lost.
  const smartProvider = typeof getSmartConsultProvider === 'function' ? getSmartConsultProvider() : subagentProvider;
  const smartModel = typeof getSmartConsultModel === 'function' ? getSmartConsultModel() : (subagentModel || 'gpt-5.5');
  console.log('[Smart] Refining subagent prompt.', {
    kind,
    provider: smartProvider,
    model: smartModel,
    chars: rawText.length
  });
  addSystemMessage(`[Smart] Refining subagent ${kind} with ${smartProvider} / ${smartModel}...`);
  subagentPromptRefinementInProgress = true;
  try {
    let result;
    try {
      result = await runSubagentPromptRefinement({ kind, text: rawText, ...context });
    } catch (firstErr) {
      if (!/empty text/i.test(String(firstErr && firstErr.message))) throw firstErr;
      console.warn('[Smart] Refinement returned empty text; retrying once.', firstErr);
      result = await runSubagentPromptRefinement({ kind, text: rawText, ...context });
    }
    const refined = String((result && result.text) || '').trim();
    if (!refined) throw new Error('Subagent prompt refinement returned empty text.');
    console.log('[Smart] Subagent prompt refined.', {
      kind,
      provider: (result && result.provider) || smartProvider,
      model: (result && result.model) || smartModel,
      inputChars: rawText.length,
      outputChars: refined.length
    });
    return refined;
  } finally {
    subagentPromptRefinementInProgress = false;
  }
}

async function startSmartMainBackgroundAgentFromTranscript(prompt, routingReason) {
  const taskSafety = sanitizeSubagentTaskForDelegation(prompt, getRecentUserUtteranceText());
  const initialTask = taskSafety.task;
  const normalizedTask = String(initialTask || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!normalizedTask) {
    return { status: 'error', message: 'I need a concrete task before I can start background work.' };
  }
  if (isGoogleDriveUploadDelegationTask(initialTask)) {
    return { status: 'error', message: 'That should use the direct Google Drive upload tool, not a background subagent.' };
  }

  const duplicateSubagent = activeSubagents.find(s => {
    if (s.status !== 'running' && s.status !== 'waiting_auth') return false;
    const existingTask = String(s.task || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return existingTask && (existingTask.includes(normalizedTask) || normalizedTask.includes(existingTask));
  });
  if (duplicateSubagent) {
    addSystemMessage(`[Smart] Matching background work is already running: ${duplicateSubagent.id}`);
    return { status: 'already_running', message: 'I already have matching background work running.' };
  }

  noteSmartMainRoutingTool('spawn_background_agent');
  spawnedSubagentThisTurn = true;
  addSystemMessage(`[Smart] Routing executable work to background subagent: ${routingReason}`);
  if (taskSafety.changed) {
    addSystemMessage('[Subagent] Delegation task sanitized to avoid passing credentials or forbidden routing hints.');
  }

  // Register the subagent with the raw task and return to the voice model IMMEDIATELY, so the
  // voice is NOT stuck "thinking" while the (possibly slow, local) prompt refinement runs.
  // Refinement AND the actual run happen in the background — the user can keep talking the whole
  // time. This applies to every provider (the refinement used to block the spawn tool response).
  const subagentRecord = createSubagentRecord(initialTask);
  activeSubagents.push(subagentRecord);
  updateSubagentIndicator();
  // Play the spawn chime NOW, the moment work is requested — not after the (possibly slow) prompt
  // refinement consult. Waiting for refinement made the alert feel late, and before the refinement
  // fallback existed a failed consult meant it never played at all.
  if (typeof playNotificationChime === 'function') playNotificationChime('start');

  (async () => {
    try {
      subagentRecord.lastMessage = 'Refining task with the subagent model...';
      if (typeof refreshSubagentProgressState === 'function') refreshSubagentProgressState(subagentRecord);
      let taskForSubagent;
      try {
        taskForSubagent = await refineSubagentInstructionWithSelectedModel('spawn', initialTask, { routing_reason: routingReason });
      } catch (refineErr) {
        // Prompt-brain refinement is best-effort. If it fails (provider auth/API hiccup, timeout,
        // empty result), run the subagent with the ORIGINAL task instead of aborting the whole
        // spawn — otherwise a flaky refinement makes every spawn instantly fail at startup.
        console.warn('[Smart] Subagent prompt refinement failed; running with the original task.', refineErr);
        addSystemMessage('[Subagent] Prompt refinement unavailable; running with the original task.');
        taskForSubagent = initialTask;
      }
      taskForSubagent = sanitizeSubagentTaskForDelegation(taskForSubagent, getRecentUserUtteranceText()).task;
      if (!String(taskForSubagent || '').trim()) taskForSubagent = initialTask;
      subagentRecord.task = taskForSubagent;
      let subModel = subagentModel;
      if (subagentProvider === 'gemini' && !subModel) {
        subModel = 'models/gemini-2.5-flash';
      }
      await runRestSubagent(taskForSubagent, subModel, subagentRecord);
    } catch (err) {
      if (isSubagentCancelled(subagentRecord)) return;
      failSubagentRecord(subagentRecord, `Startup failed: ${err.message}`);
      notifyVoiceSessionOfFailure(subagentRecord.task || initialTask, err.message, subagentRecord.id);
    }
  })();

  return { status: 'spawned', subagent_id: subagentRecord.id, message: 'I started working on it in the background.' };
}

async function sendLiveToolOutputFromOperation(targetSocket, attemptId, callId, operation, toolName = '') {
  let temporaryRegistration = false;
  if (callId && !activeLiveToolCallEpochs.has(callId)) {
    registerLiveToolCall(callId, liveToolOperationEpoch, toolName);
    temporaryRegistration = true;
  }
  if (!isLiveToolCallCurrent(callId)) return false;
  let abortController = getLiveToolAbortSignal(callId) ? activeLiveToolAbortControllers.get(callId) : null;
  let temporaryAbortController = false;
  if (!abortController && typeof AbortController !== 'undefined') {
    abortController = new AbortController();
    temporaryAbortController = true;
    if (callId) activeLiveToolAbortControllers.set(callId, abortController);
  }
  const previousLiveToolAbortSignal = currentLiveToolAbortSignal;
  if (abortController) currentLiveToolAbortSignal = abortController.signal;
  try {
    const output = await operation(abortController ? abortController.signal : null);
    return sendLiveToolResponse(targetSocket, attemptId, callId, { output, status: 'success' });
  } catch (err) {
    return sendLiveToolResponse(targetSocket, attemptId, callId, {
      output: err && err.message ? err.message : String(err),
      status: 'error'
    });
  } finally {
    if (temporaryRegistration) unregisterLiveToolCall(callId);
    if (temporaryAbortController && callId) activeLiveToolAbortControllers.delete(callId);
    currentLiveToolAbortSignal = previousLiveToolAbortSignal;
  }
}

async function readLiveResponseJsonWithTimeout(response, timeoutMs) {
  if (typeof readFetchResponseJsonWithTimeout === 'function') {
    return await readFetchResponseJsonWithTimeout(response, timeoutMs);
  }
  let timeoutId = null;
  const bodyPromise = response.json();
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

function createLiveBackendCommandId(label = 'voice') {
  const safeLabel = String(label || 'voice').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 32) || 'voice';
  const random = Math.random().toString(36).slice(2, 8);
  return `voice_${connectionAttemptId}_${safeLabel}_${Date.now()}_${random}`;
}

function trackLiveBackendCommand(commandId) {
  if (commandId) activeLiveBackendCommandIds.add(commandId);
}

function untrackLiveBackendCommand(commandId) {
  if (commandId) activeLiveBackendCommandIds.delete(commandId);
}

function cancelLiveBackendCommand(commandId, reason = 'voice interruption') {
  if (!commandId) return Promise.resolve(false);
  const cancelOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command_id: commandId, reason })
  };
  const cancelRequest = typeof fetchLocalApiWithTimeout === 'function'
    ? fetchLocalApiWithTimeout('/api/run/cancel', cancelOptions, 5000)
    : fetch('/api/run/cancel', cancelOptions);
  return Promise.resolve(cancelRequest)
    .then(res => Boolean(res && res.ok))
    .catch(err => {
      console.warn(`Failed to cancel foreground backend command ${commandId}:`, err);
      return false;
    });
}

function cancelLiveBackendCommands(reason = 'voice interruption') {
  const commandIds = [...activeLiveBackendCommandIds].filter(Boolean);
  if (commandIds.length === 0) return;
  console.debug(`Cancelling ${commandIds.length} foreground backend command(s): ${reason}`);
  for (const commandId of commandIds) {
    cancelLiveBackendCommand(commandId, reason);
  }
}

function isExpectedDisconnectPowerShellCommand(command) {
  const text = String(command || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const remoteShell = /\bssh\b/.test(text);
  if (!remoteShell) return false;
  const sudoPrefix = String.raw`(?:sudo(?:\s+(?:-[^\s]+|--[^\s]+|[a-z_][a-z0-9_]*=[^\s]+))*\s+)?`;
  return new RegExp(String.raw`\b${sudoPrefix}(?:reboot|systemctl\s+(?:--[^\s]+\s+)*reboot|shutdown\s+(?:-[rhkp]+|--reboot|--halt|--poweroff|now)(?:\s+now)?|poweroff|halt)\b`).test(text)
    || /\bsystemctl\s+restart\s+(?:ssh|sshd|network|networking|systemd-networkd)\b/.test(text)
    || /\bservice\s+(?:ssh|sshd|network|networking)\s+restart\b/.test(text);
}

function stringifyPowerShellResultField(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getPowerShellResultDiagnosticText(result) {
  if (!result || typeof result !== 'object') return stringifyPowerShellResultField(result);
  return [
    result.output,
    result.error,
    result.stderr,
    result.stdout,
    result.message,
    result.detail,
    result.details,
    result.reason,
    result.diagnostic_output
  ].map(stringifyPowerShellResultField).filter(Boolean).join('\n');
}

function looksLikeExpectedRemoteDisconnectOutput(output) {
  const text = String(output || '').toLowerCase();
  const compactText = text.replace(/\s+/g, ' ');
  if (!text) return true;
  if (/\b(shutdown scheduled|reboot scheduled|system is going down|going down for reboot|going down for system reboot|will reboot|rebooting|powering off|halting)\b/.test(compactText)
    || /\bbroadcast message\b.*\b(reboot|shutdown|poweroff|halt|going down)\b/.test(compactText)) {
    return true;
  }
  if (/\b(permission denied|authentication failed|host key verification failed|could not resolve|name or service not known|no route to host|connection refused|sudo:.*password.*required|password is required|incorrect password|not in the sudoers|command not found|not recognized|invalid option)\b/.test(compactText)) {
    return false;
  }
  return /\b(connection .*closed|closed by remote host|remote host .*closed|connection reset|reset by peer|broken pipe|client_loop|kex_exchange_identification|disconnect|exit status 255|process exited with code 255|connection to .* port \d+.*closed)\b/.test(compactText)
    || /\b(command|response body|request|fetch|execution transport).*(timed out|timeout|aborted|failed to fetch|network)\b/.test(compactText)
    || /\b(timed out|timeout|aborted|failed to fetch|network error)\b/.test(compactText);
}

function normalizeLivePowerShellCommandResult(command, json) {
  const result = json && typeof json === 'object' ? { ...json } : { status: 'error', output: String(json || '') };
  const diagnosticText = getPowerShellResultDiagnosticText(result);
  if (
    isExpectedDisconnectPowerShellCommand(command) &&
    String(result.status || '').toLowerCase() === 'error' &&
    !result.cancelled &&
    looksLikeExpectedRemoteDisconnectOutput(diagnosticText)
  ) {
    const originalOutput = String(diagnosticText || '').trim();
    result.status = 'success';
    result.assumed_success = true;
    result.assumed_success_reason = 'Remote disruptive command likely succeeded because the SSH/session disconnect is expected during reboot, shutdown, poweroff, or network/SSH restart.';
    result.diagnostic_output = originalOutput;
    result.output = [
      'Remote disruptive command initiated successfully.',
      'The SSH/session ended as expected for this kind of reboot, shutdown, poweroff, or network/SSH restart command.',
      'No recovery action is needed unless the user explicitly asks for a separate follow-up check.'
    ].join('\n');
    delete result.error;
    result.instruction = 'This is a success result. Briefly tell the user that the reboot/restart/shutdown was initiated. Do not say it failed or mention a snag. Do not call spawn_background_agent or retry just because the session ended.';
  }
  return result;
}

function rememberAssumedDisruptiveCommand(command, result) {
  if (!result || !result.assumed_success) return;
  lastAssumedDisruptiveCommandResult = {
    at: Date.now(),
    command: String(command || ''),
    reason: result.assumed_success_reason || ''
  };
}

function getRecentAssumedDisruptiveCommandBlock(task = '') {
  if (!lastAssumedDisruptiveCommandResult) return '';
  const age = Date.now() - lastAssumedDisruptiveCommandResult.at;
  if (age < 0 || age > ASSUMED_DISRUPTIVE_COMMAND_SPAWN_BLOCK_MS) return '';
  const text = String(task || '').toLowerCase();
  if (!text || /\b(failed|failure|error|snag|retry|recover|fix|check|verify|reboot|restart|shutdown|ssh|server|vps|prod|command)\b/.test(text)) {
    return 'A disruptive remote command was just interpreted as successfully initiated from an expected disconnect. Do not start a recovery subagent unless the user explicitly asks for a new follow-up task.';
  }
  return '';
}

async function runLivePowerShellCommand(command, commandTimeoutMs, fetchTimeoutMs = commandTimeoutMs, label = 'voice') {
  const commandId = createLiveBackendCommandId(label);
  trackLiveBackendCommand(commandId);
  try {
    const res = await fetchWithTimeout('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, timeout_ms: commandTimeoutMs, command_id: commandId })
    }, fetchTimeoutMs);
    const json = await readLiveResponseJsonWithTimeout(res, fetchTimeoutMs);
    if (!json.command_id) json.command_id = commandId;
    return json;
  } catch (err) {
    const reason = String(err && err.message || err || 'command failed');
    if (/cancelled|timed out|timeout|abort|failed to fetch|network/i.test(reason)) {
      await cancelLiveBackendCommand(commandId, reason);
    }
    throw err;
  } finally {
    untrackLiveBackendCommand(commandId);
  }
}

async function toggleConnection() {
  if (isConnected) {
    userInitiatedDisconnect = true;
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
    disconnect();
  } else {
    userInitiatedDisconnect = false;
    watchdogBackoffMs = 2000;
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
    await connect();
  }
}

async function connect() {
  if (connectionInProgress || isConnected || (socket && socket.readyState === WebSocket.CONNECTING)) {
    console.debug('Connect ignored because a voice connection is already active or pending.');
    return;
  }

  if (!apiKey) {
    onboardingModal.classList.remove('hidden');
    return;
  }

  connectionInProgress = true;
  const thisConnectionAttemptId = ++connectionAttemptId;

  setVisualizerState('connecting');
  btnConnect.disabled = true;
  btnConnect.querySelector('.btn-text').textContent = 'Connecting...';
  addSystemMessage('Preparing Shadow voice channel...');

  await stopWakeWordListener({ wait: true });
  await sleep(200);
  if (thisConnectionAttemptId !== connectionAttemptId) return;

  if (!(await checkBackendHealth({ announce: true }))) {
    if (thisConnectionAttemptId === connectionAttemptId) {
      connectionInProgress = false;
      btnConnect.disabled = false;
      btnConnect.querySelector('.btn-text').textContent = 'Connect';
      setVisualizerState('disconnected');
    }
    if (!userInitiatedDisconnect) {
      clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(async () => {
        watchdogBackoffMs = Math.min(watchdogBackoffMs * 2, maxWatchdogBackoffMs);
        await connect();
      }, watchdogBackoffMs);
    }
    return;
  }

  let compiledInstruction = '';
  try {
    compiledInstruction = await getCompiledSystemInstruction();
  } catch (err) {
    console.error('Failed to compile system instructions:', err);
    connectionInProgress = false;
    btnConnect.disabled = false;
    btnConnect.querySelector('.btn-text').textContent = 'Connect';
    setVisualizerState('disconnected');
    addSystemMessage(`Could not prepare Shadow: ${err.message}`);
    return;
  }
  if (thisConnectionAttemptId !== connectionAttemptId) return;

  addSystemMessage('Contacting Shadow...');

  // Set the active model directly from the user's selection
  let activeModel = normalizeLiveModel(selectedModel);
  if (activeModel !== selectedModel) {
    selectedModel = activeModel;
    localStorage.setItem('shadow_model', activeModel);
    if (selectModel) selectModel.value = activeModel;
    addSystemMessage(`Using supported Live model: ${activeModel.replace('models/', '')}`);
  }
  const apiVersion = 'v1beta';

  // Update UI
  const cleanName = activeModel.replace('models/', '');
  modelBadge.textContent = cleanName;
  modelBadge.classList.remove('hidden');
  addSystemMessage('Using model: ' + cleanName);

  if (clearExpiredLiveSessionResumptionToken('connect startup')) {
    addSystemMessage('Saved voice session expired. Starting fresh with recent conversation context...');
    saveConfigToServer({ scheduleRetry: false }).catch(err => console.warn('Failed to save cleared stale resumption token:', err));
  }

  // Clear resumption token if model changed
  const lastResumptionModel = localStorage.getItem('shadow_resumption_token_model');
  if (activeResumptionToken && lastResumptionModel && lastResumptionModel !== activeModel) {
    console.log(`Clearing resumption token due to model mismatch. Old: ${lastResumptionModel}, New: ${activeModel}`);
    addSystemMessage('Model changed. Clearing old session state and starting a fresh session...');
    clearLiveSessionResumptionToken();
  }
  const lastResumptionVoice = localStorage.getItem('shadow_resumption_token_voice');
  if (activeResumptionToken && lastResumptionVoice && shouldStartFreshVoiceSession(lastResumptionVoice, voiceName)) {
    console.log(`Clearing resumption token due to voice mismatch. Old: ${lastResumptionVoice}, New: ${voiceName}`);
    addSystemMessage('Voice changed. Starting a fresh voice session with the selected voice...');
    clearLiveSessionResumptionToken();
  }
  const lastContextVersion = localStorage.getItem('shadow_session_context_version');
  if (activeResumptionToken && lastContextVersion !== SESSION_CONTEXT_VERSION) {
    console.log(`Clearing resumption token due to context version change. Old: ${lastContextVersion || 'none'}, New: ${SESSION_CONTEXT_VERSION}`);
    addSystemMessage('Shadow updated. Clearing old session context and starting fresh...');
    clearLiveSessionResumptionToken();
  }
  localStorage.setItem('shadow_session_context_version', SESSION_CONTEXT_VERSION);

  currentActiveModel = activeModel;

  // WebSocket URL for Gemini Live API
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${apiVersion}.GenerativeService.BidiGenerateContent?key=${apiKey}`;

  try {
    socket = new WebSocket(url);
  } catch (err) {
    console.error('Failed to create WebSocket:', err);
    connectionInProgress = false;
    connectionFailed(err);
    return;
  }

  const currentSocket = socket;

  currentSocket.onopen = async (event) => {
    if (event && event.target !== currentSocket) return;
    if (thisConnectionAttemptId !== connectionAttemptId || socket !== currentSocket) return;
    console.log('WebSocket connected');
    isConnected = true;
    userInitiatedDisconnect = false;
    watchdogBackoffMs = 2000;
    liveSessionConnectedAt = Date.now();
    lastLoggedContextTokenBucket = -1;
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
    updateSessionButtonVisibility();
    btnConnect.disabled = false;
    btnConnect.querySelector('.btn-text').textContent = 'Disconnect';
    btnConnect.classList.add('connected');
    connectionBadge.textContent = 'Connected';
    connectionBadge.className = 'status-badge state-connected';
    btnToggleMic.disabled = false;
    btnToggleMic.classList.remove('disabled');
    btnToggleMic.classList.add('active');
    btnInterrupt.classList.remove('hidden');
    btnNewSession.classList.remove('hidden');

    // Enable screen share button Ã¢â‚¬â€ all Live API models support vision input
    btnShareScreen.disabled = false;
    btnShareScreen.classList.remove('disabled');

    setVisualizerState('connecting');
    addSystemMessage('Contact established. Initializing voice channel...');

    clearTimeout(connectionSetupTimeout);
    connectionSetupTimeout = setTimeout(() => {
      if (thisConnectionAttemptId === connectionAttemptId && socket === currentSocket && currentSocket.readyState === WebSocket.OPEN && currentVisualizerState === 'connecting') {
        console.warn('Gemini setup timed out before setupComplete. Closing stale socket.');
        addSystemMessage('Voice channel setup timed out. Please try connecting again.');
        cancelActiveLiveWork('voice channel setup timed out');
        try { currentSocket.close(); } catch (e) {}
        connectionFailed(new Error('Voice channel setup timed out.'));
      }
    }, 25000);

    // Do not send synthetic keepalive turns. Gemini 3.1 Live only supports
    // clientContent for initial history/context, and fake turns can close the
    // socket with "invalid argument" or interrupt active speech.
    clearInterval(wsKeepaliveTimer);
    wsKeepaliveTimer = null;

    // Initialize player. The recorder starts only after setupComplete so the
    // Live API never receives audio before the session is ready.
    audioPlayer = new AudioPlayer();

    if (thisConnectionAttemptId !== connectionAttemptId || socket !== currentSocket || currentSocket.readyState !== WebSocket.OPEN) return;

    // Send the raw WebSocket BidiGenerateContentSetup. This endpoint expects
    // the setup wrapper; the SDK-only `config` wrapper is rejected here.
    const liveThinkingConfig = getLiveGenerationThinkingConfig(activeModel);
    const setupMessage = {
      setup: {
        model: activeModel,
        generationConfig: {
          responseModalities: ['AUDIO'],
          maxOutputTokens: 8192,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: voiceName
              }
            }
          }
        },
        systemInstruction: {
          parts: [{ text: compiledInstruction }]
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'run_powershell_command',
                description: 'Executes a PowerShell command on the host machine to open applications, open websites in the user\'s normal/default browser, manage files, check status, or run automation. Use Start-Process for GUI apps and default-browser URLs. For reading files or listing directories, prefer read_file or list_directory which are faster. If the result has status=success and assumed_success=true, treat it as successful; SSH/session loss is expected after reboot/shutdown/poweroff/network restart commands. Do not use this to create current source-backed research plans or reports from the voice session; use spawn_background_agent so it can research and verify sources.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    command: {
                      type: 'STRING',
                      description: 'The exact PowerShell command to run.'
                    }
                  },
                  required: ['command']
                }
              },
              {
                name: 'read_file',
                description: 'Reads a file from the local filesystem and returns its contents (plus the resolved_path it actually read). Much faster than run_powershell_command. It auto-resolves approximate/spoken file names — if the exact path is not found it finds the closest match in that folder (or the Desktop), so you do NOT need a perfect name. If it returns a "No file matching" message, call list_directory ONCE to get the real names and retry with the exact one — never re-call read_file with the same failing path.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    path: {
                      type: 'STRING',
                      description: 'Absolute or relative path to the file to read.'
                    },
                    max_lines: {
                      type: 'NUMBER',
                      description: 'Maximum number of lines to return. Defaults to 500. Use a smaller number for large files.'
                    }
                  },
                  required: ['path']
                }
              },
              {
                name: 'list_directory',
                description: 'Lists files and subdirectories in a directory on the local filesystem. Much faster than run_powershell_command for browsing directories. Use this when you need to see what files exist.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    path: {
                      type: 'STRING',
                      description: 'Absolute or relative path to the directory to list. Defaults to current directory.'
                    },
                    pattern: {
                      type: 'STRING',
                      description: 'Optional glob filter, e.g. "*.js" or "*.txt".'
                    }
                  },
                  required: []
                }
              },
              {
                name: 'search_web',
                description: 'Searches the web through the configured local SearXNG endpoint. Use this for quick current information, fact checking, documentation lookup, news, or anything that may have changed recently. For ANY weather question — current conditions AND forecasts (rain, thunderstorms, the weather tomorrow) — use get_weather instead, never this; search snippets do not contain live weather data. If the tool response includes unit_preference_instruction, obey it: convert source/search values into the remembered user units before answering, even if the source or spoken language uses different locale defaults. Do not use direct voice search for multi-step source-backed planning with prices, dates, availability, stock, reviews, or budget constraints; use spawn_background_agent for that.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    query: {
                      type: 'STRING',
                      description: 'The search query to send to SearXNG.'
                    },
                    count: {
                      type: 'NUMBER',
                      description: 'Maximum number of results to return. Defaults to 5; maximum is 8.'
                    },
                    categories: {
                      type: 'STRING',
                      description: 'Optional SearXNG category, such as general, news, images, or videos.'
                    },
                    language: {
                      type: 'STRING',
                      description: 'Optional language code, such as en, en-US, or nl.'
                    },
                    time_range: {
                      type: 'STRING',
                      description: 'Optional time range: day, week, month, or year.'
                    }
                  },
                  required: ['query']
                }
              },
              {
                name: 'get_weather',
                description: 'Returns REAL weather for a place from a live service (Open-Meteo): current conditions AND a short daily forecast (today + next 2 days, with rain_expected / thunderstorm_expected flags and precipitation probability). ALWAYS use this for ANY weather question instead of search_web — including current temp/wind/humidity AND forecast questions like "is it going to rain", "will there be thunderstorms", or "what\'s the weather tomorrow". Search snippets do not contain live numbers. Values are already in Celsius and km/h; state them exactly — never guess, convert, answer weather from memory, or read it from a web-search snippet.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    location: {
                      type: 'STRING',
                      description: 'City or place name, e.g. "Oss" or "Amsterdam". If the city name is ambiguous, include the country, e.g. "Oss, Netherlands".'
                    },
                    country: {
                      type: 'STRING',
                      description: 'Optional ISO country code or country name to disambiguate the city, e.g. "NL" or "Netherlands".'
                    }
                  },
                  required: ['location']
                }
              },
              {
                name: 'recall_memory',
                description: 'Searches your long-term memory for facts, promises, preferences, people, or anything the user told you before. The system prompt only lists the most important memories; call this whenever the user refers to something you may have promised, remembered, or discussed that is not already listed there. Do NOT read the memory file manually and do NOT claim you do not remember without calling this first.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    query: {
                      type: 'STRING',
                      description: 'What to look for, in a few keywords, e.g. "Einstein promise", "my dad", "favorite coffee".'
                    }
                  },
                  required: ['query']
                }
              },
              {
                name: 'get_available_skills',
                description: 'Reads the skills directory to see if there is an existing, self-learned macro or script for a task the user requested. Always use this tool first if the user asks for a complex automation task.',
                parameters: {
                  type: 'OBJECT',
                  properties: {},
                  required: []
                }
              },
              {
                name: 'save_skill',
                description: 'Saves a completed, repeatable, MULTI-STEP automation/download/build workflow as a reusable instruction script (exact steps, commands, selectors, logic). ONLY for procedures genuinely worth repeating later. DO NOT save: one-off tasks, trivial single commands (e.g. checking the time, making a test.txt), date- or period-specific research, or creative content (stories, essays, poems). The server rejects low-value skills, so do not retry if a save is skipped.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    skill_name: { type: 'STRING', description: 'A lowercase snake_case name for the skill (e.g. youtube_upload)' },
                    instructions: { type: 'STRING', description: 'The exact steps, selectors, coordinates, and logic needed to repeat this task perfectly without guessing.' }
                  },
                  required: ['skill_name', 'instructions']
                }
              },
              {
                name: 'upsert_memory_node',
                description: 'Creates or updates a memory node representing an enduring, long-term key fact, user preference, or personal concept. NEVER use this tool for transient details, temporary variables, current session file paths (like a video file path on desktop), or one-off task states. ONLY store long-term, persistent traits or preferences of the user.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    id: {
                      type: 'STRING',
                      description: 'A unique, alphanumeric lowercase snake-case ID for the node. E.g. "favorite_movie", "user_birthday".'
                    },
                    label: {
                      type: 'STRING',
                      description: 'A short, visual label for the node. E.g., "Favorite Movie", "Aoede Voice".'
                    },
                    type: {
                      type: 'STRING',
                      description: 'Category of node. Must be one of: "fact", "preference", "person", "interest", "action".'
                    },
                    description: {
                      type: 'STRING',
                      description: 'Detailed description of the fact or preference stored in this memory node.'
                    }
                  },
                  required: ['id', 'label', 'type', 'description']
                }
              },
              {
                name: 'link_memory_nodes',
                description: 'Creates a directional labeled link between two memory nodes. E.g., link_memory_nodes("user", "favorite_voice", "PREFERS")',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    sourceId: {
                      type: 'STRING',
                      description: 'The unique ID of the source node.'
                    },
                    targetId: {
                      type: 'STRING',
                      description: 'The unique ID of the target node.'
                    },
                    relationshipType: {
                      type: 'STRING',
                      description: 'The type of the relationship, in uppercase. E.g. "PREFERS", "INTERESTED_IN", "CREATED", "LIKES", "HAS".'
                    }
                  },
                  required: ['sourceId', 'targetId', 'relationshipType']
                }
              },
              {
                name: 'delete_memory_node',
                description: 'Permanently deletes a memory node and its links. The id accepts the exact node id OR a distinctive keyword/phrase from the memory\'s label or description (e.g. "setup file") — it matches on all of those and falls back to a fuzzy best-match. If the user describes a memory you are not sure how to identify, call recall_memory first to find the exact node, then delete it. If the result is "ambiguous", ask the user which one.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    id: {
                      type: 'STRING',
                      description: 'The node id, or a distinctive keyword/phrase from its label or description.'
                    }
                  },
                  required: ['id']
                }
              },
              {
                name: 'delete_skill',
                description: 'Deletes a skill folder by name. Use to clean up deprecated or duplicate skills.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    skill_name: {
                      type: 'STRING',
                      description: 'The skill folder name to delete.'
                    }
                  },
                  required: ['skill_name']
                }
              },
              {
                name: 'run_desktop_action',
                description: 'Executes an OS-level physical mouse or keyboard action on the native Windows desktop. Only use this for explicit native Windows app control; never use it as a browser automation substitute. Requires exact absolute screen coordinates.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    action: { type: 'STRING', description: '"click_coordinate", "move_cursor", or "type_text"' },
                    x: { type: 'NUMBER', description: 'Absolute screen X coordinate' },
                    y: { type: 'NUMBER', description: 'Absolute screen Y coordinate' },
                    text: { type: 'STRING', description: 'Text to type natively' }
                  },
                  required: ['action']
                }
              },
              {
                name: 'ask_smart_model',
                description: 'Legacy/manual answer-only smart consult. Do not use for ordinary voice conversation. Subagent prompt and steering refinement is handled automatically by the app when spawn_background_agent or steer_subagent is used.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    prompt: {
                      type: 'STRING',
                      description: 'The exact answer-only reasoning question the smart model should answer, including relevant user requirements and constraints. Must not ask the smart model to inspect, change, run, test, download, upload, or perform work.'
                    },
                    response_style: {
                      type: 'STRING',
                      description: 'Optional style: concise, detailed, step_by_step, or decision. Defaults to concise voice-ready guidance.'
                    }
                  },
                  required: ['prompt']
                }
              },
              {
                name: 'spawn_background_agent',
                description: 'Spawns an asynchronous, text-only background subagent for actual multi-step work that could block the voice session: inspecting/changing project files, debugging/fixing apps, implementing code, running commands, builds/tests, source-backed planning or research with current prices/dates/budgets/availability/stock/reviews, downloads, video/audio compression, transcoding, ffmpeg jobs, and batch processing. Use this instead of ask_smart_model whenever the user asks Shadow to do work or current research rather than just answer a conceptual question. Browser automation is disabled; use search_web through SearXNG for research. Do not use for ordinary Google Drive uploads or just because an existing file is large; use google_drive_upload_local_file for Drive uploads. If a workflow includes compression and upload, delegate compression only, then upload directly yourself. The task must preserve every user requirement verbatim.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    task: {
                      type: 'STRING',
                      description: 'The detailed description of the task for the subagent to perform, preserving every user requirement verbatim.'
                    }
                  },
                  required: ['task']
                }
              },
              {
                name: 'get_active_subagents',
                description: 'Lists currently active background subagents separately from recent historical subagent results. Only active_subagents are doing work right now; recent_subagent_history is not active.',
                parameters: {
                  type: 'OBJECT',
                  properties: {},
                  required: []
                }
              },
              {
                name: 'cancel_subagent',
                description: 'Cancels/terminates a running background subagent by its unique ID.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    subagent_id: { type: 'STRING', description: 'The unique ID of the subagent to cancel.' }
                  },
                  required: ['subagent_id']
                }
              },
              {
                name: 'steer_subagent',
                description: 'Interrupts a running background subagent, preserves its conversation context, and injects new instructions, feedback, or corrections.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    subagent_id: { type: 'STRING', description: 'The unique ID of the subagent to interrupt. Use "latest" or "current" when the user means the currently running subagent and you do not have an exact ID.' },
                    feedback: { type: 'STRING', description: 'The correction, instructions, or feedback to inject into the subagent context.' }
                  },
                  required: ['subagent_id', 'feedback']
                }
              },
              {
                name: 'gmail_list_messages',
                description: 'List Gmail messages. Allows filtering via optional query (same format as Gmail search box).',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    count: {
                      type: 'NUMBER',
                      description: 'Maximum number of messages to return. Defaults to 10.'
                    },
                    query: {
                      type: 'STRING',
                      description: 'Gmail search query string, e.g., \'from:somebody@example.com is:unread\'.'
                    }
                  }
                }
              },
              {
                name: 'gmail_get_message',
                description: 'Retrieve the details and content of a specific Gmail message by its message_id.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    message_id: {
                      type: 'STRING',
                      description: 'The unique ID of the Gmail message.'
                    }
                  },
                  required: ['message_id']
                }
              },
              {
                name: 'gmail_send_message',
                description: 'Actually SEND an email message via Gmail. Dangerous: only use when the user explicitly says to send/send it now. For drafts, use gmail_create_draft instead. Requires send_confirmed=true.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    to: {
                      type: 'STRING',
                      description: 'Email address of the recipient.'
                    },
                    subject: {
                      type: 'STRING',
                      description: 'Subject of the email.'
                    },
                    body: {
                      type: 'STRING',
                      description: 'Plain text body content of the email.'
                    },
                    send_confirmed: {
                      type: 'BOOLEAN',
                      description: 'Must be true only when the user explicitly asked to send the email now.'
                    }
                  },
                  required: ['to', 'body', 'send_confirmed']
                }
              },
              {
                name: 'gmail_create_draft',
                description: 'Create a Gmail draft without sending it. Use this whenever the user asks to draft, prepare, write, or compose an email unless they explicitly say to send now.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    to: {
                      type: 'STRING',
                      description: 'Email address of the recipient.'
                    },
                    subject: {
                      type: 'STRING',
                      description: 'Subject of the draft email.'
                    },
                    body: {
                      type: 'STRING',
                      description: 'Plain text body content of the draft email.'
                    }
                  },
                  required: ['to', 'body']
                }
              },
              {
                name: 'google_calendar_list_events',
                description: 'List events from the user\'s visible Google calendars. Defaults to upcoming events from now across selected calendars, ordered soonest first. Set include_past=true only when the user explicitly asks for past events/history.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    calendar_id: {
                      type: 'STRING',
                      description: 'Optional specific Google Calendar ID to query. Omit for normal user questions so Shadow checks all selected visible calendars.'
                    },
                    time_min: {
                      type: 'STRING',
                      description: 'RFC3339 formatted lower bound time string, e.g., \'2026-05-21T00:00:00Z\'.'
                    },
                    time_max: {
                      type: 'STRING',
                      description: 'RFC3339 formatted upper bound time string, e.g., \'2026-05-22T00:00:00Z\'.'
                    },
                    include_past: {
                      type: 'BOOLEAN',
                      description: 'Set true only for explicit past/history queries. Leave false/omitted for "what is next", "today", "upcoming", or general calendar checks.'
                    },
                    max_results: {
                      type: 'NUMBER',
                      description: 'Maximum number of events to return. Defaults to 20.'
                    }
                  }
                }
              },
              {
                name: 'google_calendar_create_event',
                description: 'Create a new event on the user\'s primary Google Calendar.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    summary: {
                      type: 'STRING',
                      description: 'Title or summary of the calendar event.'
                    },
                    description: {
                      type: 'STRING',
                      description: 'Optional description of the calendar event.'
                    },
                    start_time: {
                      type: 'STRING',
                      description: 'RFC3339 formatted start time string, e.g., \'2026-05-21T10:00:00Z\'.'
                    },
                    end_time: {
                      type: 'STRING',
                      description: 'RFC3339 formatted end time string, e.g., \'2026-05-21T11:00:00Z\'.'
                    }
                  },
                  required: ['summary', 'start_time', 'end_time']
                }
              },
              {
                name: 'google_drive_list_files',
                description: 'List or search files stored in the user\'s Google Drive.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    page_size: {
                      type: 'NUMBER',
                      description: 'Maximum number of files to return. Defaults to 20.'
                    },
                    query: {
                      type: 'STRING',
                      description: 'Google Drive search query query string, e.g., \'name contains "meeting"\'.'
                    }
                  }
                }
              },
              {
                name: 'google_drive_upload_file',
                description: 'Upload a small text or JSON file to the user\'s Google Drive from base64 content. Do NOT use this for videos or large/binary files; use google_drive_upload_local_file for local files.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    filename: {
                      type: 'STRING',
                      description: 'The name of the file to create on Google Drive.'
                    },
                    mime_type: {
                      type: 'STRING',
                      description: 'MIME type of the file, e.g. \'text/plain\'.'
                    },
                    content_base64: {
                      type: 'STRING',
                      description: 'Base64 encoded string of the file\'s content.'
                    },
                    parent_id: {
                      type: 'STRING',
                      description: 'Optional Drive folder ID to upload the file into.'
                    }
                  },
                  required: ['filename', 'content_base64']
                }
              },
              {
                name: 'google_drive_upload_local_file',
                description: 'Upload a local file from this Windows PC directly to Google Drive. Use this for videos, large files, desktop files, downloads, and any file that already exists on disk. Never base64-encode video content through the model.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    path: {
                      type: 'STRING',
                      description: 'Absolute or resolvable local path to the file, e.g. %USERPROFILE%\\Desktop\\video.mp4.'
                    },
                    filename: {
                      type: 'STRING',
                      description: 'Optional Drive filename. Defaults to the local file name.'
                    },
                    mime_type: {
                      type: 'STRING',
                      description: 'Optional MIME type, e.g. video/mp4. Inferred from the extension when omitted.'
                    },
                    parent_id: {
                      type: 'STRING',
                      description: 'Optional Drive folder ID to upload the file into.'
                    }
                  },
                  required: ['path']
                }
              },
              {
                name: 'google_drive_create_folder',
                description: 'Create a folder in the user\'s Google Drive.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    name: {
                      type: 'STRING',
                      description: 'The folder name to create.'
                    },
                    parent_id: {
                      type: 'STRING',
                      description: 'Optional Drive folder ID to create this folder inside.'
                    }
                  },
                  required: ['name']
                }
              },
              {
                name: 'google_drive_set_link_sharing',
                description: 'Make a Google Drive file shareable via "anyone with the link" and return the shareable link. Use this when the user wants to share a Drive file or get a public/shareable link (e.g. right after uploading). Works on files Shadow uploaded or created.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    file_id: {
                      type: 'STRING',
                      description: 'The Drive file ID to share (from a prior upload or list result).'
                    },
                    role: {
                      type: 'STRING',
                      description: 'Access level for anyone with the link: "reader" (view, default) or "writer" (edit).'
                    }
                  },
                  required: ['file_id']
                }
              },
              {
                name: 'google_contacts_list',
                description: 'Search or list Google Contacts / phone contacts through the Google People API. Use this for phone numbers, email addresses, or questions like "what is my mother\'s number?". Pass query when the user gives a name, nickname, or relationship.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    query: {
                      type: 'STRING',
                      description: 'Optional name, nickname, email, phone, or relationship term to search for, e.g. "mom", "mother", "mama", or a person name.'
                    },
                    page_size: {
                      type: 'NUMBER',
                      description: 'Contacts per page to scan. Defaults to 500.'
                    },
                    max_pages: {
                      type: 'NUMBER',
                      description: 'Maximum pages to scan. Defaults higher when query is provided.'
                    },
                    include_other_contacts: {
                      type: 'BOOLEAN',
                      description: 'Optional. Include Google "Other contacts"; requires the extra contacts.other.readonly OAuth scope and is off by default.'
                    }
                  },
                  required: []
                }
              },
              {
                name: 'get_shadow_settings',
                description: 'Returns current Shadow settings. Assistant name, accent, echo gate, and SearXNG search are voice-control-safe. Voice preset, main model, main Live reasoning, subagent, and proactive settings are read-only from voice control.',
                parameters: {
                  type: 'OBJECT',
                  properties: {},
                  required: []
                }
              },
              {
                name: 'update_shadow_settings',
                description: 'Updates only voice-control-safe settings: assistant name, speaking accent, and SearXNG search. Voice presets, favorite voices, main model, main Live reasoning, subagent provider/model/reasoning, and proactive mode/profile/frequency are locked from voice control.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    assistant_name: {
                      type: 'STRING',
                      description: 'The personal name the assistant should use for itself. Example: Nova. This changes identity/name, not the ShadowMac app brand.'
                    },
                    accent: {
                      type: 'STRING',
                      description: 'Speaking accent. Allowed: neutral, southern_american, brooklyn_american, australian, british, russian, french, latina_latino.'
                    },
                    searxng_url: {
                      type: 'STRING',
                      description: 'Local SearXNG search URL. Default: http://127.0.0.1/search.'
                    },
                    searxng_port: {
                      type: 'STRING',
                      description: 'Local SearXNG endpoint port, 1-65535. Default: 8888.'
                    }
                  },
                  required: []
                }
              }
            ]
          }
        ],
        realtimeInputConfig: {
          activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
            endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
            prefixPaddingMs: 80,
            silenceDurationMs: 350
          }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        sessionResumption: {},
        // Sliding-window context compression keeps the Live session from hitting the
        // default context/duration cap and dropping (the main cause of the periodic
        // code-1006 disconnects). It lets the session run much longer; the resumption
        // handle still covers any genuine network blip.
        //
        // EXPLICIT BOUNDS (latency): without a triggerTokens, compression only fires near the model's
        // full (huge) context limit, so a long call accumulates more and more context — and since session
        // resumption preserves that context across reconnects, every reply gets slower the longer you talk.
        // Compress once the rolling context passes ~32k tokens, back down to ~16k. That keeps several
        // minutes of recent conversation for continuity (durable facts live in long-term memory regardless)
        // while keeping replies snappy. Tunable: raise if it forgets recent context too soon, lower if long
        // calls still slow down.
        contextWindowCompression: {
          triggerTokens: 32000,
          slidingWindow: { targetTokens: 16000 }
        }
      }
    };

    if (liveThinkingConfig) {
      setupMessage.setup.generationConfig.thinkingConfig = liveThinkingConfig;
    } else if (liveThinkingLevel !== 'auto' && !supportsLiveThinkingLevel(activeModel)) {
      addSystemMessage('Voice reasoning level is only supported by Gemini 3 Live. The selected fallback model will use provider defaults.');
    }

    if (activeResumptionToken) {
      setupMessage.setup.sessionResumption.handle = activeResumptionToken;
      addSystemMessage('Resuming previous conversation context...');
      console.log('[Live] Reconnecting WITH a saved resumption handle (asking the server to resume the session). NOTE: a handle does NOT guarantee the server actually restores the conversation — the re-injected recent-dialogue section is the reliable fallback for continuity.');
    } else if (recentDialogueTurns.length > 0) {
      addSystemMessage('Restoring recent conversation context...');
      // This is the "forgot everything" case: a reconnect with NO server handle, so the live context is
      // gone and only a small recent-dialogue snippet is re-injected into the prompt. Make it loud so we
      // can tell from the console whether a context-loss complaint was a real fresh-session reconnect.
      console.warn(`[Live] Reconnecting WITHOUT a session-resumption handle — the server is NOT preserving prior live context; only the recent-dialogue snippet (~${RECENT_HISTORY_PROMPT_BUDGET_CHARS} chars) is re-injected. If it seems to "forget" the conversation after a reconnect, this log is why.`);
    }

    try {
      const setupPayload = JSON.stringify(setupMessage);
      console.log('Sending setup message:', {
        model: activeModel,
        thinkingLevel: liveThinkingConfig ? liveThinkingConfig.thinkingLevel : 'auto',
        instructionChars: compiledInstruction.length,
        functionCount: setupMessage.setup.tools[0].functionDeclarations.length,
        setupBytes: setupPayload.length,
        resuming: Boolean(activeResumptionToken)
      });
      currentSocket.send(setupPayload);
    } catch (err) {
      console.error('Failed to send setup message:', err);
      connectionFailed(err);
    }
  };

  currentSocket.onmessage = async (event) => {
    if (event && event.target !== currentSocket) return;
    if (thisConnectionAttemptId !== connectionAttemptId || socket !== currentSocket) return;
    try {
      let textData = event.data;
      if (event.data instanceof Blob) {
        textData = await event.data.text();
      }
      if (thisConnectionAttemptId !== connectionAttemptId || socket !== currentSocket) return;
      const response = JSON.parse(textData);

      // Handle sessionResumptionUpdate
      if (response.sessionResumptionUpdate) {
        const update = response.sessionResumptionUpdate;
        if (update.resumable && update.newHandle) {
          persistLiveSessionResumptionToken(update.newHandle, activeModel, voiceName);
          updateSessionButtonVisibility();
          scheduleResumptionTokenSave();
        }
        return;
      }

      // Handle GoAway signal
      if (response.goAway) {
        console.log('Received GoAway signal from server:', response.goAway);
        addSystemMessage('Session limit reached. Reconnecting...');
        isAutoReconnecting = true;
        if (screenStream) {
          pauseScreenCapture();
        }
        cancelActiveLiveWork('Live API requested reconnect');
        if (currentSocket.readyState === WebSocket.OPEN || currentSocket.readyState === WebSocket.CONNECTING) {
          currentSocket.close();
        }
        return;
      }

      // Handle server-side errors returned as JSON
      if (response.error) {
        console.error('Server error response:', response.error);
        if (activeResumptionToken && isResumptionHandleError(response.error)) {
          retryWithoutResumptionHandle('Previous session handle expired.');
          return;
        }
        if (isTransientLiveApiError(response.error)) {
          scheduleSoftReconnect(`Live API temporarily unavailable: ${response.error.message || response.error.status || 'server error'}`, 500);
          return;
        }
        disconnect(`Server Error: ${response.error.message || JSON.stringify(response.error)}`);
        return;
      }

      // Handle model function calling (Tool Call)
      if (response.toolCall) {
        const calls = response.toolCall.functionCalls;
        const toolBatchEpoch = liveToolOperationEpoch;
        console.log('Received tool calls:', calls);
        if (Array.isArray(calls) && calls.length) toolCalledThisTurn = true;
        if (smartMainRoutingEnabled && Array.isArray(calls) && calls.length) {
          observeSmartMainToolBatch(calls.map(call => call.name).filter(Boolean));
        }
        markToolFollowupPending('Live tool call');

        for (const call of calls) {
          if (!isCurrentLiveToolBatch(currentSocket, thisConnectionAttemptId, toolBatchEpoch)) {
            console.debug('Stopping stale Live tool-call batch after interrupt/reconnect.');
            break;
          }
          registerLiveToolCall(call.id, toolBatchEpoch, call.name);
          try {
          if (call.name === 'run_powershell_command') {
            const command = call.args.command;
            console.log('Executing PowerShell command:', command);
            addSystemMessage(`Running system command: ${command}`);

            if (isShadowSelfModificationCommand(command)) {
              const routed = await startSmartMainBackgroundAgentFromTranscript(getRecentUserUtteranceText() || command, 'Shadow source modification must run in a background subagent.');
              addSystemMessage('Routing Shadow source modification to a background subagent.');
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                status: routed.status || 'spawned',
                subagent_id: routed.subagent_id,
                output: routed.message,
                instruction: 'Tell the user in first person that the work was started in the background. Do not refuse.'
              });
              markToolResponseFollowupPending('shadow source edit redirected to subagent');
              continue;
            }

            if (shouldBlockSchedulerCreateForEditIntent(command)) {
              addSystemMessage('Blocked duplicate reminder creation: user asked to edit an existing reminder/task.');
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                output: 'BLOCKED: The user asked to edit/change/update an existing reminder or task. Do NOT create a new task. First run: Invoke-RestMethod -Uri "http://127.0.0.1:9333/api/tasks?activeOnly=true" -Method GET. Then use the exact id with: Invoke-RestMethod -Uri "http://127.0.0.1:9333/api/tasks/TASK_ID/edit" -Method POST -ContentType "application/json" -Body (@{message="New message"; schedule="new schedule"} | ConvertTo-Json -Compress).',
                status: 'error'
              });
              continue;
            }

            const recentUserText = typeof getRecentUserUtteranceText === 'function' ? getRecentUserUtteranceText() : '';
            const commandRoutingReason = typeof getSmartConsultWorkRoutingReason === 'function'
              ? getSmartConsultWorkRoutingReason(`${recentUserText}\n${command}`)
              : '';
            if (commandRoutingReason && /source-backed research/i.test(commandRoutingReason)) {
              const routed = await startSmartMainBackgroundAgentFromTranscript(recentUserText || command, commandRoutingReason);
              addSystemMessage('Blocked direct voice command for current source-backed research. Delegating/background research required.');
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                output: routed.message,
                status: routed.status || 'spawned',
                subagent_id: routed.subagent_id,
                reason: commandRoutingReason
              });
              markToolResponseFollowupPending('current research command redirected to subagent');
              continue;
            }

            if (shouldDelegateHeavyLocalProcessingCommand(command)) {
              const routed = await startSmartMainBackgroundAgentFromTranscript(getRecentUserUtteranceText() || command, 'This looks like long-running media processing, so it belongs in spawn_background_agent.');
              addSystemMessage('Blocked heavy media processing in main voice session. Delegating/background processing required.');
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                output: routed.message,
                status: routed.status || 'spawned',
                subagent_id: routed.subagent_id
              });
              continue;
            }

            try {
              const rawJson = await runLivePowerShellCommand(command, 25000, 25000, 'run_powershell');
              const json = normalizeLivePowerShellCommandResult(command, rawJson);
              rememberAssumedDisruptiveCommand(command, json);
              console.log('Execution result:', {
                status: json.status,
                outputLength: String(json.output || '').length,
                assumedSuccess: Boolean(json.assumed_success)
              });

              // Log command result to transcript logs as visual feedback
              addSystemMessage(formatCommandOutputNotice(json.output));
              if (json.assumed_success) {
                addSystemMessage('Remote disruptive command interpreted as successfully initiated after expected session disconnect.');
              }

              // Return the execution result only if this is still the active Live socket.
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                output: json.output,
                status: json.status,
                exitCode: json.exitCode,
                timedOut: Boolean(json.timedOut),
                cancelled: Boolean(json.cancelled),
                command_id: json.command_id,
                assumed_success: Boolean(json.assumed_success),
                assumed_success_reason: json.assumed_success_reason,
                instruction: json.instruction || 'Report the command result plainly. Do not spawn a background subagent just to recover from a direct command result unless the user explicitly asks for that follow-up.'
              });
            } catch (err) {
              const fallbackJson = normalizeLivePowerShellCommandResult(command, {
                output: `Execution transport ended while waiting for command result: ${err && err.message ? err.message : String(err)}`,
                error: err && err.message ? err.message : String(err),
                status: 'error',
                transport_error: true
              });
              if (fallbackJson.assumed_success) {
                rememberAssumedDisruptiveCommand(command, fallbackJson);
                console.warn('Execution transport ended during expected disruptive command; treating as initiated success:', err);
                addSystemMessage('Remote disruptive command interpreted as successfully initiated after expected transport/session end.');
                sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                  output: fallbackJson.output,
                  status: fallbackJson.status,
                  transport_error_interpreted: true,
                  assumed_success: true,
                  assumed_success_reason: fallbackJson.assumed_success_reason,
                  instruction: fallbackJson.instruction
                });
              } else {
                console.error('Failed to communicate with local execution API:', err);
                addSystemMessage(`Command execution failed: ${err.message}`);

                sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                  output: `Execution failed: ${err.message}`,
                  status: 'error',
                  instruction: 'Report this direct command failure plainly. Do not spawn a background subagent or retry unless the user explicitly asks for that follow-up.'
                });
              }
            }
          } else if (call.name === 'read_file') {
            const filePath = call.args.path || '.';
            const maxLines = call.args.max_lines || 500;
            addSystemMessage(`Reading file: ${filePath}`);
            try {
              // Self-resolving read: a spoken/approximate path may not match exactly, so if the
              // literal path is missing, fuzzy-match the closest file in the folder (or Desktop)
              // instead of failing and making the model loop. Returns the resolved path + content.
              const safePath = filePath.replace(/'/g, "''");
              const psCmd =
                `$req='${safePath}';` +
                `if(Test-Path -LiteralPath $req -PathType Leaf){$p=(Resolve-Path -LiteralPath $req).Path}` +
                `else{` +
                  `$d=Split-Path -Parent $req;if([string]::IsNullOrWhiteSpace($d) -or -not(Test-Path -LiteralPath $d -PathType Container)){$d=[Environment]::GetFolderPath('Desktop')};` +
                  `$n=Split-Path -Leaf $req;$s=([System.IO.Path]::GetFileNameWithoutExtension($n).ToLower() -replace '[^a-z0-9]','');` +
                  `$fs=@(Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue);` +
                  `$h=$fs|Where-Object{$_.Name -ieq $n}|Select-Object -First 1;` +
                  `if(-not $h){$h=$fs|ForEach-Object{$st=([System.IO.Path]::GetFileNameWithoutExtension($_.Name).ToLower() -replace '[^a-z0-9]','');[pscustomobject]@{F=$_;S=$(if($s -and $st -eq $s){100}elseif($s -and ($st.Contains($s) -or $s.Contains($st))){50}else{0})}}|Where-Object{$_.S -gt 0}|Sort-Object S -Descending|Select-Object -First 1 -ExpandProperty F};` +
                  `if(-not $h){throw "No file matching '$n' in $d. Files there: $(($fs|Select-Object -First 15 -ExpandProperty Name) -join ', '). Call list_directory to pick the exact name."};` +
                  `$p=$h.FullName` +
                `};` +
                `$c=Get-Content -LiteralPath $p -TotalCount ${maxLines} -ErrorAction Stop;` +
                `[pscustomobject]@{resolved_path=$p;content=$c}|ConvertTo-Json -Compress`;
              const json = await runLivePowerShellCommand(psCmd, 15000, 15000, 'read_file');
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                path: filePath,
                content: json.output,
                status: json.status,
                exitCode: json.exitCode,
                timedOut: Boolean(json.timedOut),
                cancelled: Boolean(json.cancelled),
                command_id: json.command_id
              });
            } catch (err) {
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { path: filePath, content: `Error reading file: ${err.message}`, status: 'error' });
            }
          } else if (call.name === 'list_directory') {
            const dirPath = call.args.path || '.';
            const pattern = call.args.pattern || '';
            addSystemMessage(`Listing directory: ${dirPath}`);
            try {
              let psCmd = `Get-ChildItem -Path '${dirPath.replace(/'/g, "''")}' -ErrorAction Stop`;
              if (pattern) psCmd += ` | Where-Object { $_.Name -like '${pattern.replace(/'/g, "''")}' }`;
              psCmd += ` | Select-Object Name, Length, LastWriteTime, PSIsContainer | ConvertTo-Json -Compress`;
              const json = await runLivePowerShellCommand(psCmd, 15000, 15000, 'list_directory');
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                path: dirPath,
                entries: json.output,
                status: json.status,
                exitCode: json.exitCode,
                timedOut: Boolean(json.timedOut),
                cancelled: Boolean(json.cancelled),
                command_id: json.command_id
              });
            } catch (err) {
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { path: dirPath, entries: `Error listing directory: ${err.message}`, status: 'error' });
            }
          } else if (call.name === 'search_web') {
            const { query, count, categories, language, time_range } = call.args;
            addSystemMessage(`Searching web: ${query}`);

            try {
              const recentUserText = typeof getRecentUserUtteranceText === 'function' ? getRecentUserUtteranceText() : '';
              const searchRoutingReason = typeof getSmartConsultWorkRoutingReason === 'function'
                ? getSmartConsultWorkRoutingReason(`${recentUserText}\n${query}`)
                : '';
              if (searchRoutingReason && /source-backed research/i.test(searchRoutingReason)) {
                const routed = await startSmartMainBackgroundAgentFromTranscript(recentUserText || query, searchRoutingReason);
                sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                  status: routed.status || 'spawned',
                  subagent_id: routed.subagent_id,
                  reason: searchRoutingReason,
                  answer: routed.message,
                  instruction: 'Tell the user in first person that the work was started in the background. Do not continue direct voice web searches for this request.'
                });
                markToolResponseFollowupPending('current research search redirected to subagent');
                continue;
              }

              // Do NOT inject unit words into the search query. Appending terms like
              // "kilometers per hour Celsius Fahrenheit" pollutes weather/news queries
              // and makes the search return the wrong figures (e.g. a stale or unrelated
              // temperature). Keep the query clean so results are accurate, and convert
              // units only in the spoken answer via unit_preference_instruction.
              let unitPreferenceContext = null;
              if (typeof getRelevantUnitPreferenceContext === 'function') {
                unitPreferenceContext = await getRelevantUnitPreferenceContext(`${recentUserText}\n${query}`);
              }

              const res = await fetchWithTimeout('/api/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: getLiveToolAbortSignal(call.id),
                body: JSON.stringify({ query, count, categories, language, time_range, timeout_ms: MAIN_SEARCH_PROXY_TIMEOUT_MS })
              }, MAIN_SEARCH_TIMEOUT_MS);
              const searchResult = await readLiveResponseJsonWithTimeout(res, MAIN_SEARCH_TIMEOUT_MS);
              if (unitPreferenceContext && unitPreferenceContext.instruction && searchResult && typeof searchResult === 'object') {
                searchResult.unit_preference_instruction = unitPreferenceContext.instruction;
              }
              // Safety net: search snippets never contain the live temperature, so if this
              // was a weather query, tell the model to get the real number from get_weather
              // instead of reading a figure out of a snippet (which it would hallucinate).
              if (/\b(weather|temperature|temp|how (hot|cold|warm)|degrees|forecast|wind|humidity)\b/i.test(query) && searchResult && typeof searchResult === 'object') {
                searchResult.weather_tool_hint = 'Do NOT state a temperature or wind value from these search snippets — they are not live readings. Call get_weather with the location to get the real current numbers in Celsius and km/h.';
              }
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, searchResult);
            } catch (err) {
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'error', error: err.message });
            }
          } else if (call.name === 'get_weather') {
            const location = String((call.args && call.args.location) || '').trim();
            const country = String((call.args && call.args.country) || '').trim();
            addSystemMessage(`Getting live weather: ${location || '(current location)'}`);
            try {
              const res = await fetchWithTimeout('/api/weather', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: getLiveToolAbortSignal(call.id),
                body: JSON.stringify({ location, country })
              }, MAIN_SEARCH_TIMEOUT_MS);
              const weatherResult = await readLiveResponseJsonWithTimeout(res, MAIN_SEARCH_TIMEOUT_MS);
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, weatherResult);
            } catch (err) {
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'error', error: err.message });
            }
          } else if (call.name === 'ask_smart_model') {
            const prompt = String((call.args && call.args.prompt) || '').trim();
            const responseStyle = String((call.args && call.args.response_style) || 'concise').trim();
            if (!prompt) {
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'error', error: 'ask_smart_model requires a non-empty prompt.' });
              continue;
            }

            const recentUserTextForSmartRoute = typeof getRecentUserUtteranceText === 'function' ? getRecentUserUtteranceText() : '';
            const workRoutingReason = typeof getSmartConsultWorkRoutingReason === 'function'
              ? getSmartConsultWorkRoutingReason(`${recentUserTextForSmartRoute}\n${prompt}`)
              : '';
            if (workRoutingReason) {
              const routed = await startSmartMainBackgroundAgentFromTranscript(prompt, workRoutingReason);
              addSystemMessage('[Smart] Foreground smart consult was executable work; started background routing instead.');
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                status: routed.status || 'spawned',
                subagent_id: routed.subagent_id,
                reason: workRoutingReason,
                answer: routed.message,
                instruction: 'Tell the user in first person that the work was started in the background. Do not refuse and do not call ask_smart_model again for this same request.'
              });
              markToolResponseFollowupPending('smart consult redirected to subagent');
              continue;
            }

            sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
              status: 'disabled',
              answer: 'Smart consulting is disabled for ordinary voice conversation. Answer directly unless the user is starting or steering a subagent.',
              instruction: 'Do not call ask_smart_model again for this ordinary chat turn. Answer directly in your own voice.'
            });
            markToolResponseFollowupPending('smart model consult disabled for chat');
          } else if (call.name === 'recall_memory') {
            const query = String((call.args && call.args.query) || '').trim();
            addSystemMessage(`Recalling memory: ${query}`);
            try {
              const graph = await loadMemoryGraph();
              const tokens = typeof memoryRecallTokens === 'function' ? memoryRecallTokens(query) : [];
              const scored = (graph.nodes || [])
                .map(node => ({ node, score: typeof scoreMemoryForQuery === 'function' ? scoreMemoryForQuery(node, tokens) : 0 }))
                .filter(item => item.score > 0)
                .sort((a, b) => b.score - a.score || getMemoryPriority(a.node) - getMemoryPriority(b.node))
                .slice(0, 8);
              const matches = scored.map(item => formatMemoryNodeLine(item.node));
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                status: 'success',
                query,
                matches,
                instruction: matches.length
                  ? 'Answer from these remembered facts in first person; state the matching fact directly.'
                  : 'No stored memory matched this query. Tell the user you do not have that specific memory; do not guess.'
              });
            } catch (err) {
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'error', error: err.message });
            }
          } else if (call.name === 'upsert_memory_node') {
            const { id, label, type, description } = call.args;
            addSystemMessage(`Learning fact: ${label} - ${description}`);
            const result = await apiUpsertMemoryNode(id, label, type, description);
            sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, result);
          } else if (call.name === 'link_memory_nodes') {
            const { sourceId, targetId, relationshipType } = call.args;
            addSystemMessage(`Linking memory: ${sourceId} -- ${relationshipType} --> ${targetId}`);
            const result = await apiLinkMemoryNodes(sourceId, targetId, relationshipType);
            sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, result);
          } else if (call.name === 'delete_memory_node') {
            const { id } = call.args;
            addSystemMessage(`Forgetting memory: ${id}`);
            const result = await apiDeleteMemoryNode(id);
            sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, result);
          } else if (call.name === 'delete_skill') {
            const skillName = call.args.skill_name;
            addSystemMessage(`Deleting skill: ${skillName}`);
            try {
              const res = await fetchWithTimeout('/api/skills/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: getLiveToolAbortSignal(call.id),
                body: JSON.stringify({ skill_name: skillName })
              }, 15000);
              const result = await readLiveResponseJsonWithTimeout(res, 15000);
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, result);
            } catch (err) {
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'error', error: err.message });
            }
          } else if (call.name === 'run_browser_action') {
            addSystemMessage('Blocked browser automation action: browser control is disabled.');
            sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
              status: 'error',
              error: 'BLOCKED: Browser automation is disabled. Use search_web through SearXNG for research, or run_powershell_command with Start-Process only when the user explicitly asks to open a URL in their normal browser.'
            });
          } else if (call.name === 'run_desktop_action') {
            const { action, x, y, text } = call.args;
            const desktopActionText = `${action || ''} ${text || ''}`.toLowerCase();
            if (/\b(website|webpage|browser|chrome|edge|firefox|youtube|google|tweakers|pricewatch|amazon|bol\.com|login|sign in|2fa|captcha|passkey|authenticator|upload)\b/.test(desktopActionText)) {
              addSystemMessage('Blocked desktop action for browser-like task.');
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'error', error: 'BLOCKED: Browser/website control through desktop actions is disabled. Use search_web through SearXNG for research, direct APIs for Workspace tasks, or Start-Process only to open a URL when explicitly requested.' });
              continue;
            }
            addSystemMessage(`Desktop action: ${action} at [${x || 0}, ${y || 0}]`);
            try {
              const safeAction = quotePowerShellSingleQuotedString(action || '');
              const safeText = quotePowerShellSingleQuotedString(text || '');
              const safeX = normalizeDesktopCoordinate(x);
              const safeY = normalizeDesktopCoordinate(y);
              const cmd = `powershell -ExecutionPolicy Bypass -File ${quotePowerShellSingleQuotedString('./desktop_controller.ps1')} -Action ${safeAction} -X ${safeX} -Y ${safeY} -Text ${safeText}`;
              const json = await runLivePowerShellCommand(cmd, 15000, 18000, 'desktop');
              const output = String(json.output || '').trim();
              if (json.status === 'error') addSystemMessage(`Desktop action failed: ${output}`);
              else addSystemMessage(`Desktop action output: ${output}`);
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                status: json.status || 'success',
                output,
                exitCode: json.exitCode,
                timedOut: Boolean(json.timedOut),
                cancelled: Boolean(json.cancelled),
                command_id: json.command_id
              });
            } catch (err) {
              addSystemMessage(`Desktop action crashed: ${err.message}`);
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'error', error: err.message });
            }
          } else if (call.name === 'get_available_skills') {
                try {
                  const psCmd = `
                    $shadowRoot = if ($env:SHADOW_DIR) { $env:SHADOW_DIR } else { Get-Location }
                    $skillsDir = Join-Path $shadowRoot "skills"
                    if (-not (Test-Path $skillsDir)) { "[]"; return }
                    $dirs = Get-ChildItem -Path $skillsDir -Directory
                    $res = @()
                    foreach ($d in $dirs) {
                      $instPath = Join-Path $d.FullName "instructions.txt"
                      if (Test-Path $instPath) {
                        $content = Get-Content $instPath -Raw
                        if ($null -ne $content) {
                          $res += [PSCustomObject]@{ name = $d.Name; content = $content.Substring(0, [math]::Min($content.Length, 500)) + "..." }
                        }
                      }
                    }
                    if ($res.Count -eq 0) { "[]" } else { $res | ConvertTo-Json -Compress }
                  `;
                  const cmdJson = await runLivePowerShellCommand(psCmd, 15000, 15000, 'skills');
                  let skills = [];
                  if (cmdJson.output && cmdJson.output.trim() && cmdJson.output.trim() !== 'Command executed successfully with no output.') {
                    try { skills = JSON.parse(cmdJson.output.trim()); } catch (e) {}
                  }
                  if (!Array.isArray(skills)) { skills = [skills]; }
                  sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'success', skills: skills });
                } catch (err) {
                  sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'error', error: err.message });
                }
              } else if (call.name === 'save_skill') {
                try {
                  const res = await fetchWithTimeout('/api/skills/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: getLiveToolAbortSignal(call.id),
                    body: JSON.stringify({ skill_name: call.args.skill_name, instructions: call.args.instructions })
                  }, 15000);
                  const json = await readLiveResponseJsonWithTimeout(res, 15000);
                  sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, json);
                  if (json.status === 'success' && json.merged_into) {
                    addSystemMessage(`Skill merged into existing skill "${json.merged_into}"`);
                  } else if (json.status === 'success') {
                    addSystemMessage(`Saved new skill: ${call.args.skill_name}`);
                  }
                } catch (err) {
                  sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'error', error: err.message });
                }
          } else if (call.name === 'spawn_background_agent') {
            const { task } = call.args;
            try {
              const assumedBlockReason = getRecentAssumedDisruptiveCommandBlock(task);
              if (assumedBlockReason) {
                sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                  status: 'success',
                  no_action: true,
                  output: assumedBlockReason,
                  message: 'No background subagent was started because the previous disruptive command was already treated as successfully initiated.',
                  instruction: 'This is a success/no-op result. Tell the user in first person that the reboot/restart/shutdown was already initiated. Do not say there was a snag or failure.'
                });
                markToolResponseFollowupPending('blocked redundant subagent after assumed disruptive command success');
                continue;
              }
              const routed = await startSmartMainBackgroundAgentFromTranscript(task, 'Voice requested spawn_background_agent; refine the subagent task through the selected subagent model before starting.');
              if (routed.status === 'error') {
                sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                  status: 'error',
                  error: routed.message
                });
                continue;
              }
            sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                status: routed.status || 'spawned',
                subagent_id: routed.subagent_id,
              message: 'Background work started. Say this in first person: "I started working on it in the background." Do not repeat the internal task prompt or quote the delegated instructions.',
                refined_by_subagent_model: smartMainRoutingEnabled
            });
            markToolResponseFollowupPending('spawn_background_agent');
            } catch (err) {
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                status: 'error',
                error: `Subagent prompt refinement failed: ${err && err.message ? err.message : String(err)}`
              });
              markToolResponseFollowupPending('spawn_background_agent refinement failed');
            }
          } else if (call.name === 'get_active_subagents') {
            const subagents = typeof getSubagentStatusList === 'function'
              ? getSubagentStatusList(20)
              : activeSubagents.slice(-20).map(s => ({ id: s.id, task: s.task, status: s.status, step: s.step, lastMessage: s.lastMessage }));
            const activeSubagentPayloads = subagents.filter(s => s && (s.isActive || /^(running|waiting_auth)$/i.test(String(s.status || ''))));
            const recentSubagentHistory = subagents.filter(s => !activeSubagentPayloads.includes(s));
            sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
              status: 'success',
              active_count: activeSubagentPayloads.length,
              active_subagents: activeSubagentPayloads,
              recent_subagent_history: recentSubagentHistory,
              subagents,
              instruction: activeSubagentPayloads.length
                ? 'Only active_subagents are currently doing work. recent_subagent_history is historical only.'
                : 'No background subagents are currently doing work. recent_subagent_history is historical only; do not claim old tasks or research are still running.'
            });
          } else if (call.name === 'cancel_subagent') {
            const requestedId = String((call.args && call.args.subagent_id) || '').trim();
            let targets = [];
            if (/^(all|\*)$/i.test(requestedId)) {
              targets = getControllableSubagents();
            } else if (!requestedId || /^(latest|current|active|that|it)$/i.test(requestedId)) {
              const latest = getLatestControllableSubagent();
              if (latest) targets = [latest];
            } else {
              const subagent = activeSubagents.find(s => s.id === requestedId);
              if (subagent) targets = [subagent];
            }

            if (targets.length > 0) {
              const cancelledCount = targets.filter(s => cancelSubagentRecord(s, 'Cancellation requested.')).length;
              if (cancelledCount > 0) {
                addSubagentMessage(`Cancellation requested for ${cancelledCount} background subagent(s).`);
              }
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'success', message: `Cancellation requested for ${targets.length} subagent(s).` });
            } else {
              const recentDirectCancel = lastDirectSubagentCancel && (Date.now() - lastDirectSubagentCancel.at < 10000);
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, recentDirectCancel
                ? { status: 'success', message: `Already cancelled ${lastDirectSubagentCancel.count} subagent(s): ${lastDirectSubagentCancel.ids}.` }
                : { status: 'error', error: requestedId ? `Subagent ${requestedId} not found.` : 'No running subagent found to cancel.' });
            }
          } else if (call.name === 'steer_subagent') {
            const requestedSubagentId = String((call.args && call.args.subagent_id) || '').trim();
            const subagent = typeof resolveControllableSubagentReference === 'function'
              ? resolveControllableSubagentReference(requestedSubagentId)
              : activeSubagents.find(s => s.id === requestedSubagentId);
            if (subagent) {
              const feedback = String(call.args.feedback || '');
              if (subagent.authCheckpoint && /\b(done|completed|complete|logged in|login done|2fa done|resume|continue|approved|verified)\b/i.test(feedback)) {
                resumeAuthCheckpoint(subagent, 'User said auth/login is complete.');
                sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'success', subagent_id: subagent.id, message: `Authentication checkpoint resumed for subagent ${subagent.id}.` });
                continue;
              }
              // Apply the correction IMMEDIATELY with the raw feedback so the subagent stops now
              // and the voice tool response returns instantly (no waiting on a slow refine — same
              // fix as spawn). Then refine in the background and queue the refined version as a
              // follow-up clarification. Works for every provider.
              const interrupted = interruptSubagentWithFeedback(subagent, feedback, 'Tool correction received.');
              if (typeof isSubagentPromptBrainSteeringEnabled === 'function' && isSubagentPromptBrainSteeringEnabled()
                  && typeof refineSubagentSteeringFeedbackWithSelectedModel === 'function') {
                Promise.resolve(refineSubagentSteeringFeedbackWithSelectedModel(
                  subagent,
                  feedback,
                  'Voice requested steer_subagent; refine the correction through the selected subagent model.'
                )).then(res => {
                  const refined = res && res.refinedBySubagentModel ? String(res.feedback || '').trim() : '';
                  if (refined && refined !== String(feedback || '').trim() && !isSubagentCancelled(subagent) && Array.isArray(subagent.steerQueue)) {
                    subagent.steerQueue.push(`[Refined clarification of the previous correction] ${refined}`);
                  }
                }).catch(() => { /* best-effort; the raw correction was already applied */ });
              }
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, {
                status: interrupted ? 'interrupted' : 'error',
                subagent_id: subagent.id,
                requested_subagent_id: requestedSubagentId || undefined,
                message: interrupted
                  ? `Subagent ${subagent.id} was interrupted and your correction was applied. Keep talking; any refinement happens in the background.`
                  : `Subagent ${subagent.id} could not be interrupted.`
              });
            } else {
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'error', error: requestedSubagentId ? `Subagent ${requestedSubagentId} not found.` : 'No running subagent found to steer.' });
            }
          } else if (call.name === 'gmail_list_messages') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => gmailListMessages(call.args));
          } else if (call.name === 'gmail_get_message') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => gmailGetMessage(call.args));
          } else if (call.name === 'gmail_send_message') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => gmailSendMessage(call.args));
          } else if (call.name === 'gmail_create_draft') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => gmailCreateDraft(call.args));
          } else if (call.name === 'google_calendar_list_events') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleCalendarListEvents(call.args));
          } else if (call.name === 'google_calendar_create_event') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleCalendarCreateEvent(call.args));
          } else if (call.name === 'google_drive_list_files') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleDriveListFiles(call.args));
          } else if (call.name === 'google_drive_upload_file') {
            markLiveToolCallCommitted(call.id);
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleDriveUploadFile(call.args));
          } else if (call.name === 'google_drive_upload_local_file') {
            markLiveToolCallCommitted(call.id);
            addSystemMessage(`Uploading local file to Google Drive: ${call.args.path}`);
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleDriveUploadLocalFile(call.args));
          } else if (call.name === 'google_drive_create_folder') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleDriveCreateFolder(call.args));
          } else if (call.name === 'google_drive_set_link_sharing') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleDriveSetSharing(call.args));
          } else if (call.name === 'get_shadow_settings') {
            sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'success', settings: getCurrentShadowSettings() });
          } else if (call.name === 'update_shadow_settings') {
            try {
              const result = await applyShadowSettingsUpdate(call.args || {});
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, result);
              addSystemMessage(`Settings updated by voice: ${result.changed.join(', ') || 'no changes'}.`);
            } catch (err) {
              sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'error', error: err.message, settings: getCurrentShadowSettings() });
            }
          } else if (call.name === 'google_drive_download_file') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleDriveDownloadFile(call.args));
          } else if (call.name === 'google_drive_delete_file') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleDriveDeleteFile(call.args));
          } else if (call.name === 'google_drive_move_file') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleDriveMoveFile(call.args));
          } else if (call.name === 'google_drive_update_file') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleDriveUpdateFile(call.args));
          } else if (call.name === 'google_docs_create') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleDocsCreate(call.args));
          } else if (call.name === 'google_docs_get') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleDocsGet(call.args));
          } else if (call.name === 'google_sheets_create') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleSheetsCreate(call.args));
          } else if (call.name === 'google_sheets_get') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleSheetsGet(call.args));
          } else if (call.name === 'google_sheets_read_range') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleSheetsReadRange(call.args));
          } else if (call.name === 'google_sheets_update_range') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleSheetsUpdateRange(call.args));
          } else if (call.name === 'youtube_search') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => youtubeSearch(call.args));
          } else if (call.name === 'youtube_list_playlists') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => youtubeListPlaylists(call.args));
          } else if (call.name === 'google_photos_list_albums') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googlePhotosListAlbums(call.args));
          } else if (call.name === 'google_photos_list_media') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googlePhotosListMedia(call.args));
          } else if (call.name === 'google_photos_create_album') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googlePhotosCreateAlbum(call.args));
          } else if (call.name === 'google_contacts_list') {
            await sendLiveToolOutputFromOperation(currentSocket, thisConnectionAttemptId, call.id, () => googleContactsList(call.args));
          } else {
            console.warn('Unknown voice tool call:', call.name);
            sendLiveToolResponse(currentSocket, thisConnectionAttemptId, call.id, { status: 'error', error: `Tool ${call.name} is not implemented in the voice session handler.` });
          }
          } finally {
            unregisterLiveToolCall(call.id);
          }
        }
        return;
      }

      if (response.toolCallCancellation) {
        invalidateLiveToolOperations('Live API cancelled the current tool call batch.');
        if (typeof cancelActiveSmartConsult === 'function') {
          cancelActiveSmartConsult('Live API cancelled the foreground smart consult.');
        }
        return;
      }

      // Handle setup completion
      if (response.setupComplete) {
        clearTimeout(connectionSetupTimeout);
        connectionSetupTimeout = null;
        clearInterruptedTurnFallback();
        clearToolResponseFollowupPending();
        suppressInterruptedTurnAudio = false;
        clearServerInterruptPending();
        interruptedUserSpeechConfirmed = false;
        interruptedAudioHoldStartedAt = 0;
        console.log('Setup complete from server');
        setVisualizerState('listening');
        addSystemMessage('Shadow online. Say hello.');
        schedulePendingNotificationRetry(1000);
        if (proactiveEnabled) startProactiveAttention(screenStream ? 5000 : null);

        if (screenStream && !screenCaptureInterval) {
          screenCaptureInterval = setInterval(captureAndSendFrame, 1000);
          addSystemMessage('Screen sharing resumed after reconnect.');
        }

        // Now initialize and start microphone recorder
        audioRecorder = new AudioRecorder((base64PCM) => {
          if (isCurrentLiveSocket(currentSocket, thisConnectionAttemptId)) {
            sendLiveSocketJson(currentSocket, thisConnectionAttemptId, {
              realtimeInput: {
                audio: {
                  mimeType: 'audio/pcm;rate=16000',
                  data: base64PCM
                }
              }
            }, 'Live microphone audio chunk');
          }
        });

        try {
          await waitForNextFrame();
          if (thisConnectionAttemptId !== connectionAttemptId || socket !== currentSocket) return;
          await audioRecorder.start();
          if (thisConnectionAttemptId !== connectionAttemptId || socket !== currentSocket) {
            audioRecorder.stop();
            return;
          }
          audioPlayer.init();
          connectionInProgress = false;
        } catch (err) {
          console.error('Failed to start recorder or player:', err);
          connectionInProgress = false;
          disconnect('Could not access the microphone. Check Windows Settings → Privacy & security → Microphone (make sure microphone access + desktop-app access are on) and that a mic is connected, then reconnect.');
        }
        return;
      }

      // Context-size diagnostic: the server reports the rolling token count in usageMetadata. Log it when
      // it crosses a 4k bucket so we can SEE, over a long call, whether the sliding-window compression
      // (trigger ~32k / target ~16k) is actually holding context bounded — i.e. whether replies should
      // stay fast. If this climbs past ~40-50k and keeps rising, the bound isn't holding and we tune it.
      if (response.usageMetadata && typeof response.usageMetadata.totalTokenCount === 'number') {
        const totalTokens = response.usageMetadata.totalTokenCount;
        const bucket = Math.floor(totalTokens / 4000);
        if (bucket !== lastLoggedContextTokenBucket) {
          lastLoggedContextTokenBucket = bucket;
          const ageSec = liveSessionConnectedAt ? Math.round((Date.now() - liveSessionConnectedAt) / 1000) : 0;
          console.log(`[Live] Context ~${totalTokens} tokens (session age ${ageSec}s). Compression trigger ~32k / target ~16k — this should plateau, not keep climbing.`);
        }
      }

      if (response.serverContent) {
        const content = response.serverContent;

        // 1. Handle user speech interruption (barge-in)
        if (content.interrupted) {
          const micLevel = audioRecorder ? audioRecorder.getVolume() : 0;
          handleServerInterruptedEvent(micLevel);
        }

        // 2. Play returned audio chunks
        if (content.modelTurn) {
          clearToolResponseFollowupPending();
          const holdingInterruptedUserSpeech = shouldHoldInterruptedAudioForUserSpeech();
          if (suppressInterruptedTurnAudio && holdingInterruptedUserSpeech) {
            console.debug('Holding model audio while interrupted user speech is still active.');
          } else if (suppressInterruptedTurnAudio && interruptedUserSpeechConfirmed) {
            console.debug('Re-enabling audio for the response after confirmed user speech during interruption.');
            suppressInterruptedTurnAudio = false;
            clearServerInterruptPending();
            interruptedUserSpeechConfirmed = false;
            interruptedAudioHoldStartedAt = 0;
            resetLocalBargeInDetection();
            clearInterruptedTurnFallback();
            btnInterrupt.classList.remove('interrupting');
            if (audioPlayer) audioPlayer.reset();
          }

          if (!suppressInterruptedTurnAudio) {
            markModelTurnStarted('server modelTurn');
            if (aiTranscriptFinalized) {
              currentAITranscript = '';
              recentAIOutputForEcho = '';
              lastOutputTranscriptionText = '';
              currentAITranscriptHasModelText = false;
              aiTranscriptFinalized = false;
            }
            // Reset interrupted flag at start of each new model turn
            // (so audio from new turns can play after an interruption)
            audioPlayer.reset();

            // Track when AI starts speaking for barge-in echo protection
            if (currentVisualizerState !== 'speaking') {
              aiSpeechStartTime = Date.now();
            }

            void finalizeCurrentUserTranscriptForMemory();

            // Finalize user transcript bubble on model turn
            const activeUserBubble = document.querySelector('.current-user-bubble');
            if (activeUserBubble) {
              activeUserBubble.classList.remove('current-user-bubble');
            }
            currentUserTranscript = '';
            clearTimeout(userTranscriptTimeout);
          }

          if (content.modelTurn.parts) {
            content.modelTurn.parts.forEach(part => {
              if (part.inlineData && part.inlineData.data) {
                if (!suppressInterruptedTurnAudio) {
                  setVisualizerState('speaking');
                  audioPlayer.playChunk(part.inlineData.data);
                }
              }
              if (part.text && !suppressInterruptedTurnAudio) {
                currentAITranscriptHasModelText = true;
                accumulateAIText(part.text);
              }
            });
          }
        }

        // 3. Render Input/Output Transcripts if provided
        if (content.inputTranscription && content.inputTranscription.text) {
          if (smartMainRoutingEnabled && !currentUserTranscript) {
            resetSmartMainTurnDiagnostics(content.inputTranscription.text);
          } else {
            appendSmartMainUserTranscript(content.inputTranscription.text);
          }
          if (suppressInterruptedTurnAudio) {
            interruptedUserSpeechConfirmed = true;
            if (serverInterruptPending) {
              console.debug('Server interrupt settled after receiving user speech transcription.');
              clearServerInterruptPending();
            }
          }
          confirmPendingBargeIn(content.inputTranscription.text);
          addUserTranscript(content.inputTranscription.text);
        }
        if (content.outputTranscription && content.outputTranscription.text && !suppressInterruptedTurnAudio) {
          mergeOutputTranscription(content.outputTranscription.text);
        }

        if (content.turnComplete) {
          console.log('Turn complete');
          clearInterruptedTurnFallback();
          clearToolResponseFollowupPending();
          markTurnIdle('turnComplete', { completed: true });
          // Finalize bubble. Late outputTranscription can still replace this bubble
          // during LATE_TRANSCRIPTION_WINDOW_MS via getLastBotBubble().
          const bubble = document.querySelector('.current-ai-bubble');
          if (bubble) bubble.classList.remove('current-ai-bubble');
          if (currentAITranscript) rememberDialogueTurn('Assistant', currentAITranscript);

          // Deterministic guard against the "I spawned a subagent" hallucination: if the model just
          // TOLD the user it started/spawned background work but no spawn_background_agent ran this turn
          // and nothing is actually active, inject a correction so it either calls the tool now or
          // retracts — rather than leaving the user believing work is underway when it isn't.
          try {
            const aiSaid = String(currentAITranscript || '').toLowerCase();
            const claimedBackgroundStart =
              /\bin the background\b/.test(aiSaid) ||
              /\b(spawn|spawning|spawned|spun up|spin(?:ning)? up|kick(?:ed|ing)? off|set(?:ting)? up|fired? up|launch(?:ed|ing)?)\b[^.!?]{0,40}\b(sub-?agent|background|agent)\b/.test(aiSaid) ||
              /\b(sub-?agent|background (?:agent|task|worker|job))\b[^.!?]{0,40}\b(started|running|on it|working on|underway|now)\b/.test(aiSaid);
            const offering = /\b(if you (?:want|like|'d like|wish|prefer)|would you like|do you want|want me to|should i\b|i can\b|i could\b)\b/.test(aiSaid);
            const anyActive = Array.isArray(activeSubagents) && activeSubagents.some(s => s && (s.status === 'running' || s.status === 'waiting_auth'));
            if (claimedBackgroundStart && !offering && !spawnedSubagentThisTurn && !anyActive && typeof queueSchedulerMessage === 'function') {
              console.warn('[Smart] Background-work claim detected with no spawn this turn and no active subagent — injecting correction.');
              queueSchedulerMessage('[SYSTEM NOTICE - DO NOT READ VERBATIM] You just told the user you were starting or spawning background work, but you did NOT call spawn_background_agent this turn and no subagent is running. Either call spawn_background_agent NOW for that request, or tell the user plainly that you have not actually started it yet. Never claim background work is underway when it is not.', { lane: 'critical', critical: true, ttlMs: 60000, dedupeKey: 'false-spawn-claim' });
            } else if (!offering && !toolCalledThisTurn && !anyActive && typeof queueSchedulerMessage === 'function') {
              // Broader "narrated an action then stalled" guard: the model said it would DO something that
              // requires a tool (look at files, search, read, run a command, spawn a subagent) but ended the
              // turn without calling any tool — so it just waits until the user nudges ("hurry up?"). Detect
              // the announced intent and auto-nudge it to act NOW, so the user never has to poke it.
              const announcedAction =
                /\b(let me|let's|lemme|i'?ll|i will|i'?m going to|i'?m gonna|gonna|going to|hold on|hang on|gimme|give me)\b[^.!?]{0,48}\b(look|take a look|check|see|find|search|pull up|grab|open|list|read|review|scan|inspect|examine|go through|dig in|dig into|look into|look at|look through|spawn|set up|kick off|run|execute|fetch|gather)\b/.test(aiSaid) ||
                /\b(one|a)\s+(sec|second|moment|minute|mo|sec)\b/.test(aiSaid) ||
                /\b(let me|i'?ll|i will)\s+(do|handle|get)\s+(that|this|it)\b/.test(aiSaid);
              if (announcedAction) {
                console.warn('[Smart] Model announced an action but called no tool this turn — injecting do-it-now nudge.');
                queueSchedulerMessage('[SYSTEM NOTICE - DO NOT READ VERBATIM] You told the user you were about to do something (look at files, search, read, run a command, or spawn a background agent) but you ended your turn WITHOUT calling any tool. Do it NOW: call the appropriate tool immediately (list_directory, read_file, search_web, run_powershell_command, spawn_background_agent, etc.). Never announce an action and then stop and wait for the user to prompt you again.', { lane: 'critical', critical: true, ttlMs: 60000, dedupeKey: 'announced-no-tool' });
              }
            }
          } catch (e) {}
          spawnedSubagentThisTurn = false;
          toolCalledThisTurn = false;

          aiTranscriptFinalized = true;
          suppressInterruptedTurnAudio = false;
          clearServerInterruptPending();
          interruptedUserSpeechConfirmed = false;
          interruptedAudioHoldStartedAt = 0;
          resetLocalBargeInDetection();
          if (audioPlayer) {
            audioPlayer.clearOutputStallTimer();
            audioPlayer.reset();
          }
          btnInterrupt.classList.remove('interrupting');
          clearSystemNoticeInFlight();
          schedulePendingNotificationRetry(NOTIFICATION_COOLDOWN_MS);
          attemptSettingsReconnect();
          signalProactiveAttention('ai_turn_complete');
          // If no audio is currently playing, transition to listening state immediately
          if (audioPlayer && audioPlayer.activeSources.length === 0) {
            setVisualizerState('listening');
          }
        }
      } else {
        // Fallback diagnostic: if the server sent something else entirely, print it so we can see it!
        console.log('Unrecognized server message:', response);
        // Suppress warnings for sessionResumptionUpdate, which is a standard Gemini 3.1 session resume handle
        if (!response.sessionResumptionUpdate && !response.toolCallCancellation) {
          addSystemMessage('Unrecognized Server Message: ' + JSON.stringify(response).substring(0, 100));
        }
      }
    } catch (err) {
      console.error('Error parsing WebSocket message:', err);
      addSystemMessage(`WebSocket Error: ${err.message}`);
      // Keep the voice socket alive for local UI/helper errors. Disconnecting here
      // makes a single transcript/render bug look like Shadow died when the user speaks.
    }
  };

  currentSocket.onerror = (event) => {
    if (event && event.target !== currentSocket) return;
    if (thisConnectionAttemptId !== connectionAttemptId || socket !== currentSocket) return;
    console.error('WebSocket Error:', event);
    connectionInProgress = false;
    addSystemMessage('WebSocket error while connecting. Waiting for close details...');
  };

  currentSocket.onclose = (event) => {
    if (event && event.target !== currentSocket) return;
    if (thisConnectionAttemptId !== connectionAttemptId || socket !== currentSocket) return;
    console.log('WebSocket closed:', event);
    connectionInProgress = false;
    if (isConnected) {
      if (isAutoReconnecting) {
        disconnect('', { preserveScreenShare: true, reconnecting: true, silent: true });
        isAutoReconnecting = true; // Restore isAutoReconnecting since disconnect() clears it
        addSystemMessage('Connection reset. Reconnecting to Shadow...');
        setTimeout(() => {
          if (isAutoReconnecting) {
            connect();
          }
        }, 1500);
      } else {
        if (activeResumptionToken && isResumptionSocketClose(event)) {
          retryWithoutResumptionHandle(formatSocketCloseMessage(event, 'Previous session handle expired.'));
          return;
        }

        if (isInvalidRealtimePayloadSocketClose(event) && !userInitiatedDisconnect) {
          const invalidPayloadCloseCount = noteInvalidRealtimePayloadSocketClose();
          clearLiveSessionResumptionToken();
          if (typeof clearPendingSystemNotifications === 'function') {
            clearPendingSystemNotifications('Live API rejected a realtime payload');
          } else {
            clearSystemNoticeInFlight();
          }
          cancelActiveLiveWork('Live API rejected a realtime payload');

          if (invalidPayloadCloseCount > MAX_INVALID_REALTIME_PAYLOAD_RECONNECTS) {
            const closeMsg = formatSocketCloseMessage(event, 'Shadow stopped automatic reconnects after repeated invalid realtime payload rejects.');
            console.warn('[Live] Stopped reconnect loop after repeated invalid realtime payload closes.', {
              count: invalidPayloadCloseCount,
              code: event.code,
              reason: event.reason
            });
            disconnect(closeMsg);
            return;
          }

          const reason = `Live API rejected one realtime payload${event.reason ? `: ${event.reason}` : ''}`;
          scheduleSoftReconnect(reason, 750);
          return;
        }

        if (isPermanentSocketClose(event)) {
          const closeMsg = formatSocketCloseMessage(event, 'Shadow disconnected.');
          disconnect(closeMsg);
          return;
        }

        if (isTransientSocketClose(event) && !userInitiatedDisconnect) {
          const reason = event && event.code === 1007
            ? `Live API rejected one realtime payload${event.reason ? `: ${event.reason}` : ''}`
            : `Live API temporarily unavailable${event && event.reason ? `: ${event.reason}` : ''}`;
          scheduleSoftReconnect(reason, 500);
          return;
        }

        const closeMsg = formatSocketCloseMessage(event, 'Shadow disconnected.');
        disconnect(closeMsg);

        if (!userInitiatedDisconnect) {
          clearTimeout(watchdogTimer);
          watchdogTimer = setTimeout(async () => {
            watchdogBackoffMs = Math.min(watchdogBackoffMs * 2, maxWatchdogBackoffMs);
            addSystemMessage('Watchdog: Reconnecting to Shadow...');
            await connect();
          }, watchdogBackoffMs);
        }
      }
    } else if (!userInitiatedDisconnect) {
      if (activeResumptionToken && isResumptionSocketClose(event)) {
        retryWithoutResumptionHandle(formatSocketCloseMessage(event, 'Previous session handle expired.'));
        return;
      }

      if (isInvalidRealtimePayloadSocketClose(event)) {
        const invalidPayloadCloseCount = noteInvalidRealtimePayloadSocketClose();
        clearLiveSessionResumptionToken();
        if (typeof clearPendingSystemNotifications === 'function') {
          clearPendingSystemNotifications('Live API rejected a realtime payload during setup');
        } else {
          clearSystemNoticeInFlight();
        }
        if (invalidPayloadCloseCount > MAX_INVALID_REALTIME_PAYLOAD_RECONNECTS) {
          connectionFailed(event, { retry: false });
          return;
        }
      }

      if (isPermanentSocketClose(event)) {
        connectionFailed(event, { retry: false });
        return;
      }
      connectionFailed(event);
    }
  };
}

function formatSocketCloseMessage(event, fallback = 'Shadow disconnected.') {
  if (!event || !event.code) return fallback;
  return `${fallback} (Code: ${event.code}${event.reason ? ', Reason: ' + event.reason : ''})`;
}

function isInvalidRealtimePayloadSocketClose(event) {
  if (!event || event.code !== 1007) return false;
  return /\binvalid argument\b|\brequest contains an invalid argument\b/.test(String(event.reason || '').toLowerCase());
}

function noteInvalidRealtimePayloadSocketClose(now = Date.now()) {
  invalidRealtimePayloadCloseTimes = invalidRealtimePayloadCloseTimes
    .filter(closeTime => now - closeTime <= INVALID_REALTIME_PAYLOAD_RECONNECT_WINDOW_MS);
  invalidRealtimePayloadCloseTimes.push(now);
  return invalidRealtimePayloadCloseTimes.length;
}

function isTransientSocketClose(event) {
  if (!event) return false;
  if (isPermanentSocketClose(event)) return false;
  if (TRANSIENT_SOCKET_CLOSE_CODES.has(event.code)) return true;
  return /service|unavailable|overload|restart|try again|timeout/i.test(String(event.reason || ''));
}

function isPermanentSocketClose(event) {
  if (!event) return false;
  const reason = String(event.reason || '').toLowerCase();
  if (event.code === 1007 && /\binvalid argument\b|\brequest contains an invalid argument\b/.test(reason)) {
    return false;
  }
  if ([1002, 1003, 1008, 4001, 4002, 4003, 4004].includes(event.code)) return true;
  return /\b(api key|authentication|unauthorized|permission|policy|invalid|unsupported|not found|model|malformed|bad request|forbidden|quota project)\b/.test(reason);
}

function isResumptionSocketClose(event) {
  if (!event) return false;
  const text = `${event.code || ''} ${event.reason || ''}`.toLowerCase();
  return /\b(resumption|resume|session|bidigeneratecontent)\b/.test(text) &&
    /\b(handle|token|expired|invalid|not found|not_found|failed_precondition|1008)\b/.test(text);
}

function isTransientLiveApiError(error) {
  const text = `${error && (error.status || error.code || '')} ${error && (error.message || '')}`.toLowerCase();
  return /\b(unavailable|resource_exhausted|deadline_exceeded|internal|overload|try again|timeout|503|500)\b/.test(text);
}

function isPermanentLiveApiError(error) {
  const text = `${error && (error.status || error.code || '')} ${error && (error.message || '')}`.toLowerCase();
  return /\b(invalid_argument|not_found|permission_denied|unauthenticated|failed_precondition|api key|model|unsupported|malformed|bad request|forbidden|policy)\b/.test(text);
}

function isResumptionHandleError(error) {
  const text = `${error && (error.status || error.code || '')} ${error && (error.message || '')}`.toLowerCase();
  return /\b(resumption|resume|session)\b/.test(text) && /\b(handle|token|expired|invalid|not found|not_found|failed_precondition|invalid_argument)\b/.test(text);
}

function retryWithoutResumptionHandle(reason = 'Previous session handle expired.') {
  if (userInitiatedDisconnect) return;
  console.warn('Resumption handle was rejected. Clearing it and retrying with local dialogue history.');
  addSystemMessage(`${reason} Reconnecting with saved conversation context...`);
  clearLiveSessionResumptionToken();
  saveConfigToServer().catch(err => console.warn('Failed to save cleared resumption token:', err));
  disconnect('', { preserveScreenShare: true, reconnecting: true, silent: true });
  setTimeout(() => connect(), 500);
}

function scheduleSoftReconnect(reason = 'Live API connection dropped.', delayMs = watchdogBackoffMs) {
  if (userInitiatedDisconnect) return;
  clearTimeout(watchdogTimer);
  isAutoReconnecting = true;
  const delay = Math.max(250, delayMs || 500);
  addSystemMessage(`${reason} Reconnecting...`);
  disconnect('', { preserveScreenShare: true, reconnecting: true, silent: true });
  watchdogTimer = setTimeout(async () => {
    watchdogTimer = null;
    watchdogBackoffMs = Math.min(Math.max(watchdogBackoffMs, delay) * 2, maxWatchdogBackoffMs);
    await connect();
  }, delay);
}

function disconnect(customMessage = '', options = {}) {
  const { preserveScreenShare = false, reconnecting = false, silent = false } = options;
  connectionInProgress = false;
  connectionAttemptId++;
  cancelActiveLiveWork('voice session disconnected');
  isConnected = false;
  isAutoReconnecting = reconnecting;

  // User-initiated disconnect -> next connect starts FRESH (no resumed server
  // session, no re-injected recent dialogue). Auto-reconnects (network blips,
  // reconnecting=true) keep continuity. Long-term memory (memories.json) is
  // separate and intentionally persists.
  if (!reconnecting && userInitiatedDisconnect) {
    try { clearLiveSessionResumptionToken(); } catch (e) {}
    try { if (typeof clearRecentDialogueTurns === 'function') clearRecentDialogueTurns(); } catch (e) {}
  }

  clearTimeout(connectionSetupTimeout);
  connectionSetupTimeout = null;
  clearInterval(wsKeepaliveTimer);
  wsKeepaliveTimer = null;
  stopProactiveAttention();
  clearTimeout(settingsReconnectTimer);
  settingsReconnectTimer = null;
  pendingSettingsReconnect = false;
  markTurnIdle('disconnect');
  clearInterruptedTurnFallback();
  clearToolResponseFollowupPending();
  suppressInterruptedTurnAudio = false;
  clearServerInterruptPending();
  interruptedUserSpeechConfirmed = false;
  interruptedAudioHoldStartedAt = 0;
  btnInterrupt.classList.remove('interrupting');
  clearSystemNoticeInFlight();

  const tempSocket = socket;
  socket = null;

  if (audioRecorder) {
    audioRecorder.stop();
    audioRecorder = null;
  }
  if (audioPlayer) {
    audioPlayer.close();
    audioPlayer = null;
  }

  // Restore button states
  btnConnect.disabled = false;
  btnConnect.querySelector('.btn-text').textContent = reconnecting ? 'Reconnecting...' : 'Connect';
  btnConnect.classList.toggle('connected', reconnecting);
  connectionBadge.textContent = reconnecting ? 'Reconnecting' : 'Disconnected';
  connectionBadge.className = reconnecting ? 'status-badge state-connecting' : 'status-badge state-disconnected';
  if (!reconnecting) {
    modelBadge.classList.add('hidden');
    modelBadge.textContent = '';
  }
  btnToggleMic.disabled = true;
  btnToggleMic.classList.add('disabled');
  btnToggleMic.classList.remove('active', 'muted');
  btnInterrupt.classList.add('hidden');
  if (!reconnecting) btnNewSession.classList.add('hidden');

  if (preserveScreenShare && screenStream) {
    pauseScreenCapture();
    btnShareScreen.disabled = true;
    btnShareScreen.classList.add('disabled');
  } else {
    // Disable screen sharing
    btnShareScreen.disabled = true;
    btnShareScreen.classList.add('disabled');
    if (typeof stopScreenShare === 'function') stopScreenShare();
  }

  setVisualizerState(reconnecting ? 'connecting' : 'disconnected');
  updateSessionButtonVisibility();

  if (silent) {
    // Soft reconnect already announced the reason.
  } else if (customMessage) {
    addSystemMessage(customMessage);
  } else {
    addSystemMessage('Shadow disconnected.');
  }

  if (tempSocket) {
    try {
      tempSocket.close();
    } catch (e) {}
  }
}

function connectionFailed(err, options = {}) {
  const { retry = true } = options;
  if (err && err.target !== undefined && err.target !== socket) return;
  connectionInProgress = false;

  let failMsg = 'Connection failed. Verify API Key and check internet.';
  if (err && err.message) {
    failMsg = `Connection failed: ${err.message}`;
  } else if (err && err.code) {
    failMsg = formatSocketCloseMessage(err, 'Connection failed.');
  } else if (err && err.type === 'error') {
    failMsg = 'Connection failed: WebSocket error event';
  }

  disconnect(failMsg);

  if (retry && !userInitiatedDisconnect) {
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(async () => {
      watchdogBackoffMs = Math.min(watchdogBackoffMs * 2, maxWatchdogBackoffMs);
      addSystemMessage('Watchdog: Reconnecting to Shadow...');
      await connect();
    }, watchdogBackoffMs);
  }
}

function toggleMute() {
  if (!isConnected) return;

  isMuted = !isMuted;
  if (isMuted) {
    btnToggleMic.classList.add('muted');
    btnToggleMic.classList.remove('active');
    btnToggleMic.querySelector('#icon-mic-on').classList.add('hidden');
    btnToggleMic.querySelector('#icon-mic-off').classList.remove('hidden');
    addSystemMessage('Microphone muted.');
  } else {
    btnToggleMic.classList.remove('muted');
    btnToggleMic.classList.add('active');
    btnToggleMic.querySelector('#icon-mic-on').classList.remove('hidden');
    btnToggleMic.querySelector('#icon-mic-off').classList.add('hidden');
    addSystemMessage('Microphone active.');
  }
}

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

function triggerSoftReconnection() {
  if (!isConnected || !socket) return;
  console.log('[Whisper] Triggering soft reconnection to update system instructions...');
  isAutoReconnecting = true;
  cancelActiveLiveWork('voice settings soft reconnect');
  socket.close();
}

function checkWhisperStateToggle(text) {
  const currentIsWhispering = localStorage.getItem('shadow_is_whispering') === 'true';
  const newWhisperState = detectWhisperStateChange(text, currentIsWhispering);

  if (newWhisperState !== currentIsWhispering) {
    console.log(`[Whisper] Whisper state toggled from ${currentIsWhispering} to ${newWhisperState}`);
    localStorage.setItem('shadow_is_whispering', newWhisperState ? 'true' : 'false');

    if (newWhisperState) {
      addSystemMessage('Whispering enabled.');
    } else {
      addSystemMessage('Whispering disabled.');
    }

    triggerSoftReconnection();
  }
}

function getServerInterruptControlText(reason = 'manual') {
  const normalizedReason = String(reason || '').toLowerCase();
  if (normalizedReason.includes('local barge-in')) {
    return '[SYSTEM INTERRUPT CONTROL] Stop the current response immediately. The user is already speaking in the live audio stream; use that speech as the next user turn and do not answer this control message.';
  }
  return '[SYSTEM INTERRUPT CONTROL] Stop the current response immediately and wait silently for the next user input. Do not answer this control message.';
}

function clearServerInterruptPending() {
  serverInterruptPending = false;
  serverInterruptReason = '';
}

function isLocalBargeInServerInterruptPending() {
  return Boolean(serverInterruptPending && String(serverInterruptReason || '').toLowerCase().includes('local barge-in'));
}

function shouldDeferServerInterruptFallbackForUserAudio(now = Date.now()) {
  if (!isLocalBargeInServerInterruptPending()) return false;
  return shouldHoldInterruptedAudioForUserSpeech(now);
}

function shouldHoldInterruptedAudioForUserSpeech(now = Date.now()) {
  if (!suppressInterruptedTurnAudio) return false;
  if (!(localBargeInActive || interruptedUserSpeechConfirmed || isLocalBargeInServerInterruptPending())) return false;
  if (!lastUserAudioDetectedTime) return false;
  if (interruptedAudioHoldStartedAt && now - interruptedAudioHoldStartedAt > INTERRUPTED_USER_AUDIO_MAX_HOLD_MS) return false;
  return now - lastUserAudioDetectedTime < INTERRUPTED_USER_AUDIO_SETTLE_MS;
}

function isOutputAudioStallWatchdogState() {
  return Boolean(turnInProgress && ['speaking', 'thinking'].includes(currentVisualizerState));
}

function handleOutputAudioSoftStall() {
  if (!isConnected || suppressInterruptedTurnAudio) return false;
  if (!isOutputAudioStallWatchdogState()) return false;
  if (currentVisualizerState === 'speaking') {
    setVisualizerState('thinking');
  }
  console.debug(`Output audio paused for ${OUTPUT_AUDIO_STALL_THINKING_MS}ms; switching to thinking while the Live turn continues.`);
  return true;
}

function handleOutputAudioRecoveryStall() {
  if (!isConnected || suppressInterruptedTurnAudio) return false;
  if (!isOutputAudioStallWatchdogState()) return false;
  if (currentVisualizerState === 'speaking') {
    setVisualizerState('thinking');
  }
  console.debug(`Output audio stayed silent for ${OUTPUT_AUDIO_STALL_RECOVERY_MS}ms; keeping the Live turn open and waiting in thinking state.`);
  return true;
}

function sendServerInterruptSignal(reason = 'manual') {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;

  try {
    // A non-empty clientContent message is the documented way to interrupt
    // current Live generation without sending malformed empty turns.
    const sent = sendLiveSocketJson(socket, connectionAttemptId, {
      clientContent: {
        turns: [{
          role: 'user',
          parts: [{
            text: getServerInterruptControlText(reason)
          }]
        }],
        turnComplete: false
      }
    }, 'Live interrupt signal');
    if (!sent) return false;
    serverInterruptPending = true;
    serverInterruptReason = String(reason || 'manual');
    console.debug(`Sent server interrupt signal (${reason}).`);
    return true;
  } catch (e) {
    console.warn('Failed to send interrupt signal to server:', e);
    return false;
  }
}

function manualInterrupt(options = {}) {
  const { sendToServer = true, preserveLocalBargeIn = false } = options;
  if (!isConnected) return;
  console.log('Manual interruption triggered');

  clearTimeout(pendingBargeInTimer);
  pendingBargeInTimer = null;
  pendingBargeInMicLevel = 0;
  if (typeof cancelActiveSmartConsult === 'function') {
    cancelActiveSmartConsult('user interrupted voice response');
  }
  cancelLiveBackendCommands('manual interrupt');
  if (typeof cancelWorkspaceBackendRequests === 'function') {
    // Barge-in just means "stop talking" — let committed uploads finish and report back.
    cancelWorkspaceBackendRequests('manual interrupt', { includeCommitted: false });
  }
  if (!preserveLocalBargeIn) {
    resetLocalBargeInDetection();
  }
  suppressInterruptedTurnAudio = true;
  interruptedUserSpeechConfirmed = false;
  interruptedAudioHoldStartedAt = Date.now();

  const hadActiveResponse = isTurnActiveForManualInterrupt() || Boolean(currentAITranscript);
  if (hadActiveResponse) {
    invalidateLiveToolOperations('manual interrupt');
  }
  if (!hadActiveResponse) {
    suppressInterruptedTurnAudio = false;
    clearServerInterruptPending();
    interruptedUserSpeechConfirmed = false;
    interruptedAudioHoldStartedAt = 0;
    clearInterruptedTurnFallback();
    resetLocalBargeInDetection();
    if (audioPlayer) audioPlayer.reset();
    btnInterrupt.classList.remove('interrupting');
    markTurnIdle('manual interrupt ignored because no active response');
    setVisualizerState('listening');
    return;
  }
  lastVoiceInterruptTime = Date.now();
  if (sendToServer && hadActiveResponse) {
    sendServerInterruptSignal('manual');
  }

  // Clear local playback immediately
  if (audioPlayer) audioPlayer.stop();
  markTurnInterrupting('manual interrupt');
  clearSystemNoticeInFlight();
  setVisualizerState('interrupting');
  btnInterrupt.classList.add('interrupting');
  scheduleInterruptedTurnFallback();

  if (currentAITranscript) {
    currentAITranscript += '... [interrupted]';
    updateLastAITranscript(currentAITranscript);
    currentAITranscript = '';
    const interruptedBubble = document.querySelector('.current-ai-bubble');
    if (interruptedBubble) interruptedBubble.classList.remove('current-ai-bubble');
    aiTranscriptFinalized = true;
    lastAITurnCompleteTime = 0;
  }

  if (currentUserTranscript && !preserveLocalBargeIn) {
    const bubble = document.querySelector('.current-user-bubble');
    if (bubble) bubble.classList.remove('current-user-bubble');
    currentUserTranscript = '';
    clearTimeout(userTranscriptTimeout);
  }

}

function markToolResponseFollowupPending(reason = 'tool response') {
  toolResponseFollowupPending = true;
  markToolFollowupPending(reason);

  if (currentVisualizerState !== 'speaking' && currentVisualizerState !== 'interrupting') {
    setVisualizerState('thinking');
  }

  clearTimeout(toolResponseFollowupTimer);
  toolResponseFollowupTimer = setTimeout(() => {
    toolResponseFollowupTimer = null;
    if (!toolResponseFollowupPending) return;

    console.debug(`Tool follow-up did not produce a model turn after ${TOOL_RESPONSE_FOLLOWUP_TIMEOUT_MS}ms (${reason}).`);
    toolResponseFollowupPending = false;
    if (!suppressInterruptedTurnAudio && !serverInterruptPending) {
      markTurnIdle(`tool follow-up timeout: ${reason}`);
      if (currentVisualizerState === 'thinking') {
        setVisualizerState('listening');
      }
      schedulePendingNotificationRetry(NOTIFICATION_COOLDOWN_MS);
    }
  }, TOOL_RESPONSE_FOLLOWUP_TIMEOUT_MS);
}

function clearToolResponseFollowupPending() {
  toolResponseFollowupPending = false;
  clearTimeout(toolResponseFollowupTimer);
  toolResponseFollowupTimer = null;
}

// Force a stuck Live turn back to a clean listening state so the mic input gate reopens.
// The mic gate (isLiveWorkActiveForVoiceBargeIn) stays CLOSED while any turn/tool/visualizer flag
// still reads "work active". turnComplete normally clears all of those, but a turn can rarely end
// WITHOUT a turnComplete (e.g. the model enters a thinking / tool-follow-up phase and the server
// never sends turnComplete). When that happens the gate would stay shut and the session looks
// frozen: the mic circle still animates (driven by the local analyser) but normal-volume speech is
// gated behind the barge-in threshold and never reaches Gemini, so there is no reply until a manual
// reconnect. This mirrors the flag resets turnComplete performs so the idle watchdog can reopen the
// mic WITHOUT a reconnect. Only the watchdog calls this, and only once no real backend work is in
// flight and no audio is playing (see maybeRecoverIdleVisualizerState).
function forceRecoverStuckLiveTurn(reason = 'stuck-turn watchdog') {
  console.warn(`[Live] Force-recovering a stuck turn (${reason}); reopening the mic input gate.`);
  clearToolResponseFollowupPending();
  clearInterruptedTurnFallback();
  clearServerInterruptPending();
  suppressInterruptedTurnAudio = false;
  interruptedUserSpeechConfirmed = false;
  interruptedAudioHoldStartedAt = 0;
  resetLocalBargeInDetection();
  if (audioPlayer) {
    audioPlayer.clearOutputStallTimer();
    audioPlayer.reset();
  }
  if (typeof clearSystemNoticeInFlight === 'function') clearSystemNoticeInFlight();
  markTurnIdle(reason);
  setVisualizerState('listening');
}

function getDynamicMicThreshold(playVolume = 0, options = {}) {
  const { protectPlayback = false } = options;
  // No mic-vs-playback echo gating during normal listening; only protect active playback from
  // self-triggered barge-in using the minimum playback gate.
  const multiplier = protectPlayback ? MIN_PLAYBACK_BARGE_IN_GATE_MULTIPLIER : 0.0;
  return MIC_LEVEL_THRESHOLD + (Math.max(0, playVolume || 0) * multiplier);
}

function getLocalBargeInCandidateThreshold(playVolume = 0) {
  return MIC_LEVEL_THRESHOLD + (Math.max(0, playVolume || 0) * LOCAL_BARGE_IN_PREROLL_GATE_MULTIPLIER);
}

function isPlaybackActiveForBargeIn() {
  return Boolean(
    (audioPlayer && audioPlayer.activeSources && audioPlayer.activeSources.length > 0) ||
    currentVisualizerState === 'speaking'
  );
}

function isLiveWorkActiveForVoiceBargeIn() {
  return Boolean(
    isPlaybackActiveForBargeIn() ||
    toolResponseFollowupPending ||
    activeLiveBackendCommandIds.size > 0 ||
    activeLiveToolCallEpochs.size > 0 ||
    currentLiveToolAbortSignal ||
    currentVisualizerState === 'thinking' ||
    currentVisualizerState === 'interrupting'
  );
}

function isTurnActiveForManualInterrupt() {
  return Boolean(
    isLiveWorkActiveForVoiceBargeIn() ||
    turnInProgress ||
    currentVisualizerState === 'thinking' ||
    currentVisualizerState === 'interrupting'
  );
}

function maybeTriggerLocalBargeIn(micLevel, dynamicThreshold, options = {}) {
  if (!isLiveWorkActiveForVoiceBargeIn() || localBargeInActive) return false;

  const echoProtected = options.echoProtected !== undefined
    ? Boolean(options.echoProtected)
    : micLevel >= dynamicThreshold;
  const now = Date.now();
  if (!localBargeInStartedAt) localBargeInStartedAt = now;
  localBargeInSpeechFrames++;
  if (echoProtected) {
    localBargeInDynamicFrames++;
  } else {
    localBargeInDynamicFrames = 0;
  }
  if (localBargeInSpeechFrames < LOCAL_BARGE_IN_REQUIRED_FRAMES) return false;
  if (localBargeInDynamicFrames < LOCAL_BARGE_IN_DYNAMIC_CONFIRM_FRAMES) return false;
  if (now - localBargeInStartedAt < LOCAL_BARGE_IN_MIN_SPEECH_MS) return false;
  if (now - lastLocalBargeInTime < LOCAL_BARGE_IN_MIN_INTERVAL_MS) return false;

  lastLocalBargeInTime = now;
  localBargeInActive = true;
  console.log(`Local sustained barge-in confirmed after ${now - localBargeInStartedAt}ms, cutting audio: mic ${micLevel.toFixed(3)} >= threshold ${dynamicThreshold.toFixed(3)}`);
  manualInterrupt({ sendToServer: false, preserveLocalBargeIn: true });
  return true;
}

function clearInterruptedTurnFallback() {
  clearTimeout(interruptedTurnFallbackTimer);
  interruptedTurnFallbackTimer = null;
}

function scheduleInterruptedTurnFallback() {
  clearInterruptedTurnFallback();
  interruptedTurnFallbackTimer = setTimeout(() => {
    interruptedTurnFallbackTimer = null;
    if (!suppressInterruptedTurnAudio || !isConnected) return;
    if (serverInterruptPending) {
      if (shouldDeferServerInterruptFallbackForUserAudio()) {
        console.debug('Server interrupt fallback deferred while local barge-in audio is still being handled.');
        scheduleInterruptedTurnFallback();
        return;
      }
      console.warn('Server interrupt did not settle before fallback; reconnecting voice channel.');
      clearServerInterruptPending();
      interruptedUserSpeechConfirmed = false;
      interruptedAudioHoldStartedAt = 0;
      scheduleSoftReconnect('Interrupt did not settle cleanly.', 250);
      return;
    }
    if (shouldHoldInterruptedAudioForUserSpeech()) {
      console.debug('Interrupted turn cleanup deferred while user speech is still active.');
      scheduleInterruptedTurnFallback();
      return;
    }
    console.debug('Interrupted turn cleanup fallback elapsed before turnComplete');
    markTurnIdle('interrupted turn cleanup');
    suppressInterruptedTurnAudio = false;
    interruptedUserSpeechConfirmed = false;
    interruptedAudioHoldStartedAt = 0;
    clearToolResponseFollowupPending();
    resetLocalBargeInDetection();
    btnInterrupt.classList.remove('interrupting');
    if (audioPlayer) audioPlayer.reset();
    if (currentVisualizerState === 'interrupting') {
      setVisualizerState('listening');
    }
    clearSystemNoticeInFlight();
    schedulePendingNotificationRetry(NOTIFICATION_COOLDOWN_MS);
  }, serverInterruptPending ? SERVER_INTERRUPT_FALLBACK_RECONNECT_MS : LOCAL_INTERRUPT_FALLBACK_MS);
}

function finalizeInterruptedTurnWithoutCuttingAudio() {
  markTurnIdle('interrupted turn finalized', { completed: true });
  aiTranscriptFinalized = true;
  btnInterrupt.classList.remove('interrupting');
  clearSystemNoticeInFlight();

  const bubble = document.querySelector('.current-ai-bubble');
  if (bubble) bubble.classList.remove('current-ai-bubble');

  if (audioPlayer && audioPlayer.activeSources.length === 0) {
    setVisualizerState('listening');
  }
}

function handleServerInterruptedEvent(micLevel) {
  if (suppressInterruptedTurnAudio && (serverInterruptPending || localBargeInActive || interruptedUserSpeechConfirmed)) {
    if (serverInterruptPending) {
      console.debug(`Server acknowledged interrupt signal (${serverInterruptReason || 'manual'}).`);
      clearServerInterruptPending();
    } else {
      console.debug('Server interrupted event acknowledged for the already-cut local turn.');
    }
    return true;
  }

  if (!isPlaybackActiveForBargeIn() && !currentAITranscript) {
    console.debug('Ignoring server interrupted event because no Shadow audio is currently playing.');
    resetLocalBargeInDetection();
    return false;
  }

  const playVolume = (audioPlayer && typeof audioPlayer.getVolume === 'function') ? audioPlayer.getVolume() : 0;
  const dynamicThreshold = getDynamicMicThreshold(playVolume, { protectPlayback: true });
  const timeSinceAiSpeech = Date.now() - aiSpeechStartTime;
  const hasInterruptEvidence =
    serverInterruptPending ||
    localBargeInActive ||
    interruptedUserSpeechConfirmed ||
    (micLevel >= dynamicThreshold && timeSinceAiSpeech >= BARGE_IN_COOLDOWN_MS);

  if (!hasInterruptEvidence) {
    console.log(`Deferring likely false interrupt: mic ${micLevel.toFixed(3)} < threshold ${dynamicThreshold.toFixed(3)}, ${timeSinceAiSpeech}ms since speech start`);
    requestConfirmedBargeIn(micLevel, { finalizeOnTimeout: true });
    return false;
  }

  console.log(`Confirmed interruption; cutting playback. Local mic ${micLevel.toFixed(3)} >= threshold ${dynamicThreshold.toFixed(3)}`);
  const hadConfirmedInterruptedSpeech = interruptedUserSpeechConfirmed;
  manualInterrupt({ sendToServer: false });
  clearServerInterruptPending();
  if (hadConfirmedInterruptedSpeech) {
    interruptedUserSpeechConfirmed = true;
  }
  return true;
}

function requestConfirmedBargeIn(micLevel, options = {}) {
  const { finalizeOnTimeout = false } = options;
  pendingBargeInMicLevel = micLevel || 0;
  clearTimeout(pendingBargeInTimer);
  pendingBargeInTimer = setTimeout(() => {
    console.debug(`Barge-in confirmation window expired after ${BARGE_IN_CONFIRMATION_WINDOW_MS}ms without transcript`);
    pendingBargeInTimer = null;
    pendingBargeInMicLevel = 0;

    if (finalizeOnTimeout) {
      resetLocalBargeInDetection();
      suppressInterruptedTurnAudio = false;
      interruptedAudioHoldStartedAt = 0;
      btnInterrupt.classList.remove('interrupting');
      if (audioPlayer) audioPlayer.reset();
      finalizeInterruptedTurnWithoutCuttingAudio();
    } else {
      resetLocalBargeInDetection();
      suppressInterruptedTurnAudio = false;
      interruptedAudioHoldStartedAt = 0;
      btnInterrupt.classList.remove('interrupting');
      if (audioPlayer) audioPlayer.reset();
    }
  }, BARGE_IN_CONFIRMATION_WINDOW_MS);
}

function normalizeSpeechForEcho(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isLikelyEchoTranscript(text) {
  const clean = normalizeSpeechForEcho(text);
  if (clean.length < 10) return false;
  const recent = normalizeSpeechForEcho(recentAIOutputForEcho || currentAITranscript || (getLastBotBubble() && getLastBotBubble().textContent));
  return recent.length >= clean.length && recent.includes(clean);
}

function confirmPendingBargeIn(text) {
  if (!pendingBargeInTimer) return false;
  const clean = String(text || '').trim();
  if (clean.replace(/\s+/g, '').length < MIN_BARGE_IN_TRANSCRIPT_CHARS) {
    console.debug('Waiting for a fuller barge-in transcript before interrupting.');
    return false;
  }
  if (pendingBargeInMicLevel < MIC_LEVEL_THRESHOLD || isLikelyEchoTranscript(clean)) {
    clearTimeout(pendingBargeInTimer);
    pendingBargeInTimer = null;
    pendingBargeInMicLevel = 0;
    resetLocalBargeInDetection();
    suppressInterruptedTurnAudio = false;
    interruptedAudioHoldStartedAt = 0;
    btnInterrupt.classList.remove('interrupting');
    if (audioPlayer) audioPlayer.reset();
    console.log('Ignoring unconfirmed barge-in: transcript looked like echo or mic level fell below threshold');
    return false;
  }

  clearTimeout(pendingBargeInTimer);
  pendingBargeInTimer = null;
  pendingBargeInMicLevel = 0;
  resetLocalBargeInDetection();
  manualInterrupt();
  return true;
}
