/**
 * ShadowMac - Onboarding live voice preview.
 *
 * A lightweight, isolated Gemini Live session used ONLY by onboarding's "meet your voice" step, so
 * the user hears the REAL 3.1 voice (not the TTS approximation) and can actually talk to it. It is
 * deliberately small: its own websocket, a short introduction-only system prompt, the selected
 * prebuilt voice, NO tools and NO memory. It reuses the standalone AudioPlayer for playback and a
 * dedicated minimal mic capture (NOT the main AudioRecorder, whose onaudioprocess is coupled to
 * main-session globals — PTT gating, barge-in, mute, the main audioPlayer — which would interfere).
 */

const ONBOARDING_PREVIEW_INPUT_RATE = 16000;

let obvSocket = null;
let obvCaptureCtx = null;
let obvProcessor = null;
let obvMicStream = null;
let obvSource = null;
let obvPlayer = null;          // AudioPlayer (24kHz output)
let obvActive = false;
let obvAttemptId = 0;
let obvSwitchTimer = null;
let obvStateCb = null;         // (state, detail) -> void; state: connecting|listening|speaking|error
let obvCurrent = { voice: 'Leda', name: '', accent: 'neutral', micDeviceId: '' };
let obvSpeaking = false;       // is the assistant currently producing audio for this turn?
let obvSuppress = false;       // after a local barge-in, suppress the rest of the interrupted turn's audio
let obvBargeFrames = 0;        // consecutive mic frames over the barge-in threshold (debounce)

function buildOnboardingIntroPrompt(name, accent) {
  const who = (name && String(name).trim()) ? String(name).trim() : 'a friendly companion';
  let prompt = `You are ${who}, a warm, friendly voice companion meeting the user for the very first time during app setup. `
    + `Greet them in ONE short, natural sentence (use your name), then keep chatting casually, one or two short sentences at a time. `
    + `Be lively and genuinely human. Do NOT mention setup, onboarding, models, settings, or that you are an AI, and do not list your capabilities — just be warm and conversational.`;
  const accentDesc = (typeof ACCENT_DESCRIPTIONS === 'object' && ACCENT_DESCRIPTIONS && accent && ACCENT_DESCRIPTIONS[accent])
    ? ACCENT_DESCRIPTIONS[accent] : '';
  if (accentDesc) prompt += `\n\n${accentDesc}`;
  return prompt;
}

function _obvSetState(state, detail) {
  if (typeof obvStateCb === 'function') { try { obvStateCb(state, detail); } catch (e) {} }
}

function _obvBase64FromPcm16(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return window.btoa(binary);
}

function _obvResampleTo16k(input, inRate) {
  if (inRate === ONBOARDING_PREVIEW_INPUT_RATE) return input;
  const ratio = inRate / ONBOARDING_PREVIEW_INPUT_RATE;
  const outLen = Math.round(input.length / ratio);
  const out = new Float32Array(outLen);
  let oi = 0, ii = 0;
  while (oi < outLen) {
    const next = Math.round((oi + 1) * ratio);
    let acc = 0, cnt = 0;
    for (let i = ii; i < next && i < input.length; i++) { acc += input[i]; cnt++; }
    out[oi] = cnt > 0 ? Math.max(-1, Math.min(1, acc / cnt)) : 0;
    oi++; ii = next;
  }
  return out;
}

function _obvFloat32ToPcm16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

async function _obvStartMicCapture(attemptId) {
  const baseAudio = { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 };
  const wantId = (typeof obvCurrent.micDeviceId === 'string' && obvCurrent.micDeviceId) ? obvCurrent.micDeviceId : '';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: wantId ? Object.assign({}, baseAudio, { deviceId: { exact: wantId } }) : baseAudio });
  } catch (e) {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: baseAudio }); } catch (e2) { return; }
  }
  if (attemptId !== obvAttemptId) { try { stream.getTracks().forEach(t => t.stop()); } catch (e) {} return; }
  obvMicStream = stream;
  obvCaptureCtx = new (window.AudioContext || window.webkitAudioContext)();
  obvSource = obvCaptureCtx.createMediaStreamSource(stream);
  obvProcessor = obvCaptureCtx.createScriptProcessor(2048, 1, 1);
  const inRate = obvCaptureCtx.sampleRate;
  obvProcessor.onaudioprocess = (e) => {
    if (!obvActive || attemptId !== obvAttemptId || !obvSocket || obvSocket.readyState !== WebSocket.OPEN) return;
    const data = e.inputBuffer.getChannelData(0);

    // Local barge-in: when the user talks over the assistant, cut playback instantly and suppress the
    // rest of that turn's audio so interruption feels immediate (like the main app). The mic keeps
    // streaming, so the server hears the user and the server-side interrupt + new turn follow. A short
    // sustained threshold (with echoCancellation on) keeps the assistant's own echo from self-triggering.
    if (obvSpeaking && !obvSuppress) {
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
      const level = sum / data.length;
      if (level > 0.03) {
        obvBargeFrames++;
        if (obvBargeFrames >= 2) {
          obvSuppress = true;
          obvSpeaking = false;
          obvBargeFrames = 0;
          if (obvPlayer) { try { obvPlayer.stop(); obvPlayer.reset(); } catch (e) {} }
          _obvSetState('listening');
        }
      } else {
        obvBargeFrames = 0;
      }
    }

    const resampled = _obvResampleTo16k(data, inRate);
    const pcm16 = _obvFloat32ToPcm16(resampled);
    const b64 = _obvBase64FromPcm16(pcm16.buffer);
    try { obvSocket.send(JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: b64 } } })); } catch (e) {}
  };
  obvSource.connect(obvProcessor);
  obvProcessor.connect(obvCaptureCtx.destination);
}

function _obvTeardownMic() {
  try { if (obvProcessor) { obvProcessor.disconnect(); obvProcessor.onaudioprocess = null; } } catch (e) {}
  try { if (obvSource) obvSource.disconnect(); } catch (e) {}
  try { if (obvMicStream) obvMicStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { if (obvCaptureCtx) obvCaptureCtx.close(); } catch (e) {}
  obvProcessor = null; obvSource = null; obvMicStream = null; obvCaptureCtx = null;
}

// Fully tear down the preview session: socket, mic, and player. Safe to call repeatedly.
function stopOnboardingVoicePreview() {
  obvActive = false;
  obvAttemptId++;
  obvSpeaking = false; obvSuppress = false; obvBargeFrames = 0;
  clearTimeout(obvSwitchTimer); obvSwitchTimer = null;
  _obvTeardownMic();
  if (obvPlayer) { try { obvPlayer.stop(); obvPlayer.close(); } catch (e) {} obvPlayer = null; }
  if (obvSocket) { try { obvSocket.onmessage = null; obvSocket.onerror = null; obvSocket.onclose = null; obvSocket.close(); } catch (e) {} obvSocket = null; }
}

// Open a fresh preview session in the given voice/name/accent and let the user talk to it.
function startOnboardingVoicePreview(opts = {}) {
  const key = (typeof apiKey === 'string' && apiKey.trim())
    ? apiKey.trim()
    : (typeof onboardingApiKey !== 'undefined' && onboardingApiKey && onboardingApiKey.value ? onboardingApiKey.value.trim() : '');
  stopOnboardingVoicePreview();
  obvCurrent = {
    voice: opts.voice || obvCurrent.voice || 'Leda',
    name: (typeof opts.name === 'string') ? opts.name : obvCurrent.name,
    accent: opts.accent || obvCurrent.accent || 'neutral',
    micDeviceId: (typeof opts.micDeviceId === 'string') ? opts.micDeviceId : (typeof selectedMicDeviceId === 'string' ? selectedMicDeviceId : '')
  };
  if (typeof opts.onState === 'function') obvStateCb = opts.onState;
  if (!key) { _obvSetState('error', 'no-key'); return; }

  obvActive = true;
  const attemptId = ++obvAttemptId;
  _obvSetState('connecting');

  const model = (typeof DEFAULT_LIVE_MODEL === 'string') ? DEFAULT_LIVE_MODEL : 'models/gemini-3.1-flash-live-preview';
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;
  let sock;
  try { sock = new WebSocket(url); } catch (e) { obvActive = false; _obvSetState('error', 'ws'); return; }
  obvSocket = sock;

  sock.onopen = () => {
    if (attemptId !== obvAttemptId) return;
    const setup = {
      setup: {
        model: model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: obvCurrent.voice } } }
        },
        systemInstruction: { parts: [{ text: buildOnboardingIntroPrompt(obvCurrent.name, obvCurrent.accent) }] },
        // Let the server interrupt the model the moment the user starts speaking (natural barge-in).
        realtimeInputConfig: { automaticActivityDetection: {}, activityHandling: 'START_OF_ACTIVITY_INTERRUPTS' }
      }
    };
    try { sock.send(JSON.stringify(setup)); } catch (e) {}
  };

  sock.onmessage = async (ev) => {
    if (attemptId !== obvAttemptId) return;
    let text;
    if (ev.data instanceof Blob) { try { text = await ev.data.text(); } catch (e) { return; } }
    else { text = ev.data; }
    let msg; try { msg = JSON.parse(text); } catch (e) { return; }

    if (msg.setupComplete) {
      obvPlayer = new AudioPlayer(24000);
      _obvSetState('listening');
      await _obvStartMicCapture(attemptId);
      // Trigger an immediate greeting so the user hears the voice without having to talk first.
      try {
        sock.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: '[The user just arrived. Greet them warmly in one short sentence.]' }] }], turnComplete: true } }));
      } catch (e) {}
      return;
    }

    if (msg.serverContent) {
      const c = msg.serverContent;
      if (c.interrupted) {
        if (obvPlayer) { try { obvPlayer.stop(); obvPlayer.reset(); } catch (e) {} }
        obvSpeaking = false; obvSuppress = false; obvBargeFrames = 0;
        _obvSetState('listening');
      }
      if (c.modelTurn && Array.isArray(c.modelTurn.parts) && !obvSuppress) {
        c.modelTurn.parts.forEach(part => {
          if (part.inlineData && part.inlineData.data && obvPlayer) {
            obvSpeaking = true;
            _obvSetState('speaking');
            obvPlayer.playChunk(part.inlineData.data);
          }
        });
      }
      if (c.turnComplete) {
        obvSpeaking = false; obvSuppress = false; obvBargeFrames = 0;
        _obvSetState('listening');
      }
    }
  };

  sock.onerror = () => { if (attemptId === obvAttemptId) _obvSetState('error', 'ws'); };
  sock.onclose = () => {
    if (attemptId === obvAttemptId && obvActive) { _obvSetState('error', 'closed'); }
  };
}

// Switch to a new voice — debounced so rapid ◀ ▶ clicks don't cause a reconnect storm / 429s.
function switchOnboardingVoice(voice) {
  obvCurrent.voice = voice;
  _obvSetState('connecting');
  clearTimeout(obvSwitchTimer);
  obvSwitchTimer = setTimeout(() => { startOnboardingVoicePreview(Object.assign({}, obvCurrent, { voice: voice })); }, 400);
}

window.startOnboardingVoicePreview = startOnboardingVoicePreview;
window.stopOnboardingVoicePreview = stopOnboardingVoicePreview;
window.switchOnboardingVoice = switchOnboardingVoice;
