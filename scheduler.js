/**
 * ShadowMac - Custom Cron/Scheduler Service
 * Handles reminders, scheduled subagent tasks, and scheduled main agent tasks.
 * Runs on Windows as a persistent microservice on port 9333.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.SHADOW_SCHEDULER_PORT) || 9333;
const TASKS_FILE = process.env.SHADOW_SCHEDULER_TASKS_FILE || path.join(__dirname, 'scheduled_tasks.json');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_TIMER_DELAY_MS = 2_147_000_000; // Keep below Node's signed 32-bit timer ceiling.

// In-memory task registry + timer handles
let tasks = [];
let timers = new Map(); // taskId -> { timeout, interval }
let notifications = []; // Pending notifications for frontend to pick up

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

function corsHeaders(req) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  const allowedOrigin = getAllowedCorsOrigin(req);
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
    headers.Vary = 'Origin';
  }
  return headers;
}

function sendJson(res, statusCode, payload, req) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...corsHeaders(req) });
  res.end(JSON.stringify(payload));
}

// --- Persistence ---
function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const raw = fs.readFileSync(TASKS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      tasks = Array.isArray(parsed) ? parsed : [];
    }
  } catch (e) {
    console.error('[Scheduler] Failed to load tasks:', e.message);
    tasks = [];
  }
}

function saveTasks() {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
  } catch (e) {
    console.error('[Scheduler] Failed to save tasks:', e.message);
  }
}

// --- Task Types ---
const TASK_TYPE = {
  REMINDER: 'reminder',         // Voice reminder to the user
  SUBAGENT: 'subagent',         // Spawn a subagent to do something
  MAIN_AGENT: 'main_agent',     // Inject a message/task for the main agent
  COMMAND: 'command',           // Run a PowerShell command
  RECURRING: 'recurring'        // Recurring task (any of the above on a schedule)
};

// --- Time Parsing ---
function parseScheduleTime(input) {
  // input can be:
  // - ISO date string: "2026-05-20T15:30:00"
  // - Relative: "in 5 minutes", "in 2 hours", "in 30 seconds"
  // - Time today: "at 3pm", "at 15:30", "at 3:30pm"
  
  input = input.trim().toLowerCase();
  
  // Relative time
  const relativeMatch = input.match(/in\s+(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h|day|d)s?/i);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1]);
    if (amount < 0) return null;
    const unit = relativeMatch[2].toLowerCase();
    let ms = 0;
    switch (unit) {
      case 'second': case 'sec': case 's': ms = amount * 1000; break;
      case 'minute': case 'min': case 'm': ms = amount * 60 * 1000; break;
      case 'hour': case 'hr': case 'h': ms = amount * 60 * 60 * 1000; break;
      case 'day': case 'd': ms = amount * 24 * 60 * 60 * 1000; break;
    }
    return new Date(Date.now() + ms);
  }
  
  // "at" time today/tomorrow
  const atMatch = input.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (atMatch) {
    let hours = parseInt(atMatch[1]);
    const minutes = atMatch[2] ? parseInt(atMatch[2]) : 0;
    const period = atMatch[3] ? atMatch[3].toLowerCase() : null;
    if (minutes < 0 || minutes > 59) return null;
    if (period && (hours < 1 || hours > 12)) return null;
    if (!period && (hours < 0 || hours > 23)) return null;
    
    if (period === 'pm' && hours < 12) hours += 12;
    if (period === 'am' && hours === 12) hours = 0;
    
    const target = new Date();
    target.setHours(hours, minutes, 0, 0);
    
    // If the time already passed today beyond the 60s grace period, schedule for tomorrow
    if (target.getTime() <= Date.now() - 60000) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }
  
  // ISO or parseable date string
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }
  
  return null;
}

function parseCronExpression(expr) {
  // Simple cron-like: "every 5 minutes", "every hour", "every day at 3pm", "every monday at 9am"
  expr = expr.trim().toLowerCase();
  
  const everyMatch = expr.match(/every\s+(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h|day|d)s?/i);
  if (everyMatch) {
    const amount = parseInt(everyMatch[1]);
    if (amount < 1) return null;
    const unit = everyMatch[2].toLowerCase();
    let ms = 0;
    switch (unit) {
      case 'second': case 'sec': case 's': ms = amount * 1000; break;
      case 'minute': case 'min': case 'm': ms = amount * 60 * 1000; break;
      case 'hour': case 'hr': case 'h': ms = amount * 60 * 60 * 1000; break;
      case 'day': case 'd': ms = amount * 24 * 60 * 60 * 1000; break;
    }
    return { type: 'interval', ms };
  }
  
  const everySimple = expr.match(/every\s+(second|sec|s|minute|min|m|hour|hr|h|day|d)s?/i);
  if (everySimple) {
    const unit = everySimple[1].toLowerCase();
    let ms = 0;
    switch (unit) {
      case 'second': case 'sec': case 's': ms = 1000; break;
      case 'minute': case 'min': case 'm': ms = 60 * 1000; break;
      case 'hour': case 'hr': case 'h': ms = 60 * 60 * 1000; break;
      case 'day': case 'd': ms = 24 * 60 * 60 * 1000; break;
    }
    return { type: 'interval', ms };
  }
  
  // "every monday/tuesday/etc at 3pm"
  const dayMatch = expr.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (dayMatch) {
    const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const targetDay = dayMap[dayMatch[1].toLowerCase()];
    let hours = parseInt(dayMatch[2]);
    const minutes = dayMatch[3] ? parseInt(dayMatch[3]) : 0;
    const period = dayMatch[4] ? dayMatch[4].toLowerCase() : null;
    if (minutes < 0 || minutes > 59) return null;
    if (period && (hours < 1 || hours > 12)) return null;
    if (!period && (hours < 0 || hours > 23)) return null;
    
    if (period === 'pm' && hours < 12) hours += 12;
    if (period === 'am' && hours === 12) hours = 0;
    
    return { type: 'weekly', day: targetDay, hours, minutes };
  }
  
  return null;
}

// --- Human-Readable Time Formatting ---
function formatHumanTime(date) {
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const isTomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toDateString() === date.toDateString();
  
  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  
  if (isToday) return `today at ${timeStr}`;
  if (isTomorrow) return `tomorrow at ${timeStr}`;
  return `${date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} at ${timeStr}`;
}

function formatTimeFromNow(date) {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  
  if (diffMs < 0) return 'overdue';
  if (diffMs < 60000) return 'in less than a minute';
  if (diffMs < 3600000) {
    const mins = Math.round(diffMs / 60000);
    return `in ${mins} minute${mins !== 1 ? 's' : ''}`;
  }
  if (diffMs < 86400000) {
    const hours = Math.round(diffMs / 3600000);
    return `in ${hours} hour${hours !== 1 ? 's' : ''}`;
  }
  const days = Math.round(diffMs / 86400000);
  return `in ${days} day${days !== 1 ? 's' : ''}`;
}

// --- Task Management ---
function generateId() {
  return 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function createTask(data) {
  const task = {
    id: generateId(),
    type: data.type || TASK_TYPE.REMINDER,
    message: data.message || '',
    schedule: data.schedule || '',       // "in 5 minutes", "at 3pm", ISO date
    cronExpression: data.cronExpression || null,  // "every 5 minutes", "every monday at 9am"
    createdAt: new Date().toISOString(),
    status: 'pending',                   // pending, running, completed, failed, cancelled
    lastTriggered: null,
    nextTrigger: null,
    result: null,
    // For subagent tasks
    subagentProvider: data.subagentProvider || null,
    subagentModel: data.subagentModel || null,
    // For command tasks
    command: data.command || null,
    // Metadata
    metadata: data.metadata || {}
  };
  
  // Calculate next trigger
  if (task.cronExpression) {
    task.nextTrigger = calculateNextCronTrigger(task.cronExpression);
    if (!task.nextTrigger) {
      throw new Error(`Could not parse cron expression: "${task.cronExpression}"`);
    }
    task.type = TASK_TYPE.RECURRING;
  } else if (task.schedule) {
    const triggerTime = parseScheduleTime(task.schedule);
    if (!triggerTime) {
      throw new Error(`Could not parse schedule: "${task.schedule}"`);
    }
    task.nextTrigger = triggerTime.toISOString();
  } else {
    throw new Error('Either schedule or cronExpression is required');
  }
  
  tasks.push(task);
  saveTasks();
  scheduleTask(task);
  return task;
}

function calculateNextCronTrigger(expr) {
  const parsed = parseCronExpression(expr);
  if (!parsed) return null;
  
  const now = new Date();
  
  if (parsed.type === 'interval') {
    return new Date(now.getTime() + parsed.ms).toISOString();
  }
  
  if (parsed.type === 'weekly') {
    const target = new Date();
    target.setHours(parsed.hours, parsed.minutes, 0, 0);
    
    while (target.getDay() !== parsed.day || target <= now) {
      target.setDate(target.getDate() + 1);
    }
    return target.toISOString();
  }
  
  return null;
}

function calculateNextRecurringTrigger(task) {
  if (!task.cronExpression) return null;
  
  const now = new Date();
  const parsed = parseCronExpression(task.cronExpression);
  if (!parsed) return null;
  
  if (parsed.type === 'interval') {
    const lastTrigger = task.lastTriggered ? new Date(task.lastTriggered) : now;
    return new Date(lastTrigger.getTime() + parsed.ms).toISOString();
  }
  
  if (parsed.type === 'weekly') {
    const target = new Date();
    target.setHours(parsed.hours, parsed.minutes, 0, 0);
    // Move past last trigger
    if (task.lastTriggered) {
      const last = new Date(task.lastTriggered);
      while (target <= last) {
        target.setDate(target.getDate() + 7);
      }
    }
    while (target.getDay() !== parsed.day) {
      target.setDate(target.getDate() + 1);
    }
    return target.toISOString();
  }
  
  return null;
}

function scheduleTask(task) {
  // Clear existing timer
  if (timers.has(task.id)) {
    clearTimeout(timers.get(task.id));
    timers.delete(task.id);
  }
  
  if (task.status === 'cancelled' || task.status === 'completed') return;
  
  const triggerTime = new Date(task.nextTrigger);
  const delay = triggerTime.getTime() - Date.now();
  
  if (delay <= 0) {
    // Trigger immediately
    executeTask(task);
    return;
  }

  if (delay > MAX_TIMER_DELAY_MS) {
    console.log(`[Scheduler] Task ${task.id} is beyond max timer window; rechecking in ${Math.round(MAX_TIMER_DELAY_MS / 86400000)} days`);
    const timerId = setTimeout(() => {
      scheduleTask(task);
    }, MAX_TIMER_DELAY_MS);
    timers.set(task.id, timerId);
    return;
  }
  
  console.log(`[Scheduler] Scheduling task ${task.id} (${task.type}) in ${Math.round(delay / 1000)}s`);
  
  const timerId = setTimeout(() => {
    executeTask(task);
  }, delay);
  
  timers.set(task.id, timerId);
}

async function executeTask(task) {
  // Always act on the authoritative record in `tasks`, never a stale closure copy.
  // A fired timer's closure can reference an outdated task object (e.g. created by a
  // duplicate scheduling); checking/mutating that stale copy is one way a "cancelled"
  // task kept firing. Re-resolve by id and bail (clearing any timer) if it's gone or
  // already cancelled.
  const current = tasks.find(t => t.id === task.id);
  if (!current || current.status === 'cancelled') {
    console.log(`[Scheduler] Task ${task.id} is gone or cancelled, skipping execution`);
    if (timers.has(task.id)) {
      clearTimeout(timers.get(task.id));
      timers.delete(task.id);
    }
    return;
  }
  task = current;

  console.log(`[Scheduler] Executing task ${task.id} (${task.type}): ${task.message}`);

  task.status = 'running';
  task.lastTriggered = new Date().toISOString();
  saveTasks();
  
  try {
    let result = null;
    
    switch (task.type) {
      case TASK_TYPE.REMINDER:
      case TASK_TYPE.RECURRING:
        // Queue a notification for the frontend to pick up
        // Mark as overdue if the trigger time was more than 60s ago
        const triggerTimeObj = new Date(task.nextTrigger);
        const isOverdueReminder = (Date.now() - triggerTimeObj.getTime()) > 60000;
        addNotification('reminder', task, isOverdueReminder);
        result = { delivered: true, queued: true };
        break;
        
      case TASK_TYPE.SUBAGENT:
        // Queue a notification for the frontend to spawn a subagent
        addNotification('subagent_task', task, false);
        result = { delivered: true, queued: true };
        break;
        
      case TASK_TYPE.MAIN_AGENT:
        // Queue a notification for the main agent
        addNotification('main_agent_task', task, false);
        result = { delivered: true, queued: true };
        break;
        
      case TASK_TYPE.COMMAND:
        // Execute PowerShell command directly
        result = await executeCommand(task);
        break;
        
      default:
        addNotification('reminder', task);
        result = { delivered: true, queued: true };
    }
    
    task.result = result;
    
    // Handle recurring - but only if task still exists in the array and wasn't cancelled
    // (prevents zombie tasks: timer fired but task was deleted before executeTask ran)
    const stillExists = tasks.find(t => t.id === task.id) !== undefined;
    if (task.cronExpression && stillExists && task.status !== 'cancelled') {
      task.nextTrigger = calculateNextRecurringTrigger(task);
      if (!task.nextTrigger) {
        throw new Error(`Could not calculate next trigger for cron expression: "${task.cronExpression}"`);
      }
      task.status = 'pending';
      saveTasks();
      scheduleTask(task);
    } else if (!task.cronExpression) {
      if (stillExists) {
        task.status = 'completed';
        saveTasks();
      }
    } else {
      console.log(`[Scheduler] Task ${task.id} was deleted during execution, skipping reschedule`);
    }
    
    console.log(`[Scheduler] Task ${task.id} completed`);
  } catch (e) {
    console.error(`[Scheduler] Task ${task.id} failed:`, e.message);
    task.status = 'failed';
    task.result = { error: e.message };
    saveTasks();
  }
  
  // Clean up the fired timer — but ONLY if we did not just schedule a fresh one.
  // For recurring tasks the reschedule above stored the NEXT timer in `timers`;
  // deleting it here would orphan that timer so cancelTask/deleteTask could never
  // clear it (the original runaway-task bug, where a cancelled recurring task kept
  // firing because its live timer was untracked).
  const rescheduled = Boolean(task.cronExpression) && task.status === 'pending';
  if (!rescheduled && timers.has(task.id)) {
    clearTimeout(timers.get(task.id));
    timers.delete(task.id);
  }
}

function addNotification(type, task, isOverdue = false) {
  const notification = {
    id: 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    type: type,
    taskId: task.id,
    message: task.message,
    timestamp: new Date().toISOString(),
    subagentProvider: task.subagentProvider || null,
    subagentModel: task.subagentModel || null,
    isOverdue: isOverdue,
    originalScheduledTime: isOverdue ? task.nextTrigger : null
  };
  notifications.push(notification);
  const overdueMarker = isOverdue ? ' [OVERDUE]' : '';
  console.log(`[Scheduler] Notification queued: ${type}${overdueMarker} - ${task.message}`);
}

function getNotifications() {
  const pending = [...notifications];
  notifications = []; // Clear after reading
  return pending;
}

async function executeCommand(task) {
  try {
    const res = await fetch('http://127.0.0.1:8000/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: task.command }),
      timeout: 60000
    });
    
    const data = await res.json();
    return { executed: true, output: data.output };
  } catch (e) {
    console.error('[Scheduler] Failed to execute command:', e.message);
    return { executed: false, reason: e.message };
  }
}

function cancelTask(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  
  if (timers.has(taskId)) {
    clearTimeout(timers.get(taskId));
    timers.delete(taskId);
  }
  
  task.status = 'cancelled';
  saveTasks();
  return task;
}

function getTask(taskId) {
  return tasks.find(t => t.id === taskId);
}

function listTasks(filter = {}) {
  let filtered = [...tasks];
  
  if (filter.type) {
    filtered = filtered.filter(t => t.type === filter.type);
  }
  if (filter.status) {
    filtered = filtered.filter(t => t.status === filter.status);
  }
  if (filter.activeOnly) {
    filtered = filtered.filter(t => t.status === 'pending' || t.status === 'running');
  }
  
  // Sort by nextTrigger
  filtered.sort((a, b) => {
    if (!a.nextTrigger) return 1;
    if (!b.nextTrigger) return -1;
    return new Date(a.nextTrigger) - new Date(b.nextTrigger);
  });
  
  return filtered;
}

function deleteTask(taskId) {
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) throw new Error(`Task not found: ${taskId}`);
  
  if (timers.has(taskId)) {
    clearTimeout(timers.get(taskId));
    timers.delete(taskId);
  }
  
  tasks.splice(idx, 1);
  saveTasks();
}

function deleteAllTasks() {
  // Clear all timers
  timers.forEach(timer => clearTimeout(timer));
  timers.clear();
  
  const count = tasks.length;
  tasks = [];
  saveTasks();
  return count;
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  if (!isAllowedOrigin(req)) {
    sendJson(res, 403, { status: 'error', error: 'Forbidden origin' }, req);
    return;
  }
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200, corsHeaders(req));
    res.end();
    return;
  }
  
  try {
    // GET /api/tasks - List all tasks
    if (urlPath === '/api/tasks' && req.method === 'GET') {
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const filter = {};
      if (params.get('type')) filter.type = params.get('type');
      if (params.get('status')) filter.status = params.get('status');
      if (params.get('activeOnly') === 'true') filter.activeOnly = true;
      
      const result = listTasks(filter).map(task => ({
        ...task,
        humanTime: task.nextTrigger ? formatHumanTime(new Date(task.nextTrigger)) : 'N/A',
        timeFromNow: task.nextTrigger ? formatTimeFromNow(new Date(task.nextTrigger)) : 'N/A'
      }));
      sendJson(res, 200, { status: 'success', tasks: result }, req);
      return;
    }
    
    // POST /api/tasks - Create a new task
    if (urlPath === '/api/tasks' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const task = createTask(data);
          sendJson(res, 201, { status: 'success', task }, req);
        } catch (e) {
          sendJson(res, 400, { status: 'error', error: e.message }, req);
        }
      });
      return;
    }
    
    // GET /api/tasks/:id - Get a specific task
    if (urlPath.match(/^\/api\/tasks\/task_/) && req.method === 'GET') {
      const taskId = urlPath.split('/').pop();
      const task = getTask(taskId);
      if (!task) {
        sendJson(res, 404, { status: 'error', error: 'Task not found' }, req);
        return;
      }
      sendJson(res, 200, { status: 'success', task }, req);
      return;
    }
    
    // DELETE /api/tasks/all - Permanently delete ALL tasks
    if (urlPath === '/api/tasks/all' && req.method === 'DELETE') {
      const count = deleteAllTasks();
      sendJson(res, 200, { status: 'success', deletedCount: count }, req);
      return;
    }
    
    // DELETE /api/tasks/:id - Cancel/delete a task
    if (urlPath.match(/^\/api\/tasks\/task_/) && req.method === 'DELETE') {
      const taskId = urlPath.split('/').pop();
      try {
        const task = cancelTask(taskId);
        sendJson(res, 200, { status: 'success', task }, req);
      } catch (e) {
        sendJson(res, 404, { status: 'error', error: e.message }, req);
      }
      return;
    }
    
    // POST /api/tasks/:id/delete - Permanently delete a task
    if (urlPath.match(/^\/api\/tasks\/task_[^/]+\/delete$/) && req.method === 'POST') {
      const taskId = urlPath.split('/')[3];
      try {
        deleteTask(taskId);
        sendJson(res, 200, { status: 'success' }, req);
      } catch (e) {
        sendJson(res, 404, { status: 'error', error: e.message }, req);
      }
      return;
    }
    
    // POST /api/tasks/:id/reschedule - Reschedule a task
    if (urlPath.match(/^\/api\/tasks\/task_[^/]+\/reschedule$/) && req.method === 'POST') {
      const taskId = urlPath.split('/')[3];
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const task = tasks.find(t => t.id === taskId);
          if (!task) {
            sendJson(res, 404, { status: 'error', error: 'Task not found' }, req);
            return;
          }
          
          if (timers.has(taskId)) {
            clearTimeout(timers.get(taskId));
            timers.delete(taskId);
          }
          
          if (data.schedule) {
            task.schedule = data.schedule;
            task.cronExpression = null;
            const triggerTime = parseScheduleTime(data.schedule);
            if (!triggerTime) throw new Error(`Could not parse schedule: "${data.schedule}"`);
            task.nextTrigger = triggerTime.toISOString();
          }
          if (data.cronExpression) {
            task.cronExpression = data.cronExpression;
            task.schedule = null;
            task.nextTrigger = calculateNextCronTrigger(data.cronExpression);
            if (!task.nextTrigger) throw new Error(`Could not parse cron expression: "${data.cronExpression}"`);
          }
          
          task.status = 'pending';
          task.result = null;
          task.lastTriggered = null;
          saveTasks();
          scheduleTask(task);
          
          sendJson(res, 200, { status: 'success', task }, req);
        } catch (e) {
          sendJson(res, 400, { status: 'error', error: e.message }, req);
        }
      });
      return;
    }
    
    // POST /api/tasks/:id/edit - Edit an existing task's message, schedule, or cron
    if (urlPath.match(/^\/api\/tasks\/task_[^/]+\/edit$/) && req.method === 'POST') {
      const taskId = urlPath.split('/')[3];
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const task = tasks.find(t => t.id === taskId);
          if (!task) {
            sendJson(res, 404, { status: 'error', error: 'Task not found' }, req);
            return;
          }
          
          // Update fields if provided
          if (data.message !== undefined) task.message = data.message;
          if (data.type !== undefined) task.type = data.type;
          
          // Update schedule if provided
          if (data.schedule) {
            if (timers.has(taskId)) {
              clearTimeout(timers.get(taskId));
              timers.delete(taskId);
            }
            task.schedule = data.schedule;
            task.cronExpression = null;
            const triggerTime = parseScheduleTime(data.schedule);
            if (!triggerTime) throw new Error(`Could not parse schedule: "${data.schedule}"`);
            task.nextTrigger = triggerTime.toISOString();
            task.status = 'pending';
            task.result = null;
            scheduleTask(task);
          }
          
          // Update cron if provided
          if (data.cronExpression) {
            if (timers.has(taskId)) {
              clearTimeout(timers.get(taskId));
              timers.delete(taskId);
            }
            task.cronExpression = data.cronExpression;
            task.schedule = null;
            task.nextTrigger = calculateNextCronTrigger(data.cronExpression);
            if (!task.nextTrigger) throw new Error(`Could not parse cron expression: "${data.cronExpression}"`);
            task.type = 'recurring';
            task.status = 'pending';
            task.result = null;
            scheduleTask(task);
          }
          
          saveTasks();
          
          sendJson(res, 200, { status: 'success', task }, req);
        } catch (e) {
          sendJson(res, 400, { status: 'error', error: e.message }, req);
        }
      });
      return;
    }
    
    // GET /api/notifications or /api/scheduler/notifications - Get and clear pending notifications
    if ((urlPath === '/api/notifications' || urlPath === '/api/scheduler/notifications') && req.method === 'GET') {
      const pending = getNotifications();
      sendJson(res, 200, {
        status: 'success',
        notifications: pending,
        count: pending.length
      }, req);
      return;
    }
    
    // GET /api/health - Health check
    if (urlPath === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, {
        status: 'healthy',
        taskCount: tasks.length,
        activeTimers: timers.size,
        uptime: process.uptime()
      }, req);
      return;
    }
    
    // 404
    sendJson(res, 404, { status: 'error', error: 'Not found' }, req);
    
  } catch (e) {
    console.error('[Scheduler] Unhandled error:', e);
    sendJson(res, 500, { status: 'error', error: e.message }, req);
  }
});

// --- Startup ---
loadTasks();

function rearmPendingTasks() {
  // Reschedule all pending tasks
  tasks.forEach(task => {
    if (task.status === 'pending' && task.nextTrigger) {
      const triggerTime = new Date(task.nextTrigger);
      if (triggerTime > new Date()) {
        scheduleTask(task);
      } else {
        // Missed trigger - execute now
        console.log(`[Scheduler] Task ${task.id} missed its trigger, executing now`);
        executeTask(task);
      }
    }
  });
}

// Exit cleanly if another scheduler already owns the port. Critical: a second
// instance must NOT arm any timers — a "ghost" process whose timers keep firing but
// that isn't listening on the port is unreachable by the HTTP cancel/delete API,
// which is exactly how a recurring task kept spamming after the user cancelled it.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[Scheduler] Port ${PORT} already in use; another scheduler instance is running. Exiting to avoid duplicate timers.`);
    process.exit(0);
  }
  console.error('[Scheduler] Server error:', err);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Scheduler Service] Listening on http://localhost:${PORT}`);
  // Only arm timers once we actually own the port (see the 'error' handler above).
  rearmPendingTasks();
  console.log(`[Scheduler Service] Loaded ${tasks.length} tasks, ${timers.size} active timers`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[Scheduler] Shutting down...');
  timers.forEach(timer => clearTimeout(timer));
  saveTasks();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Scheduler] Shutting down...');
  timers.forEach(timer => clearTimeout(timer));
  saveTasks();
  server.close();
  process.exit(0);
});
