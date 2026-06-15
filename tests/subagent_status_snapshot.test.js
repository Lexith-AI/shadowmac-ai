import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  if (start < 0) throw new Error(`Missing function ${functionName}`);
  const signatureEnd = source.indexOf(') {', start);
  const bodyStart = source.indexOf('{', signatureEnd > -1 ? signatureEnd : start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not parse function ${functionName}`);
}

function loadSubagentCoreFunctions(functionNames, context = {}) {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '09-subagents-core.js'), 'utf8');
  const deps = [];
  if (functionNames.includes('getSubagentStatusPayload') || functionNames.includes('getSubagentSnapshotText')) {
    deps.push('isActiveSubagentStatus', 'isTerminalSubagentStatus');
  }
  const namesToLoad = [...new Set([...deps, ...functionNames])];
  const sandbox = vm.createContext({
    console,
    redactSensitiveText: text => String(text || ''),
    ...context
  });
  const functionSource = namesToLoad.map(name => extractFunctionSource(source, name)).join('\n\n');
  const exportsSource = `\nresult = { ${functionNames.map(name => `${name}: ${name}`).join(', ')} };`;
  vm.runInContext(`${functionSource}${exportsSource}`, sandbox);
  return sandbox.result;
}

function loadSubagentRunnerFunctions(functionNames, context = {}) {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
  const sandbox = vm.createContext({
    console,
    ...context
  });
  const functionSource = functionNames.map(name => extractFunctionSource(source, name)).join('\n\n');
  const exportsSource = `\nresult = { ${functionNames.map(name => `${name}: ${name}`).join(', ')} };`;
  vm.runInContext(`${functionSource}${exportsSource}`, sandbox);
  return sandbox.result;
}

function createRunningSubagent() {
  return {
    id: 'subagent_1',
    task: 'Check storage devices',
    status: 'running',
    step: 5,
    lastMessage: 'Running PowerShell command',
    lastToolName: 'run_powershell_command',
    lastToolStatus: 'running'
  };
}

describe('subagent interruption repair', () => {
  it('closes pending tool calls with interrupted responses before continuing after correction', () => {
    const {
      getSubagentToolCallKey,
      appendInterruptedSubagentToolResponses
    } = loadSubagentRunnerFunctions([
      'getSubagentToolCallKey',
      'appendInterruptedSubagentToolResponses'
    ]);
    const history = [{ role: 'user', parts: [{ text: 'start' }] }];
    const functionCalls = [
      { functionCall: { name: 'read_file', id: 'call_done' } },
      { functionCall: { name: 'run_powershell_command', id: 'call_pending' } }
    ];
    const answered = new Set(['call_done']);
    const collectedParts = [{
      functionResponse: {
        name: 'read_file',
        id: 'call_done',
        response: { status: 'success', content: 'already read' }
      }
    }];

    expect(getSubagentToolCallKey(functionCalls[0].functionCall)).toBe('call_done');
    expect(appendInterruptedSubagentToolResponses(history, functionCalls, answered, collectedParts)).toBe(true);
    expect(history).toHaveLength(2);
    expect(history[1].parts).toHaveLength(2);
    expect(history[1].parts[0].functionResponse.id).toBe('call_done');
    expect(history[1].parts[1].functionResponse).toMatchObject({
      name: 'run_powershell_command',
      id: 'call_pending',
      response: {
        status: 'interrupted'
      }
    });
    expect(history[1].parts[1].functionResponse.response.next_action_required).toContain('queued user correction');
  });
});

describe('direct subagent status questions', () => {
  it('wires active subagent snapshot recovery into startup', () => {
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'index.html'), 'utf8');
    const stateDom = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '01-state-dom.js'), 'utf8');
    const bootUi = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '02-boot-ui.js'), 'utf8');
    const core = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '09-subagents-core.js'), 'utf8');

    expect(stateDom).toContain('const SUBAGENT_ACTIVE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000');
    expect(core).toContain("return 'shadow_active_subagents_v1'");
    expect(bootUi).toContain("typeof recoverOrphanedActiveSubagentSnapshots === 'function'");
    expect(bootUi).toContain('recoverOrphanedActiveSubagentSnapshots();');
    expect(indexHtml).toContain('09-subagents-core.js?v=remove-ollama-local-20260530');
  });

  it('recognizes "check on the agent" as a status question', () => {
    const { isSubagentStatusQuestion } = loadSubagentCoreFunctions(['isSubagentStatusQuestion']);

    expect(isSubagentStatusQuestion('can you check on the agent')).toBe(true);
    expect(isSubagentStatusQuestion('what is the agent doing')).toBe(true);
  });

  it('does not queue a subagent snapshot as a second model turn', () => {
    const systemMessages = [];
    const modelNotices = [];
    const directSteeredTurns = new Set();
    const { maybeDirectHandleSubagentUtterance } = loadSubagentCoreFunctions([
      'getControllableSubagents',
      'getLatestControllableSubagent',
      'extractDirectSteeringFeedback',
      'isSubagentStatusQuestion',
      'hasExplicitSubagentReference',
      'hasImplicitSubagentReference',
      'isSubagentCancelUtterance',
      'getCancelTargetsForUtterance',
      'maybeDirectHandleSubagentUtterance',
      'trimDirectSteeringCache'
    ], {
      activeSubagents: [createRunningSubagent()],
      directSteeredTurns,
      DIRECT_STEERED_LIMIT: 80,
      addSystemMessage: message => systemMessages.push(message),
      notifyModelOfSubagentUpdate: message => modelNotices.push(message)
    });

    maybeDirectHandleSubagentUtterance('can you check on the agent');

    expect(modelNotices).toEqual([]);
    expect(systemMessages).toContain('Subagent status question detected; answering in the current user turn.');
    expect(directSteeredTurns.has('can you check on the agent')).toBe(true);
  });

  it('routes direct transcript steering through selected-model refinement', async () => {
    const refinements = [];
    const interrupts = [];
    const notices = [];
    const directSteeredTurns = new Set();
    const record = createRunningSubagent();
    const { maybeDirectHandleSubagentUtterance } = loadSubagentCoreFunctions([
      'getControllableSubagents',
      'getLatestControllableSubagent',
      'extractDirectSteeringFeedback',
      'isSubagentStatusQuestion',
      'hasExplicitSubagentReference',
      'hasImplicitSubagentReference',
      'isSubagentCancelUtterance',
      'getCancelTargetsForUtterance',
      'isSubagentPromptBrainSteeringEnabled',
      'buildSubagentSteeringRefinementContext',
      'refineSubagentSteeringFeedbackWithSelectedModel',
      'interruptSubagentWithSelectedModelFeedback',
      'maybeDirectHandleSubagentUtterance',
      'trimDirectSteeringCache'
    ], {
      activeSubagents: [record],
      directSteeredTurns,
      DIRECT_STEERED_LIMIT: 80,
      smartMainRoutingEnabled: true,
      refineSubagentInstructionWithSelectedModel: async (kind, text, context) => {
        refinements.push({ kind, text, context });
        return `Refined correction: ${text}`;
      },
      interruptSubagentWithFeedback: (target, feedback, reason) => {
        interrupts.push({ target, feedback, reason });
        return true;
      },
      notifyModelOfSubagentUpdate: message => notices.push(message),
      addSystemMessage: () => {}
    });

    await maybeDirectHandleSubagentUtterance('tell the subagent to use dark mode');

    expect(refinements).toHaveLength(1);
    expect(refinements[0]).toMatchObject({
      kind: 'steer',
      text: 'use dark mode'
    });
    expect(refinements[0].context.subagent_id).toBe('subagent_1');
    expect(interrupts).toHaveLength(1);
    // Interrupt happens IMMEDIATELY with the raw correction (no waiting on the refine); the
    // refinement still runs in the background (refinements has 1) and is queued as a follow-up.
    expect(interrupts[0].feedback).toBe('use dark mode');
    expect(interrupts[0].reason).toBe('Direct user correction.');
    expect(notices[0]).toContain('queued into its preserved context');
  });

  it('keeps explicit snapshot injection available for non-speech UI actions', () => {
    const modelNotices = [];
    const { getSubagentSnapshotText, injectSubagentSnapshotToModel } = loadSubagentCoreFunctions([
      'getSubagentEvidenceSummary',
      'getSubagentSnapshotText',
      'injectSubagentSnapshotToModel'
    ], {
      activeSubagents: [createRunningSubagent()],
      addSystemMessage: () => {},
      notifyModelOfSubagentUpdate: message => modelNotices.push(message)
    });

    expect(getSubagentSnapshotText()).toContain('[subagent_1] status=running');

    injectSubagentSnapshotToModel('user clicked auth checkpoint status');

    expect(modelNotices).toHaveLength(1);
    expect(modelNotices[0]).toContain('[SUBAGENT SNAPSHOT: user clicked auth checkpoint status]');
  });

  it('makes auth checkpoint timeouts visible and recoverable', async () => {
    let timeoutCallback = null;
    let timeoutMs = 0;
    let indicatorUpdates = 0;
    const messages = [];
    const notices = [];
    const rendered = [];
    const record = {
      id: 'subagent_auth',
      task: 'Finish login',
      status: 'running',
      lastMessage: 'Starting',
      timeline: []
    };
    const { waitForUserAuthCheckpoint } = loadSubagentCoreFunctions([
      'redactSubagentEventText',
      'appendSubagentTimelineEvent',
      'waitForUserAuthCheckpoint'
    ], {
      setTimeout: (callback, ms) => {
        timeoutCallback = callback;
        timeoutMs = ms;
        return 'timer_auth';
      },
      renderAuthCheckpointBubble: subagent => rendered.push(subagent.authCheckpoint && subagent.authCheckpoint.message),
      addSubagentMessage: message => messages.push(message),
      notifyModelOfSubagentUpdate: notice => notices.push(notice),
      updateSubagentIndicator: () => { indicatorUpdates += 1; }
    });

    const checkpointPromise = waitForUserAuthCheckpoint(record, {
      message: 'Complete login in the visible browser.',
      url: 'https://example.com/login',
      timeout_seconds: 60
    });

    expect(timeoutMs).toBe(60000);
    expect(record.status).toBe('waiting_auth');
    expect(record.authCheckpoint).toMatchObject({
      message: 'Complete login in the visible browser.',
      url: 'https://example.com/login',
      timeoutSeconds: 60
    });
    expect(rendered).toEqual(['Complete login in the visible browser.']);
    expect(record.timeline.map(event => event.type)).toContain('auth_waiting');
    expect(indicatorUpdates).toBe(1);

    timeoutCallback();
    await expect(checkpointPromise).resolves.toMatchObject({
      status: 'error',
      error: 'User authentication checkpoint timed out after 60 seconds.'
    });

    expect(record.status).toBe('running');
    expect(record.authCheckpoint).toBe(null);
    expect(record.lastMessage).toBe('Auth checkpoint timed out.');
    expect(record.timeline.map(event => event.type)).toContain('auth_timeout');
    expect(messages[0]).toContain('Timed out for subagent_auth');
    expect(notices.some(notice => notice.includes('[AUTH CHECKPOINT]'))).toBe(true);
    expect(notices.some(notice => notice.includes('[AUTH CHECKPOINT TIMEOUT]'))).toBe(true);
    expect(indicatorUpdates).toBe(2);
  });

  it('records successful tool evidence and blocks unsupported success claims', () => {
    const activeSubagents = [];
    const storage = new Map();
    const localStorage = {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    };
    const {
      summarizeSubagentToolResponse,
      appendSubagentTimelineEvent,
      recordSubagentToolEvent,
      isSubagentToolFailureStatus,
      getSubagentEvidenceSummary,
      getSubagentStatusPayload,
      getSubagentStatusList,
      getSuccessfulSubagentToolEvents,
      getSubagentSuccessEvidenceRequirements,
      hasSuccessfulSubagentToolEvidence,
      getConcreteVerificationEvidence,
      isEvidenceRequiredForSubagentSuccess,
      getSubagentFinishReadiness,
      getSubagentRunHistoryStorageKey,
      getSubagentRunSummary,
      persistSubagentRunSummary,
      getSubagentSnapshotText
    } = loadSubagentCoreFunctions([
      'summarizeSubagentToolResponse',
      'redactSubagentEventText',
      'appendSubagentTimelineEvent',
      'getSubagentRunHistoryStorageKey',
      'getSubagentRunSummary',
      'persistSubagentRunSummary',
      'recordSubagentToolEvent',
      'isSubagentToolFailureStatus',
      'getSubagentEvidenceSummary',
      'getSubagentStatusPayload',
      'getSubagentStatusList',
      'getSuccessfulSubagentToolEvents',
      'getSubagentSuccessEvidenceRequirements',
      'hasSuccessfulSubagentToolEvidence',
      'getConcreteVerificationEvidence',
      'isEvidenceRequiredForSubagentSuccess',
      'getSubagentFinishReadiness',
      'getSubagentSnapshotText'
    ], {
      activeSubagents,
      localStorage
    });

    const record = {
      id: 'subagent_2',
      task: 'Find GPU prices in stock',
      status: 'running',
      step: 3,
      lastMessage: 'Tool web_search completed: success',
      lastToolName: 'web_search',
      lastToolStatus: 'success',
      toolEvents: [],
      timeline: []
    };

    expect(summarizeSubagentToolResponse('web_search', 'success', {
      query: 'rtx gpu stock',
      source: 'searx',
      results: [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }]
    })).toContain('2 result(s)');
    expect(summarizeSubagentToolResponse('run_powershell_command', 'error', {
      output: 'Command timed out after 15s.',
      exitCode: null,
      timedOut: true
    })).toContain('timed out');
    expect(summarizeSubagentToolResponse('run_powershell_command', 'error', {
      output: 'native command failed',
      exitCode: 1,
      timedOut: false
    })).toContain('exit 1');

    recordSubagentToolEvent(record, 'web_search', 'success', {
      query: 'rtx gpu stock',
      source: 'searx',
      results: [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }]
    }, Date.UTC(2026, 0, 1));

    expect(record.successfulToolCount).toBe(1);
    expect(record.timeline.map(event => event.type)).toContain('tool_success');
    expect(isSubagentToolFailureStatus('success')).toBe(false);
    expect(isSubagentToolFailureStatus('partial')).toBe(false);
    expect(isSubagentToolFailureStatus('blocked')).toBe(true);
    expect(isSubagentToolFailureStatus('unknown')).toBe(true);
    expect(isSubagentToolFailureStatus('', { error: 'bad tool call' })).toBe(true);
    appendSubagentTimelineEvent(record, 'completed', 'done');
    expect(record.timeline.at(-1).type).toBe('completed');
    expect(getSubagentEvidenceSummary(record)).toContain('web_search: 2 result(s)');
    expect(getSuccessfulSubagentToolEvents(record)).toHaveLength(1);
    expect(getSubagentSuccessEvidenceRequirements('Upload this video to Google Drive')).toEqual([
      'google_drive_upload_local_file',
      'google_drive_upload_file'
    ]);
    expect(hasSuccessfulSubagentToolEvidence(record, ['web_search'])).toBe(true);
    expect(hasSuccessfulSubagentToolEvidence(record, ['google_drive_upload_local_file'])).toBe(false);
    expect(getConcreteVerificationEvidence('Drive ID 123abc')).toContain('Drive ID');
    expect(isEvidenceRequiredForSubagentSuccess('Upload this video to Google Drive')).toBe(true);
    expect(isEvidenceRequiredForSubagentSuccess('Explain why latency matters')).toBe(false);
    expect(getSubagentFinishReadiness(record.task, 'success', 'Used search results.', record)).toMatchObject({ ok: true });
    expect(getSubagentFinishReadiness('Upload this video to Google Drive', 'success', 'I did it.', record)).toMatchObject({
      ok: false
    });
    expect(getSubagentFinishReadiness('Upload this video to Google Drive', 'success', 'I did it.', { toolEvents: [] })).toMatchObject({
      ok: false
    });
    expect(getSubagentFinishReadiness('Upload this video to Google Drive', 'success', 'Drive ID 123abc', { toolEvents: [] })).toMatchObject({
      ok: true
    });
    const driveRecord = { toolEvents: [], timeline: [] };
    recordSubagentToolEvent(driveRecord, 'google_drive_upload_local_file', 'success', {
      output: 'Uploaded file. Drive ID abc123.'
    });
    expect(getSubagentFinishReadiness('Upload this video to Google Drive', 'success', 'Uploaded.', driveRecord)).toMatchObject({
      ok: true
    });
    expect(getSubagentRunSummary(record)).toMatchObject({
      id: 'subagent_2',
      status: 'running',
      successfulToolCount: 1
    });
    expect(persistSubagentRunSummary(record, Date.UTC(2026, 0, 2))).toBe(true);
    const savedHistory = JSON.parse(storage.get(getSubagentRunHistoryStorageKey()));
    expect(savedHistory).toHaveLength(1);
    expect(savedHistory[0].toolEvents).toHaveLength(1);
    expect(savedHistory[0].timeline.length).toBeGreaterThan(0);

    activeSubagents.push(record);
    expect(getSubagentSnapshotText()).toContain('evidence=web_search: 2 result(s)');
    const statusPayload = getSubagentStatusPayload(record, Date.UTC(2026, 0, 1, 0, 2));
    expect(statusPayload).toMatchObject({
      id: 'subagent_2',
      status: 'running',
      isActive: true,
      isTerminal: false,
      activityState: 'active',
      successfulToolCount: 1,
      evidenceSummary: 'web_search: 2 result(s) for "rtx gpu stock" via searx'
    });
    expect(statusPayload.recentToolEvents).toHaveLength(1);
    expect(statusPayload.recentTimeline.length).toBeGreaterThan(0);
    expect(statusPayload.activeCommandCount).toBe(0);
    expect(statusPayload.idleSeconds).toBe(null);
    expect(getSubagentStatusList(1, Date.UTC(2026, 0, 1, 0, 2))).toHaveLength(1);

    const completedPayload = getSubagentStatusPayload({
      ...record,
      status: 'completed',
      completedAt: '2026-01-01T00:01:30.000Z',
      lastMessage: 'Task completed successfully.'
    }, Date.UTC(2026, 0, 1, 0, 2));
    expect(completedPayload).toMatchObject({
      isActive: false,
      isTerminal: true,
      activityState: 'historical',
      modelInstruction: 'This subagent is not currently doing work. Treat it as history only.',
      completedAgeSeconds: 30
    });
  });

  it('persists active subagent snapshots and restores reload-orphaned runs explicitly', () => {
    const storage = new Map();
    const localStorage = {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    };
    const activeSubagents = [{
      id: 'subagent_reload',
      task: 'Long running encode',
      status: 'running',
      step: 12,
      startedAt: '2026-01-01T00:00:00.000Z',
      lastMessage: 'Executing tool: run_powershell_command',
      lastToolName: 'run_powershell_command',
      lastToolStatus: 'running',
      activeCommandIds: ['cmd_reload'],
      activeRequestIds: ['req_reload'],
      toolEvents: [{ name: 'run_powershell_command', status: 'success', summary: 'started encode' }],
      timeline: [{ at: '2026-01-01T00:00:00.000Z', type: 'created', detail: 'Long running encode' }],
      successfulToolCount: 1,
      failedToolCount: 0,
      webSearchCount: 0,
      lastProgressAt: Date.UTC(2026, 0, 1, 0, 1),
      supervisorActionCount: 1
    }];
    const cancelledRuns = [];
    const cancelledRequests = [];
    const messages = [];
    const notices = [];
    let indicatorUpdates = 0;
    const {
      getSubagentRunHistoryStorageKey,
      getSubagentActiveSnapshotStorageKey,
      persistActiveSubagentSnapshots,
      recoverOrphanedActiveSubagentSnapshots
    } = loadSubagentCoreFunctions([
      'redactSubagentEventText',
      'appendSubagentTimelineEvent',
      'getSubagentRunHistoryStorageKey',
      'getSubagentRunSummary',
      'persistSubagentRunSummary',
      'getSubagentActiveSnapshotStorageKey',
      'getSubagentActiveSnapshot',
      'persistActiveSubagentSnapshots',
      'recoverOrphanedActiveSubagentSnapshots'
    ], {
      activeSubagents,
      localStorage,
      AbortController,
      SUBAGENT_ACTIVE_SNAPSHOT_MAX_AGE_MS: 24 * 60 * 60 * 1000,
      cancelSubagentBackendRuns: record => cancelledRuns.push([...record.activeCommandIds]),
      cancelSubagentBackendRequests: (record, reason) => cancelledRequests.push({ ids: [...record.activeRequestIds], reason }),
      addSubagentMessage: message => messages.push(message),
      notifyModelOfSubagentUpdate: notice => notices.push(notice),
      updateSubagentIndicator: () => { indicatorUpdates += 1; }
    });

    expect(persistActiveSubagentSnapshots(Date.UTC(2026, 0, 1, 0, 2))).toBe(true);
    const activeKey = getSubagentActiveSnapshotStorageKey();
    const snapshots = JSON.parse(storage.get(activeKey));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      id: 'subagent_reload',
      status: 'running',
      activeCommandIds: ['cmd_reload'],
      activeRequestIds: ['req_reload']
    });

    activeSubagents.length = 0;
    const restored = recoverOrphanedActiveSubagentSnapshots(Date.UTC(2026, 0, 1, 0, 3));

    expect(restored).toHaveLength(1);
    expect(activeSubagents[0]).toMatchObject({
      id: 'subagent_reload',
      status: 'orphaned',
      lastToolName: 'run_powershell_command'
    });
    expect(activeSubagents[0].lastMessage).toContain('Interrupted by app reload');
    expect(activeSubagents[0].timeline.map(event => event.type)).toContain('orphaned_after_reload');
    expect(cancelledRuns).toEqual([['cmd_reload']]);
    expect(cancelledRequests[0].ids).toEqual(['req_reload']);
    expect(cancelledRequests[0].reason).toContain('app reload');
    expect(messages[0]).toContain('[Subagent Recovery]');
    expect(notices[0]).toContain('[Subagent Recovery]');
    expect(indicatorUpdates).toBe(1);
    expect(storage.has(activeKey)).toBe(false);

    const history = JSON.parse(storage.get(getSubagentRunHistoryStorageKey()));
    expect(history[0]).toMatchObject({
      id: 'subagent_reload',
      status: 'orphaned'
    });
  });

  it('refreshes active snapshots when backend command and request IDs are tracked', () => {
    const storage = new Map();
    const localStorage = {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    };
    const record = {
      id: 'subagent_tracking',
      task: 'Run a long command',
      status: 'running',
      step: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      lastMessage: 'Executing tool: run_powershell_command',
      activeCommandIds: [],
      activeRequestIds: [],
      toolEvents: [],
      timeline: []
    };
    const activeSubagents = [record];
    const {
      getSubagentActiveSnapshotStorageKey,
      trackSubagentBackendCommand,
      untrackSubagentBackendCommand,
      trackSubagentBackendRequest,
      untrackSubagentBackendRequest
    } = loadSubagentCoreFunctions([
      'redactSubagentEventText',
      'getSubagentRunSummary',
      'getSubagentActiveSnapshotStorageKey',
      'getSubagentActiveSnapshot',
      'persistActiveSubagentSnapshots',
      'trackSubagentBackendCommand',
      'untrackSubagentBackendCommand',
      'trackSubagentBackendRequest',
      'untrackSubagentBackendRequest'
    ], {
      activeSubagents,
      localStorage
    });

    trackSubagentBackendCommand(record, 'cmd_tracked');
    trackSubagentBackendRequest(record, 'req_tracked');

    const activeKey = getSubagentActiveSnapshotStorageKey();
    let snapshots = JSON.parse(storage.get(activeKey));
    expect(snapshots[0].activeCommandIds).toEqual(['cmd_tracked']);
    expect(snapshots[0].activeRequestIds).toEqual(['req_tracked']);

    untrackSubagentBackendCommand(record, 'cmd_tracked');
    untrackSubagentBackendRequest(record, 'req_tracked');

    snapshots = JSON.parse(storage.get(activeKey));
    expect(snapshots[0].activeCommandIds).toEqual([]);
    expect(snapshots[0].activeRequestIds).toEqual([]);
  });

  it('marks backend cancellation requests in model-visible subagent status', () => {
    const cancelledCommands = [];
    const cancelledRequests = [];
    let persisted = 0;
    const record = {
      id: 'subagent_backend_cancel',
      task: 'Run long backend work',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      lastProgressAt: Date.UTC(2026, 0, 1, 0, 1),
      activeCommandIds: ['cmd_one', 'cmd_one', 'cmd_two'],
      activeRequestIds: ['req_one', 'req_one'],
      cancelledCommandIds: ['cmd_old'],
      cancelledRequestIds: [],
      toolEvents: [],
      timeline: []
    };
    const {
      cancelSubagentBackendRuns,
      cancelSubagentBackendRequests,
      getSubagentRunSummary,
      getSubagentStatusPayload
    } = loadSubagentCoreFunctions([
      'redactSubagentEventText',
      'appendSubagentTimelineEvent',
      'getSubagentEvidenceSummary',
      'getSubagentRunSummary',
      'getSubagentStatusPayload',
      'markSubagentBackendCancellationRequested',
      'cancelSubagentBackendRuns',
      'cancelSubagentBackendRequests'
    ], {
      cancelShadowBackendCommand: (commandId, reason) => cancelledCommands.push({ commandId, reason }),
      cancelShadowBackendRequest: (requestId, reason) => cancelledRequests.push({ requestId, reason }),
      persistActiveSubagentSnapshots: () => { persisted += 1; }
    });

    expect(cancelSubagentBackendRuns(record, 'user interrupted it')).toBe(2);
    expect(cancelSubagentBackendRequests(record, 'user interrupted it')).toBe(1);

    expect(cancelledCommands).toEqual([
      { commandId: 'cmd_one', reason: 'user interrupted it' },
      { commandId: 'cmd_two', reason: 'user interrupted it' }
    ]);
    expect(cancelledRequests).toEqual([
      { requestId: 'req_one', reason: 'user interrupted it' }
    ]);
    expect(record.backendCancelRequestedAt).toBeTruthy();
    expect(record.lastBackendCancelReason).toBe('user interrupted it');
    expect(record.cancelledCommandIds).toEqual(['cmd_old', 'cmd_one', 'cmd_two']);
    expect(record.cancelledRequestIds).toEqual(['req_one']);
    expect(record.timeline.map(event => event.type)).toEqual([
      'backend_cancel_requested',
      'backend_request_cancel_requested'
    ]);
    expect(persisted).toBe(2);

    const statusPayload = getSubagentStatusPayload(record, Date.UTC(2026, 0, 1, 0, 2));
    expect(statusPayload).toMatchObject({
      activeCommandCount: 3,
      activeRequestCount: 2,
      backendCancellationPending: true,
      lastBackendCancelReason: 'user interrupted it',
      cancelRequestedCommandCount: 3,
      cancelRequestedRequestCount: 1
    });
    expect(statusPayload.backendCancelRequestedAt).toBe(record.backendCancelRequestedAt);

    const summary = getSubagentRunSummary(record);
    expect(summary).toMatchObject({
      cancelledCommandCount: 3,
      cancelledRequestCount: 1,
      lastBackendCancelReason: 'user interrupted it'
    });
  });

  it('cancels stray backend work before persisting terminal subagent states', () => {
    const storage = new Map();
    const localStorage = {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    };
    const activeSubagents = [];
    const cancelledRuns = [];
    const cancelledRequests = [];
    const {
      getSubagentRunHistoryStorageKey,
      cleanupTerminalSubagentBackendWork,
      failSubagentRecord,
      completeSubagentRecord,
      partialSubagentRecord
    } = loadSubagentCoreFunctions([
      'redactSubagentEventText',
      'appendSubagentTimelineEvent',
      'getSubagentRunHistoryStorageKey',
      'getSubagentRunSummary',
      'persistSubagentRunSummary',
      'cleanupTerminalSubagentBackendWork',
      'failSubagentRecord',
      'completeSubagentRecord',
      'partialSubagentRecord'
    ], {
      activeSubagents,
      localStorage,
      cancelSubagentBackendRuns: record => cancelledRuns.push({ id: record.id, commands: [...record.activeCommandIds] }),
      cancelSubagentBackendRequests: (record, reason) => cancelledRequests.push({ id: record.id, requests: [...record.activeRequestIds], reason }),
      updateSubagentIndicator: () => {}
    });

    const failed = {
      id: 'subagent_failed_cleanup',
      task: 'Long failed task',
      status: 'running',
      activeCommandIds: ['cmd_failed'],
      activeRequestIds: ['req_failed'],
      toolEvents: [],
      timeline: []
    };
    expect(cleanupTerminalSubagentBackendWork({ activeCommandIds: [], activeRequestIds: [] })).toBe(false);

    failSubagentRecord(failed, 'model crashed');

    expect(failed.status).toBe('failed');
    expect(failed.timeline.map(event => event.type)).toContain('terminal_backend_cleanup');
    expect(cancelledRuns[0]).toEqual({ id: 'subagent_failed_cleanup', commands: ['cmd_failed'] });
    expect(cancelledRequests[0]).toEqual({ id: 'subagent_failed_cleanup', requests: ['req_failed'], reason: 'model crashed' });

    const completed = {
      id: 'subagent_completed_cleanup',
      task: 'Long completed task',
      status: 'running',
      activeCommandIds: ['cmd_done'],
      activeRequestIds: ['req_done'],
      toolEvents: [],
      timeline: []
    };
    completeSubagentRecord(completed, 'done');
    expect(completed.status).toBe('completed');
    expect(cancelledRuns[1]).toEqual({ id: 'subagent_completed_cleanup', commands: ['cmd_done'] });
    expect(cancelledRequests[1].reason).toBe('Subagent completed.');

    const partial = {
      id: 'subagent_partial_cleanup',
      task: 'Long partial task',
      status: 'running',
      activeCommandIds: ['cmd_partial'],
      activeRequestIds: ['req_partial'],
      toolEvents: [],
      timeline: []
    };
    partialSubagentRecord(partial, 'partial', 'blocked by auth');
    expect(partial.status).toBe('partial');
    expect(cancelledRuns[2]).toEqual({ id: 'subagent_partial_cleanup', commands: ['cmd_partial'] });
    expect(cancelledRequests[2].reason).toBe('blocked by auth');

    const history = JSON.parse(storage.get(getSubagentRunHistoryStorageKey()));
    expect(history.map(item => item.id)).toEqual([
      'subagent_partial_cleanup',
      'subagent_completed_cleanup',
      'subagent_failed_cleanup'
    ]);
  });
});
