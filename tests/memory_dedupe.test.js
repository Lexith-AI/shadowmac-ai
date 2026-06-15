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

function loadMemoryDedupeFunctions() {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '08-memory.js'), 'utf8');
  const functionNames = [
    'normalizeAssistantMemoryGraph',
    'normalizeAssistantIdentityMemoryNode',
    'normalizeMemorySearchText',
    'normalizeMemoryDuplicateText',
    'expandMemoryValueForStorage',
    'cleanMemoryValue',
    'isDurablePreference',
    'hasDurableMemoryValue',
    'isAssistantReferentialMemoryValue',
    'isDisfluentOrLowQualityMemoryValue',
    'isTransientOrTrivialFact',
    'getDurableMemoryContentTokens',
    'isValidMemoryNodePayload',
    'toMemoryIdSegment',
    'toTitleCase',
    'extractDurableMemoryCandidates',
    'getMemoryDuplicateSlot',
    'getMemoryDuplicateTokens',
    'isMemoryDuplicateCandidate'
  ];
  const sandbox = vm.createContext({
    getAssistantName: () => 'Nova'
  });
  const functionSource = functionNames.map(name => extractFunctionSource(source, name)).join('\n\n');
  const exportsSource = `\nresult = { ${functionNames.map(name => `${name}: ${name}`).join(', ')} };`;
  vm.runInContext(`${functionSource}${exportsSource}`, sandbox);
  return sandbox.result;
}

describe('memory node dedupe', () => {
  it('normalizes the spiderweb assistant identity to the current settings name', () => {
    const { normalizeAssistantMemoryGraph } = loadMemoryDedupeFunctions();
    const graph = normalizeAssistantMemoryGraph({
      nodes: [
        { id: 'shadow', label: 'Shadow', type: 'ai', description: 'Shadow, your AI companion' },
        { id: 'assistant_name_shadow', label: 'AI Name', type: 'fact', description: "The assistant's name is Shadow." },
        { id: 'shadow_ai_project', label: 'Shadow AI Project', type: 'fact', description: 'Shadow AI is the app project.' }
      ],
      links: []
    });

    expect(graph.nodes[0].label).toBe('Nova');
    expect(graph.nodes[0].description).toBe('Nova, your AI companion');
    expect(graph.nodes[1].description).toBe("The assistant's current personal name is Nova.");
    expect(graph.nodes[2].label).toBe('Shadow AI Project');
  });

  it('does not treat unrelated preferences as duplicates', () => {
    const { isMemoryDuplicateCandidate, getMemoryDuplicateSlot } = loadMemoryDedupeFunctions();
    const temperatureUnit = {
      id: 'user_temperature_unit_celsius',
      label: 'Temperature Unit Celsius',
      type: 'preference',
      description: 'Dylan prefers Celsius for temperature units.'
    };
    const timeFormat = {
      id: 'time_format_24hr_military',
      label: '24-Hour Time Format',
      type: 'preference',
      description: 'Dylan prefers 24-hour military time format.'
    };

    expect(getMemoryDuplicateSlot(temperatureUnit)).toBe('preference:temperature_unit');
    expect(getMemoryDuplicateSlot(timeFormat)).toBe('preference:time_format');
    expect(isMemoryDuplicateCandidate(temperatureUnit, timeFormat)).toBe(false);
  });

  it('treats symbolic speed unit preferences as the same durable slot', () => {
    const { getMemoryDuplicateSlot, isMemoryDuplicateCandidate } = loadMemoryDedupeFunctions();
    const kmhPreference = {
      id: 'user_prefers_km_h',
      label: 'Speed Unit Preference',
      type: 'preference',
      description: 'Dylan prefers km/h for speed units.'
    };
    const mphPreference = {
      id: 'user_prefers_mph',
      label: 'Speed Unit Preference',
      type: 'preference',
      description: 'Dylan prefers mph for speed units.'
    };

    expect(getMemoryDuplicateSlot(kmhPreference)).toBe('preference:speed_unit');
    expect(getMemoryDuplicateSlot(mphPreference)).toBe('preference:speed_unit');
    expect(isMemoryDuplicateCandidate(kmhPreference, mphPreference)).toBe(true);
  });

  it('expands symbolic unit preferences before storing auto memories', () => {
    const {
      cleanMemoryValue,
      extractDurableMemoryCandidates,
      hasDurableMemoryValue
    } = loadMemoryDedupeFunctions();

    expect(cleanMemoryValue('km/h i/o m/h')).toBe('kilometers per hour instead of miles per hour');
    expect(hasDurableMemoryValue('AI')).toBe(false);
    expect(hasDurableMemoryValue('ok')).toBe(false);
    expect(hasDurableMemoryValue('kilometers per hour')).toBe(true);

    const candidates = extractDurableMemoryCandidates('I prefer km/h i/o m/h when giving me speed info.');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toContain('kilometers_per_hour');
    expect(candidates[0].description).toContain('kilometers per hour instead of miles per hour');
    expect(candidates[0].description).not.toContain('km/h');
  });

  it('rejects transcription disfluency/filler as durable memory', () => {
    const { isDisfluentOrLowQualityMemoryValue, extractDurableMemoryCandidates } = loadMemoryDedupeFunctions();

    // Filler-led speech artifacts must be rejected.
    expect(isDisfluentOrLowQualityMemoryValue('um uh a setup file on my desktop')).toBe(true);
    expect(isDisfluentOrLowQualityMemoryValue('uhh i mean a thing')).toBe(true);
    expect(isDisfluentOrLowQualityMemoryValue('well so okay')).toBe(true);
    // Genuine durable values still pass.
    expect(isDisfluentOrLowQualityMemoryValue('kilometers per hour')).toBe(false);
    expect(isDisfluentOrLowQualityMemoryValue('lives in Oss, Netherlands')).toBe(false);

    // The exact garbage case from the field does not become a saved fact.
    const junk = extractDurableMemoryCandidates('I use um uh a setup file on my desktop');
    expect(junk.some(c => /setup file on my desktop/i.test(c.description || ''))).toBe(false);
  });

  it('drops transient chatter as facts but keeps genuine durable facts', () => {
    const { isTransientOrTrivialFact, extractDurableMemoryCandidates } = loadMemoryDedupeFunctions();

    // The real field junk: transient actions/states/intentions/fillers are rejected.
    ['singing', 'saying', 'paint open', 'tired', 'to go', 'a question', 'something'].forEach(v => {
      expect(isTransientOrTrivialFact(v)).toBe(true);
    });
    // Genuine durable facts pass.
    ['two cats', 'guitar', 'a Tesla', 'allergic to peanuts'].forEach(v => {
      expect(isTransientOrTrivialFact(v)).toBe(false);
    });

    // End-to-end: one-off chatter never becomes a regex-captured fact.
    expect(extractDurableMemoryCandidates('I am singing').some(c => c.id === 'user_fact_singing')).toBe(false);
    expect(extractDurableMemoryCandidates('I have paint open').some(c => /paint/.test(c.id))).toBe(false);
    expect(extractDurableMemoryCandidates('I was just coughing').some(c => /cough/.test(c.id))).toBe(false);
    // Generic possessions are now the MODEL's job (it stores them when it sees fit), not the regex.
    expect(extractDurableMemoryCandidates('I have two cats').some(c => c.type === 'fact')).toBe(false);
    // High-confidence durable facts ARE still auto-captured by the narrowed regex.
    expect(extractDurableMemoryCandidates('I am allergic to peanuts').some(c => c.type === 'fact')).toBe(true);
    expect(extractDurableMemoryCandidates('I was born in Texas').some(c => c.type === 'fact')).toBe(true);
  });

  it('rejects tiny shorthand-only memory node payloads generically', () => {
    const { isValidMemoryNodePayload } = loadMemoryDedupeFunctions();

    expect(isValidMemoryNodePayload({
      id: 'user_prefers_ai',
      label: 'AI Preference',
      type: 'preference',
      description: 'Dylan prefers AI.'
    })).toBe(false);
    expect(isValidMemoryNodePayload({
      id: 'user_prefers_ok',
      label: 'OK Preference',
      type: 'preference',
      description: 'Dylan likes OK.'
    })).toBe(false);
    expect(isValidMemoryNodePayload({
      id: 'user_prefers_speed_units',
      label: 'Speed Unit Preference',
      type: 'preference',
      description: 'Dylan prefers miles per hour for speed units.'
    })).toBe(true);
  });

  it('does replace the same preference slot when only the value changes', () => {
    const { isMemoryDuplicateCandidate } = loadMemoryDedupeFunctions();

    expect(isMemoryDuplicateCandidate(
      {
        id: 'user_temperature_unit_fahrenheit',
        label: 'Temperature Unit Fahrenheit',
        type: 'preference',
        description: 'Dylan prefers Fahrenheit for temperature units.'
      },
      {
        id: 'user_temperature_unit_celsius',
        label: 'Temperature Unit Celsius',
        type: 'preference',
        description: 'Dylan prefers Celsius for temperature units.'
      }
    )).toBe(true);

    expect(isMemoryDuplicateCandidate(
      {
        id: 'time_format_12hr_ampm',
        label: '12-Hour Time Format',
        type: 'preference',
        description: 'Dylan prefers 12-hour AM/PM time format.'
      },
      {
        id: 'time_format_24hr_military',
        label: '24-Hour Time Format',
        type: 'preference',
        description: 'Dylan prefers 24-hour military time format.'
      }
    )).toBe(true);
  });

  it('treats a labeled birthday and a generic "born in YYYY" fact as duplicates', () => {
    const { isMemoryDuplicateCandidate } = loadMemoryDedupeFunctions();

    expect(isMemoryDuplicateCandidate(
      {
        id: 'user_birthday',
        label: 'User Birthday',
        type: 'fact',
        description: 'User was born in 1996.'
      },
      {
        id: 'user_fact_born_in_1996',
        label: 'Born In 1996',
        type: 'fact',
        description: 'the user is/has/does: born in 1996.'
      }
    )).toBe(true);
  });

  it('keeps different favorite preference topics separate', () => {
    const { isMemoryDuplicateCandidate } = loadMemoryDedupeFunctions();

    expect(isMemoryDuplicateCandidate(
      {
        id: 'user_favorite_movie_blade_runner',
        label: 'Favorite Movie',
        type: 'preference',
        description: 'Dylan favorite movie is Blade Runner.'
      },
      {
        id: 'user_favorite_color_blue',
        label: 'Favorite Color',
        type: 'preference',
        description: 'Dylan favorite color is blue.'
      }
    )).toBe(false);
  });
});
