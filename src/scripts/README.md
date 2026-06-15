# ShadowMac Browser Runtime

The browser app is loaded as ordered classic scripts from `src/index.html`. This preserves the original global runtime behavior while avoiding a single giant `app.js`.

Script order matters:

1. `01-state-dom.js` - settings, constants, runtime state, and DOM references.
2. `02-boot-ui.js` - startup flow and UI event binding.
3. `03-screen-config.js` - screen sharing, config sync, settings updates, manual-connect shims, and confirm modal.
4. `04-audio.js` - audio playback and microphone recording.
5. `05-live-connection.js` - Gemini Live websocket session, reconnects, mute, and interruption handling.
6. `06-transcript.js` - status and transcript rendering.
7. `07-visualizer.js` - canvas visualizer.
8. `08-memory.js` - long-term memory APIs and memory graph.
9. `09-subagents-core.js` - subagent records, routing guards, cancellation, and backend health.
10. `10-scheduler-proactive.js` - scheduler integration, notifications, and proactive attention.
11. `11-subagents-runner.js` - REST subagent model/tool execution.
12. `12-subagents-notifications.js` - subagent result bubbles and voice-session notices.
13. `13-google-workspace.js` - Google Workspace helper APIs.

When moving code between files, keep declarations available before any top-level code that reads them. Function calls made later at runtime can reference functions declared in later script files after all scripts have loaded.
