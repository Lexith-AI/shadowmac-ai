import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

// Pull just the standalone stripReasoningBlocks helper out of the runner and run it in a sandbox.
function loadStripReasoningBlocks() {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src', 'scripts', '11-subagents-runner.js'),
    'utf8'
  );
  const start = source.indexOf('function stripReasoningBlocks(');
  if (start < 0) throw new Error('stripReasoningBlocks not found');
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) { end = i + 1; break; }
  }
  const fnSource = source.slice(start, end);
  const sandbox = vm.createContext({});
  vm.runInContext(`${fnSource}\nresult = stripReasoningBlocks;`, sandbox);
  return sandbox.result;
}

describe('stripReasoningBlocks', () => {
  const strip = loadStripReasoningBlocks();

  it('removes a paired <think> block and keeps the real answer', () => {
    expect(strip('<think>let me reason about this</think>Make a calculator in HTML.'))
      .toBe('Make a calculator in HTML.');
  });

  it('removes a paired <thinking> block', () => {
    expect(strip('<thinking>plan</thinking>Download the file to the Desktop.'))
      .toBe('Download the file to the Desktop.');
  });

  it('is case-insensitive and handles multiline reasoning', () => {
    const input = '<THINK>\nstep 1\nstep 2\n</THINK>\nDo the thing.';
    expect(strip(input)).toBe('Do the thing.');
  });

  it('drops everything after an unclosed/truncated <think> (reasoning comes first)', () => {
    expect(strip('<think>reasoning that got cut off and never closed'))
      .toBe('');
  });

  it('removes orphan tags without eating surrounding text', () => {
    expect(strip('Answer here </think> trailing')).toBe('Answer here trailing');
  });

  it('is a no-op for text with no reasoning tags (codex / gemini)', () => {
    expect(strip('Build a static site on the Desktop.'))
      .toBe('Build a static site on the Desktop.');
  });

  it('handles null/undefined/non-string input', () => {
    expect(strip(null)).toBe('');
    expect(strip(undefined)).toBe('');
    expect(strip(42)).toBe('42');
  });

  it('collapses the whitespace left behind so names/skills stay clean', () => {
    // The auto-learned skill name is derived from this — it must not start with "think_…".
    expect(strip('<think>the user wants</think>   create a static site'))
      .toBe('create a static site');
  });
});
