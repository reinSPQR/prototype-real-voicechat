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
//   - this file owns the chassis (egg-shaped body, dark screen plate, two
//     antennae — modelled after static/ezgif-split/), the floating effects
//     (! / … / ZZZ), and applies body-motion oscillations
//     (breathing/headBob/headTilt/tremor/antennaWag) from the same dict.

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
    this.camera.position.set(0, 0.85, 5.5);
    this.camera.lookAt(0, 0.85, 0);

    // Lights — body & screen use MeshStandardMaterial. Face primitives are
    // MeshBasicMaterial (self-glowing) and ignore lighting.
    // Ambient is high so the white shell reads near-white instead of mid-gray.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.95));
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(-2.5, 4, 4);
    this.scene.add(key);
    // Warm fill on the camera-right keeps the right side from collapsing
    // into shadow while the cool rim still defines the back contour.
    const fill = new THREE.DirectionalLight(0xfff2e6, 0.45);
    fill.position.set(3, 2, 3);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0x9fc4d8, 0.35);
    rim.position.set(3, 1, -2);
    this.scene.add(rim);

    this.deviceGroup = new THREE.Group();
    this.scene.add(this.deviceGroup);

    this._buildBody();

    // Face anchor — centered on the screen plate.
    this.faceAnchor = new THREE.Group();
    this.faceAnchor.position.set(0, 0.85, 0);
    this.deviceGroup.add(this.faceAnchor);

    // Floating-effects anchor — above the body, between the antennae.
    this.effectsAnchor = new THREE.Group();
    this.effectsAnchor.position.set(0, 2.20, -0.3);
    this.deviceGroup.add(this.effectsAnchor);
    this._buildEffects();
  }

  // Body chassis (per the reference PNGs in static/ezgif-split/):
  //   - egg-shaped white shell (squat — distinctly wider than tall)
  //   - dark rounded-rectangle screen on the front, where the face glows
  //   - two slim antennae at the shoulders, tilted slightly outward
  //   - cartoon-style outline using the inflated-BackSide trick
  //
  // Z layout (positive = toward camera):
  //   body center: z = -1.25, scaled radius_z = 1.18 → front apex z ≈ -0.07
  //   screen outline:                       z = -0.06
  //   screen:                               z = -0.05
  //   face primitives:                      z = 0.00 to +0.06  (front-most)
  _buildBody() {
    // Squat egg — wider than tall, slightly less deep than wide.
    const BODY_X = 1.50, BODY_Y = 1.00, BODY_Z = 1.18;
    const BODY_Y0 = 0.85, BODY_Z0 = -1.25;
    this._bodyDims = { BODY_X, BODY_Y, BODY_Z, BODY_Y0, BODY_Z0 };

    // Cartoon outline — inflated BackSide-only sphere shows as a black
    // silhouette ring around the body's profile. Inflated 7% so the ring
    // is actually visible against both the body interior and the dark
    // background; renderOrder pushes it behind the body's front faces.
    const outline = new THREE.Mesh(
      new THREE.SphereGeometry(1.0, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x05080c, side: THREE.BackSide }),
    );
    outline.position.set(0, BODY_Y0, BODY_Z0);
    outline.scale.set(BODY_X * 1.07, BODY_Y * 1.08, BODY_Z * 1.07);
    outline.renderOrder = -1;
    this.deviceGroup.add(outline);

    // Body shell — bright white egg with subtle shading from the lights above.
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(1.0, 48, 32),
      new THREE.MeshStandardMaterial({
        color: 0xfafbfd, roughness: 0.55, metalness: 0.05,
      }),
    );
    body.position.set(0, BODY_Y0, BODY_Z0);
    body.scale.set(BODY_X, BODY_Y, BODY_Z);
    this.deviceGroup.add(body);
    this._body = body;

    // Screen plate sits at the body's vertical center (in front of body apex).
    const SCREEN_Y = BODY_Y0;
    const SCREEN_Z = -0.05;

    // Screen outline (slightly larger black rounded rect, behind the screen).
    const screenOutline = new THREE.Mesh(
      new THREE.ShapeGeometry(this._makeRoundedRect(2.00, 1.30, 0.24), 12),
      new THREE.MeshBasicMaterial({ color: 0x05080c }),
    );
    screenOutline.position.set(0, SCREEN_Y, SCREEN_Z - 0.01);
    this.deviceGroup.add(screenOutline);

    // Screen — dark rounded rect, slightly forward of body apex.
    const screen = new THREE.Mesh(
      new THREE.ShapeGeometry(this._makeRoundedRect(1.85, 1.15, 0.20), 12),
      new THREE.MeshStandardMaterial({
        color: 0x0a1218, roughness: 0.30, metalness: 0.15,
      }),
    );
    screen.position.set(0, SCREEN_Y, SCREEN_Z);
    this.deviceGroup.add(screen);
    this._screen = screen;

    // Antennae sit at the body's shoulders, slightly INSIDE the silhouette
    // so they read as growing out of the shell rather than floating above.
    // Pivot y picks the body surface y at x = ±ANT_X, then we drop a hair
    // further so the stalk base gets occluded by the body for the
    // shoulder-blend look in the reference.
    this._antennae = [];
    this._buildAntenna(-0.95);
    this._buildAntenna(+0.95);
  }

  _makeRoundedRect(w, h, r) {
    const W = w / 2, H = h / 2;
    const s = new THREE.Shape();
    s.moveTo(-W + r, -H);
    s.lineTo(W - r, -H);
    s.quadraticCurveTo( W, -H,  W, -H + r);
    s.lineTo(W, H - r);
    s.quadraticCurveTo( W,  H,  W - r,  H);
    s.lineTo(-W + r, H);
    s.quadraticCurveTo(-W,  H, -W,  H - r);
    s.lineTo(-W, -H + r);
    s.quadraticCurveTo(-W, -H, -W + r, -H);
    return s;
  }

  _buildAntenna(x) {
    const sign  = x < 0 ? -1 : +1;
    const pivot = new THREE.Group();
    // Pivot sits a hair below the body's shoulder so the stalk base is
    // occluded by the shell and the antenna reads as attached, not floating.
    // Body-surface y at x=±0.95 with BODY_X=1.50, BODY_Y=1.00, BODY_Y0=0.85:
    //   y = 0.85 + 1.00 * sqrt(1 - (0.95/1.50)^2) ≈ 0.85 + 0.776 ≈ 1.626
    pivot.position.set(x, 1.55, -0.40);
    pivot.userData.sign     = sign;
    pivot.userData.baseTilt = sign * 0.18;            // ~10° outward
    pivot.rotation.z        = pivot.userData.baseTilt;

    const STALK_LEN = 0.42;
    const BALL_R    = 0.12;

    // Stalk + outline (a slightly-larger BackSide cylinder gives the dark ring).
    const stalk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, STALK_LEN, 16),
      new THREE.MeshStandardMaterial({
        color: 0xc6cdd6, roughness: 0.4, metalness: 0.35,
      }),
    );
    stalk.position.y = STALK_LEN / 2;
    pivot.add(stalk);

    const stalkOutline = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, STALK_LEN, 16),
      new THREE.MeshBasicMaterial({ color: 0x05080c, side: THREE.BackSide }),
    );
    stalkOutline.position.y = STALK_LEN / 2;
    stalkOutline.scale.set(1.35, 1.02, 1.35);   // thin objects need a bigger %
    stalkOutline.renderOrder = -1;
    pivot.add(stalkOutline);

    // Ball + outline.
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 24, 16),
      new THREE.MeshStandardMaterial({
        color: 0xeef0f3, roughness: 0.3, metalness: 0.2,
      }),
    );
    ball.position.y = STALK_LEN + BALL_R * 0.35;
    pivot.add(ball);

    const ballOutline = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0x05080c, side: THREE.BackSide }),
    );
    ballOutline.position.copy(ball.position);
    ballOutline.scale.setScalar(1.18);
    ballOutline.renderOrder = -1;
    pivot.add(ballOutline);

    this.deviceGroup.add(pivot);
    this._antennae.push(pivot);
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
  // tremor, antennaWag) on the resolved param dict. Here we apply the
  // actual oscillations to the device transform and to each antenna's
  // wag pivot.
  _applyBodyMotion(t, p) {
    const breathScale = 1 + 0.025 * p.breathing * Math.sin(t * 1.2);
    this.deviceGroup.scale.setScalar(breathScale);

    this.deviceGroup.rotation.z = p.headTilt * 0.18;
    this.deviceGroup.rotation.y = Math.sin(t * 0.4) * 0.04;
    this.deviceGroup.rotation.x = Math.sin(t * 0.3) * 0.02;
    this.deviceGroup.position.y = p.headBob * 0.06 * Math.sin(t * 4);
    this.deviceGroup.position.x = p.tremor * 0.012 * Math.sin(t * 28);

    if (this._antennae) {
      for (const a of this._antennae) {
        const wag = a.userData.sign * p.antennaWag * 0.18 * Math.sin(t * 3 + a.userData.sign);
        a.rotation.z = a.userData.baseTilt + wag;
      }
    }
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
