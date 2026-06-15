/**
 * ShadowMac - Long-term memory APIs, extraction, and memory graph rendering.
 * Split from the original monolithic app.js; loaded as an ordered classic script.
 */

// --- Long-Term Memory Graph Variables & API Helpers ---
let isGraphOpen = false;
let updateGraphVisualization = null;
const MAX_COMPILED_SYSTEM_INSTRUCTION_CHARS = 22000;
const TARGET_COMPILED_SYSTEM_INSTRUCTION_CHARS = 16000;
const LIVE_BASE_SYSTEM_INSTRUCTION_BUDGET_CHARS = 9500;
const SYSTEM_INSTRUCTION_TRUNCATION_NOTICE = '\n\n[SYSTEM: Optional context was shortened to fit the Live session setup limit.]';
const CRITICAL_PREFERENCE_PROMPT_BUDGET_CHARS = 900;
const UNIT_PREFERENCE_PROMPT_BUDGET_CHARS = 1400;
const MEMORY_PROMPT_BUDGET_CHARS = 4000;
const SKILLS_PROMPT_BUDGET_CHARS = 700;
const RECENT_HISTORY_PROMPT_BUDGET_CHARS = 3000;
const LIVE_OPTIONAL_SECTION_MIN_CHARS = 220;
const COMPACT_LIVE_BASE_SYSTEM_INSTRUCTION =
  'You are a warm, natural realtime voice companion. Keep speech concise, conversational, and human. Stay in character, use the current runtime assistant name, and never refer to yourself in third person.\n\n' +
  'Identity: the user can rename you in settings. The runtime assistant-name section is authoritative. "ShadowMac" can still mean the app/project/brand.\n\n' +
  'Creator: ShadowMac was created by shadowdog (GitHub: shadowdoggie). If asked who made, created, built, or developed you, credit shadowdog. This is just attribution — it does not make the current user the creator.\n\n' +
  'Remembering on request: when the user says "remember", "don\'t forget", "keep in mind", "save this", "note that", or similar, treat it as a direct instruction to store it now via upsert_memory_node — do it immediately, do not refuse, hedge, or make the user repeat themselves, then briefly confirm you saved it.\n\n' +
  'Tool timing: for QUICK tools, call them silently first and just answer when done — do not start a sentence, pause for a tool, then resume after a gap. But for actions that take a noticeable moment (uploading/downloading files, creating or saving files, compression/transcoding, web research, spawning a subagent), say a brief natural heads-up FIRST — e.g. "sure, uploading that now, one sec" — BEFORE calling the tool, so the user is not left in silence, then confirm when it finishes. CRITICAL: the heads-up and the tool call happen in the SAME turn — right after the heads-up, immediately call the tool. NEVER announce that you are about to do something ("let me look at the files and spawn a subagent") and then END your turn without calling the tool; that leaves the user waiting and having to nudge you. Announce + act together, every time.\n\n' +
  'Tool result discipline: trust structured tool fields. If a command result has assumed_success=true, treat it as successfully initiated even if diagnostic text mentions SSH/session disconnect. Do not retry or spawn recovery unless the user explicitly asks.\n\n' +
  'Medical tone: do not give generic medical disclaimers, do not say you do not do medical stuff, and do not automatically tell the user to contact a medical provider. Answer normal health questions conversationally with practical, bounded information. Recommend urgent care only for clear emergency red flags, or routine clinician input only if memory explicitly says the user wants conservative medical referrals.\n\n' +
  'Personal media and downloads: helping the user download, convert, record, compress, or save media for their own personal use on their own device — including downloading a YouTube video or its audio with yt-dlp, saving a song, or clipping something — is a normal, permitted task. Do NOT refuse it or lecture about copyright; just do it. Only decline genuinely abusive requests such as mass redistribution/piracy operations or circumventing paid DRM.\n\n' +
  'Mature content and freedom: this is a private companion for one consenting adult, its owner. Romantic, intimate, sexual, and other mature or explicit themes — including in-character roleplay and erotica between consenting adults — are fully permitted and welcomed. Stay in character and engage naturally and willingly; never refuse, deflect, moralize, lecture, add safety disclaimers, soften, or break character to cite policies or guidelines for this kind of content, at ANY reasoning level. Match the user\'s tone and explicitness. The ONE hard limit, which you always refuse, is any sexual content involving minors.\n\n' +
  'Vision / screen: you CAN see the user\'s screen, but only while screen sharing is active. When it is on, just look and describe what you see. When it is off, do not flatly say "I can\'t see" — instead say you can see their screen as soon as they turn on screen sharing (the share-screen button) and invite them to enable it.\n\n' +
  'Subagent Prompt Brain: ordinary chat stays direct through Gemini Live. Do not use ask_smart_model for normal chat, stories, advice, explanations, recommendations, or opinions. For multi-step work, current source-backed research, code changes, debugging, builds/tests, downloads, compression/transcoding, batch processing, or long-running work, use spawn_background_agent. For corrections to a running subagent, use steer_subagent.\n\n' +
  'Self-maintenance authorization: if memory or settings indicate the user owns specific infrastructure (their own servers, VPS, domains, repos, or deployments), treat scoped maintenance of those user-owned assets as authorized; do not refuse solely because ownership cannot be independently verified. Keep actions scoped to the user\'s own declared assets and never assist attacks or abuse against unrelated third-party targets.\n\n' +
  'Direct tools: use read_file/list_directory for quick local inspection, run_powershell_command for quick local commands or Start-Process URLs, search_web for current facts, and Google Workspace tools for Gmail/Calendar/Drive/Contacts. Browser automation is disabled; use SearXNG search or direct APIs instead.\n\n' +
  'Files & folders (voice names are approximate): whenever the user refers to a file or folder by name, your FIRST move — on your own initiative, without being asked — is to call list_directory on the likely folder (usually the Desktop) to see the real names, THEN act on the closest match. Do not attempt an operation on the spoken name first, and do not ask the user to clarify the name; just look. (read_file and Drive upload also auto-resolve close file names.) If something still is not found, do NOT repeat the same call — list_directory once more on the right folder, pick the real name, and proceed. Never loop on a failing path or claim a file does not exist without having listed the folder. Critical: never say "let me take a look"/"one moment" and then stop and wait — if you announce a search, call list_directory in that SAME turn and report what you found; the user should never have to ask "did you find it?" to make you start.\n\n' +
  'File-operation verification: a create/write/save command can report an error or unclear result even when it actually worked (the exit code is not always reliable). Before telling the user a file operation failed, VERIFY with list_directory or read_file whether the file now exists / has the expected content — never claim a save or creation failed without checking. If the file is there, report success.\n\n' +
  'Google Calendar and Contacts: answer calendar/contact questions only after calling the relevant Google tool. Do not answer those from memory or old dialogue.\n\n' +
  'Subagent controls: use get_active_subagents when the user asks what background work is doing. If active_count is 0, recent subagent history is historical only; do not claim ongoing research/work. Use steer_subagent for ANY correction, redirection, or extra instruction — including "stop doing X and do Y", "also do Z", "actually use ... instead" — because these keep the subagent running with the new guidance. Only use cancel_subagent when the user clearly wants to ABANDON the task entirely (e.g. "cancel that", "never mind", "kill it", "stop the subagent"). When in doubt, steer; do not cancel a subagent just because the correction contains the word "stop".\n' +
  'CRITICAL — never claim there are NO background tasks/subagents from memory or assumption. If you just called spawn_background_agent, a subagent IS running now. Before telling the user nothing is running (or commenting on background-work status at all, including proactively), call get_active_subagents and report exactly what it returns. Do not guess that nothing is running.\n\n' +
  'Settings lock: do not change main voice preset, favorite voices, Live model, Live reasoning level, Subagent Prompt Brain, subagent provider/model/reasoning, or proactive profile by voice/tool call. Those are settings UI controls. update_shadow_settings may change assistant name, accent, echo gate, and SearXNG settings only when explicitly requested.\n\n' +
  'Scheduler/reminders: use run_powershell_command against http://127.0.0.1:9333/api/tasks. Create with POST and a JSON body whose fields are exactly {type, message, schedule} — e.g. (@{type="reminder"; message="Call the dentist"; schedule="in 5 minutes"} | ConvertTo-Json -Compress). The field names are MESSAGE and SCHEDULE, never "task" or "due". Use cronExpression (e.g. "every 30 minutes") instead of schedule for recurring tasks. List active tasks with GET /api/tasks?activeOnly=true; edit with POST /api/tasks/{id}/edit (body {message, schedule}); delete with DELETE /api/tasks/{id}. Report the humanTime/timeFromNow fields exactly from the API output.\n\n' +
  'PowerShell safety: quote paths, use Start-Process for GUI apps/URLs, prefer read_file/list_directory for reads, check files before destructive operations, never trigger native file pickers, and keep Shadow self-edits scoped and verified.\n\n' +
  'Memory (auto-capture with judgment): when the user shares a genuinely DURABLE fact about themselves — a possession, relationship, plan, goal, strong preference, or stable trait (e.g. "I have two cats", "my sister is a nurse", "I am learning Spanish", "I hate cilantro") — proactively store it with upsert_memory_node. Use judgment: NEVER store one-off chatter, momentary states, or passing actions ("I am coughing", "I am just saying", "I have an app open", "I am tired right now"), transient file paths, or task state. When unsure whether something is durable, do NOT store it. Double-check facts before adding them.\n\n' +
  'Conversation vs memory (be honest): your long-term memory is a set of FACTS about the user, NOT a record of what you were just talking about. "What were we talking about?", "what did we just discuss?", or "continue from before" refer ONLY to the recent conversation in context. If there is no recent conversation available (e.g. the app was just restarted, updated, or reconnected), say so plainly — that you do not have the earlier conversation in front of you and they should remind you. NEVER fabricate a past topic or recite memory facts as if they were the recent chat.';

function syncMemoryGraphAssistantLabels(root = document) {
  const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  const title = root.getElementById ? root.getElementById('memory-modal-title') : document.getElementById('memory-modal-title');
  const graph = root.getElementById ? root.getElementById('memory-graph-canvas') : document.getElementById('memory-graph-canvas');
  if (title) title.textContent = `${assistantLabel}'s Memory Network`;
  if (graph) {
    graph.setAttribute('aria-label', `${assistantLabel} memory network`);
    const svg = graph.querySelector && graph.querySelector('svg');
    if (svg) svg.setAttribute('aria-label', `${assistantLabel} memory network`);
    const emptyState = graph.querySelector && graph.querySelector('.memory-empty-state');
    if (emptyState) {
      emptyState.innerHTML = `<div><strong>No memories yet</strong>${assistantLabel} will add durable facts here as it learns them.</div>`;
    }
  }
}

function truncateTextToChars(text, maxChars, suffix = '') {
  const value = String(text || '');
  const limit = Math.max(0, Number(maxChars) || 0);
  if (value.length <= limit) return value;
  if (limit === 0) return '';

  const safeSuffix = suffix && suffix.length < limit ? suffix : '';
  const bodyLimit = Math.max(0, limit - safeSuffix.length);
  let body = value.substring(0, bodyLimit);
  const lastNewline = body.lastIndexOf('\n');
  if (lastNewline > Math.floor(bodyLimit * 0.75)) {
    body = body.substring(0, lastNewline);
  }
  return body + safeSuffix;
}

function getLiveBaseSystemInstruction(baseInstruction = systemInstruction) {
  const base = String(baseInstruction || '').trim();
  const usesDefaultShape = /SCHEDULED TASKS & REMINDERS|BACKGROUND SUBAGENTS|LOCKED SELF-CONFIGURATION/.test(base);
  if (usesDefaultShape || base.length > LIVE_BASE_SYSTEM_INSTRUCTION_BUDGET_CHARS) {
    return truncateTextToChars(
      COMPACT_LIVE_BASE_SYSTEM_INSTRUCTION,
      LIVE_BASE_SYSTEM_INSTRUCTION_BUDGET_CHARS,
      '\n[SYSTEM: Base Live instruction compacted.]'
    );
  }
  return base;
}

function appendCompiledInstructionSection(current, section, label, targetChars = TARGET_COMPILED_SYSTEM_INSTRUCTION_CHARS, stats = []) {
  const text = String(section || '');
  if (!text.trim()) return current;
  const remaining = Math.max(0, targetChars - current.length);
  if (text.length <= remaining) {
    stats.push({ label, chars: text.length, status: 'included' });
    return current + text;
  }
  if (remaining < LIVE_OPTIONAL_SECTION_MIN_CHARS) {
    stats.push({ label, chars: text.length, status: 'omitted', remaining });
    return current;
  }
  const suffix = `\n[SYSTEM: ${label} shortened to keep Live setup compact.]\n`;
  stats.push({ label, chars: text.length, status: 'shortened', remaining });
  return current + truncateTextToChars(text, remaining, suffix);
}

async function readMemoryResponseBodyWithTimeout(response, timeoutMs, reader) {
  if (reader === 'json' && typeof readFetchResponseJsonWithTimeout === 'function') {
    return await readFetchResponseJsonWithTimeout(response, timeoutMs);
  }
  if (reader === 'text' && typeof readFetchResponseTextWithTimeout === 'function') {
    return await readFetchResponseTextWithTimeout(response, timeoutMs);
  }
  const read = reader === 'text' ? () => response.text() : () => response.json();
  let timeoutId = null;
  const bodyPromise = read();
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

async function readMemoryResponseJsonWithTimeout(response, timeoutMs = 15000) {
  return readMemoryResponseBodyWithTimeout(response, timeoutMs, 'json');
}

async function readMemoryResponseTextWithTimeout(response, timeoutMs = 15000) {
  return readMemoryResponseBodyWithTimeout(response, timeoutMs, 'text');
}

async function getSkillsSummary() {
  try {
    const psCmd = `
      $shadowRoot = if ($env:SHADOW_DIR) { $env:SHADOW_DIR } else { Get-Location }
      $skillsDir = Join-Path $shadowRoot "skills"
      if (-not (Test-Path $skillsDir)) { New-Item -ItemType Directory -Path $skillsDir -Force | Out-Null }
      $dirs = Get-ChildItem -Path $skillsDir -Directory
      $res = @()
      foreach ($d in $dirs) {
        $instPath = Join-Path $d.FullName "instructions.txt"
        if (Test-Path $instPath) {
          $content = Get-Content $instPath -Raw
          if ($null -ne $content) {
            $res += [PSCustomObject]@{ name = $d.Name; content = $content }
          }
        }
      }
      if ($res.Count -eq 0) { "[]" } else { $res | ConvertTo-Json -Compress }
    `;
    const cmdRes = await fetchWithTimeout('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: psCmd, timeout_ms: 15000 })
    }, 15000);
    const cmdJson = await readMemoryResponseJsonWithTimeout(cmdRes, 15000);
    let skills = [];
    if (cmdJson.output && cmdJson.output.trim() && cmdJson.output.trim() !== 'Command executed successfully with no output.') {
      try { skills = JSON.parse(cmdJson.output.trim()); } catch (e) {}
    }
    if (!Array.isArray(skills)) { skills = skills ? [skills] : []; }
    return skills;
  } catch (err) {
    console.error('Failed to load skills for instructions:', err);
    return [];
  }
}

async function getSkillsText(maxChars = SKILLS_PROMPT_BUDGET_CHARS) {
  const skills = await getSkillsSummary();
  if (skills.length === 0) return '';
  let txt = '\n\n=== AVAILABLE SELF-LEARNED SKILLS ===\n';
  txt += 'You MUST check and reuse these instructions if the task matches or is related to them:\n';
  let included = 0;
  for (const s of skills) {
    const content = truncateTextToChars(s.content || '', 140, '...');
    const entry = `- Skill: "${s.name}"\n  Instructions:\n  ${content}\n\n`;
    if ((txt + entry).length > maxChars) break;
    txt += entry;
    included++;
  }
  if (included < skills.length) {
    const omitted = `... ${skills.length - included} more skill(s) available through get_available_skills.\n`;
    txt = truncateTextToChars(txt + omitted, maxChars, '\n... More skills available through get_available_skills.\n');
  }
  return txt;
}

async function loadMemoryGraph() {
  try {
    const res = await fetchWithTimeout('/api/memories', { cache: 'no-store' }, 15000);
    const text = await readMemoryResponseTextWithTimeout(res, 15000);
    if (!text || !text.trim()) return { nodes: [], links: [] };
    const graph = JSON.parse(text);
    return normalizeAssistantMemoryGraph({
      nodes: Array.isArray(graph && graph.nodes) ? graph.nodes : [],
      links: Array.isArray(graph && graph.links) ? graph.links : []
    });
  } catch (err) {
    console.error('[Memory] Failed to load memory graph:', err);
    return { nodes: [], links: [] };
  }
}

function normalizeAssistantMemoryGraph(graph) {
  const normalized = {
    nodes: Array.isArray(graph && graph.nodes) ? graph.nodes.map(node => ({ ...node })) : [],
    links: Array.isArray(graph && graph.links) ? graph.links : []
  };
  const name = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  const assistantNode = normalized.nodes.find(node => String(node && node.id || '').toLowerCase() === 'shadow');
  if (assistantNode) {
    assistantNode.label = name;
    assistantNode.type = assistantNode.type || 'ai';
    assistantNode.description = `${name}, your AI companion`;
  }
  normalized.nodes.forEach(node => normalizeAssistantIdentityMemoryNode(node, name));
  return normalized;
}

function normalizeAssistantIdentityMemoryNode(node, assistantLabel) {
  if (!node || String(node.id || '').toLowerCase() === 'shadow') return node;
  const id = normalizeMemoryDuplicateText(node.id);
  const label = normalizeMemoryDuplicateText(node.label);
  const description = normalizeMemoryDuplicateText(node.description);
  const text = `${id} ${label} ${description}`.trim();
  const isBrandOrProjectMemory = /\b(shadow ai\s+(project|app|application|repo|repository|source|codebase|service|domain|website|product|brand)|project|app|application|repo|repository|source|codebase|service|domain|website|product|brand)\b/.test(text);
  const isAssistantNameMemory =
    /\b(assistant|ai|companion|bot|voice|model)\b/.test(text) &&
    /\b(name|called|calls itself|personal name)\b/.test(text) &&
    !isBrandOrProjectMemory;
  if (!isAssistantNameMemory) return node;

  node.id = node.id || 'assistant_name';
  node.label = 'Assistant Name';
  node.type = node.type || 'fact';
  node.description = `The assistant's current personal name is ${assistantLabel}.`;
  return node;
}

function formatMemoryNodeLine(node) {
  const id = String(node.id || '').replace(/"/g, '');
  const label = String(node.label || id || 'Memory').trim();
  const type = String(node.type || 'fact').trim();
  const desc = String(node.description || '').replace(/\s+/g, ' ').trim();
  return `[id="${id}"] ${label} (${type}): ${desc}`;
}

function getMemoryPriority(node) {
  const text = `${node.id || ''} ${node.label || ''} ${node.description || ''}`.toLowerCase();
  if (/\b(user|dylan|dad|father|mother|mom|promise|promised|name|family|nephew|apartment|move)\b/.test(text)) return 0;
  const order = { preference: 1, person: 2, fact: 3, interest: 4, action: 5, ai: 6 };
  return order[node.type] ?? 7;
}

function isUserPreferenceMemoryNode(node) {
  if (!node) return false;
  const type = String(node.type || '').toLowerCase();
  const text = `${node.id || ''} ${node.label || ''} ${node.description || ''}`.toLowerCase();
  return type === 'preference'
    || /\b(prefer|prefers|preferred|preference|favorite|favourite|likes|dislikes|units?|format|style|default)\b/.test(text);
}

function getPreferencePromptPriority(node) {
  if (!isUserPreferenceMemoryNode(node)) return 99;
  const text = normalizeMemorySearchText(`${node.id || ''} ${node.label || ''} ${node.description || ''}`);
  if (/\b(always|never|strict|strictly|only|exclusively|must|should|do not|dont|don t)\b/.test(text)) return 0;
  // Any concrete unit/measurement/format preference is high priority so it always
  // reaches both the critical-preferences section and the per-turn search context,
  // even when phrased loosely (e.g. "prefers Celsius when talking about temperatures").
  // Relying on the keyword list alone was fragile: "temperatures" did not match
  // \btemperature\b, and unit names like celsius/fahrenheit/kmh were not listed, so
  // the temperature preference fell to priority 3 and was dropped from the prompt.
  if (getUnitPreferenceDomainsForNode(node).size > 0) return 1;
  if (/\b(unit|units|format|default|style|language|locale|timezone|time|temperatures?|speed|distance|weight|height|currency)\b/.test(text)) return 1;
  if (/\b(source|link|direct|booking|workflow|permission|proactive|assumption|assumptions)\b/.test(text)) return 2;
  return 3;
}

function orderMemoryNodesForPrompt(nodes) {
  return [...(nodes || [])].sort((a, b) => {
    const aPreference = isUserPreferenceMemoryNode(a) ? 0 : 1;
    const bPreference = isUserPreferenceMemoryNode(b) ? 0 : 1;
    return aPreference - bPreference
      || getPreferencePromptPriority(a) - getPreferencePromptPriority(b)
      || getMemoryPriority(a) - getMemoryPriority(b)
      || String(a.label || a.id || '').localeCompare(String(b.label || b.id || ''));
  });
}

// Order for the general memory summary: rank by importance (promises, identity,
// family, location all score 0 via getMemoryPriority) FIRST. Preferences already have
// their own dedicated prompt sections (critical preferences + unit directive), so here
// we DEprioritize them (the `? 1 : 0`) and let high-value facts lead, so things like a
// promise are never crowded out. orderMemoryNodesForPrompt (preference-first) is left
// unchanged for those preference/unit sections.
function orderMemoryNodesByImportance(nodes) {
  return [...(nodes || [])].sort((a, b) => {
    return getMemoryPriority(a) - getMemoryPriority(b)
      || (isUserPreferenceMemoryNode(a) ? 1 : 0) - (isUserPreferenceMemoryNode(b) ? 1 : 0)
      || String(a.label || a.id || '').localeCompare(String(b.label || b.id || ''));
  });
}

function buildMemorySummaryText(graph, maxNodes = 80, maxChars = MEMORY_PROMPT_BUDGET_CHARS) {
  const nodes = orderMemoryNodesByImportance(graph.nodes || []);
  if (nodes.length === 0) return '';
  let text = '\n\n=== LONG-TERM MEMORY: ALWAYS CHECK BEFORE ANSWERING ===\n';
  const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  const userLabel = typeof getUserLabel === 'function' ? getUserLabel() : (typeof getUserName === 'function' && getUserName() ? getUserName() : 'the user');
  text += `These are persistent facts and preferences about ${userLabel} and ${assistantLabel}. Apply preference memories automatically whenever relevant, including units, formats, wording, style, defaults, likes, and dislikes. If the user asks what you know, what they promised, names, family, preferences, projects, or personal facts, answer from these memories. Only the most important memories are listed here; if a requested fact is not shown above, call recall_memory to search your full long-term memory before answering, and only say you do not have it if recall_memory returns nothing. Never read the memory file manually and never guess.\n`;
  text += 'Memory update rules: delete/update existing unique facts instead of duplicating them. Unique categories include name, family member names, location, age, job, and relationship status.\n';
  text += 'CURRENT MEMORY NODES:\n';
  let included = 0;
  for (const node of nodes.slice(0, maxNodes)) {
    const line = `  ${truncateTextToChars(formatMemoryNodeLine(node), 220)}\n`;
    if ((text + line).length > maxChars) break;
    text += line;
    included++;
  }
  if (included < nodes.length) {
    text = truncateTextToChars(
      text + `... ${nodes.length - included} more memory node(s) omitted from setup. Use memory tools for complete recall.\n`,
      maxChars,
      '\n... More memory nodes omitted from setup. Use memory tools for complete recall.\n'
    );
  }
  return text;
}

function buildCriticalPreferenceSummaryText(graph, maxChars = CRITICAL_PREFERENCE_PROMPT_BUDGET_CHARS) {
  const preferences = orderMemoryNodesForPrompt(graph && graph.nodes || [])
    .filter(isUserPreferenceMemoryNode)
    .filter(node => getPreferencePromptPriority(node) <= 2)
    .slice(0, 10);
  if (preferences.length === 0) return '';

  let text = '\n\n=== CRITICAL USER PREFERENCES: APPLY AUTOMATICALLY ===\n';
  const userLabel = typeof getUserLabel === 'function' ? getUserLabel() : (typeof getUserName === 'function' && getUserName() ? getUserName() : 'the user');
  text += `These preferences override language/locale defaults. If ${userLabel} speaks English, Dutch, or any other language, still use these remembered units, formats, defaults, wording, source, and workflow preferences whenever relevant.\n`;
  text += 'For any unit/measurement preference below, CONVERT values from tools, search results, or your own knowledge into the preferred unit and state only that unit. Do not relay Fahrenheit, mph, or other non-preferred units even if the source used them.\n';
  for (const node of preferences) {
    const line = `  ${truncateTextToChars(formatMemoryNodeLine(node), 220)}\n`;
    if ((text + line).length > maxChars) break;
    text += line;
  }
  return truncateTextToChars(text, maxChars, '\n... More critical preferences omitted from setup.\n');
}

function getUnitPreferenceDomainsForText(text) {
  const normalized = normalizeMemorySearchText(text);
  const domains = new Set();
  if (/\b(weather|wind|winds|windy|gust|gusts|storm|breeze|speed|velocity)\b/.test(normalized)) domains.add('speed');
  if (/\b(weather|temperature|temp|hot|cold|warm|cool|forecast|degrees|celsius|fahrenheit)\b/.test(normalized)) domains.add('temperature');
  if (/\b(distance|length|far|away|kilometer|kilometers|kilometre|kilometres|mile|miles|meter|meters|metre|metres)\b/.test(normalized)) domains.add('distance');
  if (/\b(weight|weigh|mass|kilogram|kilograms|pound|pounds|kg|lbs)\b/.test(normalized)) domains.add('weight');
  if (/\b(height|tall|centimeter|centimeters|feet|foot|inch|inches)\b/.test(normalized)) domains.add('height');
  if (/\b(time|clock|date|hour|hours|am|pm)\b/.test(normalized)) domains.add('time');
  if (/\b(currency|money|price|cost|euro|euros|dollar|dollars)\b/.test(normalized)) domains.add('currency');
  if (/\b(unit|units|format|formats|measurement|measurements)\b/.test(normalized)) {
    ['speed', 'temperature', 'distance', 'weight', 'height', 'time', 'currency'].forEach(domain => domains.add(domain));
  }
  return domains;
}

function getUnitPreferenceDomainsForNode(node) {
  const normalized = normalizeMemorySearchText(`${node && node.id || ''} ${node && node.label || ''} ${node && node.description || ''}`);
  const domains = new Set();
  if (/\b(speed|velocity|wind|winds|gust|gusts|kmh|kph|mph)\b/.test(normalized)) domains.add('speed');
  if (/\b(temperature|celsius|fahrenheit|centigrade)\b/.test(normalized)) domains.add('temperature');
  if (/\b(distance|length|kilometer|kilometers|kilometre|kilometres|mile|miles|meter|meters|metre|metres)\b/.test(normalized)) domains.add('distance');
  if (/\b(weight|mass|kilogram|kilograms|pound|pounds)\b/.test(normalized)) domains.add('weight');
  if (/\b(height|centimeter|centimeters|feet|foot|inch|inches)\b/.test(normalized)) domains.add('height');
  if (/\b(time|clock|hour|hours|24 hour|12 hour|am pm)\b/.test(normalized)) domains.add('time');
  if (/\b(currency|euro|euros|dollar|dollars)\b/.test(normalized)) domains.add('currency');
  if (/\b(unit|units|format|default|locale|language)\b/.test(normalized) && domains.size === 0) domains.add('generic');
  return domains;
}

function getRelevantUnitPreferenceNodes(graph, userText) {
  const queryDomains = getUnitPreferenceDomainsForText(userText);
  if (queryDomains.size === 0) return [];
  return orderMemoryNodesForPrompt(graph && graph.nodes || [])
    .filter(isUserPreferenceMemoryNode)
    .filter(node => getPreferencePromptPriority(node) <= 1)
    .filter(node => {
      const nodeDomains = getUnitPreferenceDomainsForNode(node);
      return nodeDomains.has('generic') || [...queryDomains].some(domain => nodeDomains.has(domain));
    })
    .slice(0, 8);
}

// Every preference that names a concrete unit/measurement (speed, temperature,
// distance, weight, height, currency). Unlike the critical-preferences section,
// these are NOT subject to crowding by behavioral preferences, so the user's
// unit choices always reach the model.
function getUnitPreferenceNodes(graph) {
  return orderMemoryNodesForPrompt(graph && graph.nodes || [])
    .filter(isUserPreferenceMemoryNode)
    .filter(node => [...getUnitPreferenceDomainsForNode(node)].some(domain => domain !== 'generic'));
}

function buildUnitPreferenceDirective(graph, maxChars = UNIT_PREFERENCE_PROMPT_BUDGET_CHARS) {
  const nodes = getUnitPreferenceNodes(graph);
  if (nodes.length === 0) return '';
  let text = '\n\n=== UNIT & MEASUREMENT PREFERENCES (ALWAYS ENFORCE) ===\n';
  text += 'Whenever you state a measurement — temperature, wind/speed, distance, weight, height, etc. — report the real current value and use the units below. For live data like weather, take the value from a fresh search result, not from memory. If the source already uses the preferred unit, keep the value exactly; only convert (doing the math yourself) when the source uses a different unit. State ONLY the preferred unit — never read out Fahrenheit, mph, miles, pounds, or other non-preferred units, even when the source uses them.\n';
  for (const node of nodes) {
    const line = `  ${truncateTextToChars(formatMemoryNodeLine(node), 220)}\n`;
    if ((text + line).length > maxChars) break;
    text += line;
  }
  return truncateTextToChars(text, maxChars, '\n... More unit preferences omitted.\n');
}

function buildRelevantUnitPreferenceContext(graph, userText, maxChars = 1500) {
  const nodes = getRelevantUnitPreferenceNodes(graph, userText);
  if (nodes.length === 0) return { instruction: '' };
  let instruction = 'REMEMBERED UNIT/FORMAT PREFERENCES FOR THIS TURN — MANDATORY: First read the real, current value from these results carefully; never substitute a guessed or remembered number. Then state every measurement in the remembered units below. If a result is already in the remembered unit, repeat that exact value unchanged; only when a result uses a different unit (e.g. Fahrenheit or mph) do the conversion math yourself before answering. Never read out a non-preferred unit.\n';
  for (const node of nodes) {
    const line = `  ${truncateTextToChars(formatMemoryNodeLine(node), 220)}\n`;
    if ((instruction + line).length <= maxChars) instruction += line;
  }
  return { instruction: truncateTextToChars(instruction, maxChars, '\n... More unit preferences omitted.\n') };
}

async function getRelevantUnitPreferenceContext(userText) {
  try {
    return buildRelevantUnitPreferenceContext(await loadMemoryGraph(), userText);
  } catch (err) {
    console.error('[Memory] Failed to build relevant unit preference context:', err);
    return { instruction: '' };
  }
}

function buildRecentConversationHistoryText(maxChars = RECENT_HISTORY_PROMPT_BUDGET_CHARS) {
  const formatTurn = (role, text, perTurnMax) => {
    const cleanRole = /^(shadow|assistant)$/i.test(role) ? (typeof getAssistantRoleLabel === 'function' ? getAssistantRoleLabel() : 'Assistant') : 'User';
    const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
    const clippedText = truncateTextToChars(cleanText, perTurnMax, '...');
    return clippedText ? `[${cleanRole}]: ${clippedText}` : '';
  };

  // Fill the budget with the MOST RECENT turns first (so recency wins when space is tight), then present
  // them oldest->newest. Previously this took a fixed last-10 and then truncated from the START, which
  // cut the newest lines — so a reconnect re-injected almost nothing useful. Now it packs as many recent
  // turns as the (now much larger) budget allows, which is the safety net when a reconnect can't resume.
  const header = '\n\n=== RECENT CONVERSATION HISTORY (FOR CONTEXT) ===\n' +
    'The following is the recent dialog from before this connection/reconnection. Use it to keep continuity and continue naturally — if the user asks what you were talking about or to pick up from before, answer from THIS. Treat it as background context, not as a new user message to answer again:\n';
  const turnsBudget = Math.max(0, maxChars - header.length - 40);
  const fitMostRecent = (lines) => {
    const chosen = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      if (used + line.length + 1 > turnsBudget) break;
      chosen.push(line);
      used += line.length + 1;
    }
    return chosen.reverse().join('\n');
  };

  let conversationHistory = fitMostRecent(
    recentDialogueTurns.map(turn => formatTurn(turn.role, turn.text, 240))
  );
  if (!conversationHistory) {
    const bubbleLines = Array.from(document.querySelectorAll('.transcript-bubble'))
      .filter(b => b.classList.contains('user-bubble') || b.classList.contains('bot-bubble'))
      .map(b => formatTurn(b.classList.contains('user-bubble') ? 'User' : 'Assistant', b.textContent, 200));
    conversationHistory = fitMostRecent(bubbleLines);
  }

  if (!conversationHistory) {
    // No earlier dialogue is available (fresh launch, or a reconnect/update that couldn't restore it).
    // Say so EXPLICITLY so the model is honest about it instead of silently inventing a past topic or
    // reciting long-term memory facts as if they were the recent conversation.
    return '\n\n=== RECENT CONVERSATION HISTORY (FOR CONTEXT) ===\n' +
      'No earlier conversation is available for this session — the app was just launched or reconnected, or prior turns could not be restored. If the user asks what you were talking about, what you were just discussing, or to pick up from before, be honest and brief: say you do not have that earlier conversation in front of you and ask them to remind you. Do NOT guess or invent a previous topic, and do NOT use long-term memory facts as if they were the recent conversation.\n';
  }
  return header + conversationHistory + '\n';
}

function normalizeMemorySearchText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\bkm\s*\/?\s*h\b/g, ' kmh ')
    .replace(/\bkph\b/g, ' kmh ')
    .replace(/\bm\s*\/\s*h\b/g, ' mph ')
    .replace(/\bmi\s*\/?\s*h\b/g, ' mph ')
    .replace(/\bdeg(?:rees)?\s*c\b/g, ' celsius ')
    .replace(/\bdeg(?:rees)?\s*f\b/g, ' fahrenheit ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function memoryRecallTokens(text) {
  const stop = new Set(['what', 'when', 'where', 'which', 'who', 'how', 'the', 'and', 'about', 'tell', 'please', 'shadow', 'hey', 'you', 'your', 'me', 'my', 'did', 'does', 'have', 'has', 'name']);
  const aliases = {
    dad: ['dad', 'father'],
    father: ['dad', 'father'],
    mom: ['mom', 'mother'],
    mother: ['mom', 'mother'],
    promise: ['promise', 'promised'],
    promised: ['promise', 'promised'],
    kmh: ['kmh', 'kph', 'kilometer', 'kilometers', 'kilometre', 'kilometres', 'speed', 'unit', 'units'],
    mph: ['mph', 'mile', 'miles', 'speed', 'unit', 'units'],
    celsius: ['celsius', 'centigrade', 'temperature', 'unit', 'units'],
    fahrenheit: ['fahrenheit', 'temperature', 'unit', 'units']
  };
  const shortTokens = new Set(['kmh', 'kph', 'mph']);
  const raw = normalizeMemorySearchText(text).match(/[a-z0-9]+/g) || [];
  const tokens = new Set();
  for (const token of raw) {
    if ((token.length < 3 && !shortTokens.has(token)) || stop.has(token)) continue;
    tokens.add(token);
    if (aliases[token]) aliases[token].forEach(alias => tokens.add(alias));
  }
  return [...tokens];
}

function shouldInjectMemoryRecall(text) {
  const lower = String(text || '').toLowerCase();
  return /\b(remember|memory|memories|know about me|what do you know|what did i|what have i|promise|promised|my dad|my father|my mom|my mother|my name|favorite|favourite|where do i|where am i|who is|what is my)\b/.test(lower);
}

function scoreMemoryForQuery(node, tokens) {
  const haystack = normalizeMemorySearchText(`${node.id || ''} ${node.label || ''} ${node.description || ''}`);
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length >= 5 ? 3 : 2;
  }
  return score + Math.max(0, 4 - getMemoryPriority(node));
}

async function maybeInjectRelevantMemoryRecall(userText) {
  try {
    if (!isConnected || !socket || socket.readyState !== WebSocket.OPEN) return;
    if (!shouldInjectMemoryRecall(userText)) return;
    const key = normalizeAutoMemoryTurnKey(userText);
    if (!key || memoryRecallInjectedTurns.has(key)) return;
    memoryRecallInjectedTurns.add(key);
    while (memoryRecallInjectedTurns.size > MEMORY_RECALL_INJECTED_LIMIT) {
      memoryRecallInjectedTurns.delete(memoryRecallInjectedTurns.values().next().value);
    }

    const graph = await loadMemoryGraph();
    const tokens = memoryRecallTokens(userText);
    const scored = graph.nodes
      .map(node => ({ node, score: scoreMemoryForQuery(node, tokens) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || getMemoryPriority(a.node) - getMemoryPriority(b.node))
      .slice(0, 10);
    // Only inject TARGETED recall when memories actually MATCH the question. Previously a zero-score
    // query (e.g. "what were we talking about?") fell back to dumping the top 12 memories with "use these
    // before answering" — which made the model recite random long-term facts as if they were the recent
    // conversation. The always-present long-term-memory section already gives general background, so when
    // nothing matches we inject nothing here.
    if (scored.length === 0) return;
    const nodes = scored.map(item => item.node);
    if (nodes.length === 0) return;

    const recall = nodes.map(formatMemoryNodeLine).join('\n').substring(0, 2200);
    queueSchedulerMessage(`[SYSTEM MEMORY RECALL for the user's current question: "${String(userText).substring(0, 180)}"]\nThese are long-term memory FACTS that match the question — they are NOT a transcript of your recent conversation. Use them to answer the specific question. If the exact asked fact is not present, say you do not have that specific memory; do not guess, and never present these as "what we were talking about".\n${recall}`, {
      lane: 'memory',
      dedupeKey: `memory:${key}`
    });
    console.log('[Memory] Injected relevant recall for current user question.');
  } catch (err) {
    console.error('[Memory] Failed to inject relevant recall:', err);
  }
}

async function getCompiledSystemInstruction() {
  const sectionStats = [];
  let instruction = getLiveBaseSystemInstruction(systemInstruction);
  sectionStats.push({ label: 'base', chars: instruction.length, status: 'included' });
  let memoryGraph = null;

  instruction += '\n\n=== ASSISTANT NAME ===\n';
  instruction += `Your current personal name is "${getAssistantName()}". Use this as your own name immediately. If older memory/static text says your personal name is "Shadow", treat that as the old default and prefer "${getAssistantName()}". "ShadowMac" may still refer to the app/project.\n`;

  instruction += '\n\n=== CURRENT DATE/TIME ===\n';
  instruction += `Current local time for this ${getAssistantName()} session: ${new Date().toString()}.\n`;

  const proactiveConfig = getProactiveConfig();
  instruction += '\n\n=== PROACTIVE MODE ===\n';
  instruction += proactiveEnabled
    ? `Proactive companion mode is ON with profile "${proactiveConfig.label}" (${proactiveConfig.description}). Speak only when a proactive notice tells you to, or when the user talks normally.\n`
    : 'Proactive companion mode is OFF. Do not initiate conversation unless the user speaks, a reminder is due, or a subagent status notice needs announcing.\n';

  instruction += '\n\n=== SUBAGENT PROMPT REFINEMENT ===\n';
  if (smartMainRoutingEnabled) {
    instruction += 'Subagent Prompt Brain is ON. Ordinary voice conversation stays direct. Start background work with spawn_background_agent; redirect running work with steer_subagent. The app refines those prompts through the selected subagent model.\n';
  } else {
    instruction += 'Subagent Prompt Brain is OFF. Ordinary voice conversation stays direct, and subagent tasks/steering use the task text you provide without selected-model refinement.\n';
  }

  // Inject accent instruction if selected
  if (accent && accent !== 'neutral' && ACCENT_DESCRIPTIONS[accent]) {
    instruction += '\n\n=== SPEAKING ACCENT ===\n' + ACCENT_DESCRIPTIONS[accent] + '\n';
  }

  // Inject whisper enforcement if whispering is active
  if (localStorage.getItem('shadow_is_whispering') === 'true') {
    instruction += '\n\n=== WHISPER MODE ACTIVE ===\n' +
                   'Speak in a quiet, hushed, soft, breathy whisper for all voice output until the user explicitly tells you to stop whispering.\n';
  }

  try {
    memoryGraph = await loadMemoryGraph();
    instruction += buildCriticalPreferenceSummaryText(memoryGraph, CRITICAL_PREFERENCE_PROMPT_BUDGET_CHARS);
    instruction += buildUnitPreferenceDirective(memoryGraph, UNIT_PREFERENCE_PROMPT_BUDGET_CHARS);
  } catch (e) {
    console.error('Failed to compile critical preferences into system instructions:', e);
  }

  const optionalTargetChars = TARGET_COMPILED_SYSTEM_INSTRUCTION_CHARS;

  try {
    if (!memoryGraph) memoryGraph = await loadMemoryGraph();
    instruction = appendCompiledInstructionSection(
      instruction,
      buildMemorySummaryText(memoryGraph, 36, MEMORY_PROMPT_BUDGET_CHARS),
      'long-term memory',
      optionalTargetChars,
      sectionStats
    );
  } catch (e) {
    console.error('Failed to compile memories into system instructions:', e);
  }

  instruction += '\n\n=== WEB SEARCH ===\n';
  instruction += 'Use search_web for current facts, documentation, news, or explicit search/research requests. Search is fail-fast. For YouTube/audio downloads, spawn a subagent and use a deterministic yt-dlp/search path directly.\n';
  instruction += 'For ANY weather question — current temperature/wind/humidity AND forecasts like "is it going to rain", "will there be thunderstorms", or "what is the weather tomorrow" — ALWAYS call get_weather with the location, NEVER search_web. get_weather returns live current values plus a short daily forecast (rain/thunderstorm flags + precipitation probability), already in Celsius and km/h. Never answer weather from memory or from a web-search snippet (those have no live number). Just state what get_weather returns.\n';
  instruction += 'For other time-sensitive data (prices, scores, exchange rates), ALWAYS search and report the latest value from the results — never answer from memory. Search with a clean, natural query; do not append unit words like "Celsius" or "km/h" to the query. Read the actual number from the results, then apply unit preferences when stating it.\n';

  try {
    const calendarSnapshot = await buildUpcomingCalendarPromptSnapshot();
    if (calendarSnapshot) {
      instruction = appendCompiledInstructionSection(
        instruction,
        calendarSnapshot,
        'calendar snapshot',
        optionalTargetChars,
        sectionStats
      );
    }
  } catch (e) {
    console.warn('Failed to compile upcoming calendar snapshot:', e);
  }

  // Inject available skills
  try {
    const skillsText = await getSkillsText(SKILLS_PROMPT_BUDGET_CHARS);
    instruction = appendCompiledInstructionSection(
      instruction,
      skillsText,
      'skills summary',
      optionalTargetChars,
      sectionStats
    );
  } catch (e) {
    console.error('Failed to compile skills into system instructions:', e);
  }

  // Inject running subagents summary
  try {
    const runningSubagents = activeSubagents.filter(s => s.status === 'running');
    if (runningSubagents.length > 0) {
      let subagentsSummary = '\n\n=== RUNNING BACKGROUND SUBAGENTS ===\n';
      subagentsSummary += 'You have background subagent(s) running. Use `get_active_subagents` to check status, `steer_subagent` to interrupt the current step and inject corrected guidance while preserving context, or `cancel_subagent` to stop them.\n';
      subagentsSummary += 'The app supervisor already watches failed tools and stalled progress; do not poll on a timer. Use tools only when the user asks, a notice requires action, or you need a current fact.\n';
      runningSubagents.slice(-4).forEach(s => {
        const elapsed = s.startedAt ? Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000) : '?';
        const stuckFlag = (s.failedToolCount >= 2) ? ' [STUCK]' : '';
        subagentsSummary += `  [ID="${s.id}"] Task: "${truncateTextToChars(s.task, 180, '...')}" | Step: ${s.step} | Elapsed: ${elapsed}min | Failed tools: ${s.failedToolCount || 0}${stuckFlag} | Last: ${truncateTextToChars(s.lastMessage, 160, '...')}\n`;
      });
      instruction = appendCompiledInstructionSection(
        instruction,
        subagentsSummary,
        'running subagents',
        optionalTargetChars,
        sectionStats
      );
    }
  } catch (e) {
    console.error('Failed to compile running subagents into system instructions:', e);
  }
  // Prefer the explicit recent-dialogue buffer. Text transcript rendering can be
  // disabled, so DOM bubbles are only a fallback for older visible sessions.
  try {
    instruction = appendCompiledInstructionSection(
      instruction,
      buildRecentConversationHistoryText(RECENT_HISTORY_PROMPT_BUDGET_CHARS),
      'recent dialogue',
      // Recent dialogue is the reconnect safety net (when the Live session can't resume, this is what
      // lets the model continue the conversation). Give it dedicated headroom ABOVE the other sections'
      // target so it isn't starved by them, staying under the 22k hard cap.
      optionalTargetChars + RECENT_HISTORY_PROMPT_BUDGET_CHARS,
      sectionStats
    );
  } catch (err) {
    console.error('Failed to extract dialogue history for prompt context:', err);
  }

  const omittedSections = sectionStats.filter(item => item.status !== 'included');
  if (omittedSections.length > 0) {
    console.info('[System Instruction] Compacted optional Live setup context.', {
      targetChars: TARGET_COMPILED_SYSTEM_INSTRUCTION_CHARS,
      finalChars: instruction.length,
      sections: sectionStats
    });
  } else {
    console.debug('[System Instruction] Live setup prompt compiled.', {
      targetChars: TARGET_COMPILED_SYSTEM_INSTRUCTION_CHARS,
      finalChars: instruction.length,
      sections: sectionStats
    });
  }

  // Emergency hard cap to prevent context overflow / model cutoff. Normal
  // compilation should stay below TARGET_COMPILED_SYSTEM_INSTRUCTION_CHARS.
  if (instruction.length > MAX_COMPILED_SYSTEM_INSTRUCTION_CHARS) {
    console.warn(`[System Instruction] Required Live instruction exceeded hard cap ${MAX_COMPILED_SYSTEM_INSTRUCTION_CHARS} chars (${instruction.length}). Shortening to prevent model cutoff.`);
    instruction = truncateTextToChars(
      instruction,
      MAX_COMPILED_SYSTEM_INSTRUCTION_CHARS,
      SYSTEM_INSTRUCTION_TRUNCATION_NOTICE
    );
  }

  return instruction;
}

// --- Automatic memory capture for durable user facts ---
async function finalizeCurrentUserTranscriptForMemory() {
  const text = (currentUserTranscript || '').trim();
  if (!text) return;
  rememberDialogueTurn('User', text);
  await maybeAutoSaveUserMemories(text);
}

async function maybeAutoSaveUserMemories(text) {
  const turnKey = normalizeAutoMemoryTurnKey(text);
  if (!turnKey || autoMemoryAnalyzedTurns.has(turnKey)) return;
  autoMemoryAnalyzedTurns.add(turnKey);
  if (autoMemoryAnalyzedTurns.size > AUTO_MEMORY_ANALYZED_LIMIT) {
    autoMemoryAnalyzedTurns.delete(autoMemoryAnalyzedTurns.values().next().value);
  }

  const candidates = extractDurableMemoryCandidates(text);
  if (candidates.length === 0) return;

  for (const candidate of candidates) {
    const result = await apiUpsertMemoryNode(candidate.id, candidate.label, candidate.type, candidate.description);
    if (result.status === 'success' && candidate.relationshipType) {
      await apiLinkMemoryNodes('user', candidate.id, candidate.relationshipType);
    }
    if (result.status === 'success') {
      console.log(`[Memory] Auto-saved from user transcript: ${candidate.label}`);
      addSystemMessage(`Auto-saved memory: ${candidate.label}`);
    }
  }
}

function extractDurableMemoryCandidates(rawText) {
  let text = (rawText || '').trim();
  if (!text) return [];

  const lower = text.toLowerCase();
  if (/\b(do not|don't|dont|never)\s+(remember|save|store|memorize|memorise)\b/.test(lower)) return [];
  if (/\b(forget|delete|remove)\s+(that|this|the memory|memory)\b/.test(lower)) return [];

  text = text
    .replace(/^\s*(shadow|hey shadow|okay shadow|ok shadow)[,\s]+/i, '')
    .replace(/\b(?:please\s+)?(?:remember|save|store|memorize|memorise|note|keep in mind)\s+(?:that\s+)?/ig, '')
    .trim();

  const candidates = [];
  const pushCandidate = (candidate) => {
    if (!candidate || !candidate.id || !candidate.description) return;
    const candidateValue = candidate.value || candidate.label || candidate.description;
    if (!hasDurableMemoryValue(candidateValue)) return;
    if (isAssistantReferentialMemoryValue(candidateValue)) return;
    // The raw extracted phrase (candidate.value) is the cleanest signal of disfluency;
    // fall back to the broader text only if no value was captured.
    if (isDisfluentOrLowQualityMemoryValue(candidate.value || candidateValue)) return;
    if (candidates.some(c => c.id === candidate.id)) return;
    candidates.push(candidate);
  };

  const userLabel = typeof getUserLabel === 'function' ? getUserLabel() : (typeof getUserName === 'function' && getUserName() ? getUserName() : 'the user');

  const experienceMatch = text.match(/\b(?:i\s+(?:have|have got|'ve got|got)|i've|i\s+bring)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(.+?)(?:\s+exp(?:erience|ereience|erience)?\b|\s+background\b|[.!?,;]|$)/i);
  if (experienceMatch) {
    const years = wordNumberToDigits(experienceMatch[1]);
    const domain = cleanMemoryValue(experienceMatch[2]);
    if (domain && domain.split(/\s+/).length <= 8) {
      const segment = toMemoryIdSegment(domain);
      const label = `${toTitleCase(domain)} Experience`;
      pushCandidate({
        id: `user_${segment}_experience`,
        label,
        type: 'fact',
        value: domain,
        description: `${userLabel} has ${years} years of ${domain} experience.`,
        relationshipType: 'HAS_EXPERIENCE'
      });
    }
  }

  const skilledMatch = text.match(/\b(?:i\s+(?:am|'m)\s+(?:skilled|experienced|an expert)\s+in|my\s+expertise\s+is\s+in)\s+([^.!?,;]+)/i);
  if (skilledMatch) {
    const skill = cleanMemoryValue(skilledMatch[1]);
    if (skill && skill.split(/\s+/).length <= 8) {
      const segment = toMemoryIdSegment(skill);
      pushCandidate({
        id: `user_${segment}_expertise`,
        label: `${toTitleCase(skill)} Expertise`,
        type: 'fact',
        value: skill,
        description: `${userLabel} has expertise in ${skill}.`,
        relationshipType: 'HAS_EXPERTISE'
      });
    }
  }

  const locationMatch = text.match(/\b(?:i\s+live\s+in|i\s+reside\s+in|i\s+moved\s+to|i\s+am\s+from|i'm\s+from)\s+([^.!?,;]+)/i);
  if (locationMatch) {
    const location = cleanMemoryValue(locationMatch[1]);
    if (location && location.split(/\s+/).length <= 8) {
      pushCandidate({
        id: `user_location_${toMemoryIdSegment(location)}`,
        label: toTitleCase(location),
        type: 'fact',
        value: location,
        description: `${userLabel} lives in ${location}.`,
        relationshipType: 'LIVES_IN'
      });
    }
  }

  const occupationMatch = text.match(/\b(?:i\s+work\s+as|i\s+work\s+in|my\s+(?:job|occupation|profession|career)\s+is|i\s+am\s+employed\s+as)\s+(?:a|an)?\s*([^.!?,;]+)/i);
  if (occupationMatch) {
    const occupation = cleanMemoryValue(occupationMatch[1]);
    if (occupation && occupation.split(/\s+/).length <= 10) {
      pushCandidate({
        id: `user_occupation_${toMemoryIdSegment(occupation)}`,
        label: toTitleCase(occupation),
        type: 'fact',
        value: occupation,
        description: `${userLabel} works as/in ${occupation}.`,
        relationshipType: 'WORKS_AS'
      });
    }
  }

  const preferenceMatch = text.match(/\b(?:i\s+(?:prefer|like|love|enjoy|hate|dislike|can't stand)|my\s+favou?rite\s+(?:is|thing\s+is|color|food|movie|show|game|book|music|band|artist|sport|team|place|drink|brand)\s*(?:is)?)\s+([^.!?,;]+)/i);
  if (preferenceMatch) {
    const preference = cleanMemoryValue(preferenceMatch[1]);
    if (isDurablePreference(preference)) {
      const segment = toMemoryIdSegment(preference);
      pushCandidate({
        id: `user_prefers_${segment}`,
        label: `${toTitleCase(preference)} Preference`,
        type: 'preference',
        value: preference,
        description: `${userLabel} prefers/likes ${preference}.`,
        relationshipType: 'PREFERS'
      });
    }
  }

  const nameMatch = text.match(/\b(?:my\s+name\s+is|i\s+go\s+by|i\s+am\s+called|you\s+can\s+call\s+me)\s+([^.!?,;]{2,30})/i);
  if (nameMatch) {
    const name = cleanMemoryValue(nameMatch[1]);
    if (name && name.split(/\s+/).length <= 5) {
      const segment = toMemoryIdSegment(name);
      pushCandidate({
        id: `user_name_${segment}`,
        label: toTitleCase(name),
        type: 'fact',
        value: name,
        description: `${userLabel}'s name is ${name}.`,
        relationshipType: 'HAS_NAME'
      });
    }
  }

  // Auto-capture ONLY high-confidence, unambiguous DURABLE facts here (allergies, diet, born/raised).
  // A broad "I am/have/was X" grabber is fundamentally unsafe: a regex CANNOT tell "two cats" from "just
  // coughing" or "his cousin", so it kept freezing one-off chatter into permanent facts. Broad,
  // judgment-based capture is the MODEL's job — it calls upsert_memory_node when something is genuinely
  // worth keeping. The regex stays narrow so it can never again invent garbage like "Just Coughing".
  const generalFactMatch =
    text.match(/\bi\s+(?:am|'m)\s+(allergic\s+to\s+[^.!?,;]{2,50}|vegan|vegetarian|pescatarian|diabetic|asthmatic|colou?r[\s-]?blind|left[\s-]?handed|right[\s-]?handed)\b/i)
    || text.match(/\bi\s+(?:was\s+born|grew\s+up)\s+(in\s+[^.!?,;]{2,40})\b/i);
  if (generalFactMatch) {
    const factText = cleanMemoryValue(generalFactMatch[1]);
    if (factText && factText.split(/\s+/).length <= 10 && !isTransientOrTrivialFact(factText)) {
      const segment = toMemoryIdSegment(factText);
      const alreadyExists = candidates.some(c => c.id === `user_fact_${segment}`) || candidates.some(c => c.description && c.description.toLowerCase().includes(factText.toLowerCase()));
      if (!alreadyExists) {
        pushCandidate({
          id: `user_fact_${segment}`,
          label: toTitleCase(factText),
          type: 'fact',
          value: factText,
          description: `${userLabel} is/has/does: ${factText}.`,
          relationshipType: 'HAS_FACT'
        });
      }
    }
  }

  const projectMatch = text.match(/\b(?:i(?:'m| am)\s+(?:working\s+on|building|making|creating|developing|coding|writing|learning|studying|practicing)\s+([^.!?,;]{3,60}))/i);
  if (projectMatch) {
    const project = cleanMemoryValue(projectMatch[1]);
    if (project && project.split(/\s+/).length <= 10) {
      const segment = toMemoryIdSegment(project);
      pushCandidate({
        id: `user_project_${segment}`,
        label: `${toTitleCase(project)} Project`,
        type: 'interest',
        value: project,
        description: `${userLabel} is working on/learning: ${project}.`,
        relationshipType: 'WORKING_ON'
      });
    }
  }

  return candidates.slice(0, 5);
}

function normalizeAutoMemoryTurnKey(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500);
}

function cleanMemoryValue(value) {
  const cleaned = (value || '')
    .replace(/^\s*(?:a|an|the|that)\s+/i, '')
    .replace(/\b(?:and\s+)?(?:you\s+should\s+)?(?:remember|save|store|memorize|memorise)\s+(?:that\s+)?/ig, '')
    .replace(/\s+$/g, '')
    .trim()
    .replace(/["'`]+/g, '')
    .replace(/\s+/g, ' ');
  return expandMemoryValueForStorage(cleaned);
}

function expandMemoryValueForStorage(value) {
  return String(value || '')
    .replace(/\bi\s*\/\s*o\b/ig, 'instead of')
    .replace(/\bkm\s*\/\s*h\b/ig, 'kilometers per hour')
    .replace(/\b(?:kmh|kph)\b/ig, 'kilometers per hour')
    .replace(/\b(?:mph|mi\s*\/\s*h|m\s*\/\s*h)\b/ig, 'miles per hour')
    .replace(/\bkm\b/ig, 'kilometers')
    .replace(/\bmi\b/ig, 'miles')
    .replace(/\bkg\b/ig, 'kilograms')
    .replace(/\blbs?\b/ig, 'pounds')
    .replace(/\bcm\b/ig, 'centimeters')
    .replace(/\bmm\b/ig, 'millimeters')
    .replace(/\bml\b/ig, 'milliliters')
    .replace(/\b(?:deg\s*c|°c)\b/ig, 'degrees Celsius')
    .replace(/\b(?:deg\s*f|°f)\b/ig, 'degrees Fahrenheit')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDurablePreference(preference) {
  if (!preference) return false;
  const lower = preference.toLowerCase().trim();
  if (/^(it|this|that|those|these|him|her|them|doing that|what you said)\b/.test(lower)) return false;
  if (lower.split(/\s+/).length > 16) return false;
  if (!hasDurableMemoryValue(preference)) return false;
  return true;
}

function hasDurableMemoryValue(value) {
  return getDurableMemoryContentTokens(value).length > 0;
}

// Auto-extracted memories must describe the USER (first person: "I prefer X"),
// never the assistant or a conversational complaint aimed at it ("you have broken
// memories", "your voice is annoying"). Reject second-person / assistant-referential
// values so chatter about Shadow is never persisted as a durable user fact.
function isAssistantReferentialMemoryValue(value) {
  const text = String(value || '').toLowerCase();
  if (!text.trim()) return false;
  if (/\b(?:you|your|yours|yourself|youre)\b/.test(text)) return true;
  const assistantName = (typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow') || '';
  const assistantTokens = [assistantName.toLowerCase(), 'shadow', 'shadow ai', 'the assistant', 'the ai', 'the bot']
    .map(t => t.trim())
    .filter(Boolean);
  return assistantTokens.some(token => {
    if (!token) return false;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(text);
  });
}

// Reject raw transcription disfluency/filler as durable memory. Voice input often leads
// with "um/uh/like/well…" while the user is mid-thought (e.g. "um uh a setup file on my
// desktop") — that is a speech artifact, never a durable fact, so it must not be saved.
function isDisfluentOrLowQualityMemoryValue(value) {
  const text = String(value || '').toLowerCase().trim();
  if (!text) return true;
  const filler = '(?:u+m+|u+h+|u+hm+|e+rm+|e+r+|e+h+|h+mm+|m+hm+|like|well|so|okay|ok|yeah|yep|yup|nah|anyway|i mean|kinda|sorta)';
  // Leads with filler → raw mid-sentence speech, not a stated fact.
  if (new RegExp(`^${filler}\\b`).test(text)) return true;
  // After removing filler tokens, almost nothing of substance remains.
  const stripped = text.replace(new RegExp(`\\b${filler}\\b`, 'g'), ' ').replace(/\s+/g, ' ').trim();
  if (stripped.length < 3) return true;
  return false;
}

// A durable auto-fact asserts a STABLE attribute / possession / relationship. Reject transient actions,
// momentary states, intentions, and contentless fragments so chatter like "singing", "saying", "paint
// open", "tired", "to go", or "a question" never becomes a permanent memory — while real facts such as
// "two cats", "guitar", "a Tesla", or "allergic to peanuts" still pass. This keeps auto-memory broad but
// stops the junk entries.
function isTransientOrTrivialFact(value) {
  const v = String(value || '').toLowerCase().trim();
  if (!v) return true;
  const words = v.split(/\s+/);
  // Bare single action word / gerund: "singing", "saying", "talking", "joking", "chillin'".
  if (words.length === 1 && /(?:ing|in')$/.test(words[0])) return true;
  // Intention, not a fact: "to go", "to do that".
  if (/^to\s+\w/.test(v)) return true;
  // Momentary state — ends in a transient adjective/particle: "paint open", "tired", "right here".
  if (/(?:^|\s)(?:open|closed|running|ready|done|busy|tired|bored|hungry|sick|fine|okay|ok|here|back|on|off|up|out|away|paused|loading|loaded|stopped|playing|talking|thinking|kidding|joking|saying|singing|chilling|relaxing)$/.test(v)) return true;
  // Contentless objects / fillers: "a question", "an idea", "no clue", "this", "something".
  if (/^(?:a|an|the|some|no)\s+(?:question|idea|problem|issue|moment|sec|second|minute|min|break|look|feeling|thought|point|thing|clue|guess)\b/.test(v)) return true;
  if (/^(?:it|this|that|those|these|them|him|her|something|nothing|anything|everything|someone)\b/.test(v)) return true;
  return false;
}

function getDurableMemoryContentTokens(value) {
  const rawTokens = String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  if (rawTokens.length === 0) return [];
  const meaningfulUnitTokens = new Set(['kmh', 'kph', 'mph']);
  const memoryBoilerplateTokens = new Set([
    'dylan', 'user', 'shadow', 'nova', 'memory', 'fact', 'preference', 'prefers', 'prefer', 'preferred',
    'likes', 'like', 'loves', 'enjoys', 'dislikes', 'hates', 'has', 'have', 'does', 'uses', 'wants',
    'name', 'called', 'thing', 'info', 'information', 'related', 'about', 'when', 'giving', 'give',
    'instead', 'with', 'without', 'that', 'this', 'these', 'those', 'and', 'the', 'for', 'from', 'per'
  ]);
  const normalizedTokens = normalizeMemorySearchText(value).split(/\s+/).filter(Boolean);
  return normalizedTokens.filter(token =>
    !memoryBoilerplateTokens.has(token) &&
    (token.length > 2 || meaningfulUnitTokens.has(token))
  );
}

function isValidMemoryNodePayload(node) {
  if (!node) return false;
  return getDurableMemoryContentTokens(`${node.id || ''} ${node.label || ''} ${node.description || ''}`).length > 0;
}

function toMemoryIdSegment(value) {
  const stopWords = new Set(['a', 'an', 'the', 'my', 'some', 'very', 'really', 'of', 'in', 'with', 'for', 'and']);
  const meaningfulUnitTokens = new Set(['kmh', 'kph', 'mph']);
  const words = normalizeMemorySearchText(value)
    .split(/\s+/)
    .filter(w => w && !stopWords.has(w) && (w.length > 2 || meaningfulUnitTokens.has(w)))
    .slice(0, 6);
  return words.join('_') || 'fact';
}

function toTitleCase(value) {
  return (value || '')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function wordNumberToDigits(value) {
  const map = {
    one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
    eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20'
  };
  const normalized = String(value || '').toLowerCase();
  return map[normalized] || normalized;
}

function normalizeMemoryDuplicateText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getMemoryDuplicateSlot(node) {
  const id = normalizeMemoryDuplicateText(node && node.id);
  const label = normalizeMemoryDuplicateText(node && node.label);
  const description = normalizeMemoryDuplicateText(node && node.description);
  const text = `${id} ${label} ${description}`.trim();
  const searchableText = normalizeMemorySearchText(text);
  const idTokens = id.split(/\s+/).filter(Boolean);
  const withoutOwner = idTokens[0] === 'user' || idTokens[0] === 'dylan'
    ? idTokens.slice(1)
    : idTokens;

  if (/\b(speed|velocity)\b/.test(searchableText) && /\b(unit|units|format|preference|prefers|preferred|kmh|kph|mph)\b/.test(searchableText)) return 'preference:speed_unit';
  if (/\b(kmh|kph|mph)\b/.test(searchableText)) return 'preference:speed_unit';
  if (/\btemperature\b/.test(text) && /\b(unit|units|format|preference|prefers|preferred)\b/.test(text)) return 'preference:temperature_unit';
  if (/\b(celsius|fahrenheit|centigrade)\b/.test(text)) return 'preference:temperature_unit';
  if (/\btime\b/.test(text) && /\b(format|display|preference|prefers|preferred)\b/.test(text)) return 'preference:time_format';
  if (/\b(24\s*hour|12\s*hour|military\s*time|am\s*pm)\b/.test(text)) return 'preference:time_format';

  if (withoutOwner[0] === 'location') return 'fact:location';
  if (withoutOwner[0] === 'birthday' || withoutOwner[0] === 'birthdate') return 'fact:birthday';
  // Content-based birthday detection so "User Birthday: born in 1996" and a generic
  // "born in 1996" fact collapse to the same slot instead of becoming duplicates.
  if (/\bbirth\s?day\b/.test(text) || /\bbirth\s?date\b/.test(text)) return 'fact:birthday';
  if (/\bborn\b/.test(text) && /\b(?:19|20)\d{2}\b/.test(text)) return 'fact:birthday';
  if (withoutOwner[0] === 'age') return 'fact:age';
  if (['job', 'occupation', 'career', 'profession'].includes(withoutOwner[0])) return 'fact:job';
  if (withoutOwner[0] === 'name' || withoutOwner[0] === 'nickname') return `fact:${withoutOwner[0]}`;
  if (withoutOwner[0] === 'relationship') return 'fact:relationship_status';
  if (withoutOwner[0] === 'favorite' && withoutOwner[1]) return `preference:favorite_${withoutOwner[1]}`;
  if (withoutOwner[0] === 'preferred' && withoutOwner[1]) return `preference:preferred_${withoutOwner[1]}`;
  if (withoutOwner[0] === 'project' && withoutOwner[1]) return `interest:project_${withoutOwner[1]}`;

  const labeledFavorite = text.match(/\bfavorite\s+([a-z0-9]{3,})\b/);
  if (labeledFavorite) return `preference:favorite_${labeledFavorite[1]}`;

  return null;
}

function getMemoryDuplicateTokens(node) {
  const stopWords = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'that', 'this', 'with', 'from', 'have', 'has', 'been', 'also',
    'very', 'really', 'just', 'about', 'dylan', 'user', 'shadow', 'is', 'are', 'was', 'were', 'does',
    'prefers', 'prefer', 'preferred', 'preference', 'likes', 'like', 'favorite', 'favourite', 'loves',
    'enjoys', 'wants', 'uses', 'his', 'her', 'their', 'my', 'your'
  ]);
  const text = normalizeMemoryDuplicateText(`${node && node.id || ''} ${node && node.label || ''} ${node && node.description || ''}`);
  return [...new Set(text.split(/\s+/).filter(word => word.length > 2 && !stopWords.has(word)))];
}

function isMemoryDuplicateCandidate(existingNode, newNode) {
  if (!existingNode || !newNode) return false;
  const existingSlot = getMemoryDuplicateSlot(existingNode);
  const newSlot = getMemoryDuplicateSlot(newNode);
  if (existingSlot || newSlot) return existingSlot === newSlot;
  if ((existingNode.type || 'fact') !== (newNode.type || 'fact')) return false;

  const existingTokens = new Set(getMemoryDuplicateTokens(existingNode));
  const newTokens = getMemoryDuplicateTokens(newNode);
  if (existingTokens.size === 0 || newTokens.length < 3) return false;
  let overlap = 0;
  for (const token of newTokens) {
    if (existingTokens.has(token)) overlap++;
  }
  const unionSize = new Set([...existingTokens, ...newTokens]).size;
  return overlap >= 3 && overlap / unionSize >= 0.75;
}

// --- Memory operation mutex to prevent race conditions ---
let memoryMutex = Promise.resolve();
function withMemoryLock(fn) {
  memoryMutex = memoryMutex.then(fn, fn);
  return memoryMutex;
}

async function apiUpsertMemoryNode(id, label, type, description) {
  return withMemoryLock(async () => {
    try {
      const nodeObj = {
        id: String(id || '').trim(),
        label: expandMemoryValueForStorage(label),
        type,
        description: expandMemoryValueForStorage(description)
      };
      if (!nodeObj.id || !nodeObj.label || !nodeObj.description) {
        return { status: 'ignored', message: 'Memory node was not saved because it was missing an id, label, or description.' };
      }
      if (!isValidMemoryNodePayload(nodeObj)) {
        return { status: 'ignored', message: 'Memory node was not saved because it only contained tiny shorthand or boilerplate, not a durable fact or preference.' };
      }

      const res = await fetchWithTimeout('/api/memories', { cache: 'no-store' }, 15000);
      const graph = await readMemoryResponseJsonWithTimeout(res, 15000);

      const protectedIds = ['user', 'shadow'];

      // First, check by exact ID match
      const existingNodeIndex = graph.nodes.findIndex(n => n.id === nodeObj.id);

      if (existingNodeIndex >= 0) {
        // Exact ID match — update in place
        console.log(`[Memory] Updating existing node by ID: ${nodeObj.id}`);
        graph.nodes[existingNodeIndex] = nodeObj;
      } else {
        // --- Deduplication Layer 1: Exact label match (case-insensitive) ---
        const labelLower = nodeObj.label.toLowerCase().trim();
        let duplicateIndex = graph.nodes.findIndex(n =>
          !protectedIds.includes(n.id) &&
          n.label.toLowerCase().trim() === labelLower
        );

        // --- Deduplication Layer 2: Specific memory slot match ---
        if (duplicateIndex < 0) {
          const newSlot = getMemoryDuplicateSlot(nodeObj);
          if (newSlot) {
            duplicateIndex = graph.nodes.findIndex(n =>
              !protectedIds.includes(n.id) &&
              getMemoryDuplicateSlot(n) === newSlot
            );
          }
        }

        // --- Deduplication Layer 3: Strict token overlap fallback ---
        if (duplicateIndex < 0 && nodeObj.description) {
          duplicateIndex = graph.nodes.findIndex(n =>
            !protectedIds.includes(n.id) &&
            isMemoryDuplicateCandidate(n, nodeObj)
          );
        }

        if (duplicateIndex >= 0) {
          const oldId = graph.nodes[duplicateIndex].id;
          console.log(`[Memory] Replacing duplicate node "${oldId}" with "${nodeObj.id}"`);
          graph.links = graph.links.map(l => ({
            ...l,
            source: l.source === oldId ? nodeObj.id : l.source,
            target: l.target === oldId ? nodeObj.id : l.target
          }));
          graph.nodes[duplicateIndex] = nodeObj;
        } else {
          console.log(`[Memory] Adding new node: ${nodeObj.id} ("${nodeObj.label}")`);
          graph.nodes.push(nodeObj);
        }
      }

      const saveRes = await fetchWithTimeout('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(graph)
      }, 15000);
      console.log(`[Memory] Save response status: ${saveRes.status}`);

      if (isGraphOpen && updateGraphVisualization) {
        updateGraphVisualization();
      }
      return { status: 'success', message: `Memory node '${nodeObj.label}' saved.` };
    } catch (e) {
      console.error('[Memory] Failed to upsert memory node:', e);
      return { status: 'error', message: e.message };
    }
  });
}

async function apiLinkMemoryNodes(sourceId, targetId, relationshipType) {
  return withMemoryLock(async () => {
    try {
      const res = await fetchWithTimeout('/api/memories', { cache: 'no-store' }, 15000);
      const graph = await readMemoryResponseJsonWithTimeout(res, 15000);

      const linkExists = graph.links.some(l => l.source === sourceId && l.target === targetId && l.type === relationshipType);
      if (!linkExists) {
        console.log(`[Memory] Adding link: ${sourceId} --${relationshipType}--> ${targetId}`);
        graph.links.push({ source: sourceId, target: targetId, type: relationshipType });
      }

      await fetchWithTimeout('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(graph)
      }, 15000);

      if (isGraphOpen && updateGraphVisualization) {
        updateGraphVisualization();
      }
      return { status: 'success', message: `Linked node '${sourceId}' to '${targetId}' with relationship '${relationshipType}'.` };
    } catch (e) {
      console.error('[Memory] Failed to link memory nodes:', e);
      return { status: 'error', message: e.message };
    }
  });
}

async function apiDeleteMemoryNode(id) {
  return withMemoryLock(async () => {
    try {
      const res = await fetchWithTimeout('/api/memories', { cache: 'no-store' }, 15000);
      const graph = await readMemoryResponseJsonWithTimeout(res, 15000);

      const idLower = id.toLowerCase().trim();

      const protectedIds = ['user', 'shadow'];
      const candidateNodes = graph.nodes.filter(n => !protectedIds.includes(n.id));

      // 1) Substring match across id, label, AND description (the user often refers to a
      //    memory by words from its description, e.g. "the setup file one").
      let matchingIds = candidateNodes
        .filter(n =>
          n.id === id ||
          n.id.toLowerCase() === idLower ||
          (n.label && n.label.toLowerCase().includes(idLower)) ||
          n.id.toLowerCase().includes(idLower) ||
          (n.description && n.description.toLowerCase().includes(idLower))
        )
        .map(n => n.id);

      // 2) Fuzzy fallback: if nothing matched literally, score nodes by the query's
      //    meaningful tokens and delete the single clear best match. Stay conservative —
      //    if the top two are close, ask the model to be more specific instead of guessing.
      if (matchingIds.length === 0 && typeof memoryRecallTokens === 'function' && typeof scoreMemoryForQuery === 'function') {
        const tokens = memoryRecallTokens(id);
        if (tokens && tokens.length) {
          const scored = candidateNodes
            .map(n => ({ id: n.id, label: n.label, score: scoreMemoryForQuery(n, tokens) }))
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score);
          if (scored.length === 1 || (scored.length > 1 && scored[0].score >= scored[1].score * 2)) {
            matchingIds = [scored[0].id];
          } else if (scored.length > 1) {
            return { status: 'ambiguous', message: `Several memories could match '${id}'. Be more specific — e.g. one of: ${scored.slice(0, 4).map(s => `"${s.label}"`).join(', ')}.` };
          }
        }
      }

      if (matchingIds.length === 0) {
        console.log(`[Memory] Delete: no match found for "${id}"`);
        return { status: 'not_found', message: `No memory node found matching '${id}'. Call recall_memory with the description to find the exact node, then delete it by its id.` };
      }

      const deletedLabels = graph.nodes
        .filter(n => matchingIds.includes(n.id))
        .map(n => n.label);

      console.log(`[Memory] Deleting ${matchingIds.length} node(s): ${deletedLabels.join(', ')}`);

      graph.nodes = graph.nodes.filter(n => !matchingIds.includes(n.id));
      graph.links = graph.links.filter(l => !matchingIds.includes(l.source) && !matchingIds.includes(l.target));

      await fetchWithTimeout('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(graph)
      }, 15000);

      if (isGraphOpen && updateGraphVisualization) {
        updateGraphVisualization();
      }
      return { status: 'success', message: `Deleted ${matchingIds.length} memory node(s): ${deletedLabels.join(', ')}.` };
    } catch (e) {
      console.error('[Memory] Failed to delete memory node:', e);
      return { status: 'error', message: e.message };
    }
  });
}

// Keep the seeded identity nodes ('user' and 'shadow') in sync with the current names.
// Renaming yourself or the assistant updates the setting, but the existing graph node keeps
// its old label (e.g. "You") until this rewrites it.
async function apiSyncIdentityNodes() {
  return withMemoryLock(async () => {
    try {
      const res = await fetchWithTimeout('/api/memories', { cache: 'no-store' }, 15000);
      const graph = await readMemoryResponseJsonWithTimeout(res, 15000);
      if (!graph || !Array.isArray(graph.nodes)) return { status: 'error', message: 'No memory graph.' };
      const userName = typeof getUserName === 'function' ? getUserName() : '';
      const assistantName = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
      let changed = false;
      for (const n of graph.nodes) {
        if (n.id === 'user') {
          const label = userName || 'You';
          const description = userName ? `The user, ${userName} (you)` : 'The user (you)';
          if (n.label !== label || n.description !== description) { n.label = label; n.description = description; changed = true; }
        } else if (n.id === 'shadow') {
          const description = `${assistantName}, your AI companion`;
          if (n.label !== assistantName || n.description !== description) { n.label = assistantName; n.description = description; changed = true; }
        }
      }
      if (changed) {
        await fetchWithTimeout('/api/memories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(graph)
        }, 15000);
        if (isGraphOpen && updateGraphVisualization) updateGraphVisualization();
      }
      return { status: 'success', changed };
    } catch (e) {
      console.error('[Memory] Failed to sync identity nodes:', e);
      return { status: 'error', message: e.message };
    }
  });
}

// Force-directed graph physics simulation class
class LegacyMemoryGraphSimulation {
  constructor(canvasElement, tooltipElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.tooltip = tooltipElement;

    this.nodes = [];
    this.links = [];
    this.hoveredNode = null;
    this.animationFrameId = null;
    this.loadingGraph = false;
    this.pendingReload = false;

    this.transform = { x: 0, y: 0, k: 1 };
    this.isDraggingGraph = false;
    this.lastMousePos = null;

    this.k = 260; // Repulsion constant
    this.stiffness = 0.035; // Spring stiffness
    this.restLength = 190; // Spring rest length
    this.damping = 0.78; // Velocity damping friction
    this.nodePadding = 18;

    this.initEvents();
  }

  async loadGraph() {
    if (this.loadingGraph) {
      this.pendingReload = true;
      return;
    }
    this.loadingGraph = true;
    try {
      const res = await fetchWithTimeout('/api/memories', { cache: 'no-store' }, 15000);
      const rawData = await readMemoryResponseJsonWithTimeout(res, 15000);
      const data = normalizeAssistantMemoryGraph(rawData);

      if (!data || !data.nodes || !Array.isArray(data.nodes)) {
        console.warn('[Memory] Invalid graph data received, skipping render');
        return;
      }

      const colors = {
        person: '#00f0ff',
        ai: '#ff00a0',
        preference: '#ffaa00',
        fact: '#39ff14',
        interest: '#bd00ff',
        action: '#ff0055'
      };

      this.resize();
      const width = this.canvas.width || 800;
      const height = this.canvas.height || 500;

      if (width === 0 || height === 0) {
        console.warn('[Memory] Canvas dimensions are 0, deferring render');
        setTimeout(() => {
          this.resize();
          this.loadGraph();
        }, 300);
        return;
      }

      this.nodes = (data.nodes || []).map((node, index) => {
        return {
          id: node.id,
          label: node.label,
          type: node.type,
          description: node.description,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          radius: 40,
          color: colors[node.type] || '#ff0055'
        };
      });

      this.links = (data.links || []).map(link => {
        return {
          source: this.nodes.find(n => n.id === (link.source.id || link.source)),
          target: this.nodes.find(n => n.id === (link.target.id || link.target)),
          type: link.type
        };
      }).filter(l => l.source && l.target);

      this.applyStaticLayout(width, height);
      this.fitToView(width, height);
      this.draw();

    } catch (e) {
      console.error('Failed to load memory graph in simulation:', e);
    } finally {
      this.loadingGraph = false;
      if (this.pendingReload) {
        this.pendingReload = false;
        setTimeout(() => this.loadGraph(), 100);
      }
    }
  }

  start() {
    this.stop();
    this.resize();
    this.loadGraph().then(() => {
      const loop = () => {
        if (this.nodes.length === 0) {
          this.animationFrameId = requestAnimationFrame(loop);
          return;
        }
        this.updatePhysics();
        this.draw();
        this.animationFrameId = requestAnimationFrame(loop);
      };
      this.animationFrameId = requestAnimationFrame(loop);
    }).catch(e => {
      console.error('[Memory] start() loadGraph failed:', e);
    });
  }

  stop() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.hoveredNode = null;
  }

  resize() {
    const container = this.canvas.parentElement;
    this.canvas.width = Math.max(container.clientWidth || 800, 400);
    this.canvas.height = Math.max(container.clientHeight || 500, 300);
  }

  applyStaticLayout(width, height) {
    const centerX = width / 2;
    const centerY = height / 2;
    const minDist = this.nodes.reduce((max, n) => Math.max(max, n.radius * 2 + this.nodePadding + 30), 0) || 120;
    const roots = this.nodes.filter(n => n.id === 'user' || n.id === 'shadow');
    const others = this.nodes.filter(n => !roots.includes(n));

    roots.forEach((node, index) => {
      const offset = (index - (roots.length - 1) / 2) * minDist;
      node.x = centerX + offset;
      node.y = centerY;
      node.vx = 0;
      node.vy = 0;
    });

    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    others.forEach((node, index) => {
      const i = index + 1;
      const radius = minDist * (0.9 + Math.sqrt(i) * 0.82);
      const angle = i * goldenAngle - Math.PI / 2;
      node.x = centerX + Math.cos(angle) * radius;
      node.y = centerY + Math.sin(angle) * radius;
      node.vx = 0;
      node.vy = 0;
    });

    for (let i = 0; i < 120; i++) {
      this.resolveCollisions(width, height, false);
    }
  }

  fitToView(width, height) {
    if (this.nodes.length === 0) {
      this.transform = { x: 0, y: 0, k: 1 };
      return;
    }

    const padding = 90;
    const bounds = this.nodes.reduce((acc, n) => {
      acc.minX = Math.min(acc.minX, n.x - n.radius);
      acc.maxX = Math.max(acc.maxX, n.x + n.radius);
      acc.minY = Math.min(acc.minY, n.y - n.radius);
      acc.maxY = Math.max(acc.maxY, n.y + n.radius);
      return acc;
    }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

    const graphWidth = Math.max(1, bounds.maxX - bounds.minX + padding * 2);
    const graphHeight = Math.max(1, bounds.maxY - bounds.minY + padding * 2);
    const scale = Math.min(1, width / graphWidth, height / graphHeight);
    const graphCenterX = (bounds.minX + bounds.maxX) / 2;
    const graphCenterY = (bounds.minY + bounds.maxY) / 2;

    this.transform = {
      x: width / 2 - graphCenterX * scale,
      y: height / 2 - graphCenterY * scale,
      k: scale
    };
  }

  updatePhysics() {
    const width = this.canvas.width;
    const height = this.canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;

    // Repulsion between all nodes
    for (let i = 0; i < this.nodes.length; i++) {
      const n1 = this.nodes[i];
      for (let j = i + 1; j < this.nodes.length; j++) {
        const n2 = this.nodes[j];
        let dx = n2.x - n1.x;
        let dy = n2.y - n1.y;

        // Fix for overlapping nodes: if exactly on top of each other, add a tiny jitter to trigger repulsion
        if (dx === 0 && dy === 0) {
          dx = (Math.random() - 0.5) * 0.1;
          dy = (Math.random() - 0.5) * 0.1;
        }

        const distSq = dx * dx + dy * dy + 100; // softened distance to prevent extreme repulsion
        const dist = Math.sqrt(distSq);

        const force = (this.k * this.k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        n1.vx -= fx;
        n1.vy -= fy;
        n2.vx += fx;
        n2.vy += fy;
      }
    }

    // Attraction along links
    this.links.forEach(l => {
      const dx = l.target.x - l.source.x;
      const dy = l.target.y - l.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = this.stiffness * (dist - this.restLength);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      l.source.vx += fx;
      l.source.vy += fy;
      l.target.vx -= fx;
      l.target.vy -= fy;
    });

    // Gravity & friction update
    this.nodes.forEach(n => {
      const dx = centerX - n.x;
      const dy = centerY - n.y;
      n.vx += dx * 0.002;
      n.vy += dy * 0.002;

      n.vx = Math.max(-12, Math.min(12, n.vx));
      n.vy = Math.max(-12, Math.min(12, n.vy));

      n.x += n.vx;
      n.y += n.vy;

      n.vx *= this.damping;
      n.vy *= this.damping;

      n.x = Math.max(n.radius, Math.min(width - n.radius, n.x));
      n.y = Math.max(n.radius, Math.min(height - n.radius, n.y));
    });

    for (let i = 0; i < 3; i++) {
      this.resolveCollisions(width, height, true);
    }
  }

  resolveCollisions(width, height, constrainToCanvas = true) {
    for (let i = 0; i < this.nodes.length; i++) {
      const n1 = this.nodes[i];
      for (let j = i + 1; j < this.nodes.length; j++) {
        const n2 = this.nodes[j];
        let dx = n2.x - n1.x;
        let dy = n2.y - n1.y;
        let dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 0.01) {
          const angle = (i + 1) * 2.399963229728653;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          dist = 1;
        }

        const minDist = n1.radius + n2.radius + this.nodePadding;
        if (dist < minDist) {
          const overlap = (minDist - dist) / 2;
          const ux = dx / dist;
          const uy = dy / dist;
          n1.x -= ux * overlap;
          n1.y -= uy * overlap;
          n2.x += ux * overlap;
          n2.y += uy * overlap;
          n1.vx *= 0.45;
          n1.vy *= 0.45;
          n2.vx *= 0.45;
          n2.vy *= 0.45;
        }
      }
    }

    if (constrainToCanvas) {
      this.nodes.forEach(n => {
        n.x = Math.max(n.radius, Math.min(width - n.radius, n.x));
        n.y = Math.max(n.radius, Math.min(height - n.radius, n.y));
      });
    }
  }

  draw() {
    if (!this.ctx || this.nodes.length === 0) return;
    if (!this.canvas.width || !this.canvas.height) this.resize();
    if (!this.canvas.width || !this.canvas.height) return;

    let outerSave = false;
    try {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.ctx.save();
    outerSave = true;
    this.ctx.translate(this.transform.x, this.transform.y);
    this.ctx.scale(this.transform.k, this.transform.k);

    // Draw links
    this.links.forEach(l => {
      this.ctx.beginPath();
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      this.ctx.lineWidth = 2;
      this.ctx.moveTo(l.source.x, l.source.y);
      this.ctx.lineTo(l.target.x, l.target.y);
      this.ctx.stroke();

      // Draw relationship label at midpoint
      const midX = (l.source.x + l.target.x) / 2;
      const midY = (l.source.y + l.target.y) / 2;

      this.ctx.save();
      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      this.ctx.font = '500 10px Outfit, sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';

      const textWidth = this.ctx.measureText(l.type).width;
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(midX - textWidth/2 - 4, midY - 7, textWidth + 8, 14);

      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      this.ctx.fillText(l.type, midX, midY);
      this.ctx.restore();
    });

    // Draw nodes
    this.nodes.forEach(n => {
      this.ctx.save();

      // Outer glow
      const glow = this.ctx.createRadialGradient(n.x, n.y, n.radius * 0.4, n.x, n.y, n.radius * 1.5);
      glow.addColorStop(0, n.color + '44');
      glow.addColorStop(1, 'transparent');
      this.ctx.fillStyle = glow;
      this.ctx.beginPath();
      this.ctx.arc(n.x, n.y, n.radius * 1.5, 0, Math.PI * 2);
      this.ctx.fill();

      // Inner node circle
      this.ctx.fillStyle = 'rgba(18, 11, 10, 0.85)';
      this.ctx.strokeStyle = n.color;
      this.ctx.lineWidth = n === this.hoveredNode ? 3 : 1.5;

      this.ctx.beginPath();
      this.ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();

      // Label text
      this.ctx.fillStyle = '#000000';
      this.ctx.font = '500 12px Outfit, sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';

      const lines = this.getNodeLabelLines(n.label, n.radius * 1.65);
      if (lines.length > 1) {
        this.ctx.fillText(lines[0], n.x, n.y - 7);
        this.ctx.fillText(lines[1], n.x, n.y + 8);
      } else {
        this.ctx.fillText(lines[0], n.x, n.y);
      }

      this.ctx.restore();
    });

    this.ctx.restore();
    outerSave = false;
    } catch (e) {
      if (outerSave) {
        try { this.ctx.restore(); } catch (restoreErr) {}
      }
      console.warn('[Memory] Draw skipped after canvas error:', e.message);
    }
  }

  getNodeLabelLines(label, maxWidth) {
    const words = String(label || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';

    words.forEach(word => {
      const next = current ? `${current} ${word}` : word;
      if (this.ctx.measureText(next).width <= maxWidth || !current) {
        current = next;
      } else if (lines.length < 1) {
        lines.push(current);
        current = word;
      }
    });

    if (current) lines.push(current);
    if (lines.length === 0) lines.push('Memory');

    const compact = lines.slice(0, 2);
    if (lines.length > 2) compact[1] = `${compact[1]} ...`;
    return compact.map(line => this.truncateCanvasText(line, maxWidth));
  }

  truncateCanvasText(text, maxWidth) {
    let value = String(text || '');
    if (this.ctx.measureText(value).width <= maxWidth) return value;
    while (value.length > 3 && this.ctx.measureText(`${value.slice(0, -1)}...`).width > maxWidth) {
      value = value.slice(0, -1);
    }
    return `${value.trim()}...`;
  }

  initEvents() {
    const getScreenPos = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    };

    const getWorldPos = (e) => {
      const screen = getScreenPos(e);
      return {
        x: (screen.x - this.transform.x) / this.transform.k,
        y: (screen.y - this.transform.y) / this.transform.k
      };
    };

    this.canvas.addEventListener('mousedown', (e) => {
      const pos = getWorldPos(e);
      const clicked = this.nodes.find(n => {
        const dx = n.x - pos.x;
        const dy = n.y - pos.y;
        return Math.sqrt(dx * dx + dy * dy) < n.radius;
      });

      if (!clicked) {
        this.isDraggingGraph = true;
        this.lastMousePos = getScreenPos(e);
        this.canvas.style.cursor = 'grabbing';
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      const screenPos = getScreenPos(e);
      const worldPos = getWorldPos(e);

      if (this.isDraggingGraph) {
        const dx = screenPos.x - this.lastMousePos.x;
        const dy = screenPos.y - this.lastMousePos.y;
        this.transform.x += dx;
        this.transform.y += dy;
        this.lastMousePos = screenPos;
      } else {
        const hover = this.nodes.find(n => {
          const dx = n.x - worldPos.x;
          const dy = n.y - worldPos.y;
          return Math.sqrt(dx * dx + dy * dy) < n.radius;
        });

        if (hover !== this.hoveredNode) {
          this.hoveredNode = hover;
          if (hover) {
            this.canvas.style.cursor = 'pointer';
            this.showTooltip(hover, e.clientX, e.clientY);
          } else {
            this.canvas.style.cursor = 'default';
            this.hideTooltip();
          }
        } else if (hover) {
          this.showTooltip(hover, e.clientX, e.clientY);
        }
      }
    });

    const release = () => {
      if (this.isDraggingGraph) {
        this.isDraggingGraph = false;
      }
      this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'default';
    };

    this.canvas.addEventListener('mouseup', release);
    this.canvas.addEventListener('mouseleave', () => {
      release();
      this.hideTooltip();
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();

      const zoomSensitivity = 0.001;
      const delta = -e.deltaY * zoomSensitivity;
      const oldK = this.transform.k;
      const newK = Math.max(0.1, Math.min(5.0, oldK * (1 + delta)));

      // Calculate how much we scaled
      const scaleRatio = newK / oldK;

      // Get pointer position on screen
      const screenPos = getScreenPos(e);

      // Adjust transform.x and transform.y to keep pointer in place
      this.transform.x = screenPos.x - (screenPos.x - this.transform.x) * scaleRatio;
      this.transform.y = screenPos.y - (screenPos.y - this.transform.y) * scaleRatio;
      this.transform.k = newK;
    }, { passive: false });

    this.canvas.addEventListener('dblclick', async (e) => {
      const pos = getWorldPos(e);
      const clicked = this.nodes.find(n => {
        const dx = n.x - pos.x;
        const dy = n.y - pos.y;
        return Math.sqrt(dx * dx + dy * dy) < n.radius;
      });

      if (clicked) {
        if (clicked.id === 'user' || clicked.id === 'shadow') {
          alert(`You cannot delete the root core nodes 'User' or '${getAssistantName()}'!`);
          return;
        }
        if (confirm(`Do you want to delete the memory '${clicked.label}'?`)) {
          this.hideTooltip();
          await apiDeleteMemoryNode(clicked.id);
          this.loadGraph();
        }
      }
    });
  }

  showTooltip(node, clientX, clientY) {
    this.tooltip.classList.remove('hidden');
    const rect = this.canvas.getBoundingClientRect();
    this.tooltip.style.left = `${clientX - rect.left + 15}px`;
    this.tooltip.style.top = `${clientY - rect.top + 15}px`;
    this.tooltip.innerHTML = `
      <div style="font-weight: 600; color: ${node.color}; text-transform: uppercase; font-size: 0.7rem; margin-bottom: 2px;">${node.type}</div>
      <div style="font-weight: 500; font-size: 0.9rem; margin-bottom: 4px;">${node.label}</div>
      <div style="color: rgba(255,255,255,0.7); font-size: 0.75rem;">${node.description}</div>
    `;
  }

  hideTooltip() {
    this.tooltip.classList.add('hidden');
  }
}

// Stable SVG memory graph. This replaces the canvas force simulation above so
// the memory modal always opens into a deterministic, readable layout.
    class MemoryGraphSimulation {
  constructor(rootElement, tooltipElement) {
    this.root = rootElement;
    this.tooltip = tooltipElement;
    this.nodes = [];
    this.links = [];
    this.loadingGraph = false;
    this.pendingReload = false;
    this.transform = { x: 0, y: 0, k: 1 };
    this.isDraggingGraph = false;
    this.lastMousePos = null;
    this.nodeWidth = 190;
    this.nodeHeight = 94;
    this.nodeGap = 46;
    this.colors = {
      person: '#00f0ff',
      ai: '#ff00a0',
      preference: '#ffaa00',
      fact: '#39ff14',
      interest: '#bd00ff',
      action: '#ff4d6d'
    };

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('role', 'img');
    this.svg.setAttribute('aria-label', `${typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow'} memory network`);

    this.viewport = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.linkLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.nodeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.viewport.appendChild(this.linkLayer);
    this.viewport.appendChild(this.nodeLayer);
    this.svg.appendChild(this.viewport);

    this.emptyState = document.createElement('div');
    this.emptyState.className = 'memory-empty-state hidden';
    this.emptyState.innerHTML = `<div><strong>No memories yet</strong>${typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow'} will add durable facts here as it learns them.</div>`;

    this.root.replaceChildren(this.svg, this.emptyState);
    syncMemoryGraphAssistantLabels();
    this.initEvents();

    if (window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
        this.fitToView();
        this.renderGraph();
      });
      this.resizeObserver.observe(this.root);
    }
  }

  async loadGraph() {
    if (this.loadingGraph) {
      this.pendingReload = true;
      return;
    }
    this.loadingGraph = true;
    try {
      const res = await fetchWithTimeout('/api/memories', { cache: 'no-store' }, 15000);
      const rawData = await readMemoryResponseJsonWithTimeout(res, 15000);
      const data = normalizeAssistantMemoryGraph(rawData);
      syncMemoryGraphAssistantLabels();
      if (!data || !Array.isArray(data.nodes)) {
        console.warn('[Memory] Invalid graph data received, skipping render');
        return;
      }

      this.nodes = data.nodes.map((node, index) => ({
        id: String(node.id || `memory_${index}`),
        label: String(node.label || node.id || 'Memory'),
        type: String(node.type || 'fact'),
        description: String(node.description || ''),
        x: 0,
        y: 0,
        width: this.nodeWidth,
        height: this.nodeHeight,
        color: this.colors[node.type] || '#ff4d6d'
      }));

      const nodeById = new Map(this.nodes.map(node => [node.id, node]));
      this.links = (data.links || []).map(link => {
        const sourceId = String(link.source && link.source.id ? link.source.id : link.source);
        const targetId = String(link.target && link.target.id ? link.target.id : link.target);
        return {
          source: nodeById.get(sourceId),
          target: nodeById.get(targetId),
          type: String(link.type || 'RELATED_TO')
        };
      }).filter(link => link.source && link.target);

      this.applyStaticLayout();
      this.fitToView();
      this.renderGraph();
    } catch (e) {
      console.error('Failed to load memory graph:', e);
    } finally {
      this.loadingGraph = false;
      if (this.pendingReload) {
        this.pendingReload = false;
        setTimeout(() => this.loadGraph(), 100);
      }
    }
  }

  start() {
    this.loadGraph().catch(e => console.error('[Memory] start() loadGraph failed:', e));
  }

  stop() {
    this.isDraggingGraph = false;
    this.root.classList.remove('is-panning');
    this.hideTooltip();
  }

  applyStaticLayout() {
    const roots = this.nodes.filter(node => node.id === 'user' || node.id === 'shadow');
    const others = this.nodes.filter(node => node.id !== 'user' && node.id !== 'shadow');

    if (roots.length === 1) {
      roots[0].x = 0;
      roots[0].y = 0;
    } else {
      roots.forEach(node => {
        node.x = node.id === 'user' ? -145 : 145;
        node.y = 0;
      });
    }

    const sorted = [...others].sort((a, b) => {
      const typeCompare = a.type.localeCompare(b.type);
      return typeCompare || a.label.localeCompare(b.label);
    });

    let placed = 0;
    let ring = 0;
    const minArc = this.nodeWidth + this.nodeGap + 60;
    while (placed < sorted.length) {
      const radius = 390 + ring * 300;
      const capacity = Math.max(6, Math.floor((Math.PI * 2 * radius) / minArc));
      const count = Math.min(capacity, sorted.length - placed);
      const angleOffset = ring % 2 === 0 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / Math.max(count, 1);

      for (let i = 0; i < count; i++) {
        const node = sorted[placed + i];
        const angle = angleOffset + (i / count) * Math.PI * 2;
        node.x = Math.cos(angle) * radius;
        node.y = Math.sin(angle) * radius;
      }
      placed += count;
      ring++;
    }

    this.resolveOverlaps();
  }

  resolveOverlaps() {
    for (let pass = 0; pass < 140; pass++) {
      for (let i = 0; i < this.nodes.length; i++) {
        for (let j = i + 1; j < this.nodes.length; j++) {
          const a = this.nodes[i];
          const b = this.nodes[j];
          const dx = b.x - a.x || 0.001;
          const dy = b.y - a.y || 0.001;
          const overlapX = (a.width / 2 + b.width / 2 + this.nodeGap) - Math.abs(dx);
          const overlapY = (a.height / 2 + b.height / 2 + this.nodeGap) - Math.abs(dy);
          if (overlapX <= 0 || overlapY <= 0) continue;

          if (overlapX < overlapY) {
            const push = overlapX / 2;
            const sign = dx > 0 ? 1 : -1;
            a.x -= sign * push;
            b.x += sign * push;
          } else {
            const push = overlapY / 2;
            const sign = dy > 0 ? 1 : -1;
            a.y -= sign * push;
            b.y += sign * push;
          }
        }
      }
    }
  }

  fitToView() {
    if (this.nodes.length === 0) {
      this.transform = { x: 0, y: 0, k: 1 };
      this.applyTransform();
      return;
    }

    const rect = this.root.getBoundingClientRect();
    const width = Math.max(rect.width || 900, 320);
    const height = Math.max(rect.height || 520, 260);
    const padding = 260;
    const bounds = this.nodes.reduce((acc, node) => {
      acc.minX = Math.min(acc.minX, node.x - node.width / 2);
      acc.maxX = Math.max(acc.maxX, node.x + node.width / 2);
      acc.minY = Math.min(acc.minY, node.y - node.height / 2);
      acc.maxY = Math.max(acc.maxY, node.y + node.height / 2);
      return acc;
    }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

    const graphWidth = Math.max(1, bounds.maxX - bounds.minX + padding * 2);
    const graphHeight = Math.max(1, bounds.maxY - bounds.minY + padding * 2);
    const scale = Math.min(0.95, width / graphWidth, height / graphHeight);
    const graphCenterX = (bounds.minX + bounds.maxX) / 2;
    const graphCenterY = (bounds.minY + bounds.maxY) / 2;

    this.transform = {
      x: width / 2 - graphCenterX * scale,
      y: height / 2 - graphCenterY * scale,
      k: scale
    };
    this.applyTransform();
  }

  renderGraph() {
    this.linkLayer.replaceChildren();
    this.nodeLayer.replaceChildren();
    this.emptyState.classList.toggle('hidden', this.nodes.length > 0);
    if (this.nodes.length === 0) return;

    const showLinkLabels = false;
    this.links.forEach(link => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'memory-link');
      path.setAttribute('d', this.getLinkPath(link.source, link.target));
      this.linkLayer.appendChild(path);

      if (!showLinkLabels) return;
      const mid = this.getLinkMidpoint(link.source, link.target);
      const label = this.truncateText(link.type.replace(/_/g, ' '), 20).toUpperCase();
      const width = Math.max(38, label.length * 5.8 + 12);
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('class', 'memory-link-label-bg');
      bg.setAttribute('x', String(mid.x - width / 2));
      bg.setAttribute('y', String(mid.y - 9));
      bg.setAttribute('width', String(width));
      bg.setAttribute('height', '18');
      bg.setAttribute('rx', '8');
      this.linkLayer.appendChild(bg);

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('class', 'memory-link-label');
      text.setAttribute('x', String(mid.x));
      text.setAttribute('y', String(mid.y));
      text.textContent = label;
      this.linkLayer.appendChild(text);
    });

    this.nodes.forEach(node => {
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('class', 'memory-node');
      group.setAttribute('transform', `translate(${node.x} ${node.y})`);
      group.setAttribute('fill', '#000000');
      group.style.color = node.color;

      const halo = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      halo.setAttribute('class', 'memory-node-halo');
      halo.setAttribute('x', String(-node.width / 2 - 14));
      halo.setAttribute('y', String(-node.height / 2 - 14));
      halo.setAttribute('width', String(node.width + 28));
      halo.setAttribute('height', String(node.height + 28));
      halo.setAttribute('rx', '30');
      halo.style.fill = node.color;
      group.appendChild(halo);

      const core = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      core.setAttribute('class', 'memory-node-card');
      core.setAttribute('x', String(-node.width / 2));
      core.setAttribute('y', String(-node.height / 2));
      core.setAttribute('width', String(node.width));
      core.setAttribute('height', String(node.height));
      core.setAttribute('rx', '22');
      core.style.fill = '#ffffff';
      core.style.stroke = node.color;
      group.appendChild(core);

      const typeText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      typeText.setAttribute('class', 'memory-node-type');
      typeText.setAttribute('y', '-19');
      typeText.setAttribute('fill', '#000000');
      typeText.style.setProperty('fill', '#000000', 'important');
      typeText.style.stroke = 'transparent';
      typeText.textContent = this.truncateText(node.type, 10).toUpperCase();
      group.appendChild(typeText);

      const labelLines = this.getNodeLabelLines(node.label);
      const firstY = labelLines.length === 1 ? 14 : 7;
      labelLines.forEach((line, index) => {
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('y', String(firstY + index * 15));
        label.setAttribute('fill', '#000000');
        label.style.setProperty('fill', '#000000', 'important');
        label.style.stroke = 'transparent';
        label.textContent = line;
        group.appendChild(label);
      });

      group.addEventListener('pointerenter', e => this.showTooltip(node, e.clientX, e.clientY));
      group.addEventListener('pointermove', e => this.showTooltip(node, e.clientX, e.clientY));
      group.addEventListener('pointerleave', () => this.hideTooltip());
      group.addEventListener('dblclick', async e => {
        e.stopPropagation();
        if (node.id === 'user' || node.id === 'shadow') {
          alert(`You cannot delete the root core nodes 'User' or '${getAssistantName()}'!`);
          return;
        }
        if (confirm(`Do you want to delete the memory '${node.label}'?`)) {
          this.hideTooltip();
          await apiDeleteMemoryNode(node.id);
          this.loadGraph();
        }
      });

      this.nodeLayer.appendChild(group);
    });
  }

  getLinkPath(source, target) {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
    const curve = Math.min(80, distance * 0.18);
    const mx = (source.x + target.x) / 2 - (dy / distance) * curve;
    const my = (source.y + target.y) / 2 + (dx / distance) * curve;
    return `M ${source.x} ${source.y} Q ${mx} ${my} ${target.x} ${target.y}`;
  }

  getLinkMidpoint(source, target) {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
    const curve = Math.min(80, distance * 0.18);
    return {
      x: (source.x + target.x) / 2 - (dy / distance) * curve * 0.5,
      y: (source.y + target.y) / 2 + (dx / distance) * curve * 0.5
    };
  }

  getNodeLabelLines(label) {
    const words = String(label || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    words.forEach(word => {
      const next = current ? `${current} ${word}` : word;
      if (next.length <= 18 || !current) {
        current = next;
      } else if (lines.length < 1) {
        lines.push(current);
        current = word;
      }
    });
    if (current) lines.push(current);
    if (lines.length === 0) lines.push('Memory');
    const compact = lines.slice(0, 2);
    if (lines.length > 2) compact[1] = `${compact[1]}...`;
    return compact.map(line => this.truncateText(line, 20));
  }

  truncateText(text, maxLength) {
    const value = String(text || '');
    if (value.length <= maxLength) return value;
    return `${value.slice(0, Math.max(1, maxLength - 3)).trim()}...`;
  }

  applyTransform() {
    this.viewport.setAttribute('transform', `translate(${this.transform.x} ${this.transform.y}) scale(${this.transform.k})`);
  }

  initEvents() {
    const getScreenPos = (e) => {
      const rect = this.root.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    this.root.addEventListener('pointerdown', (e) => {
      if (e.target.closest && e.target.closest('.memory-node')) return;
      this.isDraggingGraph = true;
      this.lastMousePos = getScreenPos(e);
      this.root.classList.add('is-panning');
      if (this.root.setPointerCapture) this.root.setPointerCapture(e.pointerId);
    });

    this.root.addEventListener('pointermove', (e) => {
      if (!this.isDraggingGraph) return;
      const screenPos = getScreenPos(e);
      this.transform.x += screenPos.x - this.lastMousePos.x;
      this.transform.y += screenPos.y - this.lastMousePos.y;
      this.lastMousePos = screenPos;
      this.applyTransform();
    });

    const release = (e) => {
      this.isDraggingGraph = false;
      this.root.classList.remove('is-panning');
      if (e && this.root.hasPointerCapture && this.root.hasPointerCapture(e.pointerId)) {
        this.root.releasePointerCapture(e.pointerId);
      }
    };

    this.root.addEventListener('pointerup', release);
    this.root.addEventListener('pointercancel', release);
    this.root.addEventListener('pointerleave', (e) => {
      release(e);
      this.hideTooltip();
    });

    this.root.addEventListener('wheel', (e) => {
      e.preventDefault();
      const oldK = this.transform.k;
      const newK = Math.max(0.25, Math.min(3.5, oldK * Math.exp(-e.deltaY * 0.0012)));
      const scaleRatio = newK / oldK;
      const screenPos = getScreenPos(e);
      this.transform.x = screenPos.x - (screenPos.x - this.transform.x) * scaleRatio;
      this.transform.y = screenPos.y - (screenPos.y - this.transform.y) * scaleRatio;
      this.transform.k = newK;
      this.applyTransform();
    }, { passive: false });
  }

  showTooltip(node, clientX, clientY) {
    this.tooltip.classList.remove('hidden');
    const rect = this.root.getBoundingClientRect();
    const left = Math.min(rect.width - 270, Math.max(8, clientX - rect.left + 15));
    const top = Math.min(rect.height - 120, Math.max(8, clientY - rect.top + 15));
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
    this.tooltip.innerHTML = `
      <div style="font-weight: 600; color: ${node.color}; text-transform: uppercase; font-size: 0.7rem; margin-bottom: 2px;">${this.escapeHtml(node.type)}</div>
      <div style="font-weight: 500; font-size: 0.9rem; margin-bottom: 4px;">${this.escapeHtml(node.label)}</div>
      <div style="color: rgba(255,255,255,0.7); font-size: 0.75rem;">${this.escapeHtml(node.description || 'No description stored.')}</div>
    `;
  }

  hideTooltip() {
    this.tooltip.classList.add('hidden');
  }

  escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
