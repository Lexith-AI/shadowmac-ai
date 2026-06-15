#!/usr/bin/env node
/**
 * ShadowMac — macOS/Linux backend server.
 *
 * Port of run.ps1's PowerShell HTTP listener to Node. Serves the web app from
 * ./src and implements the /api/* surface the frontend expects. Commands from
 * the model are executed with PowerShell 7 (`pwsh`, cross-platform) so the
 * model's PowerShell-based prompting works unchanged; falls back to zsh if
 * pwsh is not installed.
 *
 * No npm dependencies — Node 18+ builtins only.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const os = require('os');

const SCRIPT_DIR = __dirname;
const SRC_DIR = path.join(SCRIPT_DIR, 'src');
const SECRETS_DIR = path.join(SCRIPT_DIR, 'secrets');
const RUNTIME_DIR = path.join(SCRIPT_DIR, 'runtime');
const RUN_CANCEL_DIR = path.join(RUNTIME_DIR, 'run-cancel');
const REQ_CANCEL_DIR = path.join(RUNTIME_DIR, 'request-cancel');
const SKILLS_DIR = path.join(SCRIPT_DIR, 'skills');
const BACKUPS_DIR = path.join(SCRIPT_DIR, 'backups');
const CONFIG_FILE = path.join(SECRETS_DIR, 'config.json');
const MEMORIES_FILE = path.join(SCRIPT_DIR, 'memories.json');
const GOOGLE_CREDS_FILE = path.join(SECRETS_DIR, 'google_credentials.json');
const GOOGLE_TOKENS_FILE = path.join(SECRETS_DIR, 'google_tokens.json');

const PORT = parseInt(process.env.SHADOW_PORT || process.argv[2] || '8000', 10);
const SCHEDULER_PORT = parseInt(process.env.SHADOW_SCHEDULER_PORT || '9333', 10);
const STARTED_AT = new Date().toISOString();

for (const d of [SECRETS_DIR, RUNTIME_DIR, RUN_CANCEL_DIR, REQ_CANCEL_DIR, SKILLS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// Which shell executes run_powershell_command. pwsh keeps the app's PowerShell
// prompting working on macOS; zsh is a degraded fallback. Prefer the bundled
// runtime (runtime/pwsh/pwsh), like the Windows installer bundles its runtimes.
let SHELL_MODE = 'zsh';
let PWSH_BIN = path.join(RUNTIME_DIR, 'pwsh', 'pwsh');
if (fs.existsSync(PWSH_BIN)) {
  SHELL_MODE = 'pwsh';
} else {
  try {
    PWSH_BIN = require('child_process').execSync('command -v pwsh', { shell: '/bin/zsh' }).toString().trim();
    SHELL_MODE = 'pwsh';
  } catch {
    console.warn('[shadowmac] pwsh not found — model commands will run in zsh and PowerShell syntax will fail.');
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sendJson(res, code, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw || !raw.trim()) return {};
  return JSON.parse(raw);
}

function isLoopbackOrigin(origin, port) {
  if (!origin) return true; // same-origin / curl
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && !isLoopbackOrigin(origin, PORT)) return false;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

function normalizeId(id, fallbackPrefix) {
  const s = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return s || `${fallbackPrefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

async function readJsonFile(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJsonFile(file, obj) {
  await fsp.writeFile(file, JSON.stringify(obj, null, 2), 'utf8'); // UTF-8 no BOM
}

/** Poll a request-cancel marker; abort the controller when it appears. */
function watchCancellation(requestId, controller) {
  if (!requestId) return () => {};
  const marker = path.join(REQ_CANCEL_DIR, `${requestId}.cancel`);
  const timer = setInterval(() => {
    if (fs.existsSync(marker)) {
      controller.cancelled = true;
      controller.abort();
      try { fs.unlinkSync(marker); } catch {}
    }
  }, 250);
  return () => clearInterval(timer);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000, controller = null) {
  const ctrl = controller || new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(SRC_DIR, rel));
  if (!file.startsWith(SRC_DIR + path.sep) && file !== SRC_DIR) {
    res.writeHead(404); res.end('Not found'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// /api/config
// ---------------------------------------------------------------------------

async function handleConfig(req, res) {
  if (req.method === 'GET') {
    const cfg = await readJsonFile(CONFIG_FILE, {});
    return sendJson(res, 200, cfg);
  }
  const incoming = await readJsonBody(req);
  const existing = await readJsonFile(CONFIG_FILE, {});
  const oldStamp = Number(existing.shadow_config_saved_at || 0);
  const newStamp = Number(incoming.shadow_config_saved_at || 0);
  if (newStamp && oldStamp && newStamp <= oldStamp) {
    return sendJson(res, 200, { status: 'success', stale_ignored: true });
  }
  await writeJsonFile(CONFIG_FILE, incoming);
  sendJson(res, 200, { status: 'success', stale_ignored: false });
}

// ---------------------------------------------------------------------------
// /api/search (+ /api/searx) — SearXNG proxy
// ---------------------------------------------------------------------------

async function searxBaseUrl() {
  // Returns the SearXNG origin (scheme://host:port), no trailing path.
  // The frontend stores the URL and the port in SEPARATE config fields
  // (e.g. url="http://127.0.0.1/search", port="8888"), so we must merge them.
  const cfg = await readJsonFile(CONFIG_FILE, {});
  const stripToOrigin = (raw, fallbackPort) => {
    try {
      const u = new URL(raw);
      const port = u.port || fallbackPort || '8888';
      return `${u.protocol}//${u.hostname}:${port}`;
    } catch {
      return `http://127.0.0.1:${fallbackPort || '8888'}`;
    }
  };
  if (process.env.SHADOW_SEARXNG_URL) return stripToOrigin(process.env.SHADOW_SEARXNG_URL, process.env.SHADOW_SEARXNG_PORT);
  const port = cfg.shadow_searxng_port ? String(cfg.shadow_searxng_port) : '8888';
  if (cfg.shadow_searxng_url) return stripToOrigin(cfg.shadow_searxng_url, port);
  return `http://127.0.0.1:${port}`;
}

function parseSearxHtml(html) {
  const results = [];
  const articles = html.split(/<article[^>]*class="[^"]*result[^"]*"[^>]*>/i).slice(1);
  for (const block of articles) {
    const urlM = block.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*(?:result-link|url_header)[^"]*"/i)
      || block.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"/i)
      || block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/i);
    const titleM = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const contentM = block.match(/<p[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    const strip = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const url = urlM ? urlM[1] : '';
    if (!url) continue;
    results.push({ title: strip(titleM && titleM[1]) || url, url, content: strip(contentM && contentM[1]).slice(0, 300) });
  }
  return results;
}

async function handleSearch(req, res) {
  const body = await readJsonBody(req);
  const query = String(body.query || '').trim();
  if (!query) return sendJson(res, 200, { status: 'error', error: 'Missing query.' });
  const count = clamp(Number(body.count || 5), 1, 8);
  const timeoutMs = clamp(Number(body.timeout_ms || 20000), 3000, 30000);
  const base = await searxBaseUrl();
  const requestId = normalizeId(body.request_id, 'search');

  const params = new URLSearchParams({ q: query, pageno: '1' });
  if (body.categories) params.set('categories', String(body.categories));
  if (body.language) params.set('language', String(body.language));
  if (body.time_range) params.set('time_range', String(body.time_range));

  const deadline = Date.now() + timeoutMs;
  const attempt = async (format) => {
    const remaining = deadline - Date.now() - 250;
    if (remaining < 500) throw new Error('timeout');
    const ctrl = new AbortController();
    const stop = watchCancellation(requestId, ctrl);
    try {
      const url = `${base}/search?${params.toString()}&format=${format}`;
      const r = await fetchWithTimeout(url, {}, clamp(remaining, 1000, 8000), ctrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (format === 'json') {
        const data = await r.json();
        return (data.results || []).map((x) => ({
          title: x.title || x.url, url: x.url, content: String(x.content || '').slice(0, 300),
        }));
      }
      return parseSearxHtml(await r.text());
    } finally { stop(); }
  };

  // Retry json+html until results or the deadline. Handles a cold/slow SearXNG
  // (connection refused while it's still warming up ~10s after launch).
  let results = null; let mode = 'json'; let lastErr = '';
  while (Date.now() < deadline - 600) {
    try { results = await attempt('json'); mode = 'json'; } catch (e) { lastErr = e.message; }
    if (!results || results.length === 0) {
      try { results = await attempt('html'); mode = 'html'; } catch (e) { lastErr = e.message; }
    }
    if (results && results.length > 0) break;
    await new Promise((r) => setTimeout(r, 700)); // brief pause, then retry while warming
  }
  if (!results || results.length === 0) {
    const reachable = lastErr && !/ECONNREFUSED|fetch failed|timeout|abort/i.test(lastErr);
    return sendJson(res, 200, {
      status: 'error',
      error: reachable
        ? `SearXNG returned no results for this query (${lastErr || 'empty'}).`
        : `Could not reach SearXNG at ${base} (${lastErr || 'no response'}).`,
      hint: reachable
        ? 'The search engine is running but found nothing — try rephrasing.'
        : 'Web search is still starting up (it takes ~10s after launch) or SearXNG is not running. Wait a few seconds and retry, or run ./tools/prepare-searxng.sh if you never set it up.',
    });
  }
  sendJson(res, 200, {
    status: 'success', query, source: `${base}/search`, mode, timeout_ms: timeoutMs,
    results: results.slice(0, count),
  });
}

// ---------------------------------------------------------------------------
// /api/weather — open-meteo
// ---------------------------------------------------------------------------

const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog', 51: 'light drizzle', 53: 'drizzle',
  55: 'dense drizzle', 56: 'freezing drizzle', 57: 'dense freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain',
  67: 'heavy freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow',
  77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm',
  96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};

function compass(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((deg % 360) / 45)) % 8];
}

async function handleWeather(req, res) {
  const body = await readJsonBody(req);
  try {
    let { latitude, longitude } = body;
    let placeName = String(body.location || '').trim();
    if ((latitude == null || longitude == null)) {
      if (!placeName) return sendJson(res, 200, { status: 'error', error: 'Provide location or latitude/longitude.' });
      const q = new URLSearchParams({ name: placeName, count: '5', language: 'en', format: 'json' });
      const geo = await (await fetchWithTimeout(`https://geocoding-api.open-meteo.com/v1/search?${q}`, {}, 10000)).json();
      let hit = (geo.results || [])[0];
      if (body.country) {
        const want = String(body.country).toLowerCase();
        hit = (geo.results || []).find((r) => String(r.country || '').toLowerCase().includes(want)) || hit;
      }
      if (!hit) return sendJson(res, 200, { status: 'error', error: `Could not geocode "${placeName}".` });
      latitude = hit.latitude; longitude = hit.longitude;
      placeName = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
    }
    const fq = new URLSearchParams({
      latitude: String(latitude), longitude: String(longitude), timezone: 'auto', forecast_days: '4',
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day,weather_code',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    });
    const wx = await (await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?${fq}`, {}, 10000)).json();
    const cur = wx.current || {};
    const condition = WMO[cur.weather_code] || 'unknown';
    const forecast = (wx.daily?.time || []).map((date, i) => {
      const code = wx.daily.weather_code[i];
      return {
        day: i === 0 ? 'today' : i === 1 ? 'tomorrow' : date,
        date,
        condition: WMO[code] || 'unknown',
        precipitation_probability_percent: wx.daily.precipitation_probability_max?.[i] ?? null,
        temp_max_c: wx.daily.temperature_2m_max?.[i] ?? null,
        temp_min_c: wx.daily.temperature_2m_min?.[i] ?? null,
        rain_expected: (wx.daily.precipitation_probability_max?.[i] ?? 0) >= 40,
        thunderstorm_expected: code >= 95,
      };
    });
    const observedLocal = String(cur.time || '').split('T')[1] || '';
    sendJson(res, 200, {
      status: 'success', source: 'open-meteo.com', location: placeName || `${latitude},${longitude}`,
      latitude, longitude, timezone: wx.timezone,
      observed_at: cur.time, observed_local_time: observedLocal, observed_minutes_ago: 0,
      temperature_c: cur.temperature_2m, apparent_temperature_c: cur.apparent_temperature,
      humidity_percent: cur.relative_humidity_2m, wind_speed_kmh: cur.wind_speed_10m,
      wind_gust_kmh: cur.wind_gusts_10m, wind_from: compass(cur.wind_direction_10m || 0),
      is_day: cur.is_day === 1, condition,
      summary: `Current weather in ${placeName}: ${condition}, ${cur.temperature_2m}°C (feels like ${cur.apparent_temperature}°C), humidity ${cur.relative_humidity_2m}%, wind ${cur.wind_speed_10m} km/h from ${compass(cur.wind_direction_10m || 0)}.`,
      forecast,
      forecast_summary: forecast.map((f) => `${f.day}: ${f.condition}, ${f.temp_min_c}–${f.temp_max_c}°C, precip ${f.precipitation_probability_percent}%`).join(' | '),
      instruction: 'Report the relevant parts conversationally; do not read every field.',
    });
  } catch (e) {
    sendJson(res, 200, { status: 'error', error: `Weather lookup failed: ${e.message}` });
  }
}

// ---------------------------------------------------------------------------
// /api/run — execute model commands (pwsh on macOS)
// ---------------------------------------------------------------------------

const BLOCKED_RUN = /\b(set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|clear-content|set-itemproperty|del|erase|rm|rmdir|mkdir|ni|sc)\b[^|]*\b(memories\.json|\.git[\\/])/i;

function killTree(pid) {
  try { process.kill(-pid, 'SIGKILL'); return true; } catch {}
  try { process.kill(pid, 'SIGKILL'); return true; } catch {}
  return false;
}

async function handleRun(req, res) {
  const body = await readJsonBody(req);
  const command = String(body.command || '');
  if (!command.trim()) return sendJson(res, 200, { status: 'error', output: 'Empty command.', exitCode: null, timedOut: false, cancelled: false });
  const commandId = normalizeId(body.command_id, 'run');
  const timeoutMs = clamp(Number(body.timeout_ms || 120000), 1000, 3600000);

  if (BLOCKED_RUN.test(command) || /(^|\s)>>?\s*\S*memories\.json/i.test(command)) {
    return sendJson(res, 403, {
      status: 'error',
      output: 'BLOCKED: direct writes to memories.json or .git are not allowed. Use /api/memories for memory updates.',
      exitCode: null, timedOut: false, cancelled: false, command_id: commandId,
    });
  }

  const desktop = path.join(os.homedir(), 'Desktop');
  const cwd = fs.existsSync(desktop) ? desktop : os.homedir();
  const env = { ...process.env, SHADOW_DIR: SCRIPT_DIR, GIT_TERMINAL_PROMPT: '0' };

  let child;
  if (SHELL_MODE === 'pwsh') {
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    child = spawn(PWSH_BIN, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { cwd, env, detached: true });
  } else {
    child = spawn('/bin/zsh', ['-c', command], { cwd, env, detached: true });
  }

  const pidFile = path.join(RUN_CANCEL_DIR, `${commandId}.pid`);
  const cancelFile = path.join(RUN_CANCEL_DIR, `${commandId}.cancel`);
  await writeJsonFile(pidFile, { pid: child.pid, startedAtUtc: new Date().toISOString() });

  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  let timedOut = false; let cancelled = false;
  const killer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
  const cancelPoll = setInterval(() => {
    if (fs.existsSync(cancelFile)) { cancelled = true; killTree(child.pid); }
  }, 250);

  child.on('close', (code) => {
    clearTimeout(killer); clearInterval(cancelPoll);
    for (const f of [pidFile, cancelFile]) { try { fs.unlinkSync(f); } catch {} }
    const maxLen = 200000;
    const output = out.length > maxLen ? out.slice(0, maxLen) + `\n...[truncated ${out.length - maxLen} chars]` : out;
    sendJson(res, 200, {
      status: cancelled ? 'cancelled' : (timedOut || code !== 0) && code !== 0 ? (timedOut ? 'error' : code === 0 ? 'success' : 'error') : 'success',
      output: output || (code === 0 ? '(no output)' : ''),
      exitCode: code, timedOut, cancelled, command_id: commandId,
      shell: SHELL_MODE, platform: 'macos',
    });
  });
  child.on('error', (e) => {
    clearTimeout(killer); clearInterval(cancelPoll);
    sendJson(res, 200, { status: 'error', output: `Failed to start shell: ${e.message}`, exitCode: null, timedOut: false, cancelled: false, command_id: commandId });
  });
}

async function handleRunCancel(req, res) {
  const body = await readJsonBody(req);
  const commandId = normalizeId(body.command_id, 'run');
  const cancelFile = path.join(RUN_CANCEL_DIR, `${commandId}.cancel`);
  await fsp.writeFile(cancelFile, new Date().toISOString(), 'utf8');
  let killed = false;
  const pidInfo = await readJsonFile(path.join(RUN_CANCEL_DIR, `${commandId}.pid`), null);
  if (pidInfo && pidInfo.pid) killed = killTree(pidInfo.pid);
  sendJson(res, 200, { status: 'success', command_id: commandId, process_killed: killed, message: 'Cancellation requested.' });
}

async function handleRequestCancel(req, res) {
  const body = await readJsonBody(req);
  const requestId = normalizeId(body.request_id, 'req');
  await fsp.writeFile(path.join(REQ_CANCEL_DIR, `${requestId}.cancel`), new Date().toISOString(), 'utf8');
  sendJson(res, 200, { status: 'success', request_id: requestId });
}

// ---------------------------------------------------------------------------
// /api/memories
// ---------------------------------------------------------------------------

const DEFAULT_MEMORIES = {
  nodes: [
    { id: 'user', label: 'User', type: 'person', description: 'The user (you)' },
    { id: 'shadow', label: 'Shadow', type: 'ai', description: 'Shadow, your AI companion' },
  ],
  links: [{ source: 'shadow', target: 'user', type: 'COMPANION_OF' }],
};

async function handleMemories(req, res) {
  if (req.method === 'GET') {
    return sendJson(res, 200, await readJsonFile(MEMORIES_FILE, DEFAULT_MEMORIES));
  }
  const raw = await readBody(req);
  if (raw.length > 2 * 1024 * 1024) return sendJson(res, 200, { status: 'error', message: 'Memory graph too large (max 2 MB).' });
  let graph;
  try { graph = JSON.parse(raw); } catch { return sendJson(res, 200, { status: 'error', message: 'Invalid JSON.' }); }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
    return sendJson(res, 200, { status: 'error', message: 'Memory graph must have nodes[] and links[].' });
  }
  if (graph.nodes.length > 1000) return sendJson(res, 200, { status: 'error', message: 'Too many nodes (max 1000).' });
  await writeJsonFile(MEMORIES_FILE, graph);
  sendJson(res, 200, { status: 'success', message: 'Memory graph saved.' });
}

async function handleMemoriesBackup(req, res) {
  if (!fs.existsSync(MEMORIES_FILE)) return sendJson(res, 200, { status: 'no_memories_file' });
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').slice(0, 19);
  const rel = path.join('backups', `memories_backup_${stamp}.json`);
  await fsp.copyFile(MEMORIES_FILE, path.join(SCRIPT_DIR, rel));
  sendJson(res, 200, { status: 'success', backupFile: rel });
}

// ---------------------------------------------------------------------------
// /api/skills
// ---------------------------------------------------------------------------

const SCAFFOLD_TOKENS = new Set(('create file html css page web app open desktop document confirm verify check render display show run execute save generate write code script browser window content command powershell output start process resolve childitem line item value add set get use put place style styling inline simple working functional complete proper view').split(' '));

function skillTokens(name) {
  return String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

async function listSkills() {
  const skills = [];
  let dirs = [];
  try { dirs = await fsp.readdir(SKILLS_DIR, { withFileTypes: true }); } catch { return skills; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(SKILLS_DIR, d.name, 'instructions.txt');
    try {
      const st = await fsp.stat(file);
      skills.push({ name: d.name, instructions: await fsp.readFile(file, 'utf8'), updated: st.mtime.toISOString() });
    } catch {}
  }
  return skills;
}

async function handleSkillsAll(req, res) {
  if (req.method === 'DELETE') {
    const skills = await listSkills();
    for (const s of skills) await fsp.rm(path.join(SKILLS_DIR, s.name), { recursive: true, force: true });
    return sendJson(res, 200, { status: 'success', deletedCount: skills.length });
  }
  sendJson(res, 200, { status: 'success', skills: await listSkills() });
}

async function handleSkillsSave(req, res) {
  const body = await readJsonBody(req);
  const rawName = String(body.skill_name || '').trim();
  const instructions = String(body.instructions || '');
  const safeName = rawName.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  if (!safeName) return sendJson(res, 200, { status: 'skipped', message: 'Invalid skill name.' });

  // Quality gates
  if (instructions.length < 80) return sendJson(res, 200, { status: 'skipped', message: 'Instructions too short to be a reusable skill.' });
  if (/test\.txt|hello world/i.test(instructions)) return sendJson(res, 200, { status: 'skipped', message: 'Looks like a throwaway test, not a reusable skill.' });
  if (/_20\d\d/.test(safeName)) return sendJson(res, 200, { status: 'skipped', message: 'Date-stamped names suggest a one-off, not a skill.' });
  const salient = skillTokens(safeName).filter((t) => !SCAFFOLD_TOKENS.has(t) && t.length > 2);
  if (salient.length === 0) return sendJson(res, 200, { status: 'skipped', message: 'Skill name has no distinctive tokens.' });

  const dir = path.join(SKILLS_DIR, safeName);
  const resolved = path.normalize(dir);
  if (!resolved.startsWith(SKILLS_DIR + path.sep)) return sendJson(res, 200, { status: 'skipped', message: 'Invalid path.' });
  const file = path.join(dir, 'instructions.txt');

  // Exact-name overwrite; otherwise merge into closest existing skill by token overlap.
  let overwrote = false; let merged = null;
  if (fs.existsSync(file)) {
    overwrote = true;
    await fsp.writeFile(file, instructions, 'utf8');
  } else {
    const existing = await listSkills();
    let best = null; let bestScore = 0;
    for (const s of existing) {
      const a = new Set(skillTokens(s.name).filter((t) => !SCAFFOLD_TOKENS.has(t)));
      const b = salient;
      const shared = b.filter((t) => a.has(t)).length;
      const score = shared / Math.max(1, Math.max(a.size, b.length));
      if (shared >= 1 && score > bestScore) { best = s; bestScore = score; }
    }
    if (best && bestScore >= 0.6) {
      merged = best.name;
      await fsp.appendFile(path.join(SKILLS_DIR, best.name, 'instructions.txt'), `\n\n--- Updated ---\n${instructions}`, 'utf8');
    } else {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(file, instructions, 'utf8');
    }
  }
  sendJson(res, 200, {
    status: 'success',
    message: merged ? `Merged into existing skill ${merged}` : `Skill saved as ${safeName}`,
    skill_name: merged || safeName,
    path: path.join(SKILLS_DIR, merged || safeName, 'instructions.txt'),
    overwrote_same_name: overwrote,
  });
}

async function handleSkillsDelete(req, res) {
  const body = await readJsonBody(req);
  const name = String(body.skill_name || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!name) return sendJson(res, 200, { status: 'error', message: 'Missing skill_name.' });
  await fsp.rm(path.join(SKILLS_DIR, name), { recursive: true, force: true });
  sendJson(res, 200, { status: 'success', message: `Skill '${name}' deleted.`, deleted: name });
}

// ---------------------------------------------------------------------------
// /api/scheduler/* — proxy to the scheduler microservice
// ---------------------------------------------------------------------------

async function handleSchedulerProxy(req, res, urlObj) {
  const targetPath = urlObj.pathname.replace(/^\/api\/scheduler/, '/api') + (urlObj.search || '');
  const target = `http://127.0.0.1:${SCHEDULER_PORT}${targetPath}`;
  try {
    const init = { method: req.method, headers: { 'Content-Type': 'application/json' } };
    if (req.method === 'POST' || req.method === 'PUT') init.body = await readBody(req);
    const r = await fetchWithTimeout(target, init, 10000);
    const text = await r.text();
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
  } catch (e) {
    sendJson(res, 502, { status: 'error', error: `Scheduler unreachable: ${e.message}` });
  }
}

// ---------------------------------------------------------------------------
// /api/proxy — outbound API proxy (model providers)
// ---------------------------------------------------------------------------

async function handleProxy(req, res) {
  const body = await readJsonBody(req);
  const requestId = normalizeId(body.request_id, 'proxy');
  const timeoutMs = clamp(Number(body.timeout_ms || 120000), 5000, 300000);
  const url = String(body.url || '');
  if (!/^https?:\/\//i.test(url)) return sendJson(res, 400, { error: 'url must be http(s)', status: 400 });
  const headers = { 'Content-Type': 'application/json' };
  if (body.headers && body.headers.Authorization) headers.Authorization = String(body.headers.Authorization);
  if (body.headers && body.headers.authorization) headers.Authorization = String(body.headers.authorization);
  for (const [k, v] of Object.entries(body.headers || {})) {
    if (/^x-goog-api-key$|^api-key$|^anthropic-version$|^x-api-key$/i.test(k)) headers[k] = String(v);
  }
  const ctrl = new AbortController();
  const stop = watchCancellation(requestId, ctrl);
  try {
    const r = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body.body ?? {}) }, timeoutMs, ctrl);
    const text = await r.text();
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8' });
    res.end(text);
  } catch (e) {
    const cancelled = !!ctrl.cancelled;
    sendJson(res, cancelled ? 499 : 502, { error: e.message, status: cancelled ? 499 : 502, cancelled, request_id: requestId });
  } finally { stop(); }
}

// ---------------------------------------------------------------------------
// /api/codex — OpenAI Codex subagent backend
// ---------------------------------------------------------------------------

function codexAuthFile() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'auth.json');
}

async function handleCodexStatus(req, res) {
  const auth = await readJsonFile(codexAuthFile(), null);
  if (!auth || !auth.tokens || !auth.tokens.access_token) {
    return sendJson(res, 200, {
      connected: false, status: 'success', authMode: 'none', credentialSource: 'none',
      hasAuthFile: !!auth, accountId: '', detail: 'Codex is not logged in. Run `codex login` in a terminal (npm i -g @openai/codex), or use a different subagent model.',
    });
  }
  sendJson(res, 200, {
    connected: true, status: 'success', authMode: auth.auth_mode || 'chatgpt', credentialSource: 'auth.json',
    hasAuthFile: true, accountId: auth.tokens.account_id || '', detail: 'Codex credentials found.',
  });
}

async function handleCodexLogin(req, res) {
  // The Windows build runs a bespoke PowerShell OAuth flow. On macOS we defer
  // to the official CLI, which produces the same ~/.codex/auth.json.
  sendJson(res, 200, {
    status: 'error',
    message: 'On macOS, log in from a terminal instead: `npm install -g @openai/codex` then `codex login`. Shadow will pick up the credentials automatically.',
  });
}

async function handleCodexLogout(req, res) {
  const warnings = [];
  await new Promise((resolve) => execFile('codex', ['logout'], { timeout: 15000 }, (err) => { if (err) warnings.push('codex CLI logout failed or CLI not installed.'); resolve(); }));
  try { await fsp.unlink(codexAuthFile()); } catch {}
  sendJson(res, 200, { status: 'success', message: 'Codex local auth cache was cleared.', warnings });
}

async function handleCodexResponses(req, res) {
  const body = await readJsonBody(req);
  const requestId = normalizeId(body.request_id, 'codex');
  const timeoutMs = clamp(Number(body.timeout_ms || 180000), 5000, 300000);
  const auth = await readJsonFile(codexAuthFile(), null);
  const token = auth && auth.tokens && auth.tokens.access_token;
  if (!token) return sendJson(res, 401, { error: 'Codex is not logged in. Run `codex login` in a terminal.', status: 401, request_id: requestId });

  const ctrl = new AbortController();
  const stop = watchCancellation(requestId, ctrl);
  try {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'OpenAI-Beta': 'responses_websockets=2026-02-06',
    };
    if (auth.tokens.account_id) headers['chatgpt-account-id'] = auth.tokens.account_id;
    const upstream = await fetchWithTimeout('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST', headers, body: JSON.stringify(body.body ?? {}),
    }, timeoutMs, ctrl);
    if (!upstream.ok && upstream.status !== 200) {
      const errBody = await upstream.text();
      return sendJson(res, upstream.status, { error: `Upstream HTTP ${upstream.status}`, status: upstream.status, body: errBody.slice(0, 4000), request_id: requestId });
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    const cancelled = !!ctrl.cancelled;
    if (!res.headersSent) sendJson(res, cancelled ? 499 : 500, { error: e.message, status: cancelled ? 499 : 500, cancelled, request_id: requestId });
    else res.end();
  } finally { stop(); }
}

// ---------------------------------------------------------------------------
// /api/openai-compat/models
// ---------------------------------------------------------------------------

async function handleOpenAiCompatModels(req, res, urlObj) {
  const endpoint = String(urlObj.searchParams.get('endpoint') || '').replace(/\/+$/, '');
  const key = urlObj.searchParams.get('key') || '';
  if (!/^https?:\/\//i.test(endpoint)) {
    return sendJson(res, 400, { status: 'error', models: [], error: 'Endpoint must be an http(s) URL, e.g. http://localhost:8080/v1' });
  }
  try {
    const headers = key ? { Authorization: `Bearer ${key}` } : {};
    const r = await fetchWithTimeout(`${endpoint}/models`, { headers }, 6000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const models = (data.data || []).map((m) => m.id).filter(Boolean);
    sendJson(res, 200, { status: 'success', endpoint, models });
  } catch (e) {
    sendJson(res, 502, { status: 'error', endpoint, models: [], error: `Could not fetch models from ${endpoint}/models — ${e.message}` });
  }
}

// ---------------------------------------------------------------------------
// /api/update-check
// ---------------------------------------------------------------------------

async function handleUpdateCheck(req, res) {
  try {
    const pkg = await readJsonFile(path.join(SCRIPT_DIR, 'package.json'), {});
    const r = await fetchWithTimeout('https://api.github.com/repos/shadowdoggie/shadow-ai/releases/latest', { headers: { 'User-Agent': 'shadow-ai' } }, 8000);
    const rel = await r.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const current = String(pkg.version || '0.0.0');
    const cmp = (a, b) => {
      const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
      return 0;
    };
    sendJson(res, 200, {
      status: 'success', current, latest,
      update_available: latest ? cmp(latest, current) > 0 : false,
      release_url: rel.html_url || '', release_name: rel.name || '',
      download_url: (rel.assets || []).map((a) => a.browser_download_url).find((u) => /Setup\.exe$/i.test(u || '')) || '',
    });
  } catch (e) {
    sendJson(res, 200, { status: 'error', error: e.message, update_available: false });
  }
}

// ---------------------------------------------------------------------------
// /api/ptt — push-to-talk global hotkey (Windows-only; stubbed on macOS)
// ---------------------------------------------------------------------------

function handlePttConfig(req, res) { sendJson(res, 200, { status: 'success', supported: false }); }
function handlePttState(req, res) { sendJson(res, 200, { status: 'success', supported: false, enabled: false, vk: 0, held: false, seq: 0 }); }
function handlePttWait(req, res) {
  // Long-poll contract: never signal a change; respond after a short delay.
  setTimeout(() => sendJson(res, 200, { status: 'success', held: false, seq: 0, supported: false }), 25000).unref();
}

// ---------------------------------------------------------------------------
// /api/open-url
// ---------------------------------------------------------------------------

async function handleOpenUrl(req, res) {
  const body = await readJsonBody(req);
  const url = String(body.url || '');
  if (!/^https?:\/\//i.test(url)) return sendJson(res, 400, { status: 'error', error: 'Only http(s) URLs can be opened.' });
  execFile('open', [url], () => {});
  sendJson(res, 200, { status: 'success' });
}

// ---------------------------------------------------------------------------
// Google Workspace OAuth
// ---------------------------------------------------------------------------

const GOOGLE_SCOPES = {
  workspace: [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/contacts.readonly',
  ],
  contacts: ['https://www.googleapis.com/auth/contacts.readonly'],
  photos: [
    'https://www.googleapis.com/auth/photoslibrary.appendonly',
    'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
    'https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata',
  ],
};
GOOGLE_SCOPES.all = [...new Set([...GOOGLE_SCOPES.workspace, ...GOOGLE_SCOPES.contacts, ...GOOGLE_SCOPES.photos])];

async function googleCreds() {
  let creds = await readJsonFile(GOOGLE_CREDS_FILE, null);
  if (creds && (creds.web || creds.installed)) creds = creds.web || creds.installed; // tolerate raw downloads
  if (!creds || !creds.client_id || !creds.client_secret) return null;
  return creds;
}

function redirectUri() { return `http://127.0.0.1:${PORT}/oauth2callback`; }

async function handleGoogleStatus(req, res) {
  const creds = await googleCreds();
  const tokens = await readJsonFile(GOOGLE_TOKENS_FILE, null);
  sendJson(res, 200, {
    status: 'success',
    credentialsConfigured: !!creds,
    credentialsError: creds ? '' : 'No Google credentials configured.',
    credentialsSource: creds ? GOOGLE_CREDS_FILE : '',
    clientType: 'flat',
    redirectUri: redirectUri(),
    connected: !!(tokens && tokens.refresh_token),
    tokenScopes: tokens ? tokens.scope || '' : '',
  });
}

async function handleGoogleSetCredentials(req, res) {
  const body = await readJsonBody(req);
  const c = body.web || body.installed || body;
  const clientId = String(c.client_id || '');
  const clientSecret = String(c.client_secret || '');
  if (!/\.apps\.googleusercontent\.com$/.test(clientId) || /placeholder/i.test(clientId) || !clientSecret) {
    return sendJson(res, 400, { status: 'error', message: 'client_id must end in .apps.googleusercontent.com and client_secret must be set.' });
  }
  await writeJsonFile(GOOGLE_CREDS_FILE, { client_id: clientId, client_secret: clientSecret });
  sendJson(res, 200, { status: 'success', message: 'Google Credentials saved.' });
}

async function handleGoogleAuthUrl(req, res, urlObj) {
  const creds = await googleCreds();
  if (!creds) return sendJson(res, 400, { status: 'error', error: 'Configure Google credentials first.' });
  const profile = ['workspace', 'contacts', 'photos', 'all'].includes(urlObj.searchParams.get('profile')) ? urlObj.searchParams.get('profile') : 'workspace';
  const scopes = GOOGLE_SCOPES[profile];
  const q = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes.join(' '),
  });
  sendJson(res, 200, { status: 'success', url: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, profile, scopes });
}

async function handleOauth2Callback(req, res, urlObj) {
  const code = urlObj.searchParams.get('code');
  const fail = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><body style="font-family:sans-serif;background:#0b0e1a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh"><div><h2>❌ Google connection failed</h2><p>${msg}</p></div></body></html>`);
  };
  if (!code) return fail(urlObj.searchParams.get('error') || 'No authorization code received.');
  const creds = await googleCreds();
  if (!creds) return fail('No Google credentials configured.');
  try {
    const r = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: creds.client_id, client_secret: creds.client_secret,
        redirect_uri: redirectUri(), grant_type: 'authorization_code',
      }),
    }, 15000);
    const tok = await r.json();
    if (!tok.access_token) return fail(`Token exchange failed: ${JSON.stringify(tok).slice(0, 300)}`);
    const old = await readJsonFile(GOOGLE_TOKENS_FILE, {});
    await writeJsonFile(GOOGLE_TOKENS_FILE, {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || old.refresh_token || '',
      expires_at: Math.floor(Date.now() / 1000) + (tok.expires_in || 3600),
      scope: tok.scope || '',
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body style="font-family:sans-serif;background:#0b0e1a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h1>✅</h1><h2>Google connected!</h2><p>You can close this tab and return to Shadow.</p></div></body></html>');
  } catch (e) { fail(e.message); }
}

async function refreshGoogleToken() {
  const tokens = await readJsonFile(GOOGLE_TOKENS_FILE, null);
  if (!tokens) return null;
  const now = Math.floor(Date.now() / 1000);
  if (tokens.access_token && tokens.expires_at - now > 300) return tokens.access_token;
  const creds = await googleCreds();
  if (!creds || !tokens.refresh_token) return tokens.access_token || null;
  const r = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token, client_id: creds.client_id,
      client_secret: creds.client_secret, grant_type: 'refresh_token',
    }),
  }, 15000);
  const tok = await r.json();
  if (!tok.access_token) return null;
  await writeJsonFile(GOOGLE_TOKENS_FILE, {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || tokens.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (tok.expires_in || 3600),
    scope: tok.scope || tokens.scope || '',
  });
  return tok.access_token;
}

async function handleGoogleToken(req, res) {
  try {
    const token = await refreshGoogleToken();
    if (!token) return sendJson(res, 200, { status: 'error', error: 'Not connected to Google.' });
    sendJson(res, 200, { status: 'success', access_token: token });
  } catch (e) { sendJson(res, 200, { status: 'error', error: e.message }); }
}

async function handleGoogleDisconnect(req, res) {
  try { await fsp.unlink(GOOGLE_TOKENS_FILE); } catch {}
  sendJson(res, 200, { status: 'success', message: 'Disconnected from Google.' });
}

const MIME_BY_EXT = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.txt': 'text/plain',
  '.json': 'application/json', '.pdf': 'application/pdf', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.png': 'image/png',
};

async function resolveLocalPath(requested) {
  if (requested && fs.existsSync(requested)) return requested;
  // fuzzy: look in requested dir (or Desktop) for closest filename-stem match
  const wantDir = requested ? path.dirname(requested) : '';
  const dir = wantDir && fs.existsSync(wantDir) ? wantDir : path.join(os.homedir(), 'Desktop');
  const wantStem = requested ? path.basename(requested, path.extname(requested)).toLowerCase() : '';
  if (!wantStem) return null;
  let entries = [];
  try { entries = await fsp.readdir(dir); } catch { return null; }
  let best = null; let bestScore = 0;
  for (const name of entries) {
    const stem = path.basename(name, path.extname(name)).toLowerCase();
    let score = 0;
    if (stem === wantStem) score = 1;
    else if (stem.includes(wantStem) || wantStem.includes(stem)) score = 0.7;
    if (score > bestScore) { best = path.join(dir, name); bestScore = score; }
  }
  return bestScore >= 0.7 ? best : null;
}

async function handleGoogleUpload(req, res) {
  const body = await readJsonBody(req);
  const requestId = normalizeId(body.request_id, 'upload');
  const timeoutMs = clamp(Number(body.timeout_ms || 1800000), 5000, 6 * 3600 * 1000);
  try {
    const localPath = await resolveLocalPath(String(body.path || ''));
    if (!localPath) return sendJson(res, 500, { status: 'error', error: `File not found: ${body.path}`, cancelled: false, timedOut: false, request_id: requestId });
    const token = await refreshGoogleToken();
    if (!token) return sendJson(res, 500, { status: 'error', error: 'Not connected to Google.', cancelled: false, timedOut: false, request_id: requestId });

    const data = await fsp.readFile(localPath);
    const filename = String(body.filename || path.basename(localPath));
    const mime = String(body.mime_type || MIME_BY_EXT[path.extname(localPath).toLowerCase()] || 'application/octet-stream');
    const meta = { name: filename };
    if (body.parent_id) meta.parents = [String(body.parent_id)];

    const boundary = `shadow_${crypto.randomBytes(8).toString('hex')}`;
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const ctrl = new AbortController();
    const stop = watchCancellation(requestId, ctrl);
    try {
      const r = await fetchWithTimeout(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,parents,webViewLink,size',
        { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart },
        timeoutMs, ctrl,
      );
      const file = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(file).slice(0, 500));
      sendJson(res, 200, { status: 'success', file, localPath, bytes: data.length, request_id: requestId });
    } finally { stop(); }
  } catch (e) {
    sendJson(res, 500, { status: 'error', error: e.message, cancelled: false, timedOut: /abort/i.test(e.message), request_id: requestId });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const ROUTES = {
  '/api/health': (req, res) => sendJson(res, 200, { status: 'healthy', service: 'shadow-main', port: PORT, startedAt: STARTED_AT, scriptDir: SCRIPT_DIR }),
  '/api/config': handleConfig,
  '/api/search': handleSearch,
  '/api/searx': handleSearch,
  '/api/weather': handleWeather,
  '/api/run': handleRun,
  '/api/run/cancel': handleRunCancel,
  '/api/request/cancel': handleRequestCancel,
  '/api/memories': handleMemories,
  '/api/memories/backup': handleMemoriesBackup,
  '/api/skills/all': handleSkillsAll,
  '/api/skills/save': handleSkillsSave,
  '/api/skills/delete': handleSkillsDelete,
  '/api/browser': (req, res) => sendJson(res, 200, { success: false, status: 'disabled', error: 'Browser automation is disabled. Use search_web/web_search through SearXNG, or open_url for the default browser.' }),
  '/api/proxy': handleProxy,
  '/api/codex/status': handleCodexStatus,
  '/api/codex/login': handleCodexLogin,
  '/api/codex/logout': handleCodexLogout,
  '/api/codex/responses': handleCodexResponses,
  '/api/update-check': handleUpdateCheck,
  '/api/ptt/config': handlePttConfig,
  '/api/ptt/state': handlePttState,
  '/api/ptt/wait': handlePttWait,
  '/api/open-url': handleOpenUrl,
  '/api/google/status': handleGoogleStatus,
  '/api/google/set-credentials': handleGoogleSetCredentials,
  '/api/google/auth-url': handleGoogleAuthUrl,
  '/api/google/token': handleGoogleToken,
  '/api/google/disconnect': handleGoogleDisconnect,
  '/api/google/upload-local-file': handleGoogleUpload,
};

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = urlObj.pathname;
  try {
    if (p === '/oauth2callback') return await handleOauth2Callback(req, res, urlObj);

    if (p.startsWith('/api/')) {
      if (!applyCors(req, res)) return sendJson(res, 403, { status: 'error', error: 'Forbidden origin.' });
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (p.startsWith('/api/scheduler/')) return await handleSchedulerProxy(req, res, urlObj);
      if (p === '/api/openai-compat/models') return await handleOpenAiCompatModels(req, res, urlObj);
      const handler = ROUTES[p];
      if (handler) return await handler(req, res, urlObj);
      return sendJson(res, 404, { status: 'error', error: `Unknown API route: ${p}` });
    }

    return serveStatic(req, res, p);
  } catch (e) {
    console.error(`[shadowmac] ${req.method} ${p} failed:`, e);
    if (!res.headersSent) sendJson(res, 500, { status: 'error', error: e.message });
    else res.end();
  }
});

// Clean stale cancel markers (>12h) at boot, like run.ps1 does.
for (const dir of [RUN_CANCEL_DIR, REQ_CANCEL_DIR]) {
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > 12 * 3600 * 1000) fs.unlinkSync(fp);
    }
  } catch {}
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[shadowmac] backend ready on http://127.0.0.1:${PORT} (shell: ${SHELL_MODE})`);
});
