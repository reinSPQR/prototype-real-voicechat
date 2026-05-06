// FaceRig — owns every face primitive once and exposes a parametric API.
//
// Design follows VRM's ExpressionManager → mesh pipeline:
//   ExpressionManager produces a flat parameter dict (alphas + scalars);
//   FaceRig.apply(p) writes those onto materials and transforms.
//
// Layer A (this file):
//   - Eye assembly ×2 — fillOval + specular + four shape-variant strokes
//     (arch ⌒, V slit, × cross, closed ⌣). Variants are co-located so an
//     alpha crossfade between them reads as a "shape morph" while the
//     surrounding params (eyeOpen, eyeTilt, mouth) genuinely interpolate.
//   - Mouth assembly — a single closed-loop CatmullRomCurve3 whose 4
//     control points are recomputed from (mouthCurl, mouthOpen, mouthWidth,
//     mouthSize) each frame; the boundary samples feed a ShapeGeometry so
//     the mouth is a SOLID FILL (not a stroked outline) that morphs cleanly
//     between every observed shape — frown ⌢ → flat → smile ⌣ → small "o"
//     → wide-D laughing.
//
// Layer B (floating effects: !, …, ZZZ) lives in main.js since it sits
// above the device chassis, not on the face.

import * as THREE from 'three';

const CYAN  = 0x8ce6ff;
const WHITE = 0xffffff;

// Tuned to fit the screen plate inside the dome (roughly 2 wide × 1 tall).
const EYE_DX     = 0.55;     // horizontal offset of each eye from center
const EYE_BASE   = 0.22;     // base eye radius
const EYE_Y      = 0.05;     // vertical offset for the eye row
const EYE_Z      = 0.0;      // depth offset for the eye anchor
const FRONT_Z    = 0.06;     // strokes sit forward of the fill (so they read on top)
const MOUTH_Y    = -0.42;    // vertical offset of the mouth from face center
const MOUTH_W0   = 0.34;     // base half-width of the mouth at width=1, size=1
const MOUTH_H0   = 0.20;     // base "interior height" — drives curl/open scale

export class FaceRig {
  constructor(parent) {
    this.group = new THREE.Group();
    parent.add(this.group);

    // Tracked materials for disposal.
    this._mats = [];

    this._buildEyes();
    this._buildMouth();
  }

  _track(mat) { this._mats.push(mat); return mat; }

  // ───── Eyes ─────

  _buildEyes() {
    this.leftEye  = this._buildEye(-EYE_DX, -1);
    this.rightEye = this._buildEye(+EYE_DX, +1);
  }

  // sign: -1 for left eye, +1 for right. Used to mirror the V-slit tilt.
  _buildEye(x, sign) {
    const eye = new THREE.Group();
    eye.position.set(x, EYE_Y, EYE_Z);
    this.group.add(eye);

    // 1) fillOval — cyan rounded blob (neutral / sad / surprised / thinking / relaxed)
    const fillGeo = new THREE.SphereGeometry(EYE_BASE, 24, 16);
    const fillMat = this._track(new THREE.MeshBasicMaterial({
      color: CYAN, transparent: true, opacity: 0, depthWrite: false,
    }));
    const fill = new THREE.Mesh(fillGeo, fillMat);
    fill.scale.set(0.85, 1.0, 0.55);   // squashed oval
    eye.add(fill);

    // 2) specular — small white sparkle on top-left of fill (rides with fill)
    const specGeo = new THREE.SphereGeometry(EYE_BASE * 0.18, 12, 8);
    const specMat = this._track(new THREE.MeshBasicMaterial({
      color: WHITE, transparent: true, opacity: 0, depthWrite: false,
    }));
    const spec = new THREE.Mesh(specGeo, specMat);
    spec.position.set(-EYE_BASE * 0.32, EYE_BASE * 0.45, EYE_BASE * 0.55);
    eye.add(spec);

    // 3) archCurve ⌒ — half-torus, default orientation (apex up). For happy.
    const archGeo = new THREE.TorusGeometry(EYE_BASE * 0.95, 0.030, 8, 28, Math.PI);
    const archMat = this._track(new THREE.MeshBasicMaterial({
      color: CYAN, transparent: true, opacity: 0, depthWrite: false,
    }));
    const arch = new THREE.Mesh(archGeo, archMat);
    arch.position.z = FRONT_Z;
    eye.add(arch);

    // 4) vSlit — same half-torus, tilted so the inner endpoint drops. For angry.
    //    LEFT eye: rotation.z = -0.5 (right side / inner side dips)
    //    RIGHT eye: rotation.z = +0.5 (left side / inner side dips)
    //    sign * 0.5 gives both correctly.
    const slitGeo = new THREE.TorusGeometry(EYE_BASE * 0.95, 0.034, 8, 28, Math.PI);
    const slitMat = this._track(new THREE.MeshBasicMaterial({
      color: CYAN, transparent: true, opacity: 0, depthWrite: false,
    }));
    const slit = new THREE.Mesh(slitGeo, slitMat);
    slit.position.z = FRONT_Z;
    slit.rotation.z = sign * 0.5;
    eye.add(slit);

    // 5) crossX — × scrunched eyes for excited (two short bars at ±45°)
    const crossGroup = new THREE.Group();
    crossGroup.position.z = FRONT_Z;
    const crossMat = this._track(new THREE.MeshBasicMaterial({
      color: CYAN, transparent: true, opacity: 0, depthWrite: false,
    }));
    const crossBarGeo = new THREE.BoxGeometry(EYE_BASE * 1.15, 0.045, 0.045);
    const cross1 = new THREE.Mesh(crossBarGeo, crossMat);
    cross1.rotation.z = Math.PI / 4;
    const cross2 = new THREE.Mesh(crossBarGeo, crossMat);
    cross2.rotation.z = -Math.PI / 4;
    crossGroup.add(cross1, cross2);
    eye.add(crossGroup);

    // 6) closedCurve ⌣ — half-torus rotated 180° so the arc dips down. For sleeping.
    //    Endpoints sit at the eye centerline; apex hangs below — matches the
    //    "lashes drooping" look in the reference.
    const closedGeo = new THREE.TorusGeometry(EYE_BASE * 0.85, 0.030, 8, 24, Math.PI);
    const closedMat = this._track(new THREE.MeshBasicMaterial({
      color: CYAN, transparent: true, opacity: 0, depthWrite: false,
    }));
    const closed = new THREE.Mesh(closedGeo, closedMat);
    closed.position.z = FRONT_Z;
    closed.rotation.z = Math.PI;
    eye.add(closed);

    return {
      group: eye, sign,
      fillMat, specMat, archMat, slitMat, crossMat, closedMat,
    };
  }

  // ───── Mouth ─────

  _buildMouth() {
    this.mouthGroup = new THREE.Group();
    this.mouthGroup.position.set(0, MOUTH_Y, FRONT_Z);
    this.group.add(this.mouthGroup);

    this.mouthMat = this._track(new THREE.MeshBasicMaterial({
      color: CYAN, transparent: true, opacity: 1, depthWrite: false,
    }));
    this.mouthMesh = null;
    this._mouthKey = '';
  }

  // Build a closed loop through 4 control points:
  //   leftCorner → upperMid → rightCorner → lowerMid (clockwise).
  //
  // SMILE convention (curl > 0): both midpoints sit BELOW the corners
  // (negative Y), so the corners ride higher than the middle — the U
  // shape that reads as a smile. Frown (curl < 0) is the mirror image.
  // mouthOpen separates the two midpoints vertically (creating an
  // interior). BASE_GAP·H keeps a visible thickness even when open=0
  // since this is a solid fill, not a stroked outline.
  //
  // This single primitive covers every observed mouth:
  //   happy U-smile     → curl=+1,   open=0
  //   sad/angry frown   → curl=-0.7, open=0
  //   neutral lens      → curl=+0.5, open=0.4, width=0.7
  //   surprised "o"     → curl=0,    open=0.6, width=0.3
  //   excited wide-D    → curl=+1,   open=0.7, width=1.2
  //   sleeping flat     → curl=+0.1, open=0,   width=0.4
  _rebuildMouth(curl, open, width, size) {
    // Quantise the cache key — we don't need to rebuild for sub-pixel param drifts.
    const key = `${curl.toFixed(3)}|${open.toFixed(3)}|${width.toFixed(3)}|${size.toFixed(3)}`;
    if (key === this._mouthKey) return;
    this._mouthKey = key;

    if (this.mouthMesh) {
      this.mouthMesh.geometry.dispose();
      this.mouthGroup.remove(this.mouthMesh);
    }

    const W = MOUTH_W0 * width * size;
    const H = MOUTH_H0 * size;

    // Note the negated curl — see direction convention above.
    const BASE_GAP = 0.18;
    const upperY = -curl * 0.55 * H + (BASE_GAP + open * 0.5) * H;
    const lowerY = -curl * 0.55 * H - (BASE_GAP + open * 0.5) * H;

    const pts = [
      new THREE.Vector3(-W, 0,      0),
      new THREE.Vector3( 0, upperY, 0),
      new THREE.Vector3(+W, 0,      0),
      new THREE.Vector3( 0, lowerY, 0),
    ];
    const curve = new THREE.CatmullRomCurve3(pts, /* closed */ true);

    // Sample the closed curve and feed the boundary into a Shape so
    // ShapeGeometry triangulates it as a SOLID FILL.
    const samples = curve.getPoints(64);
    const shape = new THREE.Shape();
    shape.moveTo(samples[0].x, samples[0].y);
    for (let i = 1; i < samples.length; i++) {
      shape.lineTo(samples[i].x, samples[i].y);
    }
    shape.closePath();

    const geom = new THREE.ShapeGeometry(shape);
    this.mouthMesh = new THREE.Mesh(geom, this.mouthMat);
    this.mouthGroup.add(this.mouthMesh);
  }

  // ───── Apply resolved params (called once per frame) ─────

  apply(p) {
    // Eye shape variant alphas. specular gates on fill so the sparkle never
    // floats over an empty (non-fill) eye.
    for (const eye of [this.leftEye, this.rightEye]) {
      eye.fillMat.opacity   = p.eyeFillAlpha;
      eye.specMat.opacity   = p.specularAlpha * p.eyeFillAlpha;
      eye.archMat.opacity   = p.eyeArchAlpha;
      eye.slitMat.opacity   = p.eyeVAlpha;
      eye.crossMat.opacity  = p.eyeCrossAlpha;
      eye.closedMat.opacity = p.eyeClosedAlpha;

      // Continuous transforms — these morph cleanly between any two presets.
      eye.group.scale.y    = Math.max(0.05, p.eyeOpen);
      const tilt           = eye.sign < 0 ? p.eyeTiltL : p.eyeTiltR;
      eye.group.rotation.z = tilt;
      eye.group.position.x = (eye.sign < 0 ? -EYE_DX : +EYE_DX) + p.eyeOffsetX;
      eye.group.position.y = EYE_Y + p.eyeOffsetY;
    }

    // Mouth — rebuild if shape params changed.
    this._rebuildMouth(p.mouthCurl, p.mouthOpen, p.mouthWidth, p.mouthSize);
  }

  dispose() {
    for (const m of this._mats) m.dispose();
    this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    if (this.mouthMesh) this.mouthMesh.geometry.dispose();
  }
}
