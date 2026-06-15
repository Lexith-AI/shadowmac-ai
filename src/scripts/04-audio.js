/**
 * ShadowMac - Audio playback and microphone recording classes.
 * Split from the original monolithic app.js; loaded as an ordered classic script.
 */

const OUTPUT_AUDIO_JITTER_BUFFER_SEC = 0.14;
const OUTPUT_AUDIO_UNDERRUN_LOG_THRESHOLD_SEC = 0.025;
const OUTPUT_AUDIO_UNDERRUN_LOG_INTERVAL_MS = 1500;
const OUTPUT_AUDIO_STALL_THINKING_MS = 2200;
const OUTPUT_AUDIO_STALL_RECOVERY_MS = 8000;

// --- Audio Player Class (24kHz Output) ---
class AudioPlayer {
  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
    this.audioContext = null;
    this.nextPlayTime = 0;
    this.activeSources = [];
    this.gainNode = null;
    this.analyser = null;
    this._interrupted = false;
    this._volHistory = [];
    this.underrunCount = 0;
    this.lastUnderrunLogAt = 0;
    this.outputStallTimer = null;
  }

  clearOutputStallTimer() {
    if (this.outputStallTimer) {
      clearTimeout(this.outputStallTimer);
      this.outputStallTimer = null;
    }
  }

  scheduleOutputStallWatchdog(stage = 'soft') {
    this.clearOutputStallTimer();
    if (!turnInProgress || !['speaking', 'thinking'].includes(currentVisualizerState)) return;
    const nextStage = stage === 'recover' ? 'recover' : 'soft';
    const delay = nextStage === 'recover'
      ? Math.max(0, OUTPUT_AUDIO_STALL_RECOVERY_MS - OUTPUT_AUDIO_STALL_THINKING_MS)
      : OUTPUT_AUDIO_STALL_THINKING_MS;

    this.outputStallTimer = setTimeout(() => {
      this.outputStallTimer = null;
      if (
        this.activeSources.length === 0 &&
        turnInProgress &&
        ['speaking', 'thinking'].includes(currentVisualizerState)
      ) {
        if (nextStage === 'soft') {
          if (typeof handleOutputAudioSoftStall === 'function') {
            handleOutputAudioSoftStall();
          }
          this.scheduleOutputStallWatchdog('recover');
        } else if (typeof handleOutputAudioRecoveryStall === 'function') {
          handleOutputAudioRecoveryStall();
        }
      }
    }, delay);
  }

  init() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.sampleRate });
      this.gainNode = this.audioContext.createGain();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.gainNode.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }

  set interrupted(value) {
    this._interrupted = value;
  }

  get interrupted() {
    return this._interrupted;
  }

  playChunk(base64Data) {
    this.init();
    this.clearOutputStallTimer();

    // Don't play audio if we've been interrupted
    if (this._interrupted) {
      return;
    }

    try {
      // Decode Base64 to Binary ArrayBuffer
      const binaryString = atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const arrayBuffer = bytes.buffer;

      // Convert 16-bit little-endian PCM to Float32
      const int16Array = new Int16Array(arrayBuffer);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }

      // Create Web Audio Buffer
      const audioBuffer = this.audioContext.createBuffer(1, float32Array.length, this.sampleRate);
      audioBuffer.copyToChannel(float32Array, 0);

      // Create Buffer Source
      const sourceNode = this.audioContext.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(this.gainNode);

      const now = this.audioContext.currentTime;
      if (this.nextPlayTime <= now) {
        const underrunGap = this.nextPlayTime > 0 ? now - this.nextPlayTime : 0;
        if (underrunGap >= OUTPUT_AUDIO_UNDERRUN_LOG_THRESHOLD_SEC) {
          this.underrunCount++;
          const logNow = Date.now();
          if (logNow - this.lastUnderrunLogAt >= OUTPUT_AUDIO_UNDERRUN_LOG_INTERVAL_MS) {
            console.warn(`[Audio] Output underrun ${this.underrunCount}: gap ${Math.round(underrunGap * 1000)}ms. Rebuffering ${Math.round(OUTPUT_AUDIO_JITTER_BUFFER_SEC * 1000)}ms.`);
            this.lastUnderrunLogAt = logNow;
          }
        }
        this.nextPlayTime = now + OUTPUT_AUDIO_JITTER_BUFFER_SEC;
      }

      sourceNode.start(this.nextPlayTime);

      const sourceInfo = {
        node: sourceNode,
        startTime: this.nextPlayTime,
        duration: audioBuffer.duration
      };
      this.activeSources.push(sourceInfo);

      // Increment future play time
      this.nextPlayTime += audioBuffer.duration;

      sourceNode.onended = () => {
        this.activeSources = this.activeSources.filter(s => s.node !== sourceNode);
        if (this.activeSources.length === 0) {
          this.nextPlayTime = 0;
          this.underrunCount = 0;
          this.lastUnderrunLogAt = 0;
          if (turnInProgress && currentVisualizerState === 'speaking') {
            this.scheduleOutputStallWatchdog();
          } else if (!turnInProgress && currentVisualizerState === 'speaking') {
            setVisualizerState('listening');
          }
        }
      };
    } catch (err) {
      console.error('Error playing audio chunk:', err);
    }
  }

  getVolume() {
    if (!this.analyser) return 0;
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
    }
    const currentVol = sum / dataArray.length / 255; // Normalized 0 to 1

    // Maintain recent volume history (last 800ms) to bridge brief speech pauses
    const now = Date.now();
    this._volHistory.push({ time: now, vol: currentVol });
    const cutoff = now - 800;
    this._volHistory = this._volHistory.filter(item => item.time >= cutoff);

    // Return the peak volume in the active window (peak hold)
    let maxVol = 0;
    for (let i = 0; i < this._volHistory.length; i++) {
      if (this._volHistory[i].vol > maxVol) {
        maxVol = this._volHistory[i].vol;
      }
    }
    return maxVol;
  }

  getFrequencyData() {
    if (!this.analyser) return new Uint8Array(0);
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);
    return dataArray;
  }

  stop() {
    this.clearOutputStallTimer();
    this.activeSources.forEach(source => {
      try {
        source.node.stop();
      } catch (e) {}
    });
    this.activeSources = [];
    this.nextPlayTime = 0;
    this._interrupted = true;
    this._volHistory = [];
    this.underrunCount = 0;
    this.lastUnderrunLogAt = 0;
  }

  reset() {
    this.clearOutputStallTimer();
    this._interrupted = false;
    this._volHistory = [];
    if (this.activeSources.length === 0) {
      this.nextPlayTime = 0;
      this.underrunCount = 0;
      this.lastUnderrunLogAt = 0;
    }
  }

  close() {
    this.stop();
    this.clearOutputStallTimer();
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
      this.analyser = null;
      this.gainNode = null;
    }
  }
}

// --- Audio Recorder Class (16kHz Input) ---
class AudioRecorder {
  constructor(onAudioChunk) {
    this.onAudioChunk = onAudioChunk;
    this.audioContext = null;
    this.mediaStream = null;
    this.source = null;
    this.processor = null;
    this.analyser = null;
  }

  // Acquire a mic stream for the device the user picked in Settings. Uses "exact" so Chrome actually
  // honors the choice (with "ideal" it often silently falls back to the system default); if that exact
  // device is unavailable (e.g. unplugged), retries without the constraint so audio still works on the
  // default mic instead of failing outright.
  async _getMicStream() {
    const baseAudio = { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 };
    let wantId = (typeof selectedMicDeviceId === 'string' && selectedMicDeviceId) ? selectedMicDeviceId : '';
    // Only constrain to the saved device when it's ACTUALLY present right now. A saved device that is
    // currently absent (unplugged, or a virtual mic like NVIDIA Broadcast whose app isn't running)
    // lists fine in Settings but would throw OverconstrainedError on every connect. In that case use
    // the default this time WITHOUT erasing the saved preference, so it's used again once it returns.
    if (wantId && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      try {
        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(function (d) { return d.kind === 'audioinput'; });
        const idsExposed = inputs.some(function (d) { return d.deviceId; });
        const present = inputs.some(function (d) { return d.deviceId === wantId; });
        if (idsExposed && !present) wantId = '';
      } catch (e) {}
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: wantId ? Object.assign({}, baseAudio, { deviceId: { exact: wantId } }) : baseAudio
      });
    } catch (err) {
      if (wantId && (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError'))) {
        console.warn('Selected microphone unavailable; falling back to the default device.', err);
        stream = await navigator.mediaDevices.getUserMedia({ audio: baseAudio });
      } else {
        throw err;
      }
    }
    // A live grant exposes real device names — learn them so the Settings picker can show them later.
    if (typeof window.cacheMicLabels === 'function') {
      navigator.mediaDevices.enumerateDevices()
        .then(function (devs) { window.cacheMicLabels(devs.filter(function (d) { return d.kind === 'audioinput'; })); })
        .catch(function () {});
    }
    return stream;
  }

  // Hot-swap the input device mid-call: re-acquire the stream for the currently-selected mic and splice
  // the new source node into the running audio graph, leaving the processor/analyser (and the live
  // socket) untouched so the call continues seamlessly. No-op if not currently capturing.
  async switchDevice() {
    if (!this.audioContext || !this.processor || !this.analyser) return;
    let newStream;
    try {
      newStream = await this._getMicStream();
    } catch (err) {
      console.warn('Could not switch microphone; keeping the current device.', err);
      return;
    }
    const newSource = this.audioContext.createMediaStreamSource(newStream);
    if (this.source) { try { this.source.disconnect(); } catch (e) {} }
    if (this.mediaStream) { this.mediaStream.getTracks().forEach(function (t) { t.stop(); }); }
    this.mediaStream = newStream;
    this.source = newSource;
    this.source.connect(this.analyser);
    this.source.connect(this.processor);
  }

  async start() {
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

      this.mediaStream = await this._getMicStream();

      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);

      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.source.connect(this.analyser);

      const bufferSize = 2048;
      this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

      this.source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      const inputSampleRate = this.audioContext.sampleRate;
      const targetSampleRate = 16000;

      this.processor.onaudioprocess = (e) => {
        let inputData = e.inputBuffer.getChannelData(0);

        // Push-to-talk gate. When a key is bound:
        //  - held (or within the brief release tail) -> force the mic open, bypassing the VAD/echo gate.
        //  - not held -> fall through to the noise gate and stream continuous SILENCE (never nothing).
        //    Gemini Live's server VAD needs an unbroken audio stream to detect end-of-speech; dropping
        //    frames entirely makes turns finalize painfully slowly and segment erratically.
        const pttArmed = (typeof pttIsArmed === 'function') && pttIsArmed();
        const pttGateClosed = pttArmed && !pttIsOpen();
        const pttForcePass = pttArmed && !pttGateClosed;
        // Muting must behave like a CLOSED gate, not a dead stream: stop passing the user's audio and skip
        // barge-in, but keep streaming continuous SILENCE below. The old `if (isMuted) return` broke the
        // audio stream to Gemini for the whole mute, which wedged the server VAD so the model often went
        // silent after unmuting — the exact failure PTT had before it switched to streaming silence.
        const inputGateClosed = isMuted || pttGateClosed;

        // Analyze volume for user audio activity & dynamic echo gate
        const micLevel = this.getVolume();
        const playVolume = (audioPlayer && typeof audioPlayer.getVolume === 'function') ? audioPlayer.getVolume() : 0;
        const dynamicThreshold = getDynamicMicThreshold(playVolume, {
          protectPlayback: turnInProgress || currentVisualizerState === 'speaking'
        });
        const candidateThreshold = typeof getLocalBargeInCandidateThreshold === 'function'
          ? getLocalBargeInCandidateThreshold(playVolume)
          : MIC_LEVEL_THRESHOLD;

        const micAboveThreshold = micLevel >= dynamicThreshold;
        const playbackActiveForBargeIn = isPlaybackActiveForBargeIn();
        // The elevated barge-in gate (which forces the user to "talk over" the AI to be heard) should
        // apply ONLY when there is a real reason for it: audio is ACTUALLY playing (echo protection)
        // or a backend command/tool is genuinely mid-flight. We deliberately do NOT gate on the
        // 'thinking'/'interrupting' visualizer state or a lingering tool-follow-up flag -- those can
        // get STUCK with nothing actually happening, which silently throttles the mic and is the root
        // cause of the rare "Shadow suddenly stops replying" freeze (you'd have to reconnect). When
        // nothing is playing the mic stays open at the normal threshold, so the user is ALWAYS heard
        // immediately and can simply talk to recover even if a turn got stuck. (PTT/mute still force
        // the gate closed via inputGateClosed and stream silence below.)
        const realBackendWorkActive =
          (typeof activeLiveBackendCommandIds !== 'undefined' && activeLiveBackendCommandIds.size > 0) ||
          (typeof activeLiveToolCallEpochs !== 'undefined' && activeLiveToolCallEpochs.size > 0);
        const activeWorkForBargeIn = inputGateClosed
          ? false
          : (playbackActiveForBargeIn || realBackendWorkActive);
        const micAboveCandidateThreshold = micLevel >= candidateThreshold;
        // Gate closed (muted or PTT not held) -> never pass the user's audio (we stream silence below).
        // PTT held -> always pass.
        let shouldPassMicAudio = inputGateClosed ? false : (micAboveThreshold || pttForcePass);
        let shouldBufferLocalBargeInAudio = false;
        let shouldFlushLocalBargeInPreroll = false;
        let shouldSendLocalBargeInInterruptSignal = false;

        if (activeWorkForBargeIn && micAboveCandidateThreshold) {
          const wasLocalBargeInActive = localBargeInActive;
          const triggeredLocalBargeIn = maybeTriggerLocalBargeIn(micLevel, dynamicThreshold, {
            echoProtected: playbackActiveForBargeIn ? micAboveThreshold : true
          });
          shouldPassMicAudio = triggeredLocalBargeIn || localBargeInActive;
          shouldBufferLocalBargeInAudio = !shouldPassMicAudio && !wasLocalBargeInActive;
          shouldFlushLocalBargeInPreroll = triggeredLocalBargeIn;
          shouldSendLocalBargeInInterruptSignal = triggeredLocalBargeIn;
        }

        // While the PTT key is held, the user is deliberately talking — always stream their audio
        // (the barge-in block above may still fire its interrupt so holding to talk cuts the AI off).
        if (pttForcePass) shouldPassMicAudio = true;
        if (pttGateClosed) shouldPassMicAudio = false;
        if (isMuted) shouldPassMicAudio = false; // mute is the hard override — beats PTT-held

        if (shouldPassMicAudio) {
          markUserAudioActivity('microphone');
        } else if (!micAboveCandidateThreshold) {
          resetLocalBargeInDetection({
            preservePreroll: activeWorkForBargeIn
          });
        }

        // Apply noise gate at all times to prevent background noise from keeping the server VAD open indefinitely,
        // and to prevent server-side false VAD barge-ins when AI is speaking.
        if (!shouldPassMicAudio) {
          // Buffer the user's REAL audio so a local barge-in can flush the lead-in (the instant they
          // start talking over the AI) without clipping the first syllables.
          if (activeWorkForBargeIn && shouldBufferLocalBargeInAudio) {
            const bufferedData = this.resample(inputData, inputSampleRate, targetSampleRate);
            const bufferedPcm16 = this.convertFloat32ToInt16(bufferedData);
            queueLocalBargeInPrerollChunk(this.base64ArrayBuffer(bufferedPcm16.buffer));
          }
          // Stream continuous SILENCE rather than dropping frames. The old early `return` here (taken
          // while "work" was active) sent NOTHING to the server, which wedges Gemini's server VAD:
          // if any barge-in gate flag ever gets stuck true (e.g. a turn that ends without a
          // turnComplete, leaving the visualizer on "thinking"), the mic stream goes fully dark and
          // the model never detects end-of-speech again — the rare "circle still reacts but no reply
          // until manual reconnect" freeze. Streaming silence keeps the VAD alive and matches the
          // mute / PTT-closed behavior, honoring the "apply the noise gate at all times" rule above.
          inputData = new Float32Array(inputData.length);
        }

        // Downsample Float32 down to 16kHz
        const resampledData = this.resample(inputData, inputSampleRate, targetSampleRate);

        // Convert to Int16 PCM
        const pcm16 = this.convertFloat32ToInt16(resampledData);

        // Base64 encode PCM ArrayBuffer
        const base64 = this.base64ArrayBuffer(pcm16.buffer);

        if (shouldFlushLocalBargeInPreroll) {
          const prerollChunks = consumeLocalBargeInPrerollChunks();
          for (const chunk of prerollChunks) {
            this.onAudioChunk(chunk);
          }
        }
        this.onAudioChunk(base64);
        if (
          shouldSendLocalBargeInInterruptSignal &&
          typeof sendServerInterruptSignal === 'function' &&
          !serverInterruptPending
        ) {
          const sentInterrupt = sendServerInterruptSignal('local barge-in after mic pre-roll');
          if (sentInterrupt && typeof scheduleInterruptedTurnFallback === 'function') {
            scheduleInterruptedTurnFallback();
          }
        }
      };
    } catch (err) {
      console.error('Failed to initialize microphone:', err);
      addSystemMessage('Microphone access denied or error occurred.');
      throw err;
    }
  }

  resample(inputBuffer, inputSampleRate, outputSampleRate) {
    if (inputSampleRate === outputSampleRate) {
      return inputBuffer;
    }
    const sampleRateRatio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(inputBuffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetInput = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0, count = 0;
      for (let i = offsetInput; i < nextOffsetBuffer && i < inputBuffer.length; i++) {
        accum += inputBuffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? Math.max(-1, Math.min(1, accum / count)) : 0;
      offsetResult++;
      offsetInput = nextOffsetBuffer;
    }
    return result;
  }

  convertFloat32ToInt16(buffer) {
    const buf = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      const s = Math.max(-1, Math.min(1, buffer[i]));
      buf[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return buf;
  }

  base64ArrayBuffer(arrayBuffer) {
    let binary = '';
    const bytes = new Uint8Array(arrayBuffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  // The mic stream stays live even when PTT is closed (we gate what's SENT, not the capture), so
  // treat a closed PTT gate like mute for visualization — otherwise the blob reacts to the user's
  // voice while the key isn't held, making it look like Shadow is listening when it isn't.
  _inputSilencedForVisuals() {
    if (isMuted) return true;
    return (typeof pttIsArmed === 'function' && pttIsArmed() && typeof pttIsOpen === 'function' && !pttIsOpen());
  }

  getVolume() {
    if (!this.analyser || this._inputSilencedForVisuals()) return 0;
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
    }
    return sum / dataArray.length / 255;
  }

  getFrequencyData() {
    if (!this.analyser || this._inputSilencedForVisuals()) return new Uint8Array(0);
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);
    return dataArray;
  }

  stop() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.analyser = null;
  }
}
