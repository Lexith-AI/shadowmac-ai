import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('reusable skill dedupe guards', () => {
  it('canonicalizes skill saves server-side before writing new folders', () => {
    const root = process.cwd();
    const server = fs.readFileSync(path.join(root, 'run.ps1'), 'utf8');

    expect(server).toContain('function Find-ShadowReusableArtifact');
    expect(server).toContain('function ConvertTo-ShadowReusableToken');

    const skillSaveStart = server.indexOf('if ($urlPath -eq "/api/skills/save")');
    const skillSaveEnd = server.indexOf('# Skills delete-all endpoint', skillSaveStart);
    const skillSaveBlock = server.slice(skillSaveStart, skillSaveEnd);

    expect(skillSaveStart).toBeGreaterThanOrEqual(0);
    expect(skillSaveBlock).toContain('-Kind "skill"');
    expect(skillSaveBlock).toContain('merged_kind = "skill"');
    expect(skillSaveBlock).not.toContain('/api/' + 'capab' + 'ilities');
    expect(skillSaveBlock).not.toContain('merged_kind = "' + 'capab' + 'ility"');
  });

  it('subagent auto-learning saves and tracks skills only', () => {
    const root = process.cwd();
    const runner = fs.readFileSync(path.join(root, 'src', 'scripts', '11-subagents-runner.js'), 'utf8');

    expect(runner).toContain('subagentRecord.savedSkill = true');
    expect(runner).toContain('Skill merged into existing skill');
    expect(runner).not.toContain('save_' + 'capab' + 'ility');
    expect(runner).not.toContain('run_' + 'capab' + 'ility');
    expect(runner).not.toContain('saved' + 'Capab' + 'ility');
  });
});
