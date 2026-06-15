export function parseVoiceSessionLog(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      if (/Turn complete\b/.test(line)) return { type: 'turnComplete', raw: line };
      if (/Received tool calls:/.test(line)) return { type: 'toolCalls', raw: line };
      const delivered = line.match(/Delivered queued notification(?:\s+\(([^)]+)\))?:\s*(.*)$/);
      if (delivered) {
        return {
          type: 'noticeDelivered',
          lane: delivered[1] || 'unknown',
          message: delivered[2] || '',
          raw: line
        };
      }
      if (/Delivering queued notification:/.test(line)) return { type: 'noticeDequeued', raw: line };
      return { type: 'log', raw: line };
    });
}

export function createVoiceSessionReplay(handlers = {}) {
  const state = {
    turnCompletes: 0,
    toolCallBursts: 0,
    deliveredNotices: [],
    duplicateNoticeMessages: []
  };
  const seenNoticeMessages = new Set();

  function apply(event) {
    if (event.type === 'turnComplete') {
      state.turnCompletes += 1;
      if (handlers.onTurnComplete) handlers.onTurnComplete(event, state);
    } else if (event.type === 'toolCalls') {
      state.toolCallBursts += 1;
      if (handlers.onToolCalls) handlers.onToolCalls(event, state);
    } else if (event.type === 'noticeDelivered') {
      state.deliveredNotices.push(event);
      const key = event.message.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seenNoticeMessages.has(key)) state.duplicateNoticeMessages.push(event.message);
      seenNoticeMessages.add(key);
      if (handlers.onNoticeDelivered) handlers.onNoticeDelivered(event, state);
    }
    if (handlers.onEvent) handlers.onEvent(event, state);
  }

  return {
    state,
    replay(input) {
      const events = Array.isArray(input) ? input : parseVoiceSessionLog(input);
      for (const event of events) apply(event);
      return state;
    }
  };
}
