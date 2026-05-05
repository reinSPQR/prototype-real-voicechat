// VRM avatar with a 5-state machine driven by audio levels and a server-await flag.
//
// States resolve every frame from priority: talking > listening > thinking > sleeping > idle.
//   talking   — playback RMS above threshold (drives mouth viseme)
//   listening — mic RMS above threshold
//   thinking  — server is preparing a response (set externally via setThinking)
//   idle      — connected, no I/O
//   sleeping  — no I/O for >IDLE_TO_SLEEP_MS
//
// Lip-sync is amplitude-only (one viseme, "aa"). Phoneme-accurate sync would
// need a viseme classifier on the audio — overkill for a prototype.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const MIC_THRESHOLD = 0.04;
const PLAYBACK_THRESHOLD = 0.015;
const IDLE_TO_SLEEP_MS = 10_000;
// Time constant for state-transition smoothing (seconds). Lower = snappier.
const TRANSITION_TAU = 0.35;

export class Avatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = 'idle';
    this.lastActivity = Date.now();
    this._mouth = 0;
    this._thinking = false;
    // Smoothed values that lerp toward per-state targets each frame.
    this._smooth = { headX: 0, headZ: 0, relaxed: 0, happy: 0, lookUp: 0, eyesClosed: 0 };
    this._initScene();
    this._loop();
  }

  _initScene() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this._resize();
    new ResizeObserver(() => this._resize()).observe(this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
    this.camera.position.set(0, 1.35, 1.9);
    this.camera.lookAt(0, 1.3, 0);

    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, 2, 1.5);
    this.scene.add(key);
    this.scene.add(new THREE.AmbientLight(0xfff1e6, 0.7));

    this._t0 = performance.now() / 1000;
    this._tPrev = this._t0;
  }

  _resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    if (this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  async loadFromUrl(url) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    this._installVrm(gltf);
  }

  async loadFromFile(file) {
    const buf = await file.arrayBuffer();
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await new Promise((res, rej) => loader.parse(buf, '', res, rej));
    this._installVrm(gltf);
  }

  _installVrm(gltf) {
    if (this.vrm) this.scene.remove(this.vrm.scene);
    this.vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    this.vrm.scene.rotation.y = Math.PI;
    this.scene.add(this.vrm.scene);
    this._setRestPose();
  }

  // VRM models load in T-pose; rotate arms down to a natural A-pose so
  // they don't stick out horizontally during idle.
  _setRestPose() {
    const h = this.vrm.humanoid;
    if (!h) return;
    const set = (name, x = 0, y = 0, z = 0) => {
      const b = h.getNormalizedBoneNode(name);
      if (b) b.rotation.set(x, y, z);
    };
    set('leftUpperArm',  0,  0.05,  1.25);
    set('rightUpperArm', 0, -0.05, -1.25);
    set('leftLowerArm',  0,  0.15,  0);
    set('rightLowerArm', 0, -0.15,  0);
    set('leftHand',  0, 0,  0.1);
    set('rightHand', 0, 0, -0.1);
  }

  attachAudio({ micAnalyser, playbackAnalyser }) {
    this.micAnalyser = micAnalyser;
    this.playbackAnalyser = playbackAnalyser;
  }

  setThinking(on) {
    this._thinking = !!on;
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
    return {
      headX:      s === 'sleeping' ? 0.35 : s === 'thinking' ? -0.10 : 0,
      headZ:      s === 'sleeping' ? 0.15 : s === 'thinking' ?  0.12 : 0,
      relaxed:    s === 'sleeping' ? 0.5  : s === 'thinking' ?  0.3  : 0,
      happy:      s === 'listening' ? 0.25 : 0,
      lookUp:     s === 'thinking' ? 0.6 : 0,
      eyesClosed: s === 'sleeping' ? 1 : 0,
    };
  }

  _smoothToward(dt) {
    const k = 1 - Math.exp(-dt / TRANSITION_TAU);
    const tgt = this._stateTargets();
    for (const key in this._smooth) {
      this._smooth[key] += (tgt[key] - this._smooth[key]) * k;
    }
  }

  _applyExpressions(t) {
    const expr = this.vrm.expressionManager;
    if (!expr) return;
    const s = this._smooth;

    expr.setValue('aa', this._mouth);
    expr.setValue('blink', Math.max(this._blink(t), s.eyesClosed));
    expr.setValue('happy', s.happy);
    expr.setValue('relaxed', s.relaxed);
    expr.setValue('sad', 0);
    if (expr.getExpression?.('lookUp')) {
      expr.setValue('lookUp', s.lookUp);
    }
  }

  _blink(t) {
    const phase = (t % 5) / 5;
    if (phase < 0.04) return Math.sin(phase / 0.04 * Math.PI);
    return 0;
  }

  _idleMotion(t) {
    const h = this.vrm.humanoid;
    if (!h) return;
    const head = h.getNormalizedBoneNode('head');
    const spine = h.getNormalizedBoneNode('spine');
    const s = this._smooth;

    if (head) {
      head.rotation.x = s.headX + Math.sin(t * 0.6) * 0.03;
      head.rotation.y = Math.sin(t * 0.4) * 0.06;
      head.rotation.z = s.headZ;
    }
    if (spine) spine.rotation.x = Math.sin(t * 1.2) * 0.012;
  }

  dispose() {
    this._disposed = true;
    this.renderer?.dispose();
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

    if (this.vrm) {
      this._smoothToward(dt);
      this._applyExpressions(t);
      this._idleMotion(t);
      this.vrm.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
  };

  getState() { return this.state; }
}
