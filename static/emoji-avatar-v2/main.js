// EmojiAvatarV2 — three.js half-globe device with a parametric robot face.
//
// Public API mirrors static/emoji-avatar.js so this is a drop-in swap:
//   attachAudio({micAnalyser, playbackAnalyser}) / setThinking(on) /
//   setEmotion(name) / getState() / dispose() / loadFromUrl() / loadFromFile()
//
// Architecture (see face-rig.js / expression-manager.js):
//   - state machine (here) decides which named expression should be on;
//   - ExpressionManager smooths weights toward that target and resolves a
//     flat parameter dict;
//   - FaceRig renders the face from those params (eyes, mouth);
//   - this file owns the floating effects (! / … / ZZZ) and applies
//     body-motion oscillations (breathing/headBob/headTilt/tremor) from
//     the same param dict. There is no chassis; the face renders against
//     the canvas's transparent background.

import * as THREE from 'three';

import { FaceRig }            from './face-rig.js';
import { ExpressionManager }  from './expression-manager.js';

// Audio thresholds & sleep timeout — copied from emoji-avatar.js for parity.
const MIC_THRESHOLD       = 0.04;
const PLAYBACK_THRESHOLD  = 0.015;
const IDLE_TO_SLEEP_MS    = 10_000;

// Backend emotion preset → which face module to use while talking.
// 'whisper' and 'calm' both project onto 'relaxed'.
const EMOTION_FACE_MAP = {
  excited: 'excited',
  happy:   'happy',
  sad:     'sad',
  angry:   'angry',
  calm:    'relaxed',
  whisper: 'relaxed',
  neutral: 'neutral',
};

export class EmojiAvatarV2 {
  constructor(canvas) {
    this.canvas        = canvas;
    this.state         = 'idle';
    this.lastActivity  = Date.now();
    this._thinking     = false;
    this._emotion      = null;
    this._mouth        = 0;
    this._t0           = performance.now() / 1000;
    this._tPrev        = this._t0;

    this._setupRenderer();
    this._setupScene();
    this._setupFace();

    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._loop();
  }

  // ───── Public API (parity with emoji-avatar.js) ─────

  // VRM hooks aren't relevant here but the host page wires file inputs to
  // them — keep as no-ops so it doesn't throw.
  async loadFromUrl()  { /* no-op */ }
  async loadFromFile() { /* no-op */ }

  attachAudio({ micAnalyser, playbackAnalyser }) {
    this.micAnalyser      = micAnalyser;
    this.playbackAnalyser = playbackAnalyser;
  }

  setThinking(on) { this._thinking = !!on; }

  setEmotion(emotion) {
    if (!emotion) return;
    const e = String(emotion).toLowerCase();
    if (EMOTION_FACE_MAP[e]) this._emotion = e;
  }

  getState() { return this.state; }

  dispose() {
    this._disposed = true;
    this.rig?.dispose();
    this.renderer?.dispose();
  }

  // ───── Scene setup ─────

  _setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, alpha: true, antialias: true,
    });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x000000, 0);
  }

  _setupScene() {
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.camera.position.set(0, 0.9, 5.5);
    this.camera.lookAt(0, 0.9, 0);

    // No lights — face primitives are MeshBasicMaterial (self-glowing).

    this.deviceGroup = new THREE.Group();
    this.scene.add(this.deviceGroup);

    // Face anchor.
    this.faceAnchor = new THREE.Group();
    this.faceAnchor.position.set(0, 0.9, 0);
    this.deviceGroup.add(this.faceAnchor);

    // Floating-effects anchor — above the face.
    this.effectsAnchor = new THREE.Group();
    this.effectsAnchor.position.set(0, 1.55, 0);
    this.deviceGroup.add(this.effectsAnchor);
    this._buildEffects();
  }

  // Floating effects: '!', '...' bubble, and 'ZZZ'. Each lives in its own
  // sub-group; the loop drives alpha + per-effect motion from resolved
  // params (exclamationAlpha / thinkBubbleAlpha / zzzAlpha).
  _buildEffects() {
    const cyan = 0x8ce6ff;

    // ! exclamation
    this._fxExclamation = new THREE.Group();
    const exMat = new THREE.MeshBasicMaterial({
      color: cyan, transparent: true, opacity: 0, depthWrite: false,
    });
    const exBar = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.45, 6, 12), exMat);
    exBar.position.y = 0.30;
    this._fxExclamation.add(exBar);
    const exDot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), exMat);
    exDot.position.y = -0.05;
    this._fxExclamation.add(exDot);
    this._fxExclamation.userData.mat = exMat;
    this.effectsAnchor.add(this._fxExclamation);

    // ... thought bubble
    this._fxBubble = new THREE.Group();
    const bubMat = new THREE.MeshBasicMaterial({
      color: cyan, transparent: true, opacity: 0, depthWrite: false,
    });
    const bubBody = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.45, 0.05), bubMat);
    this._fxBubble.add(bubBody);
    const dotMatTemplate = new THREE.MeshBasicMaterial({
      color: 0x102233, transparent: true, opacity: 0, depthWrite: false,
    });
    const dots = [];
    for (let i = 0; i < 3; i++) {
      const dotMat = dotMatTemplate.clone();
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), dotMat);
      dot.position.set((i - 1) * 0.20, 0, 0.04);
      this._fxBubble.add(dot);
      dots.push(dot);
    }
    this._fxBubble.userData = { bubMat, dots };
    this.effectsAnchor.add(this._fxBubble);

    // ZZZ
    this._fxZ = new THREE.Group();
    const zs = [];
    for (let i = 0; i < 3; i++) {
      const z = this._buildLetterZ(cyan);
      z.scale.setScalar(0.32 + i * 0.08);
      zs.push(z);
      this._fxZ.add(z);
    }
    this._fxZ.userData = { zs };
    this.effectsAnchor.add(this._fxZ);
  }

  _buildLetterZ(color) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0, depthWrite: false,
    });
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.06, 0.04), mat);
    top.position.y = 0.16;
    const bot = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.06, 0.04), mat);
    bot.position.y = -0.16;
    const diag = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.06, 0.04), mat);
    diag.rotation.z = Math.PI / 4;
    g.add(top, bot, diag);
    g.userData.mat = mat;
    return g;
  }

  _setupFace() {
    this.rig = new FaceRig(this.faceAnchor);
    this.expressions = new ExpressionManager();
  }

  // ───── Per-frame helpers ─────

  _resize() {
    const w = this.canvas.clientWidth  || this.canvas.width  || 512;
    const h = this.canvas.clientHeight || this.canvas.height || 512;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
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

  _resolveState(playLevel, _micLevel) {
    if (playLevel > PLAYBACK_THRESHOLD) return 'talking';
    // Listening intentionally disabled — see emoji-avatar.js for rationale.
    if (this._thinking) return 'thinking';
    if (Date.now() - this.lastActivity > IDLE_TO_SLEEP_MS) return 'sleeping';
    return 'idle';
  }

  // The chosen expression is sticky — once the host calls setEmotion(), it
  // stays on that face until the next setEmotion()/setThinking() call (or
  // the long-idle sleep timeout). Audio level no longer gates the
  // expression; it only drives the procedural mouthOpen override below.
  _resolveExpressionName() {
    if (this._thinking) return 'thinking';
    if (this.state === 'sleeping') return 'sleeping';
    if (this._emotion && EMOTION_FACE_MAP[this._emotion]) {
      return EMOTION_FACE_MAP[this._emotion];
    }
    return 'neutral';
  }

  // The rig publishes amplitude scalars (headTilt, headBob, breathing,
  // tremor) on the resolved param dict. Here we apply the actual
  // oscillations to the face transform. (antennaWag is unused now that
  // there's no chassis — it stays in the param dict for parity but no
  // mesh listens to it.)
  _applyBodyMotion(t, p) {
    const breathScale = 1 + 0.025 * p.breathing * Math.sin(t * 1.2);
    this.deviceGroup.scale.setScalar(breathScale);

    this.deviceGroup.rotation.z = p.headTilt * 0.18;
    this.deviceGroup.rotation.y = Math.sin(t * 0.4) * 0.04;
    this.deviceGroup.rotation.x = Math.sin(t * 0.3) * 0.02;
    this.deviceGroup.position.y = p.headBob * 0.06 * Math.sin(t * 4);
    this.deviceGroup.position.x = p.tremor * 0.012 * Math.sin(t * 28);
  }

  _applyEffects(t, p) {
    // ! — bobs and pulses while visible
    this._fxExclamation.userData.mat.opacity = p.exclamationAlpha;
    this._fxExclamation.position.y           = Math.sin(t * 4) * 0.08;
    this._fxExclamation.scale.setScalar(0.9 + 0.10 * Math.sin(t * 4));

    // ... — bubble visible together; the three dots twinkle in sequence
    const { bubMat, dots } = this._fxBubble.userData;
    bubMat.opacity = p.thinkBubbleAlpha;
    for (let i = 0; i < dots.length; i++) {
      const phase = (Math.sin(t * 3 - i * 0.8) + 1) * 0.5;
      dots[i].material.opacity = p.thinkBubbleAlpha * (0.25 + 0.75 * phase);
    }

    // ZZZ — drift up-right with a 2.5s emission cycle, fading at the ends
    const zs = this._fxZ.userData.zs;
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i];
      const cycle = ((t * 0.55) + i * 0.45) % 2.0;
      const k = cycle / 2.0;          // 0..1
      z.position.set(-0.25 + k * 0.85, 0.10 + k * 0.55, 0);
      z.userData.mat.opacity = p.zzzAlpha * Math.sin(k * Math.PI);
    }
  }

  _loop = () => {
    if (this._disposed) return;
    requestAnimationFrame(this._loop);

    const now = performance.now() / 1000;
    const dt  = Math.min(0.1, now - this._tPrev);
    this._tPrev = now;
    const t = now - this._t0;

    const playLevel = this._rms(this.playbackAnalyser);
    const micLevel  = this._rms(this.micAnalyser);

    const next = this._resolveState(playLevel, micLevel);
    if (next !== 'sleeping') this.lastActivity = Date.now();
    this.state = next;

    // Audio-driven mouth — fast attack, slow release. Applied AFTER expression
    // resolution as a procedural override (VRM does this with mouth shapes too).
    const target = Math.min(1, playLevel * 7);
    this._mouth = this._mouth < target ? target : this._mouth * 0.85;

    this.expressions.setExpression(this._resolveExpressionName());
    const params = this.expressions.update(dt);

    // Audio mouth wins when louder than the expression's static mouthOpen.
    params.mouthOpen = Math.max(params.mouthOpen, this._mouth);

    this.rig.apply(params);
    this._applyBodyMotion(t, params);
    this._applyEffects(t, params);

    this.renderer.render(this.scene, this.camera);
  };
}
