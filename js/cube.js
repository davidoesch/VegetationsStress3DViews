// Space-time cube: a first-hit voxel ray-march through a 3D texture (east × north × time),
// cropped by an axis-aligned box and filtered by a class bit mask.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { buildLut, CLASS_OF, ALL_MASK } from './classes.js';

// Voxel space: x = column (east), y = row (south, row 0 = north edge), z = time layer.
// Object space: the unit box [-0.5, 0.5]³ with x = east, y = time (up), z = south.
const vertexShader = /* glsl */ `
out vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform sampler3D uVol;
uniform sampler2D uLut;
uniform vec3 uDims;
uniform vec3 uCropMin;
uniform vec3 uCropMax;
uniform int uMask;
uniform vec3 uCamLocal;
uniform vec3 uHover;
uniform vec3 uHoverColor;

in vec3 vLocal;
out vec4 fragColor;

vec3 toVox(vec3 l) { return vec3((l.x + 0.5) * uDims.x, (l.z + 0.5) * uDims.y, (l.y + 0.5) * uDims.z); }
vec3 toLocal(vec3 v) { return vec3(v.x / uDims.x - 0.5, v.z / uDims.z - 0.5, v.y / uDims.y - 0.5); }

void main() {
  vec3 o = toVox(uCamLocal);
  vec3 d = normalize(toVox(vLocal) - o);
  d = mix(d, vec3(1e-7), vec3(lessThan(abs(d), vec3(1e-7))));
  vec3 inv = 1.0 / d;

  vec3 t0 = (uCropMin - o) * inv;
  vec3 t1 = (uCropMax - o) * inv;
  vec3 tlo = min(t0, t1);
  vec3 thi = max(t0, t1);
  float tNear = max(max(tlo.x, tlo.y), tlo.z);
  float tFar = min(min(thi.x, thi.y), thi.z);
  if (tNear >= tFar || tFar <= 0.0) discard;

  int axis = (tlo.x >= tlo.y && tlo.x >= tlo.z) ? 0 : (tlo.y >= tlo.z ? 1 : 2);
  float t = max(tNear, 0.0);
  ivec3 lo = ivec3(uCropMin);
  ivec3 hi = ivec3(uCropMax) - 1;
  ivec3 cell = clamp(ivec3(floor(o + d * (t + 1e-3))), lo, hi);
  ivec3 stp = ivec3(sign(d));
  vec3 tDelta = abs(inv);
  vec3 tNext = (vec3(cell) + vec3(greaterThan(stp, ivec3(0))) - o) * inv;
  int maxSteps = int(uDims.x + uDims.y + uDims.z) + 3;

  for (int i = 0; i < 16384; i++) {
    if (i > maxSteps) break;
    float v = texelFetch(uVol, cell, 0).r;
    vec4 lut = texelFetch(uLut, ivec2(int(v * 255.0 + 0.5), 0), 0);
    int k = int(lut.a * 255.0 + 0.5) - 1;
    if (k >= 0 && ((uMask >> k) & 1) == 1) {
      // Time faces keep the exact class colour; side faces are shaded to read as volume.
      float shade = axis == 2 ? 1.0 : (axis == 0 ? 0.8 : 0.66);
      vec3 col = lut.rgb * shade;
      vec3 hit = o + d * t;
      if (ivec3(uHover) == cell) {
        vec3 f = hit - vec3(cell);
        vec2 uv = axis == 0 ? f.yz : (axis == 1 ? f.xz : f.xy);
        float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
        if (edge < 0.14) col = uHoverColor;
      }
      vec4 clip = projectionMatrix * modelViewMatrix * vec4(toLocal(hit), 1.0);
      gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
      fragColor = vec4(col, 1.0);
      return;
    }
    if (tNext.x < tNext.y && tNext.x < tNext.z) { cell.x += stp.x; t = tNext.x; tNext.x += tDelta.x; axis = 0; }
    else if (tNext.y < tNext.z) { cell.y += stp.y; t = tNext.y; tNext.y += tDelta.y; axis = 1; }
    else { cell.z += stp.z; t = tNext.z; tNext.z += tDelta.z; axis = 2; }
    if (any(lessThan(cell, lo)) || any(greaterThan(cell, hi))) break;
  }
  discard;
}`;

const fmtCoord = (v) => Math.round(v).toLocaleString('de-CH');

function label(className, text) {
  const outer = document.createElement('div');
  const inner = document.createElement('span');
  inner.className = `cube-label ${className}`;
  inner.textContent = text;
  outer.appendChild(inner);
  const obj = new CSS2DObject(outer);
  obj.inner = inner;
  return obj;
}

export class Cube {
  constructor(container) {
    this.container = container;
    this.vol = null;
    this.mask = ALL_MASK;
    this.crop = null;
    this.timeHeight = 0.7;
    this.hover = null;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    const gl = this.renderer.getContext();
    this.max3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'cube-labels';
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 50);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener('change', () => this.requestRender());

    const lut = new THREE.DataTexture(buildLut(), 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    lut.minFilter = lut.magFilter = THREE.NearestFilter;
    lut.needsUpdate = true;

    this.uniforms = {
      uVol: { value: null },
      uLut: { value: lut },
      uDims: { value: new THREE.Vector3(1, 1, 1) },
      uCropMin: { value: new THREE.Vector3() },
      uCropMax: { value: new THREE.Vector3(1, 1, 1) },
      uMask: { value: ALL_MASK },
      uCamLocal: { value: new THREE.Vector3() },
      uHover: { value: new THREE.Vector3(-1, -1, -1) },
      uHoverColor: { value: new THREE.Color(0x111111) },
    };
    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader, fragmentShader,
        uniforms: this.uniforms, side: THREE.BackSide,
      }),
    );
    this.mesh.visible = false;
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      this.uniforms.uCamLocal.value.copy(camera.position);
      this.mesh.worldToLocal(this.uniforms.uCamLocal.value);
    };
    this.scene.add(this.mesh);

    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.35 }));
    this.cropOutline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial());
    this.pinLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ depthTest: false }),
    );
    this.pinLine.renderOrder = 10;
    for (const o of [this.outline, this.cropOutline, this.pinLine]) { o.visible = false; this.scene.add(o); }

    this.timeLabels = [];
    this.cornerLabels = [label('corner', ''), label('corner', ''), label('north', 'N ↑')];
    this.topLabel = label('top', '');
    for (const l of [...this.cornerLabels, this.topLabel]) { l.visible = false; this.scene.add(l); }

    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.invMatrix = new THREE.Matrix4();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.resetView();
  }

  setTheme({ ink, muted, accent }) {
    this.outline.material.color.set(muted);
    this.cropOutline.material.color.set(ink);
    this.pinLine.material.color.set(accent);
    this.uniforms.uHoverColor.value.set(ink);
    this.requestRender();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      // update() reports true while damping is still moving the camera.
      if (this.controls.update()) this.requestRender();
      this.updateLabels();
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
    });
  }

  setVolume(vol) {
    this.vol = vol;
    this.uniforms.uVol.value?.dispose();
    const tex = new THREE.Data3DTexture(vol.data, vol.nx, vol.ny, vol.nt);
    tex.format = THREE.RedFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    this.uniforms.uVol.value = tex;
    this.uniforms.uDims.value.set(vol.nx, vol.ny, vol.nt);

    for (const l of this.timeLabels) this.scene.remove(l);
    // About 7 evenly stepped ticks; the last date replaces a tick that would crowd it.
    const step = Math.max(1, Math.ceil((vol.nt - 1) / 6));
    const ticks = [];
    for (let t = 0; t < vol.nt; t += step) ticks.push(t);
    if (ticks[ticks.length - 1] !== vol.nt - 1) {
      if (vol.nt - 1 - ticks[ticks.length - 1] < step / 2) ticks.pop();
      ticks.push(vol.nt - 1);
    }
    this.timeLabels = ticks.map((t) => {
      const l = label('time', vol.dates[t]);
      l.layer = t;
      this.scene.add(l);
      return l;
    });

    const b = vol.plan.bbox;
    this.cornerLabels[0].inner.textContent = `${fmtCoord(b.e0)} / ${fmtCoord(b.n0)}`;
    this.cornerLabels[1].inner.textContent = `${fmtCoord(b.e1)} / ${fmtCoord(b.n1)}`;
    for (const o of [this.mesh, this.outline, this.cropOutline, ...this.cornerLabels, this.topLabel]) o.visible = true;
    this.hover = null;
    this.crop = null;
    this.setPin(null);
    this.applyScale();
    this.setCrop({ c0: 0, c1: vol.nx, r0: 0, r1: vol.ny, t0: 0, t1: vol.nt });
  }

  // Re-upload the texture while layers are still arriving.
  refresh() {
    if (this.uniforms.uVol.value) this.uniforms.uVol.value.needsUpdate = true;
    this.requestRender();
  }

  setTimeHeight(h) {
    this.timeHeight = h;
    this.applyScale();
  }

  applyScale() {
    if (!this.vol) return;
    const m = Math.max(this.vol.nx, this.vol.ny);
    this.mesh.scale.set(this.vol.nx / m, this.timeHeight, this.vol.ny / m);
    this.outline.scale.copy(this.mesh.scale);
    this.mesh.updateMatrixWorld();
    this.setCrop(this.crop);
  }

  // crop = { c0, c1, r0, r1, t0, t1 } in voxel indices, half-open.
  setCrop(crop) {
    if (!this.vol || !crop) return;
    this.crop = crop;
    this.uniforms.uCropMin.value.set(crop.c0, crop.r0, crop.t0);
    this.uniforms.uCropMax.value.set(crop.c1, crop.r1, crop.t1);
    const a = this.voxToWorld(new THREE.Vector3(crop.c0, crop.r0, crop.t0));
    const b = this.voxToWorld(new THREE.Vector3(crop.c1, crop.r1, crop.t1));
    this.cropOutline.position.copy(a).add(b).multiplyScalar(0.5);
    this.cropOutline.scale.set(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
    this.topLabel.inner.textContent = `▲ ${this.vol.dates[crop.t1 - 1]}`;
    this.updatePinLine();
    this.requestRender();
  }

  setMask(mask) {
    this.mask = mask;
    this.uniforms.uMask.value = mask;
    this.requestRender();
  }

  setHover(cell) {
    this.hover = cell;
    this.uniforms.uHover.value.set(cell ? cell.col : -1, cell ? cell.row : -1, cell ? cell.t : -1);
    this.requestRender();
  }

  setPin(cell) {
    this.pin = cell;
    this.pinLine.visible = !!cell;
    this.updatePinLine();
    this.requestRender();
  }

  updatePinLine() {
    if (!this.pin || !this.vol) return;
    const { col, row } = this.pin;
    const a = this.voxToWorld(new THREE.Vector3(col + 0.5, row + 0.5, 0));
    const b = this.voxToWorld(new THREE.Vector3(col + 0.5, row + 0.5, this.vol.nt));
    b.y += 0.08;
    this.pinLine.geometry.setFromPoints([a, b]);
  }

  voxToWorld(v) {
    const { nx, ny, nt } = this.vol;
    const local = new THREE.Vector3(v.x / nx - 0.5, v.z / nt - 0.5, v.y / ny - 0.5);
    return local.applyMatrix4(this.mesh.matrixWorld);
  }

  // Put the date ticks on whichever vertical edge of the crop box is currently left-most on screen.
  updateLabels() {
    if (!this.vol || !this.crop) return;
    const { c0, c1, r0, r1, t0, t1 } = this.crop;
    const corners = [[c0, r0], [c1, r0], [c0, r1], [c1, r1]];
    let best = null, bestX = Infinity;
    for (const [c, r] of corners) {
      const p = this.voxToWorld(new THREE.Vector3(c, r, (t0 + t1) / 2)).project(this.camera);
      if (p.x < bestX) { bestX = p.x; best = [c, r]; }
    }
    for (const l of this.timeLabels) {
      l.visible = l.layer >= t0 && l.layer < t1;
      l.position.copy(this.voxToWorld(new THREE.Vector3(best[0], best[1], l.layer + 0.5)));
    }
    this.topLabel.position.copy(this.voxToWorld(new THREE.Vector3(best[0], best[1], t1)));
    const { nx, ny } = this.vol;
    this.cornerLabels[0].position.copy(this.voxToWorld(new THREE.Vector3(0, ny, 0)));
    this.cornerLabels[1].position.copy(this.voxToWorld(new THREE.Vector3(nx, 0, 0)));
    this.cornerLabels[2].position.copy(this.voxToWorld(new THREE.Vector3(nx / 2, -0.06 * Math.max(nx, ny), this.vol.nt)));
  }

  // CPU twin of the shader's traversal: the first visible voxel under the pointer, or null.
  pick(clientX, clientY) {
    if (!this.vol) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.invMatrix.copy(this.mesh.matrixWorld).invert();
    const { nx, ny, nt, data } = this.vol;
    const toVox = (l) => [(l.x + 0.5) * nx, (l.z + 0.5) * ny, (l.y + 0.5) * nt];
    const oL = this.raycaster.ray.origin.clone().applyMatrix4(this.invMatrix);
    const pL = this.raycaster.ray.origin.clone().add(this.raycaster.ray.direction).applyMatrix4(this.invMatrix);
    const o = toVox(oL);
    const p = toVox(pL);
    let d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const len = Math.hypot(...d);
    d = d.map((x) => (Math.abs(x / len) < 1e-7 ? 1e-7 : x / len));

    const { c0, c1, r0, r1, t0, t1 } = this.crop;
    const lo = [c0, r0, t0], hi = [c1, r1, t1];
    let tNear = -Infinity, tFar = Infinity;
    for (let a = 0; a < 3; a++) {
      const ta = (lo[a] - o[a]) / d[a], tb = (hi[a] - o[a]) / d[a];
      tNear = Math.max(tNear, Math.min(ta, tb));
      tFar = Math.min(tFar, Math.max(ta, tb));
    }
    if (tNear >= tFar || tFar <= 0) return null;
    const t = Math.max(tNear, 0) + 1e-3;
    const cell = [0, 1, 2].map((a) => Math.min(Math.max(Math.floor(o[a] + d[a] * t), lo[a]), hi[a] - 1));
    const step = d.map(Math.sign);
    const tDelta = d.map((x) => Math.abs(1 / x));
    const tNext = [0, 1, 2].map((a) => (cell[a] + (step[a] > 0 ? 1 : 0) - o[a]) / d[a]);
    for (let i = 0, max = nx + ny + nt + 3; i < max; i++) {
      const value = data[(cell[2] * ny + cell[1]) * nx + cell[0]];
      const k = CLASS_OF[value];
      if (k >= 0 && (this.mask >> k) & 1) return { col: cell[0], row: cell[1], t: cell[2], value };
      const a = tNext[0] < tNext[1] && tNext[0] < tNext[2] ? 0 : tNext[1] < tNext[2] ? 1 : 2;
      cell[a] += step[a];
      tNext[a] += tDelta[a];
      if (cell[a] < lo[a] || cell[a] >= hi[a]) return null;
    }
    return null;
  }

  // Default south-east view, pulled back on narrow (portrait) viewports so the cube fits.
  resetView() {
    const k = Math.max(1, 1.4 / this.camera.aspect);
    this.camera.position.set(1.35, 1.15, 1.75).multiplyScalar(k);
    this.controls.target.set(0, 0, 0);
    this.requestRender();
  }
}
