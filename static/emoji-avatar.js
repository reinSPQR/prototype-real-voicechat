// Procedural 2D emoji-robot avatar — parallel prototype to the VRM Avatar.
// Same public API (attachAudio / setThinking / getState / loadFromFile) so it's
// a drop-in swap in index.html. State machine, RMS, and smoothing mirror
// avatar.js; only the rendering differs.

const MIC_THRESHOLD = 0.04;
const PLAYBACK_THRESHOLD = 0.015;
const IDLE_TO_SLEEP_MS = 10_000;
const TRANSITION_TAU = 0.35;

// The robot has fewer knobs than VRM, so we project each backend emotion onto
// (mouth-curve, screen-brightness). Applied only while talking.
const EMOTION_ROBOT_MAP = {
  excited: { smile:  0.9, brightness: 1.15 },
  happy:   { smile:  0.7, brightness: 1.05 },
  sad:     { smile: -0.6, brightness: 0.75 },
  angry:   { smile: -0.4, brightness: 1.10 },
  calm:    { smile:  0.2, brightness: 0.95 },
  whisper: { smile:  0.1, brightness: 0.80 },
  neutral: { smile:  0.0, brightness: 1.00 },
};

const GLOW = 'rgba(140, 230, 255, 1)';
const SHELL = '#e8ecf3';
const EAR = '#cdd2dc';
const SCREEN = '20, 28, 46';

export class EmojiAvatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = 'idle';
    this.lastActivity = Date.now();
    this._mouth = 0;
    this._thinking = false;
    this._emotion = null;
    this._smooth = {
      eyeOpen: 1,     // 1 fully open, 0 closed
      gazeY: 0,       // pupil vertical offset, -1 up, 1 down
      smile: 0,       // mouth curve, -1 frown, 1 smile
      brightness: 1,  // screen luminance, drops while sleeping
      accentDots: 0,  // thinking "..." opacity
      accentZ: 0,     // sleeping Z opacity
      ringPulse: 0,   // listening ring opacity
    };
    // Random eye darts ("saccades") so idle doesn't stare blankly.
    this._saccade = { x: 0, y: 0, until: 0, next: performance.now() + 2000 };
    this._t0 = performance.now() / 1000;
    this._tPrev = this._t0;
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._loop();
  }

  // No-op stubs to keep API parity with the VRM Avatar; index.html's vrm file
  // input still calls these, so don't throw.
  async loadFromUrl() {}
  async loadFromFile() {}

  attachAudio({ micAnalyser, playbackAnalyser }) {
    this.micAnalyser = micAnalyser;
    this.playbackAnalyser = playbackAnalyser;
  }

  setThinking(on) { this._thinking = !!on; }
  setEmotion(emotion) {
    if (!emotion) return;
    const e = String(emotion).toLowerCase();
    if (EMOTION_ROBOT_MAP[e]) this._emotion = e;
  }
  getState() { return this.state; }
  dispose() { this._disposed = true; }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = w; this._h = h;
  }

  _rms(analyser) {
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const x = (data[i] - 128) / 128;
      sum += x * x;
    }
    return Math.sqrt(sum / data.length);
  }

  _resolveState(playLevel, micLevel) {
    if (playLevel > PLAYBACK_THRESHOLD) return 'talking';
    // if (micLevel > MIC_THRESHOLD) return 'listening';
    if (this._thinking) return 'thinking';
    if (Date.now() - this.lastActivity > IDLE_TO_SLEEP_MS) return 'sleeping';
    return 'idle';
  }

  _stateTargets() {
    const s = this.state;
    let smile = s === 'listening' ? 0.7 : s === 'sleeping' ? -0.1 : 0.15;
    let brightness = s === 'sleeping' ? 0.4 : 1;
    if (s === 'talking' && this._emotion && EMOTION_ROBOT_MAP[this._emotion]) {
      const m = EMOTION_ROBOT_MAP[this._emotion];
      smile = m.smile;
      brightness = m.brightness;
    }
    return {
      eyeOpen:    s === 'sleeping' ? 0.05 : 1,
      gazeY:      s === 'thinking' ? -0.6 : 0,
      smile,
      brightness,
      accentDots: s === 'thinking' ? 1 : 0,
      accentZ:    s === 'sleeping' ? 1 : 0,
      ringPulse:  s === 'listening' ? 1 : 0,
    };
  }

  _smoothToward(dt) {
    const k = 1 - Math.exp(-dt / TRANSITION_TAU);
    const tgt = this._stateTargets();
    for (const key in this._smooth) {
      this._smooth[key] += (tgt[key] - this._smooth[key]) * k;
    }
  }

  _updateSaccade(nowMs) {
    if (nowMs > this._saccade.until && nowMs > this._saccade.next) {
      this._saccade.x = (Math.random() - 0.5) * 0.6;
      this._saccade.y = (Math.random() - 0.5) * 0.4;
      this._saccade.until = nowMs + 300;
      this._saccade.next = nowMs + 2500 + Math.random() * 3500;
    } else if (nowMs > this._saccade.until) {
      this._saccade.x *= 0.9;
      this._saccade.y *= 0.9;
    }
  }

  _blink(t) {
    const phase = (t % 5) / 5;
    if (phase < 0.04) return Math.sin(phase / 0.04 * Math.PI);
    return 0;
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _draw(t) {
    const ctx = this.ctx;
    const w = this._w, h = this._h;
    const s = this._smooth;
    const cx = w / 2, cy = h / 2;
    const headW = Math.min(w, h) * 0.72;
    const headH = headW * 0.85;
    const breath = Math.sin(t * 1.2) * 2;

    ctx.clearRect(0, 0, w, h);

    // Side ear buds.
    ctx.fillStyle = EAR;
    const earR = headW * 0.08;
    ctx.beginPath();
    ctx.arc(cx - headW * 0.5, cy + breath, earR, 0, Math.PI * 2);
    ctx.arc(cx + headW * 0.5, cy + breath, earR, 0, Math.PI * 2);
    ctx.fill();

    // Head shell.
    ctx.fillStyle = SHELL;
    this._roundRect(ctx, cx - headW / 2, cy - headH / 2 + breath, headW, headH, headH * 0.32);
    ctx.fill();

    // Screen inset.
    const scrW = headW * 0.78, scrH = headH * 0.62;
    const scrX = cx - scrW / 2, scrY = cy - scrH / 2 + breath;
    ctx.fillStyle = `rgba(${SCREEN}, ${0.95 * s.brightness + 0.05})`;
    this._roundRect(ctx, scrX, scrY, scrW, scrH, scrH * 0.35);
    ctx.fill();

    ctx.save();
    this._roundRect(ctx, scrX, scrY, scrW, scrH, scrH * 0.35);
    ctx.clip();

    // Drifting scanlines.
    ctx.globalAlpha = 0.06 * s.brightness;
    ctx.fillStyle = '#7df';
    for (let y = scrY + ((t * 30) % 6); y < scrY + scrH; y += 6) {
      ctx.fillRect(scrX, y, scrW, 1);
    }
    ctx.globalAlpha = 1;

    // Eyes — blink lid combines auto-blink with state-driven eyeOpen target.
    const blink = Math.max(this._blink(t), 1 - s.eyeOpen);
    const eyeY = scrY + scrH * 0.42 + s.gazeY * scrH * 0.08 + this._saccade.y * scrH * 0.05;
    const eyeDX = scrW * 0.22;
    const eyeR = scrH * 0.14;
    const pulse = 1 + Math.sin(t * 1.6) * 0.04;
    const lidH = eyeR * 2 * Math.max(0.02, 1 - blink) * pulse;
    ctx.fillStyle = `rgba(140, 230, 255, ${s.brightness})`;
    ctx.shadowColor = GLOW;
    ctx.shadowBlur = 18 * s.brightness;
    for (const sgn of [-1, 1]) {
      const ex = cx + sgn * eyeDX + this._saccade.x * scrW * 0.04;
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, eyeR, lidH / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // Mouth — talking opens an ellipse from RMS; otherwise a curve from `smile`.
    const mouthY = scrY + scrH * 0.74;
    const mouthW = scrW * 0.32;
    const open = this._mouth * scrH * 0.18;
    ctx.strokeStyle = `rgba(140, 230, 255, ${s.brightness})`;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    if (open > 2) {
      ctx.beginPath();
      ctx.ellipse(cx, mouthY, mouthW * 0.4, Math.max(2, open), 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const curve = s.smile * scrH * 0.06;
      ctx.beginPath();
      ctx.moveTo(cx - mouthW / 2, mouthY);
      ctx.quadraticCurveTo(cx, mouthY + curve, cx + mouthW / 2, mouthY);
      ctx.stroke();
    }

    // Thinking "..." with cycling brightness.
    if (s.accentDots > 0.02) {
      const dotY = scrY + scrH * 0.86;
      for (let i = 0; i < 3; i++) {
        const phase = (t * 2 - i * 0.3) % 1.5;
        const a = phase > 0 && phase < 1 ? Math.sin(phase * Math.PI) : 0;
        ctx.fillStyle = `rgba(140, 230, 255, ${a * s.accentDots})`;
        ctx.beginPath();
        ctx.arc(cx + (i - 1) * 14, dotY, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Sleeping Z's drifting up + fading.
    if (s.accentZ > 0.02) {
      ctx.fillStyle = '#8cf';
      ctx.font = '600 20px ui-rounded, system-ui';
      for (let i = 0; i < 3; i++) {
        const phase = ((t * 0.4 + i * 0.5) % 2) / 2;
        const x = cx + scrW * 0.22 + phase * 14;
        const y = scrY + scrH * 0.45 - phase * scrH * 0.5;
        ctx.globalAlpha = s.accentZ * (1 - phase);
        ctx.fillText('z', x, y);
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // Listening — pulsing ring outside the head.
    if (s.ringPulse > 0.02) {
      const p = 0.5 + 0.5 * Math.sin(t * 4);
      ctx.strokeStyle = `rgba(216, 170, 255, ${0.45 * s.ringPulse * p})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy + breath, headW * 0.55 + p * 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _loop = () => {
    if (this._disposed) return;
    requestAnimationFrame(this._loop);
    const now = performance.now() / 1000;
    const dt = now - this._tPrev;
    this._tPrev = now;
    const t = now - this._t0;

    const playLevel = this._rms(this.playbackAnalyser);
    const micLevel = this._rms(this.micAnalyser);
    const next = this._resolveState(playLevel, micLevel);

    if (next !== 'sleeping') this.lastActivity = Date.now();
    this.state = next;

    const target = Math.min(1, playLevel * 7);
    this._mouth = this._mouth < target ? target : this._mouth * 0.85;

    this._smoothToward(dt);
    this._updateSaccade(performance.now());
    this._draw(t);
  };
}
