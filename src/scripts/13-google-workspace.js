/**
 * ShadowMac - Google Workspace status, token, Gmail, Calendar, Drive, Docs, Sheets, YouTube, Photos, and Contacts helpers.
 * Split from the original monolithic app.js; loaded as an ordered classic script.
 */

// --- Google Workspace Helper Functions ---

const GOOGLE_LOCAL_API_TIMEOUT_MS = 15000;
const GOOGLE_API_TIMEOUT_MS = 12000;
const GOOGLE_DRIVE_DOWNLOAD_TIMEOUT_MS = 30000;
const GOOGLE_DRIVE_LOCAL_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const activeWorkspaceBackendRequestIds = new Set();
const nonInterruptibleWorkspaceBackendRequestIds = new Set();

function getWorkspaceAbortSignal(options = {}) {
  if (options && options.signal) return options.signal;
  const subagentSignal = options && options.subagentRecord && options.subagentRecord.abortController
    ? options.subagentRecord.abortController.signal
    : null;
  if (subagentSignal) return subagentSignal;
  if (typeof currentLiveToolAbortSignal !== 'undefined' && currentLiveToolAbortSignal) {
    return currentLiveToolAbortSignal;
  }
  return null;
}

function getWorkspaceRequestOptions(options = {}) {
  const { subagentRecord, label, ...requestOptions } = options || {};
  return requestOptions;
}

async function fetchWorkspaceWithTimeout(url, options = {}, timeoutMs = GOOGLE_API_TIMEOUT_MS) {
  const externalSignal = getWorkspaceAbortSignal(options);
  const baseOptions = getWorkspaceRequestOptions(options);
  const requestOptions = externalSignal ? { ...baseOptions, signal: externalSignal } : baseOptions;
  if (typeof fetchWithTimeout === 'function') {
    return fetchWithTimeout(url, requestOptions, timeoutMs);
  }
  if (typeof fetchLocalApiWithTimeout === 'function') {
    return fetchLocalApiWithTimeout(url, requestOptions, timeoutMs);
  }
  const controller = new AbortController();
  const abortExternal = () => controller.abort();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', abortExternal, { once: true });
    }
    return await fetch(url, { ...requestOptions, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      if (externalSignal && externalSignal.aborted) throw new Error('Task cancelled by user.');
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener('abort', abortExternal);
  }
}

function createWorkspaceBackendRequestId(label = 'workspace') {
  const safeLabel = String(label || 'workspace').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 32) || 'workspace';
  const random = Math.random().toString(36).slice(2, 8);
  return `${safeLabel}_${Date.now()}_${random}`;
}

function trackWorkspaceBackendRequest(requestId, { interruptible = true } = {}) {
  if (!requestId) return;
  activeWorkspaceBackendRequestIds.add(requestId);
  // Uploads commit their side effect remotely (the file reaches Google) before we get a
  // response, so a reflexive barge-in must not abort them — that strands the model on
  // "thinking" even though the upload succeeded. Such requests are non-interruptible.
  if (!interruptible) nonInterruptibleWorkspaceBackendRequestIds.add(requestId);
}

function untrackWorkspaceBackendRequest(requestId) {
  if (!requestId) return;
  activeWorkspaceBackendRequestIds.delete(requestId);
  nonInterruptibleWorkspaceBackendRequestIds.delete(requestId);
}

function cancelWorkspaceBackendRequests(reason = 'cancelled', { includeCommitted = true } = {}) {
  const requestIds = [...activeWorkspaceBackendRequestIds];
  let cancelled = 0;
  for (const requestId of requestIds) {
    // On a barge-in (includeCommitted: false) leave committed uploads running so they
    // can finish and report success; only a real teardown cancels everything.
    if (!includeCommitted && nonInterruptibleWorkspaceBackendRequestIds.has(requestId)) continue;
    if (typeof cancelShadowBackendRequest === 'function') {
      cancelShadowBackendRequest(requestId, reason);
    }
    cancelled++;
  }
  return cancelled;
}

async function readWorkspaceResponseJson(response, timeoutMs = GOOGLE_API_TIMEOUT_MS) {
  if (typeof readFetchResponseJsonWithTimeout === 'function') {
    return await readFetchResponseJsonWithTimeout(response, timeoutMs);
  }
  return await readWorkspaceResponseBodyWithTimeout(response, timeoutMs, () => response.json());
}

async function readWorkspaceResponseText(response, timeoutMs = GOOGLE_API_TIMEOUT_MS) {
  if (typeof readFetchResponseTextWithTimeout === 'function') {
    return await readFetchResponseTextWithTimeout(response, timeoutMs);
  }
  return await readWorkspaceResponseBodyWithTimeout(response, timeoutMs, () => response.text());
}

async function readWorkspaceResponseArrayBuffer(response, timeoutMs = GOOGLE_DRIVE_DOWNLOAD_TIMEOUT_MS) {
  if (typeof readFetchResponseArrayBufferWithTimeout === 'function') {
    return await readFetchResponseArrayBufferWithTimeout(response, timeoutMs);
  }
  return await readWorkspaceResponseBodyWithTimeout(response, timeoutMs, () => response.arrayBuffer());
}

async function readWorkspaceResponseBodyWithTimeout(response, timeoutMs, reader) {
  let timeoutId = null;
  const bodyPromise = reader();
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

async function checkGoogleStatus() {
  try {
    const res = await fetchWorkspaceWithTimeout('/api/google/status', {}, GOOGLE_LOCAL_API_TIMEOUT_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await readWorkspaceResponseJson(res, GOOGLE_LOCAL_API_TIMEOUT_MS);
    if (data.status === 'success') {
      // Populate the setup wizard's copyable redirect URI (the value the user must add to
      // their Google Cloud OAuth client's Authorized redirect URIs).
      if (googleRedirectUriDisplay && data.redirectUri) {
        googleRedirectUriDisplay.value = data.redirectUri;
      }
      if (credentialsStatusText) {
        if (data.credentialsConfigured) {
          credentialsStatusText.textContent = `Configured${data.clientType ? ` (${data.clientType})` : ''}. Redirect URL: ${data.redirectUri || 'not loaded'}`;
          credentialsStatusText.style.color = '#2ed573'; // Green
          if (btnConnectGoogle) btnConnectGoogle.textContent = 'Connect Google Account';
        } else {
          credentialsStatusText.textContent = `${data.credentialsError || 'Google OAuth credentials are missing.'} Redirect URL: ${data.redirectUri || 'not loaded'}`;
          credentialsStatusText.style.color = '#ff4757'; // Red
          if (btnConnectGoogle) btnConnectGoogle.textContent = 'Connect Google Account';
        }
      }

      if (googleStatusBadge && googleStatusBadgeText) {
        if (data.connected) {
          googleStatusBadgeText.textContent = 'Connected';
          googleStatusBadge.className = 'integration-status-badge integration-connected';
          if (googleStatusDetails) {
            googleStatusDetails.textContent = 'Status: Connected to Google Workspace.';
          }
          if (btnConnectGoogle) btnConnectGoogle.classList.add('hidden');
          if (btnDisconnectGoogle) btnDisconnectGoogle.classList.remove('hidden');
        } else {
          googleStatusBadgeText.textContent = 'Disconnected';
          googleStatusBadge.className = 'integration-status-badge integration-disconnected';
          if (googleStatusDetails) {
            googleStatusDetails.textContent = 'Status: Disconnected.';
          }
          if (btnConnectGoogle) btnConnectGoogle.classList.remove('hidden');
          if (btnDisconnectGoogle) btnDisconnectGoogle.classList.add('hidden');
        }
      }
    }
  } catch (err) {
    console.error('Error fetching Google status:', err);
  }
}

async function getGoogleAccessToken(options = {}) {
  const res = await fetchWorkspaceWithTimeout('/api/google/token', options, GOOGLE_LOCAL_API_TIMEOUT_MS);
  if (!res.ok) {
    const errData = await readWorkspaceResponseJson(res, GOOGLE_LOCAL_API_TIMEOUT_MS).catch(() => ({}));
    throw new Error(errData.error || `HTTP ${res.status} failed to fetch token`);
  }
  const data = await readWorkspaceResponseJson(res, GOOGLE_LOCAL_API_TIMEOUT_MS);
  if (data.status !== 'success' || !data.access_token) {
    throw new Error(data.error || 'Failed to retrieve access token.');
  }
  return data.access_token;
}

async function callGoogleAPI(url, options = {}, workspaceOptions = {}) {
  const token = await getGoogleAccessToken(workspaceOptions);
  const requestOptions = {
    ...workspaceOptions,
    ...options,
    headers: {
      ...(options.headers || {}),
      'Authorization': `Bearer ${token}`
    }
  };

  const response = await fetchWorkspaceWithTimeout(url, requestOptions, GOOGLE_API_TIMEOUT_MS);
  if (!response.ok) {
    const errData = await readWorkspaceResponseJson(response, GOOGLE_API_TIMEOUT_MS).catch(() => ({}));
    const message = errData.error && errData.error.message ? errData.error.message : `HTTP ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.googleError = errData.error || null;
    err.url = url;
    throw err;
  }
  if (response.status === 204) {
    return null;
  }
  return readWorkspaceResponseJson(response, GOOGLE_API_TIMEOUT_MS);
}

function isGoogleApiDisabledError(err) {
  const message = String(err && err.message || '');
  return (err && err.status === 403 && /has not been used in project\s+\d+\s+before or it is disabled/i.test(message))
    || /enable it by visiting .*people\.googleapis\.com/i.test(message);
}

function isGoogleInsufficientScopesError(err) {
  const message = String(err && err.message || '');
  const reason = String(err && err.googleError && err.googleError.status || '');
  return /insufficient authentication scopes/i.test(message)
    || /ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reason);
}

function getProjectFromGoogleApiError(err) {
  const match = String(err && err.message || '').match(/project\s+(\d+)/i);
  return match ? match[1] : '';
}

function getPeopleApiSetupMessage(err) {
  const project = getProjectFromGoogleApiError(err);
  const enableUrl = project
    ? `https://console.developers.google.com/apis/api/people.googleapis.com/overview?project=${project}`
    : 'https://console.developers.google.com/apis/api/people.googleapis.com/overview';
  return `Google Contacts cannot be read because the Google People API is disabled for this OAuth project${project ? ` (${project})` : ''}. Enable it here: ${enableUrl}. After enabling, wait a few minutes and try again; reconnect Google only if it still reports a permission/scope error.`;
}

function getGoogleContactsScopeMessage() {
  return 'Google Contacts needs Contacts scopes that are not on the current token. Disconnect and reconnect Google in ShadowMac so the contacts scopes are granted, then try again.';
}

function base64urlEncode(str) {
  const base64 = btoa(unescape(encodeURIComponent(str)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildRawEmailBase64Url(args = {}) {
  if (!args.to) throw new Error('Missing to parameter.');
  if (!args.body) throw new Error('Missing body parameter.');
  const subject = args.subject || '';
  const emailLines = [
    `To: ${args.to}`,
    `Subject: ${subject}`,
    'Mime-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    args.body
  ];
  return base64urlEncode(emailLines.join('\r\n'));
}

async function gmailListMessages(args = {}, options = {}) {
  const maxResults = args.count || 10;
  let url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`;
  if (args.query) {
    url += `&q=${encodeURIComponent(args.query)}`;
  }
  return callGoogleAPI(url, {}, options);
}

async function gmailGetMessage(args = {}, options = {}) {
  if (!args.message_id) throw new Error('Missing message_id parameter.');
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.message_id)}`;
  return callGoogleAPI(url, {}, options);
}

async function gmailSendMessage(args = {}, options = {}) {
  if (args.send_confirmed !== true) {
    throw new Error('Blocked: sending email requires explicit user confirmation. Use gmail_create_draft for drafts.');
  }
  const base64UrlEmail = buildRawEmailBase64Url(args);
  const url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
  return callGoogleAPI(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: base64UrlEmail })
  }, options);
}

async function gmailCreateDraft(args = {}, options = {}) {
  const base64UrlEmail = buildRawEmailBase64Url(args);
  const url = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts';
  return callGoogleAPI(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: { raw: base64UrlEmail } })
  }, options);
}

async function googleCalendarListEvents(args = {}, options = {}) {
  const requestedMax = Number(args.max_results) || 20;
  const maxResults = Math.min(Math.max(Math.trunc(requestedMax), 1), 100);
  const includePast = args.include_past === true;
  const effectiveTimeMin = args.time_min || (includePast ? '' : new Date().toISOString());
  const calendarId = String(args.calendar_id || '').trim();
  const calendars = calendarId
    ? [{ id: calendarId, summary: calendarId, primary: calendarId === 'primary' }]
    : await googleCalendarListSelectedCalendars(options);
  const queryResults = await Promise.all(calendars.map(calendar => googleCalendarFetchEventsForCalendar(calendar, {
    maxResults,
    timeMin: effectiveTimeMin,
    timeMax: args.time_max
  }, options)));
  const items = queryResults
    .flatMap(result => result.items)
    .filter(event => event.status !== 'cancelled')
    .sort((a, b) => getCalendarEventStartMillis(a) - getCalendarEventStartMillis(b))
    .slice(0, maxResults);

  return {
    kind: 'calendar#events',
    summary: calendars.length === 1 ? calendars[0].summary : 'Selected Google calendars',
    items,
    shadowCalendarsQueried: calendars.map(calendar => ({
      id: calendar.id,
      summary: calendar.summary,
      primary: Boolean(calendar.primary),
      selected: calendar.selected !== false,
      timeZone: calendar.timeZone || null
    })),
    shadowQuery: {
      defaultedToUpcoming: !args.time_min && !includePast,
      timeMin: effectiveTimeMin || null,
      timeMax: args.time_max || null,
      orderBy: 'startTime',
      calendarId: calendarId || null,
      selectedCalendarCount: calendars.length
    }
  };
}

async function googleCalendarListSelectedCalendars(options = {}) {
  const fields = encodeURIComponent('items(id,summary,primary,selected,hidden,accessRole,timeZone)');
  const result = await callGoogleAPI(`https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&fields=${fields}`, {}, options);
  const calendars = Array.isArray(result && result.items) ? result.items : [];
  const selected = calendars.filter(calendar => {
    if (!calendar || !calendar.id || calendar.hidden) return false;
    return calendar.primary || calendar.selected !== false;
  });
  if (selected.length > 0) return selected;
  const primary = calendars.find(calendar => calendar && calendar.primary) || calendars[0];
  return primary ? [primary] : [{ id: 'primary', summary: 'Primary calendar', primary: true, selected: true }];
}

async function googleCalendarFetchEventsForCalendar(calendar, eventOptions = {}, options = {}) {
  const calendarId = calendar.id || 'primary';
  let url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?maxResults=${eventOptions.maxResults}&singleEvents=true&orderBy=startTime&showDeleted=false`;
  if (eventOptions.timeMin) {
    url += `&timeMin=${encodeURIComponent(eventOptions.timeMin)}`;
  }
  if (eventOptions.timeMax) {
    url += `&timeMax=${encodeURIComponent(eventOptions.timeMax)}`;
  }
  const result = await callGoogleAPI(url, {}, options);
  const events = Array.isArray(result && result.items) ? result.items : [];
  return {
    calendar,
    items: events.map(event => ({
      ...event,
      shadowCalendar: {
        id: calendarId,
        summary: calendar.summary || calendarId,
        primary: Boolean(calendar.primary),
        timeZone: calendar.timeZone || null
      }
    }))
  };
}

function getCalendarEventStartMillis(event) {
  const rawStart = event && event.start ? (event.start.dateTime || event.start.date) : '';
  const parsed = Date.parse(rawStart);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

async function googleCalendarCreateEvent(args = {}, options = {}) {
  if (!args.summary) throw new Error('Missing summary parameter.');
  if (!args.start_time) throw new Error('Missing start_time parameter.');
  if (!args.end_time) throw new Error('Missing end_time parameter.');

  const body = {
    summary: args.summary,
    description: args.description || '',
    start: {
      dateTime: args.start_time
    },
    end: {
      dateTime: args.end_time
    }
  };

  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  return callGoogleAPI(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }, options);
}

async function buildUpcomingCalendarPromptSnapshot() {
  const result = await googleCalendarListEvents({ max_results: 5 });
  const events = Array.isArray(result && result.items) ? result.items : [];
  const queried = Array.isArray(result && result.shadowCalendarsQueried) ? result.shadowCalendarsQueried : [];
  const lines = events
    .slice(0, 5)
    .map(formatCalendarEventForPrompt)
    .filter(Boolean);
  let snapshot = '\n\n=== UPCOMING GOOGLE CALENDAR SNAPSHOT ===\n';
  snapshot += `Snapshot generated at ${new Date().toString()} from ${queried.length || 1} visible selected calendar(s).\n`;
  snapshot += 'Use this snapshot only for vague immediate calendar questions. For date-specific, create/update/delete, or detailed calendar requests, call `google_calendar_list_events` with the right bounds.\n';
  if (lines.length === 0) {
    snapshot += 'No upcoming events were returned by Google Calendar.\n';
  } else {
    snapshot += lines.join('\n') + '\n';
  }
  return snapshot;
}

function formatCalendarEventForPrompt(event) {
  if (!event) return '';
  const title = event.summary || '(untitled event)';
  const start = event.start ? (event.start.dateTime || event.start.date || '') : '';
  const end = event.end ? (event.end.dateTime || event.end.date || '') : '';
  const calendar = event.shadowCalendar && event.shadowCalendar.summary ? event.shadowCalendar.summary : '';
  const calendarPart = calendar ? ` | calendar: ${calendar}` : '';
  const endPart = end ? ` | end: ${end}` : '';
  return `- ${title} | start: ${start}${endPart}${calendarPart}`;
}

async function googleDriveListFiles(args = {}, options = {}) {
  const pageSize = args.page_size || 20;
  let url = `https://www.googleapis.com/drive/v3/files?pageSize=${pageSize}&fields=${encodeURIComponent('files(id,name,mimeType,parents,webViewLink,createdTime,modifiedTime)')}`;
  if (args.query) {
    url += `&q=${encodeURIComponent(args.query)}`;
  }
  return callGoogleAPI(url, {}, options);
}

async function googleDriveCreateFolder(args = {}, options = {}) {
  const name = String(args.name || '').trim();
  if (!name) throw new Error('Missing folder name.');

  const metadata = {
    name,
    mimeType: 'application/vnd.google-apps.folder'
  };

  if (args.parent_id) {
    metadata.parents = [String(args.parent_id)];
  }

  const url = 'https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,parents,webViewLink';
  return callGoogleAPI(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  }, options);
}

async function googleDriveSetSharing(args = {}, options = {}) {
  const fileId = String(args.file_id || '').trim();
  if (!fileId) throw new Error('Missing file_id.');
  // "anyone with the link" sharing; role reader (view) by default, writer (edit) if asked.
  const role = String(args.role || 'reader').toLowerCase() === 'writer' ? 'writer' : 'reader';
  await callGoogleAPI(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, type: 'anyone' })
  }, options);
  // Return the shareable link so the assistant can hand it to the user.
  const meta = await callGoogleAPI(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,webViewLink`, {}, options);
  return {
    status: 'success',
    file_id: fileId,
    name: meta && meta.name,
    role,
    access: 'anyone_with_link',
    webViewLink: meta && meta.webViewLink
  };
}

async function googleDriveUploadFile(args = {}, options = {}) {
  if (!args.filename) throw new Error('Missing filename parameter.');
  if (!args.content_base64) throw new Error('Missing content_base64 parameter.');
  if (String(args.content_base64).length > 1500000) {
    throw new Error('Base64 upload payload is too large for the Live session. Use google_drive_upload_local_file with the local file path instead.');
  }

  const mimeType = args.mime_type || 'text/plain';
  const boundary = 'foo_bar_boundary_shadow_ai';

  const metadata = {
    name: args.filename,
    mimeType: mimeType
  };
  if (args.parent_id) {
    metadata.parents = [String(args.parent_id)];
  }

  let base64Data = args.content_base64;
  if (base64Data.includes(',')) {
    base64Data = base64Data.split(',')[1];
  }

  const bodyParts = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Data,
    `--${boundary}--`
  ];

  const multipartBody = bodyParts.join('\r\n');
  const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

  return callGoogleAPI(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: multipartBody
  }, options);
}

async function googleDriveUploadLocalFile(args = {}, options = {}) {
  if (!args.path) throw new Error('Missing local file path.');
  const requestId = args.request_id || createWorkspaceBackendRequestId(options.label || 'drive_upload');
  const subagentRecord = options.subagentRecord || null;
  // Non-interruptible: once the local server starts streaming the file to Google, a
  // barge-in must not abort it (the file commits remotely before we read the response).
  trackWorkspaceBackendRequest(requestId, { interruptible: false });
  if (subagentRecord && typeof trackSubagentBackendRequest === 'function') {
    trackSubagentBackendRequest(subagentRecord, requestId);
  }

  let res;
  let data = {};
  try {
    res = await fetchWorkspaceWithTimeout('/api/google/upload-local-file', {
      ...options,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        path: args.path,
        filename: args.filename || '',
        mime_type: args.mime_type || '',
        parent_id: args.parent_id || '',
        request_id: requestId,
        timeout_ms: GOOGLE_DRIVE_LOCAL_UPLOAD_TIMEOUT_MS
      })
    }, GOOGLE_DRIVE_LOCAL_UPLOAD_TIMEOUT_MS);
    data = await readWorkspaceResponseJson(res, GOOGLE_DRIVE_LOCAL_UPLOAD_TIMEOUT_MS).catch(() => ({}));
  } catch (err) {
    if (typeof cancelShadowBackendRequest === 'function' && /cancelled|timed out|abort/i.test(String(err && err.message || err))) {
      cancelShadowBackendRequest(requestId, String(err && err.message || err));
    }
    throw err;
  } finally {
    untrackWorkspaceBackendRequest(requestId);
    if (subagentRecord && typeof untrackSubagentBackendRequest === 'function') {
      untrackSubagentBackendRequest(subagentRecord, requestId);
    }
  }

  if (!res.ok || data.status !== 'success') {
    throw new Error(data.error || `Local Drive upload failed with HTTP ${res.status}`);
  }
  return data;
}

async function googleDriveDownloadFile(args = {}, options = {}) {
  if (!args.file_id) throw new Error('Missing file_id parameter.');
  const token = await getGoogleAccessToken(options);
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(args.file_id)}?alt=media`;
  const response = await fetchWorkspaceWithTimeout(url, {
    ...options,
    headers: { 'Authorization': `Bearer ${token}` }
  }, GOOGLE_DRIVE_DOWNLOAD_TIMEOUT_MS);
  if (!response.ok) {
    const errData = await readWorkspaceResponseJson(response, GOOGLE_DRIVE_DOWNLOAD_TIMEOUT_MS).catch(() => ({}));
    throw new Error(errData.error?.message || `HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('json')) {
    return readWorkspaceResponseJson(response, GOOGLE_DRIVE_DOWNLOAD_TIMEOUT_MS);
  } else if (contentType.includes('text') || contentType.includes('xml')) {
    return { content: await readWorkspaceResponseText(response, GOOGLE_DRIVE_DOWNLOAD_TIMEOUT_MS), mimeType: contentType };
  } else {
    const arrayBuffer = await readWorkspaceResponseArrayBuffer(response, GOOGLE_DRIVE_DOWNLOAD_TIMEOUT_MS);
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return { content_base64: btoa(binary), mimeType: contentType };
  }
}

async function googleDriveDeleteFile(args = {}, options = {}) {
  if (!args.file_id) throw new Error('Missing file_id parameter.');
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(args.file_id)}`;
  await callGoogleAPI(url, { method: 'DELETE' }, options);
  return { status: 'success', message: `File ${args.file_id} deleted successfully.` };
}

async function googleDriveMoveFile(args = {}, options = {}) {
  if (!args.file_id) throw new Error('Missing file_id parameter.');
  let url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(args.file_id)}?fields=id,parents`;
  const queryParams = [];
  if (args.add_parents) queryParams.push(`addParents=${encodeURIComponent(args.add_parents)}`);
  if (args.remove_parents) queryParams.push(`removeParents=${encodeURIComponent(args.remove_parents)}`);
  if (queryParams.length > 0) {
    url += `&${queryParams.join('&')}`;
  }
  return callGoogleAPI(url, { method: 'PATCH' }, options);
}

async function googleDriveUpdateFile(args = {}, options = {}) {
  if (!args.file_id) throw new Error('Missing file_id parameter.');
  const body = {};
  if (args.name) body.name = args.name;
  if (args.description) body.description = args.description;
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(args.file_id)}`;
  return callGoogleAPI(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, options);
}

async function googleDocsCreate(args = {}, options = {}) {
  const body = { title: args.title || 'Untitled Document' };
  const url = 'https://docs.googleapis.com/v1/documents';
  return callGoogleAPI(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, options);
}

async function googleDocsGet(args = {}, options = {}) {
  if (!args.document_id) throw new Error('Missing document_id parameter.');
  const url = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(args.document_id)}`;
  return callGoogleAPI(url, {}, options);
}

async function googleSheetsCreate(args = {}, options = {}) {
  const body = { properties: { title: args.title || 'Untitled Spreadsheet' } };
  const url = 'https://sheets.googleapis.com/v4/spreadsheets';
  return callGoogleAPI(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, options);
}

async function googleSheetsGet(args = {}, options = {}) {
  if (!args.spreadsheet_id) throw new Error('Missing spreadsheet_id parameter.');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(args.spreadsheet_id)}`;
  return callGoogleAPI(url, {}, options);
}

async function googleSheetsReadRange(args = {}, options = {}) {
  if (!args.spreadsheet_id) throw new Error('Missing spreadsheet_id parameter.');
  if (!args.range) throw new Error('Missing range parameter.');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(args.spreadsheet_id)}/values/${encodeURIComponent(args.range)}`;
  return callGoogleAPI(url, {}, options);
}

async function googleSheetsUpdateRange(args = {}, options = {}) {
  if (!args.spreadsheet_id) throw new Error('Missing spreadsheet_id parameter.');
  if (!args.range) throw new Error('Missing range parameter.');
  if (!args.values) throw new Error('Missing values parameter.');
  const body = { values: args.values };
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(args.spreadsheet_id)}/values/${encodeURIComponent(args.range)}?valueInputOption=USER_ENTERED`;
  return callGoogleAPI(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, options);
}

async function youtubeSearch(args = {}, options = {}) {
  if (!args.query) throw new Error('Missing query parameter.');
  const maxResults = args.max_results || 5;
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(args.query)}&maxResults=${maxResults}&type=video`;
  return callGoogleAPI(url, {}, options);
}

async function youtubeListPlaylists(args = {}, options = {}) {
  const maxResults = args.max_results || 10;
  const url = `https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=${maxResults}`;
  return callGoogleAPI(url, {}, options);
}

async function googlePhotosListAlbums(args = {}, options = {}) {
  const pageSize = args.page_size || 20;
  const url = `https://photoslibrary.googleapis.com/v1/albums?pageSize=${pageSize}`;
  return callGoogleAPI(url, {}, options);
}

async function googlePhotosListMedia(args = {}, options = {}) {
  const pageSize = args.page_size || 20;
  if (args.album_id) {
    const url = 'https://photoslibrary.googleapis.com/v1/mediaItems:search';
    return callGoogleAPI(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumId: args.album_id, pageSize })
    }, options);
  } else {
    const url = `https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=${pageSize}`;
    return callGoogleAPI(url, {}, options);
  }
}

async function googlePhotosCreateAlbum(args = {}, options = {}) {
  if (!args.title) throw new Error('Missing title parameter.');
  const url = 'https://photoslibrary.googleapis.com/v1/albums';
  return callGoogleAPI(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ album: { title: args.title } })
  }, options);
}

function normalizeContactSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim();
}

function compactGooglePerson(person, source) {
  const names = Array.isArray(person.names) ? person.names : [];
  const nicknames = Array.isArray(person.nicknames) ? person.nicknames : [];
  const emailAddresses = Array.isArray(person.emailAddresses) ? person.emailAddresses : [];
  const phoneNumbers = Array.isArray(person.phoneNumbers) ? person.phoneNumbers : [];
  const relations = Array.isArray(person.relations) ? person.relations : [];
  const organizations = Array.isArray(person.organizations) ? person.organizations : [];

  return {
    source,
    resourceName: person.resourceName || '',
    displayName: names[0]?.displayName || names[0]?.unstructuredName || '',
    names: names.map(name => ({
      displayName: name.displayName || '',
      givenName: name.givenName || '',
      familyName: name.familyName || ''
    })).filter(name => name.displayName || name.givenName || name.familyName),
    nicknames: nicknames.map(nickname => nickname.value || '').filter(Boolean),
    emailAddresses: emailAddresses.map(email => ({
      value: email.value || '',
      type: email.type || email.formattedType || ''
    })).filter(email => email.value),
    phoneNumbers: phoneNumbers.map(phone => ({
      value: phone.value || '',
      canonicalForm: phone.canonicalForm || '',
      type: phone.type || phone.formattedType || ''
    })).filter(phone => phone.value || phone.canonicalForm),
    relations: relations.map(relation => ({
      person: relation.person || '',
      type: relation.type || relation.formattedType || ''
    })).filter(relation => relation.person || relation.type),
    organizations: organizations.map(org => ({
      name: org.name || '',
      title: org.title || ''
    })).filter(org => org.name || org.title)
  };
}

function getContactSearchAliases(query) {
  const normalized = normalizeContactSearchText(query);
  const aliases = new Set();
  const relationAliases = {
    mother: ['mother', 'mom', 'mum', 'mama', 'mam', 'moeder'],
    father: ['father', 'dad', 'papa', 'vader'],
    brother: ['brother', 'broer'],
    sister: ['sister', 'zus'],
    partner: ['partner', 'wife', 'husband', 'spouse', 'girlfriend', 'boyfriend', 'vrouw', 'man', 'vriendin', 'vriend']
  };

  for (const values of Object.values(relationAliases)) {
    if (values.some(value => normalized.includes(value))) {
      values.forEach(value => aliases.add(value));
    }
  }
  normalized.split(/\s+/).filter(Boolean).forEach(term => aliases.add(term));
  return Array.from(aliases);
}

function contactMatchesQuery(contact, query) {
  const normalizedQuery = normalizeContactSearchText(query);
  if (!normalizedQuery) return true;

  const aliases = getContactSearchAliases(query);
  const haystack = normalizeContactSearchText([
    contact.displayName,
    ...contact.names.flatMap(name => [name.displayName, name.givenName, name.familyName]),
    ...contact.nicknames,
    ...contact.emailAddresses.map(email => email.value),
    ...contact.phoneNumbers.flatMap(phone => [phone.value, phone.canonicalForm, phone.type]),
    ...contact.relations.flatMap(relation => [relation.person, relation.type]),
    ...contact.organizations.flatMap(org => [org.name, org.title])
  ].join(' '));

  if (haystack.includes(normalizedQuery)) return true;
  return aliases.some(alias => alias.length >= 2 && haystack.includes(alias));
}

async function googleContactsList(args = {}, options = {}) {
  const query = String(args.query || args.name || '').trim();
  const pageSize = Math.min(Math.max(Number(args.page_size) || 500, 1), 1000);
  const maxPages = Math.min(Math.max(Number(args.max_pages) || (query ? 20 : 3), 1), 50);
  const includeOtherContacts = args.include_other_contacts === true || args.include_other_contacts === 'true';
  const personFields = encodeURIComponent('names,nicknames,emailAddresses,phoneNumbers,relations,organizations,metadata');
  const otherContactMask = encodeURIComponent('names,emailAddresses,phoneNumbers');
  const errors = [];
  const connections = [];
  const otherContacts = [];

  try {
    let pageToken = '';
    for (let page = 0; page < maxPages; page++) {
      let connUrl = `https://people.googleapis.com/v1/people/me/connections?pageSize=${pageSize}&personFields=${personFields}`;
      if (pageToken) connUrl += `&pageToken=${encodeURIComponent(pageToken)}`;
      const connData = await callGoogleAPI(connUrl, {}, options);
      if (Array.isArray(connData && connData.connections)) {
        connections.push(...connData.connections.map(person => compactGooglePerson(person, 'connections')));
      }
      pageToken = connData && connData.nextPageToken ? connData.nextPageToken : '';
      if (!pageToken) break;
    }
  } catch (err) {
    if (isGoogleApiDisabledError(err)) {
      throw new Error(getPeopleApiSetupMessage(err));
    }
    if (isGoogleInsufficientScopesError(err)) {
      throw new Error(getGoogleContactsScopeMessage());
    }
    console.error('Error fetching google connections:', err);
    errors.push(`connections: ${err.message}`);
  }

  if (includeOtherContacts) {
    try {
      let pageToken = '';
      for (let page = 0; page < maxPages; page++) {
        let otherUrl = `https://people.googleapis.com/v1/otherContacts?pageSize=${pageSize}&readMask=${otherContactMask}`;
        if (pageToken) otherUrl += `&pageToken=${encodeURIComponent(pageToken)}`;
        const otherData = await callGoogleAPI(otherUrl, {}, options);
        if (Array.isArray(otherData && otherData.otherContacts)) {
          otherContacts.push(...otherData.otherContacts.map(person => compactGooglePerson(person, 'otherContacts')));
        }
        pageToken = otherData && otherData.nextPageToken ? otherData.nextPageToken : '';
        if (!pageToken) break;
      }
    } catch (err) {
      if (isGoogleApiDisabledError(err)) {
        throw new Error(getPeopleApiSetupMessage(err));
      }
      console.error('Error fetching google other contacts:', err);
      errors.push(`otherContacts: ${isGoogleInsufficientScopesError(err) ? getGoogleContactsScopeMessage() : err.message}`);
    }
  }

  const allContacts = connections.concat(otherContacts);
  const contacts = query
    ? allContacts.filter(contact => contactMatchesQuery(contact, query))
    : allContacts.slice(0, Math.min(pageSize, 250));

  return {
    status: errors.length ? 'partial' : 'success',
    query,
    contacts,
    connections: query ? connections.filter(contact => contactMatchesQuery(contact, query)) : connections.slice(0, Math.min(pageSize, 250)),
    otherContacts: query ? otherContacts.filter(contact => contactMatchesQuery(contact, query)) : otherContacts.slice(0, Math.min(pageSize, 250)),
    scanned: {
      connections: connections.length,
      otherContacts: otherContacts.length,
      total: allContacts.length,
      pageSize,
      maxPages,
      includeOtherContacts
    },
    errors,
    note: query && contacts.length === 0
      ? 'No matching contact was found in the scanned Google People contacts. If the user asked for a relationship like mother, ask for the contact name unless a relation/nickname is stored in Google Contacts.'
      : ''
  };
}
