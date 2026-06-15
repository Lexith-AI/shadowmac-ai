/**
 * ShadowMac - Subagent state, routing guards, cancellation, and backend health helpers.
 * Split from the original monolithic app.js; loaded as an ordered classic script.
 */

// --- Asynchronous REST Subagents & Proactive Notifications ---

function addSubagentMessage(text) {
  if (!SHOW_TEXT_TRANSCRIPT) {
    console.debug('[Subagent notice]', redactSensitiveText(text));
    return;
  }
  const bubble = document.createElement('div');
  bubble.className = 'transcript-bubble subagent-bubble';

  const icon = document.createElement('span');
  icon.className = 'subagent-icon';
  icon.setAttribute('aria-hidden', 'true');
  bubble.appendChild(icon);

  const content = document.createElement('span');
  content.textContent = redactSensitiveText(text);
  bubble.appendChild(content);

  transcriptFeed.appendChild(bubble);
  scrollTranscript();
}

function getControllableSubagents() {
  return activeSubagents.filter(s => s.status === 'running' || s.status === 'waiting_auth');
}

function isActiveSubagentStatus(status) {
  return /^(running|waiting_auth)$/i.test(String(status || ''));
}

function isTerminalSubagentStatus(status) {
  return /^(completed|failed|partial|cancelled)$/i.test(String(status || ''));
}

function getActiveSubagentDisplayCount() {
  return getControllableSubagents().length;
}

function updateSubagentIndicator() {
  persistActiveSubagentSnapshots();
  if (!subagentIndicator || !subagentIndicatorCount || !subagentIndicatorLabel) return;
  const count = getActiveSubagentDisplayCount();
  subagentIndicatorCount.textContent = String(count);
  subagentIndicatorLabel.textContent = 'subagents active';
  subagentIndicator.classList.toggle('active', count > 0);
  subagentIndicator.classList.toggle('idle', count === 0);
  subagentIndicator.title = count === 0
    ? 'No background subagents running'
    : `${count} background subagent${count === 1 ? '' : 's'} running`;
  subagentIndicator.setAttribute('aria-label', subagentIndicator.title);
  if (count > 0) {
    startSubagentSupervisor();
  } else {
    stopSubagentSupervisor();
  }
  updateDiagnosticsPanel();
  signalProactiveAttention('subagent_update');
}

function getLatestControllableSubagent() {
  const candidates = getControllableSubagents();
  return candidates.length ? candidates[candidates.length - 1] : null;
}

function isSubagentInterrupted(subagentRecord) {
  return Boolean(subagentRecord && subagentRecord.interruptRequested && !isSubagentCancelled(subagentRecord));
}

function consumeSubagentInterrupt(subagentRecord, message = 'Correction received; continuing with preserved context.') {
  if (!isSubagentInterrupted(subagentRecord)) return false;
  subagentRecord.interruptRequested = false;
  subagentRecord.status = 'running';
  subagentRecord.lastMessage = message;
  subagentRecord.abortController = new AbortController();
  appendSubagentTimelineEvent(subagentRecord, 'interrupt_consumed', message);
  updateSubagentIndicator();
  return true;
}

function interruptSubagentWithFeedback(subagentRecord, feedback, reason = 'User correction received.') {
  if (!subagentRecord || isSubagentCancelled(subagentRecord)) return false;
  const cleanFeedback = String(feedback || '').trim();
  if (cleanFeedback) subagentRecord.steerQueue.push(cleanFeedback);
  subagentRecord.interruptRequested = true;
  subagentRecord.interruptedAt = new Date().toISOString();
  subagentRecord.lastMessage = `Interrupted for correction: ${reason}`;
  cancelAuthCheckpoint(subagentRecord, reason);
  cancelSubagentBackendRuns(subagentRecord, reason);
  cancelSubagentBackendRequests(subagentRecord, reason);
  if (subagentRecord.abortController) subagentRecord.abortController.abort();
  appendSubagentTimelineEvent(subagentRecord, 'interrupted', reason, { feedback: cleanFeedback });
  addSubagentMessage(`[Subagent Interrupt] ${subagentRecord.id}: ${reason}`);
  updateSubagentIndicator();
  return true;
}

function isSubagentPromptBrainSteeringEnabled() {
  return Boolean(
    typeof smartMainRoutingEnabled !== 'undefined' &&
    smartMainRoutingEnabled &&
    typeof refineSubagentInstructionWithSelectedModel === 'function'
  );
}

function buildSubagentSteeringRefinementContext(subagentRecord, routingReason = '') {
  return {
    subagent_id: subagentRecord && subagentRecord.id,
    subagent_task: subagentRecord && subagentRecord.task,
    subagent_status: subagentRecord && subagentRecord.status,
    routing_reason: routingReason || 'A running subagent is being steered; rewrite this correction through the selected subagent model before injecting it.'
  };
}

function refineSubagentSteeringFeedbackWithSelectedModel(subagentRecord, feedback, routingReason = '') {
  const rawFeedback = String(feedback || '').trim();
  if (!rawFeedback || !isSubagentPromptBrainSteeringEnabled()) {
    return Promise.resolve({
      feedback: rawFeedback,
      refinedBySubagentModel: false,
      refinementAttempted: false
    });
  }

  const context = buildSubagentSteeringRefinementContext(subagentRecord, routingReason);
  return Promise.resolve(refineSubagentInstructionWithSelectedModel('steer', rawFeedback, context))
    .then(refined => {
      const cleanRefined = String(refined || '').trim();
      if (!cleanRefined) throw new Error('Subagent steering refinement returned empty text.');
      return {
        feedback: cleanRefined,
        refinedBySubagentModel: true,
        refinementAttempted: true
      };
    })
    .catch(err => {
      // Prompt-brain refinement is best-effort; if the chosen model is busy/unavailable
      // (e.g. an upstream 503/overload) we simply steer with the user's original wording.
      console.debug('[Smart] Prompt-brain refinement unavailable; using your original instruction.', err);
      return {
        feedback: rawFeedback,
        refinedBySubagentModel: false,
        refinementAttempted: true,
        refinementError: err && err.message ? err.message : String(err)
      };
    });
}

function interruptSubagentWithSelectedModelFeedback(subagentRecord, feedback, reason = 'User correction received.', routingReason = '') {
  return refineSubagentSteeringFeedbackWithSelectedModel(subagentRecord, feedback, routingReason)
    .then(result => {
      const finalReason = result.refinementAttempted
        ? `${reason} Selected-model steering refinement ${result.refinedBySubagentModel ? 'applied' : 'attempted'}.`
        : reason;
      const interrupted = interruptSubagentWithFeedback(subagentRecord, result.feedback, finalReason);
      return { ...result, interrupted };
    });
}

function resolveControllableSubagentReference(requestedId) {
  const candidates = getControllableSubagents();
  if (candidates.length === 0) return null;
  const cleanId = String(requestedId || '').trim();
  if (!cleanId || /^(latest|current|active|that|it|them|this|the\s+subagent|subagent|background\s+agent)$/i.test(cleanId)) {
    return candidates[candidates.length - 1] || null;
  }
  const exact = candidates.find(s => s.id === cleanId);
  if (exact) return exact;
  const lower = cleanId.toLowerCase();
  const insensitive = candidates.find(s => String(s.id || '').toLowerCase() === lower);
  if (insensitive) return insensitive;
  return candidates.length === 1 ? candidates[0] : null;
}

function getSubagentSnapshotText() {
  const recent = activeSubagents.slice(-10);
  if (recent.length === 0) return 'No subagents exist yet.';
  return recent.map(s => {
    const isActive = isActiveSubagentStatus(s.status);
    const activity = isActive ? 'ACTIVE NOW' : 'HISTORICAL ONLY - not currently doing work';
    const auth = s.authCheckpoint ? ` | AUTH CHECKPOINT: ${s.authCheckpoint.message}` : '';
    const summary = s.summary ? ` | Summary: ${String(s.summary).substring(0, 260)}` : '';
    const error = s.lastError ? ` | Last error: ${String(s.lastError).substring(0, 180)}` : '';
    const engine = s.provider ? `; engine=${s.provider}${s.model ? `/${s.model}` : ''}${s.adapter ? ` via ${s.adapter}` : ''}` : '';
    const search = s.webSearchCount ? `; webSearches=${s.webSearchCount}` : '';
    const evidence = getSubagentEvidenceSummary(s, 2);
    const evidenceText = evidence ? `; evidence=${evidence}` : '';
    return redactSensitiveText(`[${s.id}] status=${s.status}; activity=${activity}${engine}${search}; step=${s.step}; task="${s.task}"; last="${s.lastMessage}"; lastTool=${s.lastToolName || 'none'}:${s.lastToolStatus || 'n/a'}${evidenceText}${auth}${summary}${error}`);
  }).join('\n');
}

function summarizeSubagentToolResponse(toolName, responseStatus, responseData) {
  const status = String(responseStatus || '').toLowerCase();
  const data = responseData && typeof responseData === 'object' ? responseData : {};
  if (toolName === 'web_search') {
    const results = Array.isArray(data.results) ? data.results : [];
    const source = data.source ? ` via ${data.source}` : '';
    const query = data.query ? ` for "${String(data.query).slice(0, 80)}"` : '';
    return `${results.length} result(s)${query}${source}`;
  }
  if (toolName === 'run_powershell_command') {
    const output = String(data.output || data.error || '').replace(/\s+/g, ' ').trim();
    const meta = [];
    if (data.timedOut) meta.push('timed out');
    if (data.exitCode !== undefined && data.exitCode !== null) meta.push(`exit ${data.exitCode}`);
    const prefix = meta.length ? `${meta.join(', ')}: ` : '';
    return output ? `${prefix}${output}`.slice(0, 180) : `PowerShell returned ${status || 'unknown status'}${meta.length ? ` (${meta.join(', ')})` : ''}`;
  }
  if (toolName === 'read_file') {
    return data.path ? `read ${data.path}` : 'file read completed';
  }
  if (toolName === 'list_directory') {
    return data.path ? `listed ${data.path}` : 'directory list completed';
  }
  if (/^google_|^gmail_|^youtube_/.test(toolName || '')) {
    const output = typeof data.output === 'string' ? data.output : JSON.stringify(data.output || data).slice(0, 220);
    return output ? output.replace(/\s+/g, ' ').slice(0, 180) : `${toolName} returned ${status || 'unknown status'}`;
  }
  const text = String(data.message || data.error || data.output || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 180) : `${toolName || 'tool'} returned ${status || 'unknown status'}`;
}

function redactSubagentEventText(text) {
  return typeof redactSensitiveText === 'function'
    ? redactSensitiveText(text)
    : String(text || '');
}

function appendSubagentTimelineEvent(subagentRecord, type, detail = '', data = {}, now = Date.now()) {
  if (!subagentRecord) return null;
  const event = {
    at: new Date(now).toISOString(),
    type: String(type || 'event'),
    detail: redactSubagentEventText(String(detail || '')).slice(0, 320)
  };
  if (data && typeof data === 'object') {
    const safeData = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null || value === '') continue;
      safeData[key] = typeof value === 'string'
        ? redactSubagentEventText(value).slice(0, 240)
        : value;
    }
    if (Object.keys(safeData).length > 0) event.data = safeData;
  }
  subagentRecord.timeline = Array.isArray(subagentRecord.timeline) ? subagentRecord.timeline : [];
  subagentRecord.timeline.push(event);
  if (subagentRecord.timeline.length > 80) subagentRecord.timeline.splice(0, subagentRecord.timeline.length - 80);
  return event;
}

function getSubagentRunHistoryStorageKey() {
  return 'shadow_subagent_run_history_v1';
}

function getSubagentRunSummary(subagentRecord) {
  if (!subagentRecord) return null;
  return {
    id: subagentRecord.id,
    task: redactSubagentEventText(subagentRecord.task || ''),
    status: subagentRecord.status || '',
    provider: subagentRecord.provider || '',
    model: subagentRecord.model || '',
    adapter: subagentRecord.adapter || '',
    step: Number(subagentRecord.step) || 0,
    startedAt: subagentRecord.startedAt || '',
    completedAt: subagentRecord.completedAt || '',
    failedAt: subagentRecord.failedAt || '',
    lastMessage: redactSubagentEventText(subagentRecord.lastMessage || ''),
    lastToolName: subagentRecord.lastToolName || '',
    lastToolStatus: subagentRecord.lastToolStatus || '',
    lastError: redactSubagentEventText(subagentRecord.lastError || ''),
    summary: redactSubagentEventText(subagentRecord.summary || '').slice(0, 1200),
    successfulToolCount: Number(subagentRecord.successfulToolCount) || 0,
    failedToolCount: Number(subagentRecord.failedToolCount) || 0,
    webSearchCount: Number(subagentRecord.webSearchCount) || 0,
    backendCancelRequestedAt: subagentRecord.backendCancelRequestedAt || '',
    lastBackendCancelReason: redactSubagentEventText(subagentRecord.lastBackendCancelReason || ''),
    cancelledCommandCount: Array.isArray(subagentRecord.cancelledCommandIds) ? subagentRecord.cancelledCommandIds.filter(Boolean).length : 0,
    cancelledRequestCount: Array.isArray(subagentRecord.cancelledRequestIds) ? subagentRecord.cancelledRequestIds.filter(Boolean).length : 0,
    toolEvents: Array.isArray(subagentRecord.toolEvents) ? subagentRecord.toolEvents.slice(-12) : [],
    timeline: Array.isArray(subagentRecord.timeline) ? subagentRecord.timeline.slice(-24) : []
  };
}

function persistSubagentRunSummary(subagentRecord, now = Date.now()) {
  if (!subagentRecord || typeof localStorage === 'undefined') return false;
  try {
    const key = getSubagentRunHistoryStorageKey();
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    const history = Array.isArray(existing) ? existing : [];
    const summary = getSubagentRunSummary(subagentRecord);
    if (!summary) return false;
    summary.savedAt = new Date(now).toISOString();
    const next = [summary, ...history.filter(item => item && item.id !== summary.id)].slice(0, 40);
    localStorage.setItem(key, JSON.stringify(next));
    return true;
  } catch (err) {
    console.warn('Failed to persist subagent run summary:', err);
    return false;
  }
}

function getSubagentActiveSnapshotStorageKey() {
  return 'shadow_active_subagents_v1';
}

function getSubagentActiveSnapshot(subagentRecord, now = Date.now()) {
  const summary = getSubagentRunSummary(subagentRecord);
  if (!summary) return null;
  return {
    ...summary,
    snapshotKind: 'active',
    savedAt: new Date(now).toISOString(),
    interruptedAt: subagentRecord.interruptedAt || '',
    lastProgressAt: Number(subagentRecord.lastProgressAt) || 0,
    supervisorActionCount: Number(subagentRecord.supervisorActionCount) || 0,
    cancelledCommandIds: Array.isArray(subagentRecord.cancelledCommandIds) ? [...new Set(subagentRecord.cancelledCommandIds.filter(Boolean))].slice(-40) : [],
    cancelledRequestIds: Array.isArray(subagentRecord.cancelledRequestIds) ? [...new Set(subagentRecord.cancelledRequestIds.filter(Boolean))].slice(-40) : [],
    activeCommandIds: Array.isArray(subagentRecord.activeCommandIds) ? [...new Set(subagentRecord.activeCommandIds.filter(Boolean))].slice(-12) : [],
    activeRequestIds: Array.isArray(subagentRecord.activeRequestIds) ? [...new Set(subagentRecord.activeRequestIds.filter(Boolean))].slice(-12) : []
  };
}

function persistActiveSubagentSnapshots(now = Date.now()) {
  if (typeof localStorage === 'undefined' || !Array.isArray(activeSubagents)) return false;
  try {
    const key = getSubagentActiveSnapshotStorageKey();
    const snapshots = activeSubagents
      .filter(subagent => subagent && (subagent.status === 'running' || subagent.status === 'waiting_auth'))
      .map(subagent => getSubagentActiveSnapshot(subagent, now))
      .filter(Boolean)
      .slice(-20);
    if (snapshots.length > 0) {
      localStorage.setItem(key, JSON.stringify(snapshots));
    } else {
      localStorage.removeItem(key);
    }
    return true;
  } catch (err) {
    console.warn('Failed to persist active subagent snapshots:', err);
    return false;
  }
}

function recoverOrphanedActiveSubagentSnapshots(now = Date.now()) {
  if (typeof localStorage === 'undefined' || !Array.isArray(activeSubagents)) return [];
  const key = getSubagentActiveSnapshotStorageKey();
  let snapshots = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    snapshots = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('Failed to read active subagent snapshots:', err);
    localStorage.removeItem(key);
    return [];
  }
  if (snapshots.length === 0) return [];

  const maxAgeMs = typeof SUBAGENT_ACTIVE_SNAPSHOT_MAX_AGE_MS === 'number'
    ? SUBAGENT_ACTIVE_SNAPSHOT_MAX_AGE_MS
    : 24 * 60 * 60 * 1000;
  const restored = [];
  for (const snapshot of snapshots.slice(-20)) {
    if (!snapshot || !snapshot.id || activeSubagents.some(subagent => subagent && subagent.id === snapshot.id)) continue;
    const savedAtMs = Date.parse(snapshot.savedAt || snapshot.startedAt || '');
    if (Number.isFinite(savedAtMs) && now - savedAtMs > maxAgeMs) continue;
    const reason = 'Interrupted by app reload or runtime restart; any tracked backend work was cancelled if still active.';
    const restoredRecord = {
      id: String(snapshot.id),
      task: snapshot.task || '',
      status: 'orphaned',
      step: Number(snapshot.step) || 0,
      lastMessage: reason,
      steerQueue: [],
      interruptRequested: false,
      interruptedAt: snapshot.interruptedAt || '',
      cancelRequested: false,
      startedAt: snapshot.startedAt || '',
      completedAt: new Date(now).toISOString(),
      failedAt: new Date(now).toISOString(),
      summary: snapshot.summary || '',
      lastError: reason,
      failedToolCount: Number(snapshot.failedToolCount) || 0,
      lastToolStatus: snapshot.lastToolStatus || '',
      lastToolName: snapshot.lastToolName || '',
      checkedSkills: false,
      savedSkill: false,
      authCheckpoint: null,
      executedCommands: [],
      activeCommandIds: Array.isArray(snapshot.activeCommandIds) ? snapshot.activeCommandIds.filter(Boolean) : [],
      activeRequestIds: Array.isArray(snapshot.activeRequestIds) ? snapshot.activeRequestIds.filter(Boolean) : [],
      cancelledCommandIds: Array.isArray(snapshot.cancelledCommandIds) ? snapshot.cancelledCommandIds.filter(Boolean) : [],
      cancelledRequestIds: Array.isArray(snapshot.cancelledRequestIds) ? snapshot.cancelledRequestIds.filter(Boolean) : [],
      backendCancelRequestedAt: snapshot.backendCancelRequestedAt || '',
      lastBackendCancelReason: snapshot.lastBackendCancelReason || '',
      toolEvents: Array.isArray(snapshot.toolEvents) ? snapshot.toolEvents.slice(-12) : [],
      timeline: Array.isArray(snapshot.timeline) ? snapshot.timeline.slice(-24) : [],
      successfulToolCount: Number(snapshot.successfulToolCount) || 0,
      webSearchCount: Number(snapshot.webSearchCount) || 0,
      webSearchQueries: [],
      webSearchResultUrls: [],
      lastProgressAt: Number(snapshot.lastProgressAt) || now,
      supervisorLastSignature: '',
      lastSupervisorNoticeAt: 0,
      supervisorActionCount: Number(snapshot.supervisorActionCount) || 0,
      abortController: typeof AbortController !== 'undefined' ? new AbortController() : null
    };
    activeSubagents.push(restoredRecord);
    appendSubagentTimelineEvent(restoredRecord, 'orphaned_after_reload', reason, {
      activeCommandIds: restoredRecord.activeCommandIds.length,
      activeRequestIds: restoredRecord.activeRequestIds.length
    }, now);
    if (restoredRecord.activeCommandIds.length > 0) cancelSubagentBackendRuns(restoredRecord, reason);
    if (restoredRecord.activeRequestIds.length > 0) cancelSubagentBackendRequests(restoredRecord, reason);
    persistSubagentRunSummary(restoredRecord, now);
    restored.push(restoredRecord);
  }

  localStorage.removeItem(key);
  if (restored.length > 0) {
    const notice = `[Subagent Recovery] Restored ${restored.length} interrupted background task${restored.length === 1 ? '' : 's'} after reload and marked them orphaned. Restart any still-needed task.`;
    addSubagentMessage(notice);
    notifyModelOfSubagentUpdate(notice);
    updateSubagentIndicator();
  }
  return restored;
}

function recordSubagentToolEvent(subagentRecord, toolName, responseStatus, responseData, now = Date.now()) {
  if (!subagentRecord) return null;
  const status = String(responseStatus || (responseData && responseData.error ? 'error' : 'unknown')).toLowerCase();
  const event = {
    at: new Date(now).toISOString(),
    name: toolName || 'unknown_tool',
    status,
    summary: summarizeSubagentToolResponse(toolName, status, responseData)
  };
  if (responseData && responseData.error) event.error = String(responseData.error).slice(0, 240);
  subagentRecord.toolEvents = Array.isArray(subagentRecord.toolEvents) ? subagentRecord.toolEvents : [];
  subagentRecord.toolEvents.push(event);
  if (subagentRecord.toolEvents.length > 40) subagentRecord.toolEvents.splice(0, subagentRecord.toolEvents.length - 40);
  if (status === 'success' && toolName !== 'finish_task') {
    subagentRecord.successfulToolCount = (Number(subagentRecord.successfulToolCount) || 0) + 1;
  }
  appendSubagentTimelineEvent(subagentRecord, status === 'success' ? 'tool_success' : 'tool_result', `${toolName || 'tool'}: ${event.summary}`, {
    tool: toolName || 'unknown_tool',
    status
  }, now);
  if (typeof persistActiveSubagentSnapshots === 'function') persistActiveSubagentSnapshots(now);
  return event;
}

function isSubagentToolFailureStatus(responseStatus, responseData = null) {
  const status = String(responseStatus || '').toLowerCase();
  if (responseData && responseData.error) return true;
  if (!status || status === 'unknown') return true;
  return ['error', 'failed', 'failure', 'blocked', 'cancelled', 'timeout'].includes(status);
}

function getSubagentEvidenceSummary(subagentRecord, maxEvents = 4) {
  if (!subagentRecord || !Array.isArray(subagentRecord.toolEvents)) return '';
  const useful = subagentRecord.toolEvents
    .filter(event => event && event.name !== 'finish_task' && event.status === 'success')
    .slice(-maxEvents);
  return useful.map(event => `${event.name}: ${event.summary}`).join(' | ');
}

function getSubagentStatusPayload(subagentRecord, now = Date.now()) {
  if (!subagentRecord) return null;
  const lastProgressAt = Number(subagentRecord.lastProgressAt) || 0;
  const startedAtMs = Date.parse(subagentRecord.startedAt || '');
  const completedAtMs = Date.parse(subagentRecord.completedAt || subagentRecord.failedAt || '');
  const status = subagentRecord.status || '';
  const isActive = isActiveSubagentStatus(status);
  const isTerminal = isTerminalSubagentStatus(status);
  const activeCommandIds = Array.isArray(subagentRecord.activeCommandIds) ? subagentRecord.activeCommandIds.filter(Boolean) : [];
  const activeRequestIds = Array.isArray(subagentRecord.activeRequestIds) ? subagentRecord.activeRequestIds.filter(Boolean) : [];
  const cancelledCommandIds = Array.isArray(subagentRecord.cancelledCommandIds) ? subagentRecord.cancelledCommandIds.filter(Boolean) : [];
  const cancelledRequestIds = Array.isArray(subagentRecord.cancelledRequestIds) ? subagentRecord.cancelledRequestIds.filter(Boolean) : [];
  const authCheckpoint = subagentRecord.authCheckpoint ? {
    message: redactSubagentEventText(subagentRecord.authCheckpoint.message || ''),
    url: subagentRecord.authCheckpoint.url || '',
    startedAt: subagentRecord.authCheckpoint.startedAt || null,
    timeoutSeconds: subagentRecord.authCheckpoint.timeoutSeconds || null
  } : null;
  return {
    id: subagentRecord.id,
    task: redactSubagentEventText(subagentRecord.task || ''),
    provider: subagentRecord.provider || '',
    model: subagentRecord.model || '',
    adapter: subagentRecord.adapter || '',
    status,
    isActive,
    isTerminal,
    activityState: isActive ? 'active' : (isTerminal ? 'historical' : 'inactive'),
    modelInstruction: isActive
      ? 'This subagent is currently active.'
      : 'This subagent is not currently doing work. Treat it as history only.',
    step: Number(subagentRecord.step) || 0,
    lastMessage: redactSubagentEventText(subagentRecord.lastMessage || ''),
    summary: redactSubagentEventText(subagentRecord.summary || '').slice(0, 1200),
    lastError: redactSubagentEventText(subagentRecord.lastError || ''),
    failedToolCount: Number(subagentRecord.failedToolCount) || 0,
    successfulToolCount: Number(subagentRecord.successfulToolCount) || 0,
    webSearchCount: Number(subagentRecord.webSearchCount) || 0,
    lastToolName: subagentRecord.lastToolName || '',
    lastToolStatus: subagentRecord.lastToolStatus || '',
    evidenceSummary: getSubagentEvidenceSummary(subagentRecord, 4),
    recentToolEvents: Array.isArray(subagentRecord.toolEvents) ? subagentRecord.toolEvents.slice(-8) : [],
    recentTimeline: Array.isArray(subagentRecord.timeline) ? subagentRecord.timeline.slice(-10) : [],
    activeCommandCount: activeCommandIds.length,
    activeRequestCount: activeRequestIds.length,
    backendCancellationPending: Boolean(subagentRecord.backendCancelRequestedAt && (activeCommandIds.length > 0 || activeRequestIds.length > 0)),
    backendCancelRequestedAt: subagentRecord.backendCancelRequestedAt || null,
    lastBackendCancelReason: redactSubagentEventText(subagentRecord.lastBackendCancelReason || ''),
    cancelRequestedCommandCount: cancelledCommandIds.length,
    cancelRequestedRequestCount: cancelledRequestIds.length,
    interruptRequested: Boolean(subagentRecord.interruptRequested),
    interruptedAt: subagentRecord.interruptedAt || null,
    lastProgressAt: lastProgressAt || null,
    idleSeconds: lastProgressAt ? Math.max(0, Math.round((now - lastProgressAt) / 1000)) : null,
    runtimeSeconds: Number.isFinite(startedAtMs) ? Math.max(0, Math.round((now - startedAtMs) / 1000)) : null,
    completedAgeSeconds: Number.isFinite(completedAtMs) ? Math.max(0, Math.round((now - completedAtMs) / 1000)) : null,
    supervisorActionCount: Number(subagentRecord.supervisorActionCount) || 0,
    authCheckpoint,
    startedAt: subagentRecord.startedAt || null,
    completedAt: subagentRecord.completedAt || null,
    failedAt: subagentRecord.failedAt || null
  };
}

function getSubagentStatusList(limit = 20, now = Date.now()) {
  const count = Math.max(1, Number(limit) || 20);
  return activeSubagents
    .slice(-count)
    .map(subagent => getSubagentStatusPayload(subagent, now))
    .filter(Boolean);
}

function getSuccessfulSubagentToolEvents(subagentRecord) {
  if (!subagentRecord || !Array.isArray(subagentRecord.toolEvents)) return [];
  return subagentRecord.toolEvents.filter(event => event && event.name !== 'finish_task' && event.status === 'success');
}

function getSubagentSuccessEvidenceRequirements(task) {
  const lower = String(task || '').toLowerCase();
  const requirements = new Set();
  const add = (...tools) => tools.forEach(tool => requirements.add(tool));
  const hasAny = pattern => pattern.test(lower);

  if (hasAny(/\bgoogle\s*drive\b|\bdrive\b/) && hasAny(/\b(upload|copy|send|put)\b/)) {
    add('google_drive_upload_local_file', 'google_drive_upload_file');
  }
  if (hasAny(/\bgoogle\s*drive\b|\bdrive\b/) && hasAny(/\b(create|make|new)\b/) && hasAny(/\bfolder\b/)) {
    add('google_drive_create_folder');
  }
  if (hasAny(/\bgoogle\s*drive\b|\bdrive\b/) && hasAny(/\b(download|delete|remove|move|update)\b/)) {
    add('google_drive_download_file', 'google_drive_delete_file', 'google_drive_move_file', 'google_drive_update_file');
  }
  if (hasAny(/\b(gmail|email|e-mail|mail)\b/) && hasAny(/\b(draft|compose)\b/)) add('gmail_create_draft');
  if (hasAny(/\b(gmail|email|e-mail|mail)\b/) && hasAny(/\b(send|sent|email|mail)\b/)) add('gmail_send_message');
  if (hasAny(/\b(gmail|email|e-mail|mail)\b/) && hasAny(/\b(read|list|find|search|check)\b/)) add('gmail_list_messages', 'gmail_get_message');
  if (hasAny(/\b(calendar|event|appointment)\b/) && hasAny(/\b(create|add|schedule|book)\b/)) add('google_calendar_create_event');
  if (hasAny(/\b(calendar|event|appointment)\b/) && hasAny(/\b(list|what|next|upcoming|check|read)\b/)) add('google_calendar_list_events');
  if (hasAny(/\b(contact|phone number|email address)\b/)) add('google_contacts_list');
  if (hasAny(/\bgoogle\s*doc|document\b/) && hasAny(/\b(create|make|new)\b/)) add('google_docs_create');
  if (hasAny(/\bgoogle\s*doc|document\b/) && hasAny(/\b(read|get|fetch|open)\b/)) add('google_docs_get');
  if (hasAny(/\b(sheet|spreadsheet)\b/) && hasAny(/\b(create|make|new)\b/)) add('google_sheets_create');
  if (hasAny(/\b(sheet|spreadsheet)\b/) && hasAny(/\b(read|get|fetch|range)\b/)) add('google_sheets_get', 'google_sheets_read_range');
  if (hasAny(/\b(sheet|spreadsheet)\b/) && hasAny(/\b(update|write|edit|change)\b/)) add('google_sheets_update_range');
  if (hasAny(/\byoutube\b/) && hasAny(/\b(search|find|playlist|playlists)\b/)) add('youtube_search', 'youtube_list_playlists');
  if (hasAny(/\bphoto|photos|album\b/) && hasAny(/\bgoogle\s*photos|photos\b/)) add('google_photos_list_albums', 'google_photos_list_media', 'google_photos_create_album');
  if (hasAny(/\b(memory|remember)\b/) && hasAny(/\b(save|store|update|delete|remove|link)\b/)) add('upsert_memory_node', 'link_memory_nodes', 'delete_memory_node');
  if (hasAny(/\bskill\b/) && hasAny(/\b(save|create|merge|delete|remove|list|check)\b/)) add('get_available_skills', 'save_skill', 'delete_skill');
  if (hasAny(/\b(today|tomorrow|next week|this week|open now|in stock|available|availability|booking|price|prices|budget|cheap|cheapest|best|top|review|reviews|deal|stock|current|latest|near me)\b/) &&
      hasAny(/\b(search|research|find|compare|plan|recommend|look up|look for|options?)\b/)) {
    add('web_search');
  }
  if (hasAny(/\b(read|show|inspect|open)\b/) && hasAny(/\b(file|log|txt|json|md|csv|document)\b|[a-z]:[\\/]/i)) add('read_file', 'run_powershell_command');
  if (hasAny(/\b(list|find|search)\b/) && hasAny(/\b(folder|directory|files?)\b|[a-z]:[\\/]/i)) add('list_directory', 'run_powershell_command');
  if (hasAny(/\b(create|make|write|edit|update|change|delete|remove|move|copy|rename|download|compress|convert|transcode|install|build|test|fix|debug|run|execute)\b/) &&
      hasAny(/\b(file|folder|directory|script|project|code|app|repo|video|audio|image|package|server|vps)\b|[a-z]:[\\/]/i)) {
    add('run_powershell_command');
  }

  return Array.from(requirements);
}

function hasSuccessfulSubagentToolEvidence(subagentRecord, requiredTools = []) {
  const successfulEvents = getSuccessfulSubagentToolEvents(subagentRecord);
  if (requiredTools.length === 0) return successfulEvents.length > 0;
  return successfulEvents.some(event => requiredTools.includes(event.name));
}

function getConcreteVerificationEvidence(verification) {
  const verificationText = String(verification || '').trim();
  if (/\b(exit code\s*0|file exists|event id|message id|drive id|document id|spreadsheet id|album id|test passed|tests passed|source url)\b|https?:\/\/|\b[a-z]:[\\/]/i.test(verificationText)) {
    return verificationText.slice(0, 240);
  }
  return '';
}

function isEvidenceRequiredForSubagentSuccess(task) {
  const lower = String(task || '').toLowerCase();
  if (!lower.trim()) return true;
  const actionPattern = /\b(create|make|edit|update|change|delete|remove|move|copy|rename|upload|download|send|schedule|remind|search|research|find|compare|analy[sz]e|list|read|write|run|execute|install|build|test|fix|debug|compress|convert|transcode|summari[sz]e|check|verify|look up|look for|open|save|merge|clean|organize)\b/;
  const targetPattern = /\b(file|folder|directory|drive|gmail|email|calendar|contact|doc|sheet|spreadsheet|website|web|browser|price|stock|review|availability|task|reminder|code|script|project|video|audio|image|photo|memory|skill|backup|vps|server|database)\b|https?:\/\/|\b[a-z]:[\\/]/i;
  const answerOnlyPattern = /\b(explain|tell me|what is|what are|why|how does|brainstorm|discuss|opinion|think about)\b/;
  if (actionPattern.test(lower) || targetPattern.test(lower)) return true;
  return !answerOnlyPattern.test(lower);
}

function getSubagentFinishReadiness(task, finalStatus, verification, subagentRecord) {
  const status = String(finalStatus || '').toLowerCase();
  if (status !== 'success') return { ok: true, reason: '' };
  // Custom OpenAI-compatible endpoints (esp. smaller models) are weak at producing a separate
  // verification step; accept any successful tool action as sufficient evidence so simple tasks can
  // actually finish instead of looping (and growing the prompt past their context).
  if (subagentRecord && subagentRecord.provider === 'custom_openai' && (Number(subagentRecord.successfulToolCount) || 0) > 0) {
    return { ok: true, reason: '', evidence: getSubagentEvidenceSummary(subagentRecord, 6) };
  }
  if (!isEvidenceRequiredForSubagentSuccess(task)) return { ok: true, reason: '' };
  const requiredTools = getSubagentSuccessEvidenceRequirements(task);
  const evidence = getSubagentEvidenceSummary(subagentRecord, 6);
  if (hasSuccessfulSubagentToolEvidence(subagentRecord, requiredTools)) return { ok: true, reason: '', evidence };
  const concreteVerification = getConcreteVerificationEvidence(verification);
  if (concreteVerification) {
    return { ok: true, reason: '', evidence: concreteVerification };
  }
  const requirementText = requiredTools.length
    ? ` Successful evidence for this task should come from one of: ${requiredTools.join(', ')}.`
    : '';
  return {
    ok: false,
    reason: `Success requires relevant evidence from a completed tool call or concrete verification.${requirementText} Inspect/verify the result with a tool, then call finish_task again.`
  };
}

function getSubagentProgressSignature(subagentRecord) {
  if (!subagentRecord) return '';
  return [
    subagentRecord.status,
    subagentRecord.step,
    subagentRecord.lastMessage,
    subagentRecord.lastToolName,
    subagentRecord.lastToolStatus,
    subagentRecord.failedToolCount,
    subagentRecord.summary,
    subagentRecord.lastError
  ].map(value => String(value || '')).join('|');
}

function refreshSubagentProgressState(subagentRecord, now = Date.now()) {
  if (!subagentRecord) return '';
  const signature = getSubagentProgressSignature(subagentRecord);
  if (!subagentRecord.supervisorLastSignature || subagentRecord.supervisorLastSignature !== signature) {
    subagentRecord.supervisorLastSignature = signature;
    subagentRecord.lastProgressAt = now;
    if (typeof persistActiveSubagentSnapshots === 'function') persistActiveSubagentSnapshots(now);
  }
  return signature;
}

function getSubagentSupervisorAssessment(subagentRecord, now = Date.now()) {
  refreshSubagentProgressState(subagentRecord, now);
  if (!subagentRecord || subagentRecord.status !== 'running') return null;
  if (isSubagentInterrupted(subagentRecord) || subagentRecord.authCheckpoint) return null;
  const failedToolCount = Number(subagentRecord.failedToolCount) || 0;
  if (failedToolCount >= 2) {
    return {
      reason: `${failedToolCount} failed tool calls`,
      feedback: `[SUPERVISOR] You have ${failedToolCount} failed tool calls. Stop the current approach and choose a simpler recovery path: verify paths/state first, reduce command complexity, use safer direct APIs where available, and call finish_task with partial status if blocked.`
    };
  }
  const idleMs = now - (subagentRecord.lastProgressAt || now);
  const longToolExecuting = /\bExecuting tool:\s*(run_powershell_command|google_drive_upload_local_file)\b/i.test(subagentRecord.lastMessage || '');
  const stallMs = longToolExecuting ? SUBAGENT_LONG_TOOL_STALL_MS : SUBAGENT_STALL_MS;
  if (idleMs >= stallMs) {
    const minutes = Math.max(2, Math.round(idleMs / 60000));
    return {
      reason: `no progress for ${minutes} minutes`,
      feedback: `[SUPERVISOR] No visible progress for about ${minutes} minutes. Interrupt this step, inspect the latest state, try a smaller verifiable action, and finish partial instead of looping if the task is blocked.`
    };
  }
  return null;
}

function runSubagentSupervisorPass(now = Date.now()) {
  const running = activeSubagents.filter(s => s.status === 'running');
  if (running.length === 0) {
    stopSubagentSupervisor();
    return [];
  }

  const actions = [];
  for (const subagentRecord of running) {
    const assessment = getSubagentSupervisorAssessment(subagentRecord, now);
    if (!assessment) continue;
    if (subagentRecord.lastSupervisorNoticeAt && now - subagentRecord.lastSupervisorNoticeAt < SUBAGENT_SUPERVISOR_NOTICE_COOLDOWN_MS) continue;
    const maxRecoveries = typeof SUBAGENT_SUPERVISOR_MAX_RECOVERIES === 'number'
      ? SUBAGENT_SUPERVISOR_MAX_RECOVERIES
      : 3;
    if ((subagentRecord.supervisorActionCount || 0) >= maxRecoveries) {
      const failureReason = `Supervisor stopped repeated recovery after ${maxRecoveries} corrective attempts (${assessment.reason}).`;
      cancelSubagentBackendRuns(subagentRecord, failureReason);
      cancelSubagentBackendRequests(subagentRecord, failureReason);
      if (subagentRecord.abortController) subagentRecord.abortController.abort();
      failSubagentRecord(subagentRecord, failureReason);
      appendSubagentTimelineEvent(subagentRecord, 'supervisor_failed', assessment.reason);
      const notice = `[SUBAGENT SUPERVISOR] ${subagentRecord.id} failed after repeated recovery attempts because ${assessment.reason}.`;
      addSubagentMessage(notice);
      notifyModelOfSubagentUpdate(notice);
      notifyVoiceSessionOfFailure(subagentRecord.task, failureReason, subagentRecord.id);
      actions.push({ subagentId: subagentRecord.id, reason: assessment.reason, status: 'failed' });
      continue;
    }
    subagentRecord.lastSupervisorNoticeAt = now;
    subagentRecord.supervisorActionCount = (subagentRecord.supervisorActionCount || 0) + 1;
    actions.push({ subagentId: subagentRecord.id, reason: assessment.reason, status: 'steering' });
    const supervisorSteerPromise = typeof interruptSubagentWithSelectedModelFeedback === 'function'
      ? interruptSubagentWithSelectedModelFeedback(
        subagentRecord,
        assessment.feedback,
        'Supervisor corrective guidance.',
        `The deterministic supervisor detected ${assessment.reason}; refine this recovery guidance before steering the running subagent.`
      )
      : Promise.resolve({
        interrupted: interruptSubagentWithFeedback(subagentRecord, assessment.feedback, 'Supervisor corrective guidance.')
      });
    void supervisorSteerPromise.then(result => {
      if (!result || !result.interrupted) return;
      const notice = `[SUBAGENT SUPERVISOR] ${subagentRecord.id} was interrupted for corrective guidance because ${assessment.reason}.`;
      appendSubagentTimelineEvent(subagentRecord, 'supervisor_guidance', assessment.reason);
      addSubagentMessage(notice);
      notifyModelOfSubagentUpdate(notice);
    }).catch(err => {
      console.warn('[Subagent Supervisor] Failed to steer subagent with corrective guidance:', err);
    });
  }
  updateDiagnosticsPanel();
  return actions;
}

function startSubagentSupervisor() {
  if (subagentSupervisorTimer) return;
  subagentSupervisorTimer = setInterval(() => runSubagentSupervisorPass(), SUBAGENT_SUPERVISOR_INTERVAL_MS);
}

function stopSubagentSupervisor() {
  if (!subagentSupervisorTimer) return;
  clearInterval(subagentSupervisorTimer);
  subagentSupervisorTimer = null;
}

function injectSubagentSnapshotToModel(reason) {
  const snapshot = getSubagentSnapshotText();
  const message = `[SUBAGENT SNAPSHOT: ${reason}]\n${snapshot}\nOnly claim facts shown in this snapshot. If the snapshot does not contain the answer, say you do not know and use get_active_subagents if needed.`;
  addSystemMessage(`Subagent snapshot injected: ${reason}`);
  notifyModelOfSubagentUpdate(message);
}

function extractDirectSteeringFeedback(text) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  const lower = clean.toLowerCase();
  const hasAgentTarget = /\b(subagent|sub-agent|background agent|agent|pa|assistant)\b/.test(lower);
  if (!hasAgentTarget) return '';

  const patterns = [
    /\b(?:tell|ask|steer|instruct)\s+(?:the\s+)?(?:subagent|sub-agent|background agent|agent|pa|assistant)\s+(?:to\s+)?(.+)/i,
    /\b(?:tell|ask|steer|instruct)\s+(?:it|them|him|her)\s+(?:to\s+)?(.+)/i,
    /\b(?:the\s+)?(?:subagent|sub-agent|background agent|agent|pa|assistant)\s+(?:should|needs? to|has to|must)\s+(.+)/i,
    /\b(?:have|make)\s+(?:the\s+)?(?:subagent|sub-agent|background agent|agent|pa|assistant)\s+(.+)/i
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return '';
}

function isSubagentStatusQuestion(text) {
  const lower = String(text || '').toLowerCase();
  if (!/\b(subagent|sub-agent|background agent|agent|pa|assistant|it|they)\b/.test(lower)) return false;
  return /\b(what.*(doing|said|say|status|happened)|how.*(doing|going)|still.*(working|running|doing)|is.*(working|running|stuck|done)|did.*(finish|fail|say)|knows? what|what's.*doing|whats.*doing)\b/.test(lower)
    || /\b(?:check|peek|look)\s+(?:in\s+)?(?:on|at)?\s*(?:the\s+)?(?:subagent|sub-agent|background agent|agent|pa|it|them|they)\b/.test(lower);
}

function getDirectProactiveSettingsIntent(text) {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) return null;

  if (/\b(?:turn|switch|enable)\s+(?:on\s+)?proactive\b|\bproactive\s+(?:on|enabled)\b/.test(lower)) {
    return { args: { proactive_enabled: true }, key: 'enable' };
  }
  if (/\b(?:turn|switch|disable)\s+(?:off\s+)?proactive\b|\bproactive\s+(?:off|disabled)\b|\bstop\s+being\s+proactive\b/.test(lower)) {
    return { args: { proactive_enabled: false }, key: 'disable' };
  }

  const proactiveWords = /\b(proactive|talk|speak|chime|jump|comment|react|interrupt|quiet|chatty|present|active|movie|cinema|screen|watch|watching|hyper|unhinged|insane|overdrive|20x|50x)\b/.test(lower);
  if (!proactiveWords) return null;

  // "unhinged" (5x) is the top mode. The old extreme aliases (insane/20x, overdrive/50x) were removed,
  // so a spoken request for any of them now maps here to the most-present surviving mode.
  if (/\b(?:unhinged|insane|overdrive|5x|20x|50x|five\s+times|twenty\s+times|fifty\s+times)\b/.test(lower) && /\b(?:proactive|talk|speak|chime|react|comment|present|active|mode|right now)\b/.test(lower)) {
    return { args: { proactive_enabled: true, proactive_profile: 'unhinged' }, key: 'profile:unhinged' };
  }
  if (/\b(?:hyper|4x|four\s+times)\b/.test(lower) && /\b(?:proactive|talk|speak|chime|react|comment|present|active|mode)\b/.test(lower)) {
    return { args: { proactive_enabled: true, proactive_profile: 'hyper' }, key: 'profile:hyper' };
  }
  if (/\b(?:immersive|movie|cinema|watching|watch)\b/.test(lower) && /\b(?:proactive|talk|speak|chime|react|comment|movie|screen|watching|watch)\b/.test(lower)) {
    return { args: { proactive_enabled: true, proactive_profile: 'immersive' }, key: 'profile:immersive' };
  }
  if (/\b(?:lively|2x|twice|double)\b/.test(lower) && /\b(?:proactive|talk|speak|chime|react|comment)\b/.test(lower)) {
    return { args: { proactive_enabled: true, proactive_profile: 'lively' }, key: 'profile:lively' };
  }
  if (/\b(?:balanced|normal|middle|default)\b/.test(lower) && /\b(?:proactive|talk|speak|chime|react|comment)\b/.test(lower)) {
    return { args: { proactive_enabled: true, proactive_profile: 'balanced' }, key: 'profile:balanced' };
  }
  if (/\b(?:quiet|quieter|less chatty|say less|talk less|speak less|chime in less|comment less|react less|interrupt less|back off|tone it down|too chatty|too much)\b/.test(lower)) {
    const strongQuiet = /\b(?:quiet mode|be quiet|way less|much less|a lot less|barely|almost never|shut up)\b/.test(lower);
    return {
      args: strongQuiet
        ? { proactive_enabled: true, proactive_profile: 'quiet' }
        : { proactive_enabled: true, proactive_adjustment: 'less' },
      key: strongQuiet ? 'profile:quiet' : 'adjust:less'
    };
  }
  if (/\b(?:talk more|speak more|chime in more|comment more|react more|more proactive|more active|more present|less quiet|don't be so quiet|dont be so quiet|be chatty|be more chatty|jump in more)\b/.test(lower)) {
    const strongEngaged = /\b(?:much more|way more|a lot more|very proactive|super proactive|full proactive|be very chatty)\b/.test(lower);
    return {
      args: strongEngaged
        ? { proactive_enabled: true, proactive_profile: 'lively' }
        : { proactive_enabled: true, proactive_adjustment: 'more' },
      key: strongEngaged ? 'profile:lively' : 'adjust:more'
    };
  }

  return null;
}

function maybeDirectHandleProactiveUtterance(text) {
  const intent = getDirectProactiveSettingsIntent(text);
  if (!intent) return;

  const now = Date.now();
  if (lastDirectProactiveCommand.key === intent.key && now - lastDirectProactiveCommand.at < 10000) return;
  lastDirectProactiveCommand = { key: intent.key, at: now };

  addSystemMessage('Proactive mode settings are locked from voice control. Change them in settings.');
}

function hasExplicitSubagentReference(text) {
  return /\b(sub\s*-?\s*agents?|background agents?|agents?|pa)\b/i.test(String(text || ''));
}

function hasImplicitSubagentReference(text) {
  return /\b(current|that|it|them|they)\b/i.test(String(text || ''));
}

function isSubagentCancelUtterance(text) {
  const lower = String(text || '').toLowerCase();
  if (!/\b(stop|cancel|kill|terminate|abort|shut\s*down|end)\b/.test(lower)) return false;
  // A correction/redirection ("stop doing X, do Y instead", "stop and use Z", "actually make it
  // ...") is STEERING, not a full cancel. Don't kill the subagent over a stop-word that is really
  // a course correction — only treat it as a cancel when there is no redirecting instruction.
  if (/\b(instead|rather|on second thought|actually|and (?:then |now |instead )?(?:do|use|make|try|switch|change|add|run|go|focus|create|write|build|continue)|now (?:do|use|make|try|switch|change|focus|continue)|switch to|change (?:it |that )?to|use \w+ instead|keep going)\b/.test(lower)) {
    return false;
  }
  return hasExplicitSubagentReference(lower) || hasImplicitSubagentReference(lower);
}

function getCancelTargetsForUtterance(text) {
  const controllable = getControllableSubagents();
  if (controllable.length === 0) return [];
  const lower = String(text || '').toLowerCase();
  const wantsAll = controllable.length === 1 || /\b(all|both|every|current|running|active|them|agents?|sub\s*-?\s*agents?)\b/.test(lower);
  if (wantsAll) return controllable;
  const latest = getLatestControllableSubagent();
  return latest ? [latest] : [];
}

function maybeDirectHandleSubagentUtterance(text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!key || directSteeredTurns.has(key)) return;

  const waitingAuth = activeSubagents.find(s => s.authCheckpoint);
  if (waitingAuth && /\b(done|completed|complete|logged in|login done|2fa done|resume|continue|approved|verified|finished)\b/i.test(clean)) {
    directSteeredTurns.add(key);
    resumeAuthCheckpoint(waitingAuth, 'User said authentication/login is complete. Inspect the page and continue.');
    trimDirectSteeringCache();
    return;
  }

  if (isSubagentCancelUtterance(clean)) {
    const hasControllableSubagents = getControllableSubagents().length > 0;
    if (!hasExplicitSubagentReference(clean) && !hasControllableSubagents) return;
    directSteeredTurns.add(key);
    const targets = getCancelTargetsForUtterance(clean);
    const cancelled = targets.filter(target => cancelSubagentRecord(target, 'Cancelled from user voice command.'));
    if (cancelled.length > 0) {
      const ids = cancelled.map(s => s.id).join(', ');
      lastDirectSubagentCancel = { at: Date.now(), ids, count: cancelled.length, utterance: clean };
      addSubagentMessage(`[Direct Cancel] Cancelled ${cancelled.length} background subagent(s): ${ids}`);
    } else {
      notifyModelOfSubagentUpdate(`[DIRECT SUBAGENT CANCEL] The user said: "${clean}", but there are no running background subagents to cancel. Briefly tell the user none are running.`);
    }
    trimDirectSteeringCache();
    return;
  }

  const feedback = extractDirectSteeringFeedback(clean);
  if (feedback) {
    const target = getLatestControllableSubagent();
    if (target) {
      directSteeredTurns.add(key);
      trimDirectSteeringCache();
      // Interrupt IMMEDIATELY with the raw correction so the subagent stops now and the voice is
      // not blocked on a slow refine, then refine in the background and queue the refined version
      // as a follow-up clarification.
      const interrupted = interruptSubagentWithFeedback(target, feedback, 'Direct user correction.');
      if (interrupted) {
        const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
        notifyModelOfSubagentUpdate(`[DIRECT SUBAGENT INTERRUPT] User feedback interrupted subagent ${target.id} and was queued into its preserved context: "${feedback}". Speak as ${assistantLabel} in first person: say I stopped the current background step and I am continuing with the correction.`);
        if (typeof isSubagentPromptBrainSteeringEnabled === 'function' && isSubagentPromptBrainSteeringEnabled()
            && typeof refineSubagentSteeringFeedbackWithSelectedModel === 'function') {
          Promise.resolve(refineSubagentSteeringFeedbackWithSelectedModel(
            target,
            feedback,
            'A transcript-level user correction targeted the latest running subagent; refine it through the selected subagent model.'
          )).then(res => {
            const refined = res && res.refinedBySubagentModel ? String(res.feedback || '').trim() : '';
            if (refined && refined !== String(feedback || '').trim() && !isSubagentCancelled(target) && Array.isArray(target.steerQueue)) {
              target.steerQueue.push(`[Refined clarification of the previous correction] ${refined}`);
            }
          }).catch(() => { /* best-effort; the raw correction was already applied */ });
        }
      }
    }
    return;
  }

  if (isSubagentStatusQuestion(clean)) {
    const hasControllableSubagents = getControllableSubagents().length > 0;
    if (!hasExplicitSubagentReference(clean) && !hasControllableSubagents) return;
    directSteeredTurns.add(key);
    // The user's spoken status question is already the active Live turn. Queuing
    // a snapshot here arrives after the natural answer and causes a duplicate reply.
    addSystemMessage('Subagent status question detected; answering in the current user turn.');
    trimDirectSteeringCache();
  }
}

function trimDirectSteeringCache() {
  while (directSteeredTurns.size > DIRECT_STEERED_LIMIT) {
    directSteeredTurns.delete(directSteeredTurns.values().next().value);
  }
}

function resumeAuthCheckpoint(subagentRecord, note = 'User completed authentication.') {
  if (!subagentRecord || !subagentRecord.authCheckpoint) return false;
  const checkpoint = subagentRecord.authCheckpoint;
  if (checkpoint.timeoutId) clearTimeout(checkpoint.timeoutId);
  subagentRecord.authCheckpoint = null;
  subagentRecord.status = 'running';
  subagentRecord.lastMessage = note;
  if (checkpoint.resolve) checkpoint.resolve({ status: 'success', message: note });
  appendSubagentTimelineEvent(subagentRecord, 'auth_resumed', note);
  addSubagentMessage(`[Auth Checkpoint] Resuming ${subagentRecord.id}: ${note}`);
  updateSubagentIndicator();
  return true;
}

function cancelAuthCheckpoint(subagentRecord, reason = 'Authentication checkpoint cancelled.') {
  if (!subagentRecord || !subagentRecord.authCheckpoint) return false;
  const checkpoint = subagentRecord.authCheckpoint;
  if (checkpoint.timeoutId) clearTimeout(checkpoint.timeoutId);
  subagentRecord.authCheckpoint = null;
  if (checkpoint.resolve) checkpoint.resolve({ status: 'error', error: reason });
  appendSubagentTimelineEvent(subagentRecord, 'auth_cancelled', reason);
  updateSubagentIndicator();
  return true;
}

function waitForUserAuthCheckpoint(subagentRecord, args = {}) {
  const timeoutSeconds = Math.min(Math.max(Number(args.timeout_seconds) || 900, 60), 3600);
  const message = String(args.message || 'Please complete the login, 2FA, CAPTCHA, passkey, or account verification in the visible browser, then click Resume.');
  const url = String(args.url || '');

  return new Promise(resolve => {
    const timeoutId = setTimeout(() => {
      if (subagentRecord.authCheckpoint && subagentRecord.authCheckpoint.resolve === resolve) {
        subagentRecord.authCheckpoint = null;
        subagentRecord.status = 'running';
        subagentRecord.lastMessage = 'Auth checkpoint timed out.';
        appendSubagentTimelineEvent(subagentRecord, 'auth_timeout', `User authentication checkpoint timed out after ${timeoutSeconds} seconds.`, { url, timeoutSeconds });
        addSubagentMessage(`[Auth Checkpoint] Timed out for ${subagentRecord.id} after ${timeoutSeconds} seconds.`);
        notifyModelOfSubagentUpdate(`[AUTH CHECKPOINT TIMEOUT] Subagent ${subagentRecord.id} timed out waiting for user authentication after ${timeoutSeconds} seconds. It should inspect current state and finish partial if authentication is still blocked.`);
        updateSubagentIndicator();
        resolve({ status: 'error', error: `User authentication checkpoint timed out after ${timeoutSeconds} seconds.` });
      }
    }, timeoutSeconds * 1000);

    subagentRecord.status = 'waiting_auth';
    subagentRecord.lastMessage = `Waiting for user authentication: ${message}`;
    subagentRecord.authCheckpoint = {
      message,
      url,
      startedAt: new Date().toISOString(),
      timeoutSeconds,
      timeoutId,
      resolve
    };
    appendSubagentTimelineEvent(subagentRecord, 'auth_waiting', message, { url, timeoutSeconds });
    updateSubagentIndicator();

    renderAuthCheckpointBubble(subagentRecord);
    notifyModelOfSubagentUpdate(`[AUTH CHECKPOINT] Subagent ${subagentRecord.id} paused for user authentication. Message: ${message}. Do not claim it is done until the checkpoint resumes.`);
  });
}

function renderAuthCheckpointBubble(subagentRecord) {
  if (!SHOW_TEXT_TRANSCRIPT || !transcriptFeed) return;
  const checkpoint = subagentRecord.authCheckpoint;
  if (!checkpoint) return;

  const bubble = document.createElement('div');
  bubble.className = 'transcript-bubble subagent-auth-bubble';

  const title = document.createElement('div');
  title.className = 'subagent-auth-title';
  title.textContent = 'Authentication Needed';
  bubble.appendChild(title);

  const body = document.createElement('div');
  body.className = 'subagent-auth-body';
  body.textContent = checkpoint.message;
  bubble.appendChild(body);

  const meta = document.createElement('div');
  meta.className = 'subagent-auth-meta';
  meta.textContent = `Subagent: ${subagentRecord.id}${checkpoint.url ? ` | Page: ${checkpoint.url}` : ''}`;
  bubble.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'subagent-auth-actions';

  const resumeButton = document.createElement('button');
  resumeButton.className = 'secondary-button subagent-auth-button';
  resumeButton.textContent = 'I finished login/2FA';
  resumeButton.addEventListener('click', () => {
    resumeButton.disabled = true;
    resumeAuthCheckpoint(subagentRecord, 'User clicked resume after completing authentication. Inspect the page and continue.');
  });
  actions.appendChild(resumeButton);

  const statusButton = document.createElement('button');
  statusButton.className = 'secondary-button subagent-auth-button';
  statusButton.textContent = 'Show status';
  statusButton.addEventListener('click', () => injectSubagentSnapshotToModel('user clicked auth checkpoint status'));
  actions.appendChild(statusButton);

  bubble.appendChild(actions);
  transcriptFeed.appendChild(bubble);
  scrollTranscript();
}

function convertSchemaTypesToLowercase(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const newSchema = Array.isArray(schema) ? [...schema] : { ...schema };
  if (typeof newSchema.type === 'string') {
    newSchema.type = newSchema.type.toLowerCase();
  }
  if (newSchema.properties && typeof newSchema.properties === 'object') {
    const newProps = {};
    for (const [key, value] of Object.entries(newSchema.properties)) {
      newProps[key] = convertSchemaTypesToLowercase(value);
    }
    newSchema.properties = newProps;
  }
  if (newSchema.items && typeof newSchema.items === 'object') {
    newSchema.items = convertSchemaTypesToLowercase(newSchema.items);
  } else if (newSchema.type === 'array') {
    newSchema.items = {};
  }
  return newSchema;
}

function isShadowSelfModificationTask(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return false;
  const selfPhrases = [
    'modify shadow ai source', 'edit shadow ai source', 'fix shadow ai source',
    'modify shadow ai code', 'edit shadow ai code', 'fix shadow ai code',
    'delete shadow ai source', 'remove shadow ai source',
    'overwrite shadow ai', 'rewrite shadow ai',
    "modify shadow's code", "edit shadow's code", "fix shadow's code",
    'modify the shadow app code', 'edit the shadow app code', 'fix the shadow app code',
    'modify app.js', 'edit app.js', 'fix app.js', 'change app.js',
    'modify run.ps1', 'edit run.ps1', 'fix run.ps1', 'change run.ps1',
    'modify browser_controller', 'edit browser_controller', 'fix browser_controller',
    'overwrite app.js', 'overwrite run.ps1'
  ];
  return selfPhrases.some(phrase => lower.includes(phrase));
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

function isGoogleWorkspaceTask(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return false;
  return /\b(gmail|email|e-mail|mailbox|inbox|calendar|google\s*calendar|google\s*drive|drive folder|drive file|workspace)\b/.test(lower);
}

function isExplicitBrowserAutomationTask(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return false;
  return /\b(browser|chrome|webpage|website|visible page|on screen|screen|ui|click|open gmail|open calendar|open drive)\b/.test(lower)
    || /\buse\s+(?:the\s+)?(?:browser|chrome|visible browser)\b/.test(lower);
}

function isHeavyLocalProcessingText(text) {
  const lower = String(text || '').toLowerCase();
  const heavyAction = /\b(compress|transcode|encode|convert|resize|downscale|extract audio|burn subtitles|trim|cut|merge|mux|remux|render)\b/.test(lower);
  const mediaTarget = /\b(video|audio|mp4|mov|mkv|webm|avi|wav|mp3|ffmpeg|handbrake)\b|\.(mp4|mov|mkv|webm|avi|wav|mp3)\b/.test(lower);
  return heavyAction && mediaTarget;
}

function shouldDelegateHeavyLocalProcessingCommand(command) {
  const lower = String(command || '').toLowerCase();
  if (!/\b(ffmpeg|handbrakecli)\b/.test(lower)) return false;
  if (/\b(-version|-h|--help|-encoders|-decoders|-formats|-probe|-show_streams|-show_format)\b/.test(lower)) return false;
  return /\b-i\b|\.mp4\b|\.mov\b|\.mkv\b|\.webm\b|\.avi\b|\.wav\b|\.mp3\b/.test(lower);
}

function isShadowSelfModificationCommand(command) {
  const lower = String(command || '').toLowerCase();
  if (!lower) return false;
  const writePattern = /\b(set-content|add-content|out-file|remove-item|move-item|copy-item|rename-item|clear-content|set-itemproperty)\b/i;
  if (!writePattern.test(lower)) return false;

  // Project root path identifiers Ã¢â‚¬â€ only match if the command clearly targets inside the Shadow project
  const projectPathMarkers = /(?:(?:\/|\\)shadow-ai(?:[\/\\]|$)|["']?(?:\.\/|\.\\)src[\/\\]|["']?src[\/\\])/i;
  const selfFileMarkers = /[\/\\]shadow-ai[\/\\](?:src[\/\\])?(?:app\.js|run\.ps1|browser_controller\.js|desktop_controller\.ps1|index\.html|index\.css|package\.json|package-lock\.json|memories\.json|config\.json)[\"']?\s*$/i;
  const projectResourceMarkers = /[\/\\]shadow-ai[\/\\](?:\.git[\/\\]|src[\/\\]skills[\/\\])/i;

  return projectPathMarkers.test(lower) || selfFileMarkers.test(lower) || projectResourceMarkers.test(lower);
}

function redactSensitiveText(text) {
  let safe = String(text || '');
  safe = safe.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted-api-key]');
  safe = safe.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,})\b/g, '[redacted-api-key]');
  safe = safe.replace(/\b((?:sudo\s+)?(?:password|passcode|passwd|api\s*key|token|[a-z0-9_]+_secret|secret_key)\s*[:=]\s*)(`[^`]*`|"[^"]*"|'[^']*'|[^\s,;).]+)/gi, '$1[redacted]');
  safe = safe.replace(/\b((?:host|server|ip)\s*[:=]\s*)(`[^`]*`|"[^"]*"|'[^']*'|(?:\d{1,3}\.){3}\d{1,3}|[^\s,;).]+)/gi, '$1[redacted]');
  safe = safe.replace(/\b((?:user|username|login)\s*[:=]\s*)(`[^`]*`|"[^"]*"|'[^']*'|[^\s,;).]+)/gi, '$1[redacted]');
  safe = safe.replace(/\b((?:ssh|scp|sftp|rsync)\s+(?:-[^\s]+\s+)*)(?:[^\s@]+@)?(?:\d{1,3}\.){3}\d{1,3}\b/gi, '$1[redacted-host]');
  safe = safe.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]');
  return safe;
}

function shouldDelegateByDiscovery(recentUserText) {
  const lower = String(recentUserText || '').toLowerCase();
  return /\b(don't|do not|dont|not allowed to|must not|without)\b[\s\S]{0,100}\b(tell|include|mention|give|provide|pass)\b[\s\S]{0,120}\b(info|details?|connection|ip|host|username|user|password|skill)\b/.test(lower)
    || /\b(figure out|find|discover|determine)\b[\s\S]{0,80}\b(itself|on its own|by itself|available skills?|skills?)\b/.test(lower)
    || /\bno direct info\b/.test(lower);
}

function stripInstructionalSkillLeaks(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|;\s+/)
    .filter(sentence => {
      const lower = sentence.toLowerCase();
      if (/\bskill\b/.test(lower) && /\b(do not|don't|dont|must|should|needs?|find|use|mention|include|pre-saved|saved)\b/.test(lower)) return false;
      if (/\b(connection details?|specific connection|ip|password|username|host)\b/.test(lower) && /\b(do not|don't|dont|must|should|include|mention|provide|give)\b/.test(lower)) return false;
      return true;
    })
    .join(' ');
}

function sanitizeSubagentTaskForDelegation(task, recentUserText = '') {
  let sanitized = String(task || '').trim();
  if (!sanitized) return { task: '', changed: false };

  const original = sanitized;
  sanitized = sanitized.replace(/\b((?:sudo\s+)?(?:password|passcode|passwd|api\s*key|token|secret)\s*[:=]\s*)(`[^`]*`|"[^"]*"|'[^']*'|[^\s,;).]+)/gi, '$1[redacted]');

  if (shouldDelegateByDiscovery(recentUserText)) {
    sanitized = stripInstructionalSkillLeaks(sanitized);
    sanitized = sanitized
      .replace(/\((?:[^()]|\([^()]*\))*\b(?:host|ip|user|username|password|passcode|secret|token)\b(?:[^()]|\([^()]*\))*\)/gi, '')
      .replace(/\b(?:host|server|ip|user|username|login)\s*[:=]\s*(`[^`]*`|"[^"]*"|'[^']*'|[^\s,;).]+)/gi, '')
      .replace(/\bconnect_to_vps\b/gi, '')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, 'the production VPS');
  }

  sanitized = sanitized
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/\(\s*\)/g, '')
    .trim();

  return { task: sanitized, changed: sanitized !== original };
}

function getRecentUserUtteranceText() {
  const userBubbles = Array.from(document.querySelectorAll('.user-bubble'));
  const recent = userBubbles.slice(-3).map(b => b.textContent || '');
  if (currentUserTranscript) recent.push(currentUserTranscript);
  return recent.join('\n').toLowerCase();
}

function isSchedulerCreateCommand(command) {
  const lower = String(command || '').toLowerCase();
  if (!/invoke-restmethod/.test(lower)) return false;
  if (!/(?:localhost|127\.0\.0\.1):9333\/api\/tasks/.test(lower)) return false;
  if (!/-method\s+post/.test(lower)) return false;
  return !/\/api\/tasks\/task_[^\s"']+\/(?:edit|delete)|\/api\/tasks\/all/.test(lower);
}

function shouldBlockSchedulerCreateForEditIntent(command) {
  if (!isSchedulerCreateCommand(command)) return false;
  const recent = getRecentUserUtteranceText();
  if (!/\b(reminder|task|schedule|scheduled|alarm)\b/.test(recent)) return false;
  return /\b(change|edit|update|modify|move|reschedule|rename|replace|instead)\b|\b(add\s+(?:it|that)\b)|\b(that|this|the)\s+(?:reminder|task|schedule|alarm)\b/.test(recent);
}

function createSubagentRecord(task) {
  const now = Date.now();
  // New spawn → bump the generation so any still-queued status notice from a previous subagent is
  // recognized as stale at delivery time and not voiced into this new task's context.
  if (typeof subagentSpawnGeneration === 'number') subagentSpawnGeneration++;
  const record = {
    id: `subagent_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    task,
    status: 'running',
    step: 0,
    lastMessage: 'Initializing...',
    steerQueue: [],
    interruptRequested: false,
    interruptedAt: null,
    cancelRequested: false,
    startedAt: new Date(now).toISOString(),
    completedAt: null,
    failedAt: null,
    summary: '',
    lastError: '',
    failedToolCount: 0,
    lastToolStatus: '',
    lastToolName: '',
    checkedSkills: false,
    savedSkill: false,
    authCheckpoint: null,
    executedCommands: [],
    activeCommandIds: [],
    activeRequestIds: [],
    cancelledCommandIds: [],
    cancelledRequestIds: [],
    backendCancelRequestedAt: '',
    lastBackendCancelReason: '',
    toolEvents: [],
    timeline: [],
    successfulToolCount: 0,
    webSearchCount: 0,
    webSearchQueries: [],
    webSearchResultUrls: [],
    lastProgressAt: now,
    supervisorLastSignature: '',
    lastSupervisorNoticeAt: 0,
    supervisorActionCount: 0,
    abortController: new AbortController()
  };
  appendSubagentTimelineEvent(record, 'created', task, {}, now);
  return record;
}

function isSubagentCancelled(subagentRecord) {
  return Boolean(subagentRecord && (subagentRecord.cancelRequested || subagentRecord.status === 'cancelled'));
}

function createSubagentBackendCommandId(subagentRecord, label = 'cmd') {
  const prefix = String(subagentRecord && subagentRecord.id || 'subagent').replace(/[^a-z0-9_.-]/gi, '_');
  const safeLabel = String(label || 'cmd').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 32) || 'cmd';
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${safeLabel}_${Date.now()}_${random}`;
}

function trackSubagentBackendCommand(subagentRecord, commandId) {
  if (!subagentRecord || !commandId) return;
  if (!Array.isArray(subagentRecord.activeCommandIds)) subagentRecord.activeCommandIds = [];
  if (!subagentRecord.activeCommandIds.includes(commandId)) {
    subagentRecord.activeCommandIds.push(commandId);
  }
  if (typeof persistActiveSubagentSnapshots === 'function') persistActiveSubagentSnapshots();
}

function untrackSubagentBackendCommand(subagentRecord, commandId) {
  if (!subagentRecord || !Array.isArray(subagentRecord.activeCommandIds) || !commandId) return;
  subagentRecord.activeCommandIds = subagentRecord.activeCommandIds.filter(id => id !== commandId);
  if (typeof persistActiveSubagentSnapshots === 'function') persistActiveSubagentSnapshots();
}

function cancelShadowBackendCommand(commandId, reason = 'cancelled') {
  const cleanId = String(commandId || '').trim();
  if (!cleanId) return Promise.resolve(false);
  const cancelOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command_id: cleanId, reason })
  };
  const cancelPromise = typeof fetchLocalApiWithTimeout === 'function'
    ? fetchLocalApiWithTimeout('/api/run/cancel', cancelOptions, 5000)
    : fetch('/api/run/cancel', cancelOptions);
  return Promise.resolve(cancelPromise)
    .then(res => Boolean(res && res.ok))
    .catch(err => {
      console.warn(`[Shadow] Failed to cancel backend command ${cleanId}:`, err);
      return false;
    });
}

function markSubagentBackendCancellationRequested(subagentRecord, reason, commandIds = [], requestIds = [], now = Date.now()) {
  if (!subagentRecord) return false;
  const cleanCommandIds = [...new Set((Array.isArray(commandIds) ? commandIds : []).filter(Boolean).map(String))];
  const cleanRequestIds = [...new Set((Array.isArray(requestIds) ? requestIds : []).filter(Boolean).map(String))];
  if (cleanCommandIds.length === 0 && cleanRequestIds.length === 0) return false;
  subagentRecord.backendCancelRequestedAt = subagentRecord.backendCancelRequestedAt || new Date(now).toISOString();
  subagentRecord.lastBackendCancelReason = reason || 'subagent cancellation';
  const existingCommandIds = Array.isArray(subagentRecord.cancelledCommandIds) ? subagentRecord.cancelledCommandIds : [];
  const existingRequestIds = Array.isArray(subagentRecord.cancelledRequestIds) ? subagentRecord.cancelledRequestIds : [];
  subagentRecord.cancelledCommandIds = [...new Set([...existingCommandIds, ...cleanCommandIds].filter(Boolean).map(String))].slice(-40);
  subagentRecord.cancelledRequestIds = [...new Set([...existingRequestIds, ...cleanRequestIds].filter(Boolean).map(String))].slice(-40);
  if (typeof persistActiveSubagentSnapshots === 'function') persistActiveSubagentSnapshots(now);
  return true;
}

function cancelSubagentBackendRuns(subagentRecord, reason = 'subagent cancellation') {
  if (!subagentRecord || !Array.isArray(subagentRecord.activeCommandIds) || subagentRecord.activeCommandIds.length === 0) return 0;
  const commandIds = [...new Set(subagentRecord.activeCommandIds.filter(Boolean))];
  if (commandIds.length === 0) return 0;
  markSubagentBackendCancellationRequested(subagentRecord, reason, commandIds, []);
  appendSubagentTimelineEvent(subagentRecord, 'backend_cancel_requested', `${commandIds.length} command(s)`, { reason });
  for (const commandId of commandIds) {
    cancelShadowBackendCommand(commandId, reason);
  }
  return commandIds.length;
}

function createSubagentBackendRequestId(subagentRecord, label = 'request') {
  const prefix = String(subagentRecord && subagentRecord.id || 'subagent').replace(/[^a-z0-9_.-]/gi, '_');
  const safeLabel = String(label || 'request').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 32) || 'request';
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${safeLabel}_${Date.now()}_${random}`;
}

function trackSubagentBackendRequest(subagentRecord, requestId) {
  if (!subagentRecord || !requestId) return;
  if (!Array.isArray(subagentRecord.activeRequestIds)) subagentRecord.activeRequestIds = [];
  if (!subagentRecord.activeRequestIds.includes(requestId)) {
    subagentRecord.activeRequestIds.push(requestId);
  }
  if (typeof persistActiveSubagentSnapshots === 'function') persistActiveSubagentSnapshots();
}

function untrackSubagentBackendRequest(subagentRecord, requestId) {
  if (!subagentRecord || !Array.isArray(subagentRecord.activeRequestIds) || !requestId) return;
  subagentRecord.activeRequestIds = subagentRecord.activeRequestIds.filter(id => id !== requestId);
  if (typeof persistActiveSubagentSnapshots === 'function') persistActiveSubagentSnapshots();
}

function cancelShadowBackendRequest(requestId, reason = 'cancelled') {
  const cleanId = String(requestId || '').trim();
  if (!cleanId) return Promise.resolve(false);
  const cancelOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: cleanId, reason })
  };
  const cancelPromise = typeof fetchLocalApiWithTimeout === 'function'
    ? fetchLocalApiWithTimeout('/api/request/cancel', cancelOptions, 5000)
    : fetch('/api/request/cancel', cancelOptions);
  return Promise.resolve(cancelPromise)
    .then(res => {
      if (!res) return false;
      if (res.ok) return true;
      console.debug(`[Shadow] Backend request cancel ${cleanId} was ignored (${res.status}).`);
      return false;
    })
    .catch(err => {
      console.debug(`[Shadow] Backend request cancel ${cleanId} was ignored:`, err);
      return false;
    });
}

function cancelSubagentBackendRequests(subagentRecord, reason = 'cancelled') {
  if (!subagentRecord || !Array.isArray(subagentRecord.activeRequestIds) || subagentRecord.activeRequestIds.length === 0) return 0;
  const requestIds = [...new Set(subagentRecord.activeRequestIds.filter(Boolean))];
  if (requestIds.length === 0) return 0;
  markSubagentBackendCancellationRequested(subagentRecord, reason, [], requestIds);
  appendSubagentTimelineEvent(subagentRecord, 'backend_request_cancel_requested', `${requestIds.length} request(s)`, { reason });
  for (const requestId of requestIds) {
    cancelShadowBackendRequest(requestId, reason);
  }
  return requestIds.length;
}

function cancelSubagentRecord(subagentRecord, reason = 'Cancelled by user.') {
  if (!subagentRecord || isSubagentCancelled(subagentRecord)) return false;
  subagentRecord.cancelRequested = true;
  subagentRecord.status = 'cancelled';
  subagentRecord.lastMessage = reason;
  subagentRecord.completedAt = subagentRecord.completedAt || new Date().toISOString();
  cancelAuthCheckpoint(subagentRecord, reason);
  cancelSubagentBackendRuns(subagentRecord, reason);
  cancelSubagentBackendRequests(subagentRecord, reason);
  if (subagentRecord.abortController) subagentRecord.abortController.abort();
  appendSubagentTimelineEvent(subagentRecord, 'cancelled', reason);
  persistSubagentRunSummary(subagentRecord);
  playNotificationChime('stop');
  updateSubagentIndicator();
  return true;
}

function cleanupTerminalSubagentBackendWork(subagentRecord, reason = 'Subagent reached terminal state.') {
  if (!subagentRecord) return false;
  const commandCount = Array.isArray(subagentRecord.activeCommandIds)
    ? subagentRecord.activeCommandIds.filter(Boolean).length
    : 0;
  const requestCount = Array.isArray(subagentRecord.activeRequestIds)
    ? subagentRecord.activeRequestIds.filter(Boolean).length
    : 0;
  if (commandCount === 0 && requestCount === 0) return false;
  appendSubagentTimelineEvent(subagentRecord, 'terminal_backend_cleanup', reason, {
    activeCommandIds: commandCount,
    activeRequestIds: requestCount
  });
  cancelSubagentBackendRuns(subagentRecord, reason);
  cancelSubagentBackendRequests(subagentRecord, reason);
  return true;
}

function failSubagentRecord(subagentRecord, reason) {
  cleanupTerminalSubagentBackendWork(subagentRecord, reason || 'Subagent failed.');
  subagentRecord.status = 'failed';
  subagentRecord.lastError = reason;
  subagentRecord.lastMessage = `Failed: ${reason}`;
  subagentRecord.failedAt = new Date().toISOString();
  appendSubagentTimelineEvent(subagentRecord, 'failed', reason);
  persistSubagentRunSummary(subagentRecord);
  updateSubagentIndicator();
}

function completeSubagentRecord(subagentRecord, summary) {
  cleanupTerminalSubagentBackendWork(subagentRecord, 'Subagent completed.');
  subagentRecord.status = 'completed';
  subagentRecord.summary = summary;
  subagentRecord.lastMessage = 'Task completed successfully.';
  subagentRecord.completedAt = new Date().toISOString();
  appendSubagentTimelineEvent(subagentRecord, 'completed', summary);
  persistSubagentRunSummary(subagentRecord);
  updateSubagentIndicator();
}

function partialSubagentRecord(subagentRecord, summary, reason) {
  cleanupTerminalSubagentBackendWork(subagentRecord, reason || 'Subagent partially completed.');
  subagentRecord.status = 'partial';
  subagentRecord.summary = summary;
  subagentRecord.lastError = reason;
  subagentRecord.lastMessage = `Partially completed: ${reason}`;
  subagentRecord.completedAt = new Date().toISOString();
  appendSubagentTimelineEvent(subagentRecord, 'partial', reason);
  persistSubagentRunSummary(subagentRecord);
  updateSubagentIndicator();
}

function subagentSleep(ms, subagentRecord) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const signal = subagentRecord && subagentRecord.abortController && subagentRecord.abortController.signal;
    if (signal) {
      const abort = () => {
        clearTimeout(timer);
        reject(new Error('Task cancelled by user.'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000, subagentRecord = null) {
  const timeoutController = new AbortController();
  const recordSignal = subagentRecord && subagentRecord.abortController && subagentRecord.abortController.signal;
  const optionSignal = options && options.signal;
  const externalSignals = [recordSignal, optionSignal].filter(Boolean);
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const abortExternal = () => timeoutController.abort();
  try {
    for (const signal of externalSignals) {
      if (signal.aborted) timeoutController.abort();
      else signal.addEventListener('abort', abortExternal, { once: true });
    }
    const response = await fetch(url, { ...options, signal: timeoutController.signal });
    return response;
  } catch (err) {
    if (timeoutController.signal.aborted) {
      if (externalSignals.some(signal => signal.aborted)) throw new Error('Task cancelled by user.');
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    for (const signal of externalSignals) {
      signal.removeEventListener('abort', abortExternal);
    }
  }
}

function cancelFetchResponseBody(response) {
  try {
    if (response && response.body && typeof response.body.cancel === 'function') {
      response.body.cancel().catch(() => {});
    }
  } catch {}
}

async function readFetchResponseTextWithTimeout(response, timeoutMs = 60000, subagentRecord = null) {
  const externalSignal = subagentRecord && subagentRecord.abortController && subagentRecord.abortController.signal;
  let timeoutId = null;
  let abortExternal = null;
  const bodyPromise = response.text();
  const abortPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      cancelFetchResponseBody(response);
      reject(new Error(`Response body timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    if (externalSignal) {
      abortExternal = () => {
        cancelFetchResponseBody(response);
        reject(new Error('Task cancelled by user.'));
      };
      if (externalSignal.aborted) abortExternal();
      else externalSignal.addEventListener('abort', abortExternal, { once: true });
    }
  });
  try {
    return await Promise.race([bodyPromise, abortPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (externalSignal && abortExternal) externalSignal.removeEventListener('abort', abortExternal);
  }
}

async function readFetchResponseJsonWithTimeout(response, timeoutMs = 60000, subagentRecord = null) {
  const text = await readFetchResponseTextWithTimeout(response, timeoutMs, subagentRecord);
  if (!String(text || '').trim()) return {};
  return JSON.parse(text);
}

async function readFetchResponseArrayBufferWithTimeout(response, timeoutMs = 60000, subagentRecord = null) {
  const externalSignal = subagentRecord && subagentRecord.abortController && subagentRecord.abortController.signal;
  let timeoutId = null;
  let abortExternal = null;
  const bodyPromise = response.arrayBuffer();
  const abortPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      cancelFetchResponseBody(response);
      reject(new Error(`Response body timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    if (externalSignal) {
      abortExternal = () => {
        cancelFetchResponseBody(response);
        reject(new Error('Task cancelled by user.'));
      };
      if (externalSignal.aborted) abortExternal();
      else externalSignal.addEventListener('abort', abortExternal, { once: true });
    }
  });
  try {
    return await Promise.race([bodyPromise, abortPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (externalSignal && abortExternal) externalSignal.removeEventListener('abort', abortExternal);
  }
}

function getBackendOfflineMessage(reason = '') {
  const detail = reason ? ` (${reason})` : '';
  return `Shadow's local backend is not reachable from this app window${detail}. This window is probably stale or pointed at the wrong localhost port. Close this Shadow window and launch Shadow again with run.bat.`;
}

async function checkBackendHealth({ announce = false } = {}) {
  try {
    const res = await fetchWithTimeout('/api/health', { cache: 'no-store' }, BACKEND_HEALTH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await readFetchResponseJsonWithTimeout(res, BACKEND_HEALTH_TIMEOUT_MS);
    if (json.status !== 'healthy' || json.service !== 'shadow-main') {
      throw new Error('unexpected health response');
    }

    backendHealthy = true;
    backendHealthLastMessage = '';
    if (!isConnected) {
      btnConnect.disabled = false;
      btnConnect.classList.remove('disabled');
    }
    return true;
  } catch (err) {
    backendHealthy = false;
    const message = getBackendOfflineMessage(err.message);
    if (!isConnected) {
      btnConnect.disabled = true;
      btnConnect.classList.add('disabled');
    }
    // We intentionally DO NOT disconnect the voice connection here.
    // The backend might simply be blocked executing a long-running synchronous PowerShell command.
    if (announce && backendHealthLastMessage !== message) {
      addSystemMessage(message);
      backendHealthLastMessage = message;
    }
    return false;
  }
}

function startBackendHealthMonitor() {
  clearInterval(backendHealthTimer);
  void checkBackendHealth({ announce: true });
  backendHealthTimer = setInterval(() => {
    void checkBackendHealth({ announce: true });
  }, BACKEND_HEALTH_INTERVAL_MS);
}
