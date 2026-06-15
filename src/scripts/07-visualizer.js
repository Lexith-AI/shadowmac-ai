/**
 * ShadowMac - Canvas visualizer animation engine.
 * Split from the original monolithic app.js; loaded as an ordered classic script.
 */

// --- Canvas Visualizer Animation Engine ---
let time = 0;
const baseRadius = 130;
let particles = [];

// Initialize simple particles
for (let i = 0; i < 45; i++) {
  particles.push({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    radius: Math.random() * 2 + 0.5,
    speedX: (Math.random() - 0.5) * 0.4,
    speedY: (Math.random() - 0.5) * 0.4,
    alpha: Math.random() * 0.5 + 0.2,
    angle: Math.random() * Math.PI * 2,
    dist: Math.random() * 150 + 100
  });
}

function visualizerLoop() {
  // Recover from a stuck "thinking" indicator while idle (no-op unless genuinely stuck).
  if (typeof maybeRecoverIdleVisualizerState === 'function') maybeRecoverIdleVisualizerState();

  // Clear with slight trailing opacity for a gorgeous fluid blend
  ctx.fillStyle = 'rgba(10, 6, 5, 0.15)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  // Get active audio values
  let recVolume = audioRecorder ? audioRecorder.getVolume() : 0;
  let playVolume = audioPlayer ? audioPlayer.getVolume() : 0;

  let recFreqs = audioRecorder ? audioRecorder.getFrequencyData() : new Uint8Array(0);
  let playFreqs = audioPlayer ? audioPlayer.getFrequencyData() : new Uint8Array(0);

  time += 0.015;

  // Render floating background particle field
  renderParticles(centerX, centerY, playVolume || recVolume);

  // 1. Draw glowing aura (background shadow/glow layer)
  ctx.save();
  ctx.shadowColor = 'rgba(168, 85, 247, 0.45)';
  ctx.shadowBlur = 60 + (playVolume * 90) + (recVolume * 50);
  ctx.beginPath();
  ctx.arc(centerX, centerY, baseRadius * 0.9, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(22, 14, 12, 0.05)';
  ctx.fill();
  ctx.restore();

  // 2. Draw the organic breathing blob
  drawOrganicBlob(centerX, centerY, recVolume, playVolume, recFreqs, playFreqs);

  // 3. Draw thin glowing boundary ring
  drawBoundaryRing(centerX, centerY, playVolume);

  requestAnimationFrame(visualizerLoop);
}

function drawOrganicBlob(centerX, centerY, recVol, playVol, recFreqs, playFreqs) {
  const numPoints = 120;
  ctx.beginPath();

  // Modify color schemes based on active state
  let primaryColor = 'rgba(168, 85, 247, 0.8)';
  let centerColor = 'rgba(216, 180, 254, 0.9)';

  if (currentVisualizerState === 'connecting') {
    // Golden pulse
    primaryColor = `rgba(192, 132, 252, ${0.6 + Math.sin(time * 5) * 0.2})`;
    centerColor = 'rgba(233, 213, 255, 0.8)';
  } else if (currentVisualizerState === 'speaking') {
    // Vibrant deep red-orange
    primaryColor = 'rgba(192, 38, 211, 0.8)';
    centerColor = 'rgba(240, 200, 255, 0.95)';
  } else if (currentVisualizerState === 'listening') {
    // Warm steady peach
    primaryColor = 'rgba(168, 85, 247, 0.65)';
    centerColor = 'rgba(216, 180, 254, 0.8)';
  } else if (currentVisualizerState === 'thinking') {
    // Soft core glow (whitish-violet pulsing)
    primaryColor = 'rgba(220, 160, 255, 0.5)';
    centerColor = `rgba(255, 255, 255, ${0.75 + Math.sin(time * 8) * 0.15})`;
  } else if (currentVisualizerState === 'interrupting') {
    // Tight red pulse while the current response is being cut off.
    primaryColor = `rgba(255, 70, 70, ${0.58 + Math.sin(time * 10) * 0.16})`;
    centerColor = 'rgba(255, 245, 235, 0.9)';
  }

  for (let i = 0; i <= numPoints; i++) {
    const angle = (i / numPoints) * Math.PI * 2;

    // Simulate multi-octave noise via trigonometry
    let breathing = Math.sin(time * 1.5) * 6; // gentle idle breathing
    let wave1 = Math.sin(angle * 3 + time * 2) * 14;
    let wave2 = Math.cos(angle * 5 - time * 2.8) * 8;
    let wave3 = Math.sin(angle * 8 + time * 3.5) * 4;

    // Mic Input Modulations (Pulsing size, smaller boundaries)
    let micMod = recVol * 50 * Math.sin(angle * 12 + time * 5);

    // AI Speaker Modulations (High-frequency boundary ripples)
    let aiMod = 0;
    if (playFreqs.length > 0) {
      // Map angle to frequency index (low to mid frequencies)
      const freqIdx = Math.floor((Math.sin(angle) + 1.0) * 0.5 * (playFreqs.length / 3));
      aiMod = (playFreqs[freqIdx] / 255) * 40;
    }

    const r = baseRadius + breathing + wave1 + wave2 + wave3 + micMod + aiMod + (playVol * 30);

    const x = centerX + Math.cos(angle) * r;
    const y = centerY + Math.sin(angle) * r;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.closePath();

  // Create smooth organic radial gradient
  const grad = ctx.createRadialGradient(
    centerX, centerY, baseRadius * 0.1,
    centerX, centerY, baseRadius * 1.5 + (playVol * 40) + (recVol * 20)
  );
  grad.addColorStop(0, centerColor);
  grad.addColorStop(0.4, primaryColor);
  grad.addColorStop(0.85, 'rgba(32, 12, 10, 0.15)');
  grad.addColorStop(1, 'rgba(10, 6, 5, 0)');

  ctx.fillStyle = grad;
  ctx.fill();
}

function drawBoundaryRing(centerX, centerY, playVol) {
  ctx.save();
  ctx.strokeStyle = `rgba(199, 125, 255, ${0.12 + playVol * 0.25})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  // Oscillating boundary ring
  const pulseRadius = baseRadius * 1.08 + Math.sin(time * 0.8) * 4 + (playVol * 15);
  ctx.arc(centerX, centerY, pulseRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function renderParticles(centerX, centerY, activeAmplitude) {
  particles.forEach(p => {
    if (currentVisualizerState === 'disconnected') {
      // Gentle linear drift
      p.x += p.speedX;
      p.y += p.speedY;

      // Wrap boundaries
      if (p.x < 0) p.x = canvas.width;
      if (p.x > canvas.width) p.x = 0;
      if (p.y < 0) p.y = canvas.height;
      if (p.y > canvas.height) p.y = 0;

      ctx.fillStyle = `rgba(199, 125, 255, ${p.alpha * 0.6})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Connect/Active state: spiral orbit around the central blob
      p.angle += 0.003 + (activeAmplitude * 0.02);
      p.dist -= 0.15; // gravitate inward

      // Reset distance if it gets too close to the core
      if (p.dist < baseRadius * 0.6) {
        p.dist = Math.max(canvas.width, canvas.height) * 0.5 * (Math.random() * 0.5 + 0.5);
        p.angle = Math.random() * Math.PI * 2;
      }

      const x = centerX + Math.cos(p.angle) * p.dist;
      const y = centerY + Math.sin(p.angle) * p.dist;

      ctx.fillStyle = `rgba(199, 125, 255, ${p.alpha * (0.4 + activeAmplitude * 0.6)})`;
      ctx.beginPath();

      // Speed trails when AI or user speaks
      if (activeAmplitude > 0.05) {
        const xTrail = x - Math.cos(p.angle) * (5 + activeAmplitude * 15);
        const yTrail = y - Math.sin(p.angle) * (5 + activeAmplitude * 15);

        ctx.strokeStyle = `rgba(199, 125, 255, ${p.alpha * 0.4})`;
        ctx.lineWidth = p.radius;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(xTrail, yTrail);
        ctx.stroke();
      } else {
        ctx.arc(x, y, p.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
}
