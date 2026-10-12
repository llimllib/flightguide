// A speed, turn and fade chart of discs, in three dimensions with three.js.
//
// It stands in for Chart, with the same methods and callbacks, so the filters,
// colors, tooltip and cards all work on it unchanged. app.js only loads it when
// a reader asks for the 3D version, so the 2D chart never pays for three.js.
//
// Speed runs up, turn runs across with understable on the right as in the 2D
// chart, and fade runs front to back. Brush zoom, ghosts and the throwing hand
// don't apply here: orbiting does the zooming, ghosts would only be clutter, and
// the hand only mirrors flight paths, which this chart doesn't draw.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// the plot is a cube this many units on a side, whatever the axes' ranges
const SIZE = 10;
const H = SIZE / 2;
const RADIUS = 0.14;
// discs sharing all three numbers would sit inside one another, so each is
// nudged by up to this much. The nudge comes from its id, so a disc lands in
// the same place every time
const JITTER = 0.18;
const HOVER_SCALE = 1.8;
// the plot's floor height, as in the 2D chart
const MIN_HEIGHT = 220;
// hovering is nearest-dot within this many pixels, as in the 2D chart, since a
// dot a few pixels across is too small to hit exactly
const HIT_PX = 12;
// a pointer that moves further than this between down and up was orbiting,
// not clicking
const CLICK_SLOP = 4;
// the opening camera looks down on the cube from its front right
const VIEW = new THREE.Vector3(1, 0.65, 1.35);

const AXES = {
  speed: { label: "Speed", step: 2 },
  turn: { label: "Turn", step: 1, flip: true },
  fade: { label: "Fade", step: 1 },
};

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// hash spreads an id over [-1, 1), differently for each salt
const hash = (id, salt) => {
  const x = Math.sin(id * 12.9898 + salt * 78.233) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
};

export class Chart3D {
  constructor(container, { onHover, onClick, onVisible }) {
    this.container = container;
    this.onHover = onHover;
    this.onVisible = onVisible;
    this.discs = [];
    this.points = []; // the world position of each of discs
    this.hovered = null;
    this.pinned = null;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.setClearColor(css("--bg"));
    this.canvas = this.renderer.domElement;
    // three sets display: block inline, which would beat the stylesheet hiding
    // the canvas while the 2D chart is showing
    this.canvas.style.removeProperty("display");
    container.append(this.canvas);

    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(3, 10, 6);
    this.scene.add(sun);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.addEventListener("change", () => this.render());
    // once the reader has moved the camera, a resize leaves it where they put it
    this.controls.addEventListener("start", () => (this.moved = true));

    this.geometry = new THREE.SphereGeometry(RADIUS, 16, 12);
    this.material = new THREE.MeshStandardMaterial({ roughness: 0.6 });
    this.matrix = new THREE.Matrix4();
    this.color = new THREE.Color();

    this.canvas.addEventListener("pointerdown", (e) => {
      this.down = { x: e.clientX, y: e.clientY, type: e.pointerType };
      // the tooltip would be left behind as the cube turns under it
      this.hover(null);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      // a touch has no hover, and a pressed button is orbiting
      if (e.pointerType === "touch" || e.buttons) return;
      this.hover(this.hitTest(e), e);
    });
    this.canvas.addEventListener("pointerleave", () => this.hover(null));
    this.canvas.addEventListener("click", (e) => {
      const down = this.down;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP) return;
      // a click on empty space is reported too, as null, so a touch can
      // dismiss whatever its last tap opened
      onClick(this.hitTest(e), { touch: down?.type === "touch" });
    });

    new ResizeObserver(() => this.resize()).observe(container);
  }

  resize() {
    const w = this.container.clientWidth;
    const h = Math.max(MIN_HEIGHT, this.container.clientHeight);
    if (!w) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.moved) this.frame();
    this.render();
  }

  // frame backs the camera off until the cube and its labels fit the view
  frame() {
    const r = ((SIZE * Math.sqrt(3)) / 2) * 1.15;
    const v = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const h = Math.atan(Math.tan(v) * this.camera.aspect);
    this.camera.position.copy(VIEW).setLength(r / Math.sin(Math.min(v, h)));
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  // render draws a frame, at most one per animation frame. Nothing moves on its
  // own, so frames are only drawn when something changes; while the controls
  // are easing to a stop, their update asks for the next one
  render() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  // setData shows discs. Ghosts are ignored, and extent fixes the axes, so the
  // cube holds still while the filters move dots around inside it
  setData(discs, ghosts, extent, color) {
    if (!this.extent) {
      this.extent = extent;
      this.scene.add(this.axes());
    }
    this.discs = discs;
    this.points = discs.map((d) =>
      new THREE.Vector3(
        this.scale("turn", d.turn) + JITTER * hash(d.id, 1),
        this.scale("speed", d.speed) + JITTER * hash(d.id, 2),
        this.scale("fade", d.fade) + JITTER * hash(d.id, 3),
      ),
    );
    if (this.hovered && !discs.includes(this.hovered)) this.hover(null);

    if (!this.mesh || this.mesh.instanceMatrix.count < discs.length) {
      if (this.mesh) {
        this.scene.remove(this.mesh);
        this.mesh.dispose();
      }
      this.mesh = new THREE.InstancedMesh(this.geometry, this.material, discs.length);
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(this.mesh);
    }
    this.mesh.count = discs.length;
    this.place();
    this.recolor(color);
    this.onVisible?.(discs.length);
  }

  // scale maps a value on one of the axes to world units across the cube
  scale(axis, v) {
    const { min, max } = this.extent[axis];
    const t = (v - min) / (max - min || 1);
    return ((AXES[axis].flip ? 1 - t : t) - 0.5) * SIZE;
  }

  // place positions every dot, raising the hovered or pinned one
  place() {
    if (!this.mesh) return;
    const lit = this.hovered ?? this.pinned;
    const scale = new THREE.Vector3();
    const turn = new THREE.Quaternion();
    this.discs.forEach((d, i) => {
      const k = lit && d.id === lit.id ? HOVER_SCALE : 1;
      this.mesh.setMatrixAt(i, this.matrix.compose(this.points[i], turn, scale.setScalar(k)));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    // the mesh culls and raycasts by a bounding sphere it computes once
    this.mesh.computeBoundingSphere();
    this.render();
  }

  recolor(color) {
    if (!this.mesh) return;
    this.discs.forEach((d, i) => this.mesh.setColorAt(i, this.color.set(color(d).fill)));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.render();
  }

  // pin keeps disc highlighted when nothing is hovered, or stops if it's null
  pin(disc) {
    this.pinned = disc;
    this.place();
  }

  setHand() {}
  setZoom() {}

  hover(d, e) {
    if (d !== this.hovered) {
      this.hovered = d;
      this.canvas.style.cursor = d ? "pointer" : "";
      this.place();
      if (!d) this.onHover(null);
    }
    // keep calling while on the same disc, so the tooltip follows the pointer
    if (d) this.onHover(d, e);
  }

  // hitTest returns the disc nearest the pointer on screen, if it's close
  // enough
  hitTest(e) {
    const box = this.canvas.getBoundingClientRect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    const v = new THREE.Vector3();
    let best = null;
    let bestD = HIT_PX * HIT_PX;
    this.points.forEach((p, i) => {
      v.copy(p).project(this.camera);
      // behind the camera
      if (v.z > 1) return;
      const dx = ((v.x + 1) / 2) * box.width - px;
      const dy = ((1 - v.y) / 2) * box.height - py;
      const dist = dx * dx + dy * dy;
      if (dist < bestD) [best, bestD] = [this.discs[i], dist];
    });
    return best;
  }

  // axes draws the cube's grid on its floor and two back walls, and labels the
  // three edges nearest the opening camera
  axes() {
    const group = new THREE.Group();
    const ticks = {};
    for (const [axis, { step }] of Object.entries(AXES)) {
      const { min, max } = this.extent[axis];
      ticks[axis] = [];
      for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks[axis].push(v);
    }
    const x = ticks.turn.map((v) => this.scale("turn", v));
    const y = ticks.speed.map((v) => this.scale("speed", v));
    const z = ticks.fade.map((v) => this.scale("fade", v));

    const lines = [];
    const line = (a, b) => lines.push(...a, ...b);
    for (const xi of x) {
      line([xi, -H, -H], [xi, -H, H]); // floor
      line([xi, -H, -H], [xi, H, -H]); // back wall
    }
    for (const zi of z) {
      line([-H, -H, zi], [H, -H, zi]); // floor
      line([-H, -H, zi], [-H, H, zi]); // side wall
    }
    for (const yi of y) {
      line([-H, yi, -H], [H, yi, -H]); // back wall
      line([-H, yi, -H], [-H, yi, H]); // side wall
    }
    const grid = new THREE.BufferGeometry();
    grid.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
    group.add(new THREE.LineSegments(grid, new THREE.LineBasicMaterial({ color: css("--grid") })));
    const box = new THREE.EdgesGeometry(new THREE.BoxGeometry(SIZE, SIZE, SIZE));
    group.add(new THREE.LineSegments(box, new THREE.LineBasicMaterial({ color: css("--muted") })));

    const muted = css("--muted");
    const label = (str, at, color = muted, height = 0.42) => {
      const s = sprite(str, color, height);
      s.position.set(...at);
      group.add(s);
    };
    ticks.turn.forEach((v, i) => label(String(v), [x[i], -H - 0.3, H + 0.5]));
    ticks.fade.forEach((v, i) => label(String(v), [H + 0.5, -H - 0.3, z[i]]));
    ticks.speed.forEach((v, i) => label(String(v), [-H - 0.5, y[i], H]));
    const text = css("--text");
    label("Turn", [0, -H - 1, H + 1.2], text, 0.6);
    label("Fade", [H + 1.2, -H - 1, 0], text, 0.6);
    label("Speed", [-H, H + 0.8, H], text, 0.6);
    // which way is which along turn isn't obvious from the numbers alone
    label("understable", [H, -H - 1, H + 1.2], muted, 0.36);
    label("overstable", [-H, -H - 1, H + 1.2], muted, 0.36);
    return group;
  }
}

// sprite is text that always faces the camera, height world units tall
function sprite(str, color, height) {
  const px = 64;
  const font = `${px}px system-ui, sans-serif`;
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  g.font = font;
  canvas.width = Math.ceil(g.measureText(str).width) + 8;
  canvas.height = Math.ceil(px * 1.3);
  // resizing the canvas resets its context
  g.font = font;
  g.fillStyle = color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(str, canvas.width / 2, canvas.height / 2);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, depthWrite: false }));
  s.scale.set((height * canvas.width) / canvas.height, height, 1);
  return s;
}
