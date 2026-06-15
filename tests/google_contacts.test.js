import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

function loadGoogleWorkspaceWithFetch(fetchImpl, extraContext = {}) {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '13-google-workspace.js'), 'utf8');
  const context = {
    console,
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    ...extraContext
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

describe('googleContactsList setup failures', () => {
  it('uses bounded fetches for Google Workspace helper calls', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scripts', '13-google-workspace.js'), 'utf8');

    expect(source).toContain('async function fetchWorkspaceWithTimeout');
    expect(source).toContain('const GOOGLE_LOCAL_API_TIMEOUT_MS = 15000');
    expect(source).toContain('const GOOGLE_API_TIMEOUT_MS = 12000');
    expect(source).toContain('const GOOGLE_DRIVE_DOWNLOAD_TIMEOUT_MS = 30000');
    expect(source).toContain('function getWorkspaceAbortSignal');
    expect(source).toContain('options.subagentRecord.abortController.signal');
    expect(source).toContain('const { subagentRecord, label, ...requestOptions }');
    expect(source).toContain("fetchWorkspaceWithTimeout('/api/google/status', {}, GOOGLE_LOCAL_API_TIMEOUT_MS)");
    expect(source).toContain("fetchWorkspaceWithTimeout('/api/google/token', options, GOOGLE_LOCAL_API_TIMEOUT_MS)");
    expect(source).toContain('fetchWorkspaceWithTimeout(url, requestOptions, GOOGLE_API_TIMEOUT_MS)');
    expect(source).toContain('GOOGLE_DRIVE_LOCAL_UPLOAD_TIMEOUT_MS');
    expect(source).toContain('GOOGLE_DRIVE_DOWNLOAD_TIMEOUT_MS');
    expect(source).toContain('function cancelWorkspaceBackendRequests');
    expect(source).toContain("cancelShadowBackendRequest(requestId, reason)");
    expect(source).not.toContain("fetch('/api/google/status'");
    expect(source).not.toContain("fetch('/api/google/token'");
  });

  it('propagates the active Live tool abort signal through Workspace API fetches', async () => {
    const controller = new AbortController();
    const calls = [];
    const context = loadGoogleWorkspaceWithFetch(async () => {
      throw new Error('raw fetch should not be used');
    }, {
      currentLiveToolAbortSignal: controller.signal,
      fetchWithTimeout: async (url, options = {}, timeoutMs) => {
        calls.push({ url: String(url), signal: options.signal, timeoutMs });
        if (String(url) === '/api/google/token') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'success', access_token: 'token' })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ connections: [] })
        };
      }
    });

    await context.googleContactsList({ query: 'mom' });

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every(call => call.signal === controller.signal)).toBe(true);
    expect(calls[0].timeoutMs).toBe(15000);
    expect(calls[1].timeoutMs).toBe(12000);
  });

  it('propagates a subagent abort signal through Workspace API fetches', async () => {
    const subagentRecord = { abortController: new AbortController() };
    const calls = [];
    const context = loadGoogleWorkspaceWithFetch(async () => {
      throw new Error('raw fetch should not be used');
    }, {
      fetchWithTimeout: async (url, options = {}, timeoutMs) => {
        calls.push({ url: String(url), signal: options.signal, subagentRecord: options.subagentRecord, timeoutMs });
        if (String(url) === '/api/google/token') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'success', access_token: 'token' })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ connections: [] })
        };
      }
    });

    await context.googleContactsList({ query: 'mom' }, { subagentRecord });

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every(call => call.signal === subagentRecord.abortController.signal)).toBe(true);
    expect(calls.every(call => call.subagentRecord === undefined)).toBe(true);
  });

  it('attaches cancellable request metadata to local Drive uploads', async () => {
    const requests = [];
    const cancelled = [];
    const context = loadGoogleWorkspaceWithFetch(async (url, options = {}) => {
      requests.push({ url: String(url), body: JSON.parse(options.body || '{}') });
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', file: { id: 'drive_file_1' } })
      };
    }, {
      cancelShadowBackendRequest: (requestId, reason) => {
        cancelled.push({ requestId, reason });
        return Promise.resolve(true);
      }
    });

    const result = await context.googleDriveUploadLocalFile({ path: 'G:\\video.mp4' }, { label: 'test_upload' });

    expect(result.file.id).toBe('drive_file_1');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/api/google/upload-local-file');
    expect(requests[0].body.request_id).toMatch(/^test_upload_/);
    expect(requests[0].body.timeout_ms).toBe(30 * 60 * 1000);

    context.trackWorkspaceBackendRequest('manual_req');
    expect(context.cancelWorkspaceBackendRequests('manual interrupt')).toBe(1);
    expect(cancelled).toEqual([{ requestId: 'manual_req', reason: 'manual interrupt' }]);
  });

  it('cancels the backend local Drive upload when the frontend upload times out', async () => {
    const cancelled = [];
    const context = loadGoogleWorkspaceWithFetch(async () => {
      throw new Error('Request timed out after 1800s.');
    }, {
      cancelShadowBackendRequest: (requestId, reason) => {
        cancelled.push({ requestId, reason });
        return Promise.resolve(true);
      }
    });

    await expect(context.googleDriveUploadLocalFile({ path: 'G:\\large.mp4' }, { label: 'timeout_upload' }))
      .rejects.toThrow(/timed out/);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].requestId).toMatch(/^timeout_upload_/);
    expect(cancelled[0].reason).toContain('timed out');
  });

  it('surfaces a People API disabled setup error and stops after the first contacts request', async () => {
    const calls = [];
    const context = loadGoogleWorkspaceWithFetch(async url => {
      calls.push(String(url));
      if (url === '/api/google/token') {
        return {
          ok: true,
          json: async () => ({ status: 'success', access_token: 'token' })
        };
      }
      return {
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            code: 403,
            message: 'People API has not been used in project 738706402556 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/people.googleapis.com/overview?project=738706402556 then retry.',
            status: 'PERMISSION_DENIED'
          }
        })
      };
    });

    await expect(context.googleContactsList({ query: 'mom' })).rejects.toThrow(/People API is disabled/);
    expect(calls.filter(url => url.includes('people.googleapis.com'))).toHaveLength(1);
  });

  it('does not request other contacts by default', async () => {
    const calls = [];
    const context = loadGoogleWorkspaceWithFetch(async url => {
      const requestUrl = String(url);
      calls.push(requestUrl);
      if (requestUrl === '/api/google/token') {
        return {
          ok: true,
          json: async () => ({ status: 'success', access_token: 'token' })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          connections: [{
            resourceName: 'people/1',
            names: [{ displayName: 'Jane Doe' }],
            emailAddresses: [{ value: 'jane@example.com' }]
          }]
        })
      };
    });

    const result = await context.googleContactsList({ query: 'Jane' });
    expect(result.status).toBe('success');
    expect(result.contacts).toHaveLength(1);
    expect(calls.some(url => url.includes('/otherContacts'))).toBe(false);
  });

  it('keeps connection contacts when optional other contacts lacks scope', async () => {
    const context = loadGoogleWorkspaceWithFetch(async url => {
      const requestUrl = String(url);
      if (requestUrl === '/api/google/token') {
        return {
          ok: true,
          json: async () => ({ status: 'success', access_token: 'token' })
        };
      }
      if (requestUrl.includes('/people/me/connections')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            connections: [{
              resourceName: 'people/1',
              names: [{ displayName: 'Jane Doe' }],
              emailAddresses: [{ value: 'jane@example.com' }]
            }]
          })
        };
      }
      return {
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            code: 403,
            message: 'Request had insufficient authentication scopes.',
            status: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'
          }
        })
      };
    });

    const result = await context.googleContactsList({ query: 'Jane', include_other_contacts: true });
    expect(result.status).toBe('partial');
    expect(result.contacts).toHaveLength(1);
    expect(result.errors[0]).toMatch(/Disconnect and reconnect Google/);
  });
});
