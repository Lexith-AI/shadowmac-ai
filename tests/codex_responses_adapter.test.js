import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

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

function loadRunnerFunctions(functionNames, context = {}) {
  const root = process.cwd();
  const source = fs.readFileSync(path.join(root, 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
  const sandbox = vm.createContext({
    console,
    ...context
  });
  const functionSource = functionNames.map(name => extractFunctionSource(source, name)).join('\n\n');
  const exportsSource = `\nresult = { ${functionNames.map(name => `${name}: ${name}`).join(', ')} };`;
  vm.runInContext(`${functionSource}${exportsSource}`, sandbox);
  return sandbox.result;
}

function loadWholeRunnerFunctions(functionNames, context = {}) {
  const root = process.cwd();
  const source = fs.readFileSync(path.join(root, 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
  const sandbox = vm.createContext({
    console,
    ...context
  });
  const exportsSource = `\nresult = { ${functionNames.map(name => `${name}: ${name}`).join(', ')} };`;
  vm.runInContext(`${source}${exportsSource}`, sandbox);
  return sandbox.result;
}

function loadCoreFunctions(functionNames, context = {}) {
  const root = process.cwd();
  const source = fs.readFileSync(path.join(root, 'src', 'scripts', '09-subagents-core.js'), 'utf8');
  const sandbox = vm.createContext({
    console,
    ...context
  });
  const functionSource = functionNames.map(name => extractFunctionSource(source, name)).join('\n\n');
  const exportsSource = `\nresult = { ${functionNames.map(name => `${name}: ${name}`).join(', ')} };`;
  vm.runInContext(`${functionSource}${exportsSource}`, sandbox);
  return sandbox.result;
}

describe('Codex Responses subagent adapter', () => {
  it('normalizes Gemini schemas for Codex tool payloads', () => {
    const { convertSchemaTypesToLowercase } = loadCoreFunctions(['convertSchemaTypesToLowercase']);

    expect(convertSchemaTypesToLowercase({
      type: 'OBJECT',
      properties: {
        enabled: { type: 'BOOLEAN' },
        values: { type: 'ARRAY', items: { type: 'STRING' } },
        matrix: { type: 'ARRAY', items: { type: 'ARRAY' } }
      }
    })).toEqual({
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        values: { type: 'array', items: { type: 'string' } },
        matrix: { type: 'array', items: { type: 'array', items: {} } }
      }
    });
  });

  it('parses streamed reasoning items and function-call argument deltas', () => {
    const { parseCodexResponsesSseToGemini } = loadRunnerFunctions(['parseCodexResponsesSseToGemini']);
    const sse = [
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"encrypted"}}',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"encrypted"}}',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"run_powershell_command","arguments":""}}',
      'data: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_1","delta":"{\\"command\\":"}',
      'data: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_1","delta":"\\"Get-ChildItem\\"}"}',
      'data: {"type":"response.function_call_arguments.done","output_index":1,"item_id":"fc_1","name":"run_powershell_command","arguments":"{\\"command\\":\\"Get-ChildItem\\"}"}',
      'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"run_powershell_command","arguments":"{\\"command\\":\\"Get-ChildItem\\"}"}}',
      'data: [DONE]'
    ].join('\n');

    const parsed = parseCodexResponsesSseToGemini(sse);

    expect(parsed.codexResponseItems.map(item => item.type)).toEqual(['reasoning', 'function_call']);
    expect(parsed.codexResponseItems[0].encrypted_content).toBe('encrypted');
    expect(parsed.candidates[0].content.parts).toEqual([
      {
        functionCall: {
          name: 'run_powershell_command',
          args: { command: 'Get-ChildItem' },
          id: 'call_1'
        }
      }
    ]);
  });

  it('replays raw Codex output items before tool outputs on the next turn', () => {
    const {
      createCodexResponsesContent,
      getCodexSubagentReasoning,
      buildCodexSubagentInstructions,
      createCodexResponsesPayload
    } = loadRunnerFunctions([
      'createCodexResponsesContent',
      'getCodexSubagentReasoning',
      'buildCodexSubagentInstructions',
      'createCodexResponsesPayload'
    ], {
      OPENAI_CODEX_REASONING_MODES: new Set(['none', 'low', 'medium', 'high', 'xhigh']),
      OPENAI_CODEX_REASONING_MODELS: new Set(['gpt-5.5', 'gpt-5.4']),
      subagentReasoningMode: 'high',
      convertSchemaTypesToLowercase: schema => schema
    });

    expect(createCodexResponsesContent([{ text: 'hello' }], 'user')).toEqual([
      { type: 'input_text', text: 'hello' }
    ]);

    const payload = createCodexResponsesPayload([
      { role: 'user', parts: [{ text: 'List files.' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'run_powershell_command',
              args: { command: 'Get-ChildItem' },
              id: 'call_1'
            }
          }
        ],
        _codexResponseItems: [
          { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted' },
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'run_powershell_command', arguments: '{"command":"Get-ChildItem"}' }
        ]
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'run_powershell_command',
              response: { status: 'success', output: 'file.txt' }
            }
          }
        ]
      }
    ], 'system', [
      {
        functionDeclarations: [
          {
            name: 'run_powershell_command',
            description: 'Run PowerShell.',
            parameters: { type: 'OBJECT', properties: { command: { type: 'STRING' } } }
          }
        ]
      }
    ], 'gpt-5.5');

    expect(payload.input.map(item => item.type)).toEqual([
      'message',
      'reasoning',
      'function_call',
      'function_call_output'
    ]);
    expect(payload.input[1].encrypted_content).toBe('encrypted');
    expect(payload.input[3].call_id).toBe('call_1');
    expect(payload.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(payload.parallel_tool_calls).toBe(false);
    expect(payload.instructions).toContain('Every assistant turn MUST do exactly one of these');
    expect(payload.instructions).toContain('Do NOT make multiple tool calls in one response');
    expect(payload.instructions).toContain('stop after 8 total web_search calls');
    expect(buildCodexSubagentInstructions('base')).toContain('base');
    expect(buildCodexSubagentInstructions('base', 10)).toContain('stop after 10 total web_search calls');
    expect(getCodexSubagentReasoning('gpt-5.5')).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('builds chat-completions history with stable tool ids and safe empty args', () => {
    const { createChatCompletionsMessages } = loadRunnerFunctions(['createChatCompletionsMessages']);
    const history = [
      { role: 'user', parts: [{ text: 'Do the thing.' }] },
      {
        role: 'model',
        parts: [
          {
            text: 'Working.',
          },
          {
            functionCall: {
              name: 'run_powershell_command',
              id: 'call_1'
            }
          }
        ]
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'run_powershell_command',
              response: { status: 'success', output: 'ok' }
            }
          }
        ]
      }
    ];

    const messages = createChatCompletionsMessages(history, 'system');

    expect(messages[0]).toEqual({ role: 'system', content: 'system' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Do the thing.' });
    expect(messages[2].tool_calls[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: {
        name: 'run_powershell_command',
        arguments: '{}'
      }
    });
    expect(messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      name: 'run_powershell_command',
      content: JSON.stringify({ status: 'success', output: 'ok' })
    });
  });

  it('omits Codex reasoning when disabled and honors the selected effort for tool work', () => {
    const { getCodexSubagentReasoning } = loadRunnerFunctions(['getCodexSubagentReasoning'], {
      OPENAI_CODEX_REASONING_MODES: new Set(['none', 'low', 'medium', 'high', 'xhigh']),
      OPENAI_CODEX_REASONING_MODELS: new Set(['gpt-5.5', 'gpt-5.4']),
      subagentReasoningMode: 'none'
    });

    expect(getCodexSubagentReasoning('gpt-5.5')).toBeNull();
    expect(getCodexSubagentReasoning('not-a-codex-reasoning-model')).toBeNull();

    const { getCodexSubagentReasoning: getXHighReasoning } = loadRunnerFunctions(['getCodexSubagentReasoning'], {
      OPENAI_CODEX_REASONING_MODES: new Set(['none', 'low', 'medium', 'high', 'xhigh']),
      OPENAI_CODEX_REASONING_MODELS: new Set(['gpt-5.5', 'gpt-5.4']),
      subagentReasoningMode: 'xhigh'
    });

    expect(getXHighReasoning('gpt-5.5')).toEqual({ effort: 'xhigh', summary: 'auto' });
  });

  it('builds a foreground smart-consult payload for voice answers', () => {
    const {
      getSmartConsultModel,
      getCodexSmartConsultReasoning,
      normalizeSmartConsultResponseStyle,
      buildSmartConsultInstructions,
      buildSmartConsultContextText,
      createCodexSmartConsultPayload,
      extractTextFromCodexGeminiResponse
    } = loadWholeRunnerFunctions([
      'getSmartConsultModel',
      'getCodexSmartConsultReasoning',
      'normalizeSmartConsultResponseStyle',
      'buildSmartConsultInstructions',
      'buildSmartConsultContextText',
      'createCodexSmartConsultPayload',
      'extractTextFromCodexGeminiResponse'
    ], {
      OPENAI_CODEX_REASONING_MODES: new Set(['none', 'low', 'medium', 'high', 'xhigh']),
      OPENAI_CODEX_REASONING_MODELS: new Set(['gpt-5.5', 'gpt-5.4']),
      subagentModel: 'gpt-5.5',
      subagentReasoningMode: 'high',
      currentUserTranscript: 'What are my options?',
      currentAITranscript: '',
      formatRecentDialogueTurns: () => 'User: I want smarter voice replies.'
    });

    const payload = createCodexSmartConsultPayload({
      prompt: 'Brainstorm voice architecture options.',
      response_style: 'decision'
    });

    expect(getSmartConsultModel()).toBe('gpt-5.5');
    expect(getCodexSmartConsultReasoning('gpt-5.5')).toEqual({ effort: 'high', summary: 'auto' });
    expect(normalizeSmartConsultResponseStyle('unknown')).toBe('concise');
    expect(buildSmartConsultInstructions('decision')).toContain('Return a recommendation');
    expect(buildSmartConsultContextText('Question')).toContain('Recent dialogue');
    expect(payload.model).toBe('gpt-5.5');
    expect(payload.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(payload.stream).toBe(true);
    expect(payload.input[0].content[0].text).toContain('Brainstorm voice architecture options.');
    expect(extractTextFromCodexGeminiResponse({
      candidates: [{ content: { parts: [{ text: 'First' }, { text: 'Second' }] } }]
    })).toBe('First\nSecond');
  });

  it('uses a stricter plain-text repair prompt for Codex subagents', () => {
    const { getPlainTextFinishRepairPrompt } = loadRunnerFunctions(['getPlainTextFinishRepairPrompt'], {
      OPENAI_CODEX_PROVIDER: 'openai_codex'
    });

    const prompt = getPlainTextFinishRepairPrompt('openai_codex', 'I am done.');

    expect(prompt).toContain('exactly one tool call');
    expect(prompt).toContain('Do not include prose outside the tool call');
    expect(prompt).toContain('I am done.');
  });

  it('auto-wraps useful Codex plain-text final answers after tool evidence', () => {
    const completed = [];
    const partial = [];
    const notices = [];
    const {
      maybeFinalizeCodexPlainTextResponse,
      looksLikeUsableCodexPlainTextFinal
    } = loadRunnerFunctions([
      'isOpenAiCodexSubagentProvider',
      'looksLikeUsableCodexPlainTextFinal',
      'maybeFinalizeCodexPlainTextResponse'
    ], {
      OPENAI_CODEX_PROVIDER: 'openai_codex',
      getSubagentEvidenceSummary: () => 'web_search: 4 result(s) for "RX 9070 XT"',
      completeSubagentRecord: (record, summary) => completed.push({ record, summary }),
      partialSubagentRecord: (record, summary, reason) => partial.push({ record, summary, reason }),
      renderSubagentFinalBubble: () => {},
      notifyVoiceSession: (task, finalText, id) => notices.push({ task, finalText, id }),
      notifyVoiceSessionOfPartial: (task, reason, id) => notices.push({ task, reason, id }),
      addSubagentMessage: () => {}
    });

    const record = { id: 'subagent_codex', provider: 'openai_codex' };
    const finalText = 'The best evidence I found points to rough RX 9070 XT performance being source-dependent, so I would report the benchmark range with those caveats.';

    expect(looksLikeUsableCodexPlainTextFinal(finalText)).toBe(true);
    expect(maybeFinalizeCodexPlainTextResponse('Research RX 9070 XT benchmark results.', record, finalText, 1)).toBe(true);
    expect(completed).toHaveLength(1);
    expect(completed[0].summary).toContain('Verification: web_search');
    expect(notices[0]).toMatchObject({ id: 'subagent_codex' });

    const secondRecord = { id: 'subagent_codex_partial', provider: 'openai_codex' };
    expect(maybeFinalizeCodexPlainTextResponse('Research RX 9070 XT benchmark results.', secondRecord, 'I need to search again but have some evidence.', 2)).toBe(true);
    expect(partial).toHaveLength(1);
    expect(partial[0].reason).toContain('plain text instead of finish_task');
  });

  it('uses Codex web-search hard limits while leaving other providers adaptive', () => {
    const {
      normalizeSubagentSearchQuery,
      isCurrentSourceSensitiveResearchTask,
      isCurrentTravelPlanningTask,
      getSubagentWebSearchCheckpoint,
      getSubagentWebSearchHardLimit,
      shouldBlockCodexResearchPowerShellWebFetch,
      reserveSubagentWebSearch,
      getWebSearchCheckpointGuidancePrompt,
      getWebSearchBatchBlockedPrompt
    } = loadRunnerFunctions([
      'normalizeSubagentSearchQuery',
      'isCurrentSourceSensitiveResearchTask',
      'isCurrentTravelPlanningTask',
      'getSubagentWebSearchCheckpoint',
      'isOpenAiCodexSubagentProvider',
      'isResearchLikeSubagentTask',
      'getSubagentWebSearchHardLimit',
      'isPowerShellWebFetchCommand',
      'shouldBlockCodexResearchPowerShellWebFetch',
      'reserveSubagentWebSearch',
      'getCodexResearchExhaustedPrompt',
      'getWebSearchCheckpointGuidancePrompt',
      'getWebSearchBatchBlockedPrompt'
    ], {
      OPENAI_CODEX_PROVIDER: 'openai_codex'
    });

    expect(getSubagentWebSearchCheckpoint('openai_codex')).toBe(8);
    expect(getSubagentWebSearchCheckpoint('minimax')).toBe(8);
    expect(isCurrentTravelPlanningTask('Plan a vacation to Portugal next week under 1000 euros')).toBe(true);
    expect(isCurrentTravelPlanningTask('Plan a trip to Faro next week under \u20ac1000')).toBe(true);
    expect(isCurrentSourceSensitiveResearchTask('Find me the best GPU in stock under 700 euros in the Netherlands')).toBe(true);
    expect(isCurrentSourceSensitiveResearchTask('Compare voice architecture tradeoffs')).toBe(false);
    expect(getSubagentWebSearchCheckpoint('openai_codex', 'Plan a vacation to Portugal next week under 1000 euros')).toBe(24);
    expect(getSubagentWebSearchCheckpoint('openai_codex', 'Find a laptop in stock under 1000 euros with good reviews')).toBe(24);
    expect(getSubagentWebSearchHardLimit('openai_codex', 'Find a laptop in stock under 1000 euros with good reviews')).toBe(12);
    expect(getSubagentWebSearchHardLimit('openai_codex', 'Research RX 9070 XT llama-bench tokens per second')).toBe(8);
    expect(getSubagentWebSearchHardLimit('minimax', 'Research RX 9070 XT llama-bench tokens per second')).toBeNull();
    expect(normalizeSubagentSearchQuery('Latest RTX 4090 prices, 2026!')).toBe('rtx 4090');

    const record = {};
    for (let i = 1; i <= 8; i++) {
      expect(reserveSubagentWebSearch(record, `static documentation lookup ${i}`, 'minimax')).toMatchObject({
        ok: true,
        count: i,
        checkpoint: 8,
        normal_checkpoint: 8,
        searches_before_checkpoint: 8 - i,
        past_normal_checkpoint: false
      });
    }
    const pastCheckpoint = reserveSubagentWebSearch(record, 'static documentation lookup 9', 'minimax');
    expect(pastCheckpoint).toMatchObject({ ok: true, count: 9, checkpoint: 8, normal_checkpoint: 8, searches_before_checkpoint: 0, past_normal_checkpoint: true });
    expect(getWebSearchCheckpointGuidancePrompt(pastCheckpoint)).toContain('not a hard stop');
    expect(getWebSearchBatchBlockedPrompt()).toContain('Only one web_search');
    const duplicate = reserveSubagentWebSearch(record, 'static documentation lookup 9', 'minimax');
    expect(duplicate).toMatchObject({ ok: false, kind: 'duplicate_query', count: 9, checkpoint: 8 });
    expect(getWebSearchCheckpointGuidancePrompt(duplicate)).toContain('Do not repeat equivalent web_search queries');

    const codexRecord = { task: 'Research RX 9070 XT llama-bench tokens per second for Qwen models.' };
    for (let i = 1; i <= 8; i++) {
      expect(reserveSubagentWebSearch(codexRecord, `rx 9070 xt llama bench query ${i}`, 'openai_codex')).toMatchObject({
        ok: true,
        count: i,
        checkpoint: 12,
        hard_limit: 8,
        searches_before_hard_limit: 8 - i,
        hard_limit_reached: i === 8
      });
    }
    const overLimit = reserveSubagentWebSearch(codexRecord, 'rx 9070 xt extra benchmark query', 'openai_codex');
    expect(overLimit).toMatchObject({ ok: false, kind: 'hard_limit', count: 8, hard_limit: 8 });
    expect(getWebSearchCheckpointGuidancePrompt(overLimit)).toContain('Codex research budget reached');
    expect(shouldBlockCodexResearchPowerShellWebFetch(codexRecord, "Invoke-WebRequest 'https://example.com'", 'openai_codex')).toBe(true);
    expect(shouldBlockCodexResearchPowerShellWebFetch(codexRecord, 'Get-ChildItem .', 'openai_codex')).toBe(false);
    expect(shouldBlockCodexResearchPowerShellWebFetch(codexRecord, "Invoke-WebRequest 'https://example.com'", 'minimax')).toBe(false);

    const travelRecord = { task: 'Plan a vacation to Portugal next week under 1000 euros.' };
    for (let i = 1; i <= 12; i++) {
      expect(reserveSubagentWebSearch(travelRecord, `Portugal hotel option ${i}`, 'openai_codex')).toMatchObject({
        ok: true,
        count: i,
        checkpoint: 24,
        hard_limit: 12,
        normal_checkpoint: 24,
        searches_before_hard_limit: 12 - i,
        past_normal_checkpoint: false
      });
    }
    expect(reserveSubagentWebSearch(travelRecord, 'Portugal extra hotel option', 'openai_codex')).toMatchObject({ ok: false, kind: 'hard_limit', count: 12, checkpoint: 24, hard_limit: 12 });

    const runnerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'), 'utf8');
    expect(runnerSource).not.toContain('getSubagentWebSearchLimit');
    expect(runnerSource).not.toContain('over_soft_limit');
    expect(runnerSource).not.toContain('soft_limit');
  });
});
