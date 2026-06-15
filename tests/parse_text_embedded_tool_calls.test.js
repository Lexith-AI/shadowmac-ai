import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

// Extract parseTextEmbeddedToolCalls AND its two helpers (tolerantJsonParse, extractBalancedJsonObject)
// as one consecutive block — they live in sequence ending right before buildSubagentPromptRefinementInstructions.
// (Brace-counting can't isolate extractBalancedJsonObject because it contains '{'/'}' string literals.)
function loadParser() {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'),
    'utf8'
  );
  const start = source.indexOf('function tolerantJsonParse(');
  const end = source.indexOf('function buildSubagentPromptRefinementInstructions(');
  if (start < 0 || end < 0 || end <= start) throw new Error('parser function block not found');
  const sandbox = vm.createContext({});
  vm.runInContext(`${source.slice(start, end)}\nresult = parseTextEmbeddedToolCalls;`, sandbox);
  return sandbox.result;
}

const KNOWN = ['run_powershell_command', 'read_file', 'list_directory', 'save_skill', 'finish_task'];

describe('parseTextEmbeddedToolCalls', () => {
  const parse = loadParser();

  it('recovers a Qwen/Hermes <tool_call> block', () => {
    const text = '<tool_call>\n{"name": "run_powershell_command", "arguments": {"command": "Get-ChildItem"}}\n</tool_call>';
    const r = parse(text, KNOWN);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe('run_powershell_command');
    expect(r.calls[0].args.command).toBe('Get-ChildItem');
    expect(r.remainingText).toBe('');
  });

  it('keeps surrounding prose as remaining text', () => {
    const text = 'Sure, let me do that.\n<tool_call>{"name":"list_directory","arguments":{"path":"C:/x"}}</tool_call>\nDone.';
    const r = parse(text, KNOWN);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe('list_directory');
    expect(r.remainingText).toContain('Sure, let me do that.');
    expect(r.remainingText).toContain('Done.');
  });

  it('parses multiple tool_call blocks', () => {
    const text = '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call><tool_call>{"name":"finish_task","arguments":{"status":"success"}}</tool_call>';
    const r = parse(text, KNOWN);
    expect(r.calls.map(c => c.name)).toEqual(['read_file', 'finish_task']);
  });

  it('parses "arguments" given as a JSON string', () => {
    const text = '<tool_call>{"name":"run_powershell_command","arguments":"{\\"command\\":\\"ls\\"}"}</tool_call>';
    const r = parse(text, KNOWN);
    expect(r.calls[0].args.command).toBe('ls');
  });

  it('accepts a fenced ```json block naming a known tool (when no <tool_call> present)', () => {
    const text = '```json\n{"name": "save_skill", "arguments": {"skill_name": "x", "instructions": "y"}}\n```';
    const r = parse(text, KNOWN);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe('save_skill');
  });

  it('does NOT extract a block naming an unknown tool', () => {
    const text = '<tool_call>{"name":"definitely_not_a_tool","arguments":{}}</tool_call>';
    const r = parse(text, KNOWN);
    expect(r.calls.length).toBe(0);
    expect(r.remainingText).toContain('definitely_not_a_tool');
  });

  it('is a no-op for ordinary prose', () => {
    const text = 'I will create the calculator file on your desktop now.';
    const r = parse(text, KNOWN);
    expect(r.calls.length).toBe(0);
    expect(r.remainingText).toBe(text);
  });

  it('handles empty/known-empty input safely', () => {
    expect(parse('', KNOWN).calls.length).toBe(0);
    expect(parse('<tool_call>{"name":"read_file"}</tool_call>', []).calls.length).toBe(0); // no known tools
  });

  it('supports the "tool"/"parameters" key variants', () => {
    const text = '<tool_call>{"tool":"list_directory","parameters":{"path":"D:/"}}</tool_call>';
    const r = parse(text, KNOWN);
    expect(r.calls[0].name).toBe('list_directory');
    expect(r.calls[0].args.path).toBe('D:/');
  });

  // ---- The exact LM Studio + Qwen failure mode from real logs ----

  it('recovers a <tool_call> with NO closing tag (model omitted </tool_call>)', () => {
    const text = '<tool_call>{"name": "run_powershell_command", "arguments": {"command": "Get-ChildItem"}}';
    const r = parse(text, KNOWN);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].args.command).toBe('Get-ChildItem');
  });

  it('handles a huge HTML payload (braces & quotes) inside the command argument', () => {
    const html = '<!DOCTYPE html>\\n<html lang=\\"en\\"><head><style>body{margin:0}</style></head><body><div class=\\"x\\">{ not json }</div></body></html>';
    const text = `<tool_call>{"name": "run_powershell_command", "arguments": {"command": "Set-Content -Path \\"$env:USERPROFILE\\\\Desktop\\\\calculator.html\\" -Value '${html}'"}}`;
    const r = parse(text, KNOWN);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe('run_powershell_command');
    expect(r.calls[0].args.command).toContain('Set-Content');
    expect(r.calls[0].args.command).toContain('<!DOCTYPE html>');
  });

  it('tolerates raw (unescaped) newlines inside the JSON string', () => {
    // Some local models put literal newlines in the argument instead of \\n — strict JSON.parse fails.
    const text = '<tool_call>{"name": "run_powershell_command", "arguments": {"command": "line1\nline2\nline3"}}</tool_call>';
    const r = parse(text, KNOWN);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].args.command).toContain('line1');
    expect(r.calls[0].args.command).toContain('line3');
  });

  it('recovers a finish_task call emitted as text', () => {
    const text = 'Done.\n<tool_call>{"name":"finish_task","arguments":{"status":"success","summary":"made it","verification":"Test-Path true"}}</tool_call>';
    const r = parse(text, KNOWN);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe('finish_task');
    expect(r.calls[0].args.status).toBe('success');
  });
});
