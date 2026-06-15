const { chromium, firefox, webkit } = require('playwright');
const http = require('http');
const path = require('path');

// Persistent browser state
let browserContext = null;
let page = null;
let currentBrowserType = null;
let pendingUploadPath = null;

const PORT = Number(process.env.SHADOW_BROWSER_CONTROLLER_PORT || process.argv[2] || 9222);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function getAllowedCorsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return '';
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) {
      return origin;
    }
  } catch (_) {}
  return '';
}

function isAllowedOrigin(req) {
  return !req.headers.origin || Boolean(getAllowedCorsOrigin(req));
}

function writeJson(res, statusCode, payload, req = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (req) {
    const allowedOrigin = getAllowedCorsOrigin(req);
    if (allowedOrigin) {
      headers['Access-Control-Allow-Origin'] = allowedOrigin;
      headers.Vary = 'Origin';
    }
  }
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

// Use a persistent profile directory so logins are saved between sessions.
const PROFILE_DIR = path.join(__dirname, 'runtime', 'profiles', 'browser_controller');

async function ensureBrowser(browserType = 'chromium') {
  // If browser type changed, close and relaunch
  if (browserContext && currentBrowserType !== browserType) {
    try { await browserContext.close(); } catch(e) {}
    browserContext = null;
    page = null;
  }
  
  // Check if browser context/page is closed or dead
  if (browserContext) {
    try {
      if (!page || page.isClosed() || browserContext.pages().length === 0) {
        throw new Error('Page or context closed');
      }
    } catch (e) {
      console.log('[Browser] Context or page is closed/unresponsive. Relaunching...');
      try { await browserContext.close(); } catch (err) {}
      browserContext = null;
      page = null;
    }
  }
  
  if (!browserContext) {
    const opts = {
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    };
    
    // Use real installed browser to avoid "This browser may not be secure" errors
    if (browserType === 'firefox') {
      delete opts.channel;
      browserContext = await firefox.launchPersistentContext(PROFILE_DIR + '_firefox', opts);
      console.log('[Browser] Launched Firefox');
    } else if (browserType === 'webkit') {
      delete opts.channel;
      browserContext = await webkit.launchPersistentContext(PROFILE_DIR + '_webkit', opts);
      console.log('[Browser] Launched WebKit');
    } else {
      // Try Chrome first, fall back to Edge, then bundled Chromium
      let launched = false;
      
      for (const channel of ['chrome', 'msedge', null]) {
        try {
          if (channel) {
            opts.channel = channel;
            console.log(`[Browser] Trying ${channel}...`);
          } else {
            delete opts.channel;
            console.log('[Browser] Trying bundled Chromium...');
          }
          browserContext = await chromium.launchPersistentContext(PROFILE_DIR, opts);
          console.log(`[Browser] Launched ${channel || 'bundled Chromium'} successfully`);
          launched = true;
          break;
        } catch(e) {
          console.log(`[Browser] ${channel || 'bundled Chromium'} failed: ${e.message}`);
        }
      }
      
      if (!launched) {
        throw new Error('No supported browser found. Install Chrome, Edge, or run: npx playwright install chromium');
      }
    }
    
    currentBrowserType = browserType;
    const pages = browserContext.pages();
    page = pages.length > 0 ? pages[0] : await browserContext.newPage();
    
    // Intercept native file chooser dialogs (e.g. YouTube upload button click)
    page.on('filechooser', async (fileChooser) => {
      if (pendingUploadPath) {
        console.log(`[Browser] Intercepted file chooser, uploading: ${pendingUploadPath}`);
        await fileChooser.setFiles(pendingUploadPath);
        pendingUploadPath = null;
      } else {
        console.log('[Browser] File chooser opened but no pendingUploadPath set');
      }
    });
    
    console.log(`[Browser] Ready with ${browserContext.pages().length} page(s)`);
  }
  
  const livePages = browserContext.pages().filter(browserPage => !browserPage.isClosed());
  if (livePages.length > 0 && (!page || page.isClosed())) {
    page = livePages[livePages.length - 1];
  }
  return page;
}

const ACTION_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label || 'Action'} timed out after ${Math.round(ms/1000)}s`)), ms))
  ]);
}

async function handleAction(data) {
  const p = await ensureBrowser(data.browser || 'chromium');
  const action = data.action;

  async function pageState(extra = {}) {
    let title = '';
    let url = '';
    try { title = await p.title(); } catch (e) {}
    try { url = p.url(); } catch (e) {}
    return { title, url, ...extra };
  }
  
  async function verifyScreenshot() {
    try {
      await p.waitForTimeout(200);
      const buf = await p.screenshot({ type: 'jpeg', quality: 40 });
      return buf.toString('base64');
    } catch (e) {
      return null;
    }
  }
  
  try {
    if (action === 'goto') {
      await p.goto(data.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      return { success: true, status: `Navigated to ${data.url}`, ...(await pageState()) };
    } else if (action === 'get_state') {
      return { success: true, status: 'Current browser state', ...(await pageState()) };
      
    } else if (action === 'click') {
      if (data.url && data.url !== await p.url()) {
        await p.goto(data.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      }
      
      console.log(`[Browser] Action: click on "${data.selector}"`);
      
      // Stage 1: Standard Playwright click
      try {
        await p.click(data.selector, { timeout: 2000 });
        console.log(`[Browser] Click Stage 1 (Standard) succeeded for "${data.selector}"`);
        const screenshot = await verifyScreenshot();
        return { success: true, status: `Clicked ${data.selector} (Standard)`, screenshot };
      } catch (err) {
        console.log(`[Browser] Click Stage 1 failed: ${err.message}. Trying Stage 2 (Force)...`);
      }
      
      // Stage 2: Force Click (bypasses visibility/obstruction checks)
      try {
        await p.click(data.selector, { timeout: 2000, force: true });
        console.log(`[Browser] Click Stage 2 (Force) succeeded for "${data.selector}"`);
        const screenshot = await verifyScreenshot();
        return { success: true, status: `Clicked ${data.selector} (Force)`, screenshot };
      } catch (err) {
        console.log(`[Browser] Click Stage 2 failed: ${err.message}. Trying Stage 3 (JS DOM Dispatch)...`);
      }
      
      // Stage 3: JS DOM Click dispatch (runs directly in page context)
      try {
        await p.$eval(data.selector, el => el.click());
        console.log(`[Browser] Click Stage 3 (JS DOM Dispatch) succeeded for "${data.selector}"`);
        const screenshot = await verifyScreenshot();
        return { success: true, status: `Clicked ${data.selector} (JS Dispatch)`, screenshot };
      } catch (err) {
        console.log(`[Browser] Click Stage 3 failed: ${err.message}. Trying Stage 4 (Bounding Box)...`);
      }
      
      // Stage 4: Bounding Box Coordinate Click
      try {
        const el = await p.$(data.selector);
        if (el) {
          const box = await el.boundingBox();
          if (box) {
            await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            console.log(`[Browser] Click Stage 4 (Bounding Box) succeeded at (${box.x + box.width/2}, ${box.y + box.height/2})`);
            const screenshot = await verifyScreenshot();
            return { success: true, status: `Clicked ${data.selector} (Bounding Box)`, screenshot };
          }
        }
      } catch (err) {
        console.log(`[Browser] Click Stage 4 failed: ${err.message}`);
      }

      // Stage 5: Special Google Search / Enter Key fallback
      if (data.selector.includes('btnK') || data.selector.includes('search')) {
        try {
          console.log('[Browser] Selector looks like a search button. Trying to press Enter on active element...');
          await p.keyboard.press('Enter');
          const screenshot = await verifyScreenshot();
          return { success: true, status: `Pressed Enter key (Search Fallback)`, screenshot };
        } catch (err) {
          console.log(`[Browser] Click Stage 5 failed: ${err.message}`);
        }
      }

      const state = await pageState();
      throw new Error(`Failed to click selector "${data.selector}" after all 5 fallback stages. Current page: ${state.title} (${state.url})`);
      
    } else if (action === 'type') {
      if (data.url && data.url !== await p.url()) {
        await p.goto(data.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      }
      
      if (typeof data.text !== 'string') {
        const state = await pageState();
        throw new Error(`Cannot type missing/non-string text into selector "${data.selector}". Current page: ${state.title} (${state.url})`);
      }

      const selector = typeof data.selector === 'string' ? data.selector.trim() : '';
      if (!selector) {
        console.log(`[Browser] Action: type "${data.text}" into active element`);
        if (data.clear) {
          await p.keyboard.down('Control');
          await p.keyboard.press('A');
          await p.keyboard.up('Control');
          await p.keyboard.press('Backspace');
        }
        await withTimeout(p.keyboard.type(data.text, { delay: 30 }), ACTION_TIMEOUT_MS, 'type_active_element');
        const screenshot = await verifyScreenshot();
        return { success: true, status: `Typed "${data.text}" into active element`, screenshot };
      }

      console.log(`[Browser] Action: type "${data.text}" into "${selector}"`);
      
      // Stage 1: Standard Playwright fill
      try {
        await p.fill(selector, data.text, { timeout: 2000 });
        console.log(`[Browser] Type Stage 1 (Standard Fill) succeeded for "${selector}"`);
        const screenshot = await verifyScreenshot();
        return { success: true, status: `Typed "${data.text}" into ${selector} (Fill)`, screenshot };
      } catch (err) {
        console.log(`[Browser] Type Stage 1 failed: ${err.message}. Trying Stage 2 (Focus & Keyboard type)...`);
      }
      
      // Stage 2: Focus, select all, delete, and type manually
      try {
        const el = await p.$(selector);
        if (!el) throw new Error(`Element not found: ${selector}`);
        await el.focus();
        await p.keyboard.down('Control');
        await p.keyboard.press('A');
        await p.keyboard.up('Control');
        await p.keyboard.press('Backspace');
        await el.type(data.text, { delay: 30 }); // slow/human typing speed simulation
        console.log(`[Browser] Type Stage 2 (Focus & Type) succeeded for "${selector}"`);
        const screenshot = await verifyScreenshot();
        return { success: true, status: `Typed "${data.text}" into ${selector} (Keyboard)`, screenshot };
      } catch (err) {
        console.log(`[Browser] Type Stage 2 failed: ${err.message}`);
      }

      const state = await pageState();
      throw new Error(`Failed to type into selector "${selector}" after all fallback stages. Current page: ${state.title} (${state.url})`);
      
    } else if (action === 'click_coordinate') {
      if (data.url && data.url !== await p.url()) {
        await withTimeout(p.goto(data.url, { waitUntil: 'domcontentloaded', timeout: 15000 }), ACTION_TIMEOUT_MS, 'goto');
      }
      console.log(`[Browser] Action: click_coordinate at [${data.x}, ${data.y}]`);
      let x = data.x;
      let y = data.y;
      
      if (data.normalized) {
        const viewport = p.viewportSize();
        x = Math.round((x / 1000) * viewport.width);
        y = Math.round((y / 1000) * viewport.height);
      }

      await withTimeout(p.mouse.click(x, y), ACTION_TIMEOUT_MS, 'click_coordinate');
      const screenshot = await verifyScreenshot();
      return { success: true, status: `Clicked coordinate (${x}, ${y})`, screenshot };
      
    } else if (action === 'type_coordinate') {
      if (data.url && data.url !== await p.url()) {
        await withTimeout(p.goto(data.url, { waitUntil: 'domcontentloaded', timeout: 15000 }), ACTION_TIMEOUT_MS, 'goto');
      }
      console.log(`[Browser] Action: type_coordinate at [${data.x}, ${data.y}] with text "${data.text}"`);
      if (typeof data.text !== 'string') {
        const state = await pageState();
        throw new Error(`Cannot type missing/non-string text at coordinates. Current page: ${state.title} (${state.url})`);
      }
      let x = data.x;
      let y = data.y;
      
      if (data.normalized) {
        const viewport = p.viewportSize();
        x = Math.round((x / 1000) * viewport.width);
        y = Math.round((y / 1000) * viewport.height);
      }

      await withTimeout(p.mouse.click(x, y), ACTION_TIMEOUT_MS, 'type_coordinate_click');
      await p.waitForTimeout(100);
      
      if (data.clear) {
        await p.keyboard.down('Control');
        await p.keyboard.press('A');
        await p.keyboard.up('Control');
        await p.keyboard.press('Backspace');
      }
      
      await withTimeout(p.keyboard.type(data.text, { delay: 30 }), ACTION_TIMEOUT_MS, 'type_coordinate_type');
      const screenshot = await verifyScreenshot();
      return { success: true, status: `Typed "${data.text}" at coordinate (${x}, ${y})`, screenshot };
      
    } else if (action === 'screenshot') {
      const buf = await withTimeout(p.screenshot({ type: 'jpeg', quality: 50 }), ACTION_TIMEOUT_MS, 'screenshot');
      return { success: true, status: 'Screenshot taken', screenshot: buf.toString('base64'), ...(await pageState()) };
      
    } else if (action === 'get_text') {
      const selector = data.selector || 'body';
      let text = '';
      try {
        text = await withTimeout(p.textContent(selector, { timeout: 5000 }), ACTION_TIMEOUT_MS, 'get_text_textContent');
      } catch (err) {
        console.log(`[Browser] get_text textContent failed for "${selector}": ${err.message}. Trying DOM innerText fallback...`);
        text = await withTimeout(p.evaluate((sel) => {
          const el = document.querySelector(sel) || document.body || document.documentElement;
          return (el && (el.innerText || el.textContent)) || '';
        }, selector), ACTION_TIMEOUT_MS, 'get_text_innerText');
      }
      return { success: true, status: 'Text retrieved', text: (text || '').substring(0, 4000), ...(await pageState()) };
      
    } else if (action === 'wait') {
      if (data.selector) {
        await p.waitForSelector(data.selector, { timeout: data.ms || 10000 });
        return { success: true, status: `Waited for selector "${data.selector}"`, ...(await pageState()) };
      } else {
        await p.waitForTimeout(data.ms || 2000);
        return { success: true, status: `Waited ${data.ms || 2000}ms`, ...(await pageState()) };
      }
      
    } else if (action === 'get_selectors') {
      try {
        const elements = await p.$$eval('a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], tp-yt-paper-radio-button, paper-radio-button, [role="tab"]', els => {
          return els.map(el => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            if (!isVisible) return null;

            const attrs = {};
            for (const attr of el.attributes) {
              attrs[attr.name] = attr.value;
            }

            let selector = el.tagName.toLowerCase();
            if (attrs.id) {
              selector += `#${attrs.id}`;
            } else if (attrs.name) {
              selector += `[name="${attrs.name}"]`;
            } else if (attrs.type && (attrs.type === 'submit' || attrs.type === 'button' || attrs.type === 'file')) {
              selector += `[type="${attrs.type}"]`;
            } else if (attrs.href) {
              const cleanHref = attrs.href.split('?')[0];
              selector += `[href="${cleanHref}"]`;
            } else if (attrs.class) {
              const firstClass = attrs.class.trim().split(/\s+/)[0];
              if (firstClass) selector += `.${firstClass}`;
            }

            return {
              tagName: el.tagName.toLowerCase(),
              text: (el.innerText || el.value || el.placeholder || '').trim().substring(0, 100),
              selector: selector,
              attributes: attrs
            };
          }).filter(Boolean);
        });
        return { success: true, status: `Retrieved ${elements.length} interactive elements`, elements: elements.slice(0, 100), ...(await pageState()) };
      } catch (err) {
        return { success: false, error: `Failed to retrieve selectors: ${err.message}` };
      }
      
    } else if (action === 'upload') {
      if (data.url && data.url !== await p.url()) {
        await p.goto(data.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      }
      const selector = data.selector || 'input[type="file"]';
      console.log(`[Browser] Action: upload file "${data.text}" to selector "${selector}"`);
      
      // Set pending path so filechooser listener can handle native dialogs
      pendingUploadPath = data.text;
      
      // Wait briefly for input element to load if not instantly ready
      try {
        await p.waitForSelector(selector, { timeout: 5000 });
      } catch (e) {
        console.log(`[Browser] Warning waiting for upload selector: ${e.message}`);
      }
      
      const el = await p.$(selector);
      if (el) {
        await el.setInputFiles(data.text);
        pendingUploadPath = null;
        return { success: true, status: `Uploaded file to ${selector}`, ...(await pageState()) };
      } else {
        // Element not found — maybe site uses hidden/native file picker.
        // pendingUploadPath remains set for the filechooser listener.
        // Give the listener a brief window to catch a triggered dialog.
        await p.waitForTimeout(3000);
        pendingUploadPath = null;
        return { success: true, status: `Set upload path for native file chooser interception`, ...(await pageState()) };
      }

    } else if (action === 'close') {
      if (browserContext) {
        await browserContext.close();
        browserContext = null;
        page = null;
        currentBrowserType = null;
      }
      return { success: true, status: 'Browser closed' };
      
    } else {
      return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: err.message, ...(await pageState()) };
  }
}

// Run as a small HTTP server so the PowerShell server doesn't block
const server = http.createServer(async (req, res) => {
  if (!isAllowedOrigin(req)) {
    writeJson(res, 403, { success: false, error: 'Forbidden origin' });
    return;
  }

  if (req.method === 'OPTIONS') {
    const allowedOrigin = getAllowedCorsOrigin(req);
    const headers = {
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (allowedOrigin) {
      headers['Access-Control-Allow-Origin'] = allowedOrigin;
      headers.Vary = 'Origin';
    }
    res.writeHead(200, headers);
    res.end();
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const result = await handleAction(data);
        writeJson(res, 200, result, req);
      } catch (err) {
        writeJson(res, 500, { success: false, error: err.message }, req);
      }
    });
  } else {
    writeJson(res, 200, { status: 'browser_controller running', browserActive: !!browserContext }, req);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Browser Controller] Listening on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  if (browserContext) await browserContext.close();
  server.close();
  process.exit(0);
});
