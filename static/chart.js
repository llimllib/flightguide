// A speed vs. stability chart of discs, rendered as SVG.
//
// Stability (turn + fade) runs along the x axis, overstable on the left, and
// speed runs down the y axis. Each disc draws its flight: a thick translucent
// line from 0 to its turn, then a thin line from there to turn+fade, where the
// disc's dot sits.

const SVG_NS = "http://www.w3.org/2000/svg";
const MARGIN = { top: 56, right: 24, bottom: 12, left: 64 };

// the chart zooms to fit the discs shown, but never tighter than this many
// units either side of their center
const MIN_SPEED_HALF = 3;
const MIN_STABILITY_HALF = 2;
const PAD = 0.5;

// label as many discs as fit when there are at most this many; past that, the
// chart is too dense for labels to help
const LABEL_LIMIT = 300;
const LABEL_HEIGHT = 12;
const DURATION = 400;

const el = (tag, attrs = {}) => {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const stab = (d) => d.turn + d.fade;

// fit returns a domain covering values, at least minHalf either side of
// center, shifted (not shrunk) to stay within bounds where possible
function fit(values, minHalf, bounds) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const c = (lo + hi) / 2;
  const half = Math.max((hi - lo) / 2 + PAD, minHalf);
  let d0 = c - half;
  let d1 = c + half;
  if (d0 < bounds[0]) [d0, d1] = [bounds[0], d1 + bounds[0] - d0];
  if (d1 > bounds[1]) [d0, d1] = [Math.max(bounds[0], d0 - (d1 - bounds[1])), bounds[1]];
  return [d0, d1];
}

export function domainFor(discs, extent) {
  const speedBounds = [extent.speed.min - PAD, extent.speed.max + PAD];
  const stabBounds = [Math.min(0, extent.stability.min) - PAD, extent.stability.max + PAD];
  if (!discs.length) return { speed: speedBounds, stab: stabBounds };
  // every flight line starts at 0 and passes through the disc's turn
  const flight = discs.flatMap((d) => [stab(d), d.turn]).concat(0);
  // speed rows span ±0.5 around each speed, so extend to whole rows
  const [v0, v1] = fit(discs.map((d) => d.speed), MIN_SPEED_HALF, speedBounds);
  return {
    speed: [Math.floor(v0 - 0.5) + 0.5, Math.ceil(v1 - 0.5) + 0.5],
    stab: fit(flight, MIN_STABILITY_HALF, stabBounds),
  };
}

// pixels between the plot's edges and the domain, so discs at the domain's
// edges aren't drawn on the border. Speed rows end at half speeds, so a disc
// with a half speed in an edge row would otherwise sit on the border.
const PAD_X = 24;
const PAD_Y = 14;

// the closest lanes in a crowded speed row get, in pixels
const MIN_LANE = 2;

// a brush smaller than this, in pixels, is a click and doesn't zoom
const MIN_BRUSH = 8;

const inDomain = (d, dom) =>
  d.speed >= dom.speed[0] && d.speed <= dom.speed[1] && stab(d) >= dom.stab[0] && stab(d) <= dom.stab[1];

// dot radius shrinks as the chart gets busier
const radiusFor = (n) => (n > 300 ? 3.5 : n > 80 ? 5 : 7);

const measure = (() => {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = "11px system-ui, sans-serif";
  return (text) => ctx.measureText(text).width;
})();

export class Chart {
  constructor(container, { onHover, onClick, onZoom, onVisible }) {
    this.container = container;
    this.onZoom = onZoom;
    this.onVisible = onVisible;
    this.zoom = null; // a domain chosen by brushing, overriding the automatic fit
    this.items = new Map(); // disc id -> { disc, lines, turn, fade, dot, lane, fromLane, toLane }
    this.discs = [];
    this.ghosts = [];
    this.dom = null;

    this.svg = el("svg");
    const clip = el("clipPath", { id: "plot-clip" });
    this.clipRect = el("rect");
    clip.append(this.clipRect);
    this.svg.append(el("defs"));
    this.svg.firstChild.append(clip);

    this.axisLayer = el("g", { class: "axis" });
    const plot = el("g", { "clip-path": "url(#plot-clip)" });
    this.ghostLayer = el("g");
    this.lineLayer = el("g", { class: "lines" });
    this.dotLayer = el("g");
    // labels are clipped too, since they follow their discs during transitions
    this.labelLayer = el("g");
    plot.append(this.ghostLayer, this.lineLayer, this.dotLayer, this.labelLayer);
    this.brushRect = el("rect", { class: "brush" });
    this.brushRect.style.display = "none";
    this.svg.append(this.axisLayer, plot, this.brushRect);
    container.append(this.svg);

    this.svg.addEventListener("pointerdown", (e) => this.brushStart(e));
    this.svg.addEventListener("pointermove", (e) => this.brushMove(e));
    this.svg.addEventListener("pointerup", (e) => this.brushEnd(e));
    this.svg.addEventListener("pointercancel", () => this.brushEnd(null));
    this.svg.addEventListener("dblclick", (e) => {
      if (!e.target.classList.contains("disc")) this.setZoom(null);
    });

    this.dotLayer.addEventListener("pointerover", (e) => {
      const it = this.items.get(Number(e.target.dataset.id));
      if (!it) return;
      this.highlight(it);
      onHover(it.disc, e);
    });
    this.dotLayer.addEventListener("pointermove", (e) => {
      const it = this.items.get(Number(e.target.dataset.id));
      if (it) onHover(it.disc, e);
    });
    this.dotLayer.addEventListener("pointerout", () => {
      this.highlight(null);
      onHover(null);
    });
    this.dotLayer.addEventListener("click", (e) => {
      const it = this.items.get(Number(e.target.dataset.id));
      if (it) onClick(it.disc);
    });

    new ResizeObserver(() => this.resize()).observe(container);
  }

  resize() {
    this.measure();
    if (!this.extent) return;
    cancelAnimationFrame(this.raf);
    const target = this.target();
    this.density(target);
    this.layout(target);
    for (const it of this.items.values()) it.fromLane = it.toLane;
    this.draw(target, 1);
    this.finish();
  }

  measure() {
    const w = this.container.clientWidth;
    const h = Math.max(360, this.container.clientHeight);
    this.size = { w, h };
    this.svg.setAttribute("width", w);
    this.svg.setAttribute("height", h);
    set(this.clipRect, {
      x: MARGIN.left,
      y: MARGIN.top,
      width: Math.max(0, w - MARGIN.left - MARGIN.right),
      height: Math.max(0, h - MARGIN.top - MARGIN.bottom),
    });
  }

  // setData shows discs, with ghosts drawn faintly behind them for context
  setData(discs, ghosts, extent, color) {
    this.discs = discs;
    this.extent = extent;
    if (!this.size) this.measure();

    const ids = new Set(discs.map((d) => d.id));
    for (const [id, it] of this.items) {
      if (ids.has(id)) continue;
      it.lines.remove();
      it.dot.remove();
      it.label?.el.remove();
      this.items.delete(id);
    }
    for (const disc of discs) {
      let it = this.items.get(disc.id);
      if (it) {
        it.disc = disc;
        it.entering = false;
        continue;
      }
      it = { disc, entering: true, lane: 0 };
      it.lines = el("g");
      it.turn = el("line", { class: "turn" });
      it.fade = el("line", { class: "fade" });
      it.lines.append(it.turn, it.fade);
      it.dot = el("circle", { class: "disc", "data-id": disc.id });
      this.lineLayer.append(it.lines);
      this.dotLayer.append(it.dot);
      this.items.set(disc.id, it);
    }
    this.recolor(color);

    this.ghosts = ghosts;
    this.ghostLayer.replaceChildren(...ghosts.map(() => el("circle", { class: "ghost", r: 2.5 })));

    const target = this.target();
    this.density(target);
    this.layout(target);
    for (const it of this.items.values()) it.fromLane = it.entering ? it.toLane : it.lane;
    this.animate(this.dom ?? target, target);
  }

  // target is the domain the chart should show: the brushed zoom if there is
  // one, otherwise a fit to the discs
  target() {
    return this.zoom ?? domainFor(this.discs, this.extent);
  }

  // density marks which discs are visible in dom, whose dots and lines are
  // hidden otherwise, and sizes dots and fades lines by how many there are
  density(dom) {
    let n = 0;
    for (const it of this.items.values()) {
      it.toVis = inDomain(it.disc, dom) ? 1 : 0;
      it.fromVis = it.entering ? it.toVis : (it.vis ?? it.toVis);
      n += it.toVis;
    }
    this.visible = n;
    this.onVisible?.(n);
    this.R = radiusFor(n);
    this.svg.style.setProperty("--k", Math.min(1, Math.max(0.2, Math.sqrt(60 / Math.max(n, 1)))));
    this.lineLayer.style.setProperty("--turn-w", `${Math.max(3, this.R)}px`);
  }

  // setZoom animates to dom, or back to the automatic fit if it's null
  setZoom(dom) {
    if (!dom && !this.zoom) return;
    this.zoom = dom;
    this.onZoom?.(Boolean(dom));
    if (!this.extent) return;
    const target = this.target();
    this.density(target);
    this.layout(target);
    for (const it of this.items.values()) it.fromLane = it.lane;
    this.animate(this.dom ?? target, target);
  }

  // local returns the pointer position in svg pixels, clamped to the plot
  local(e) {
    const box = this.svg.getBoundingClientRect();
    const { x0, x1, y0, y1 } = this.scales(this.dom);
    return {
      x: Math.min(x1, Math.max(x0, e.clientX - box.left)),
      y: Math.min(y1, Math.max(y0, e.clientY - box.top)),
      inside: e.clientX - box.left >= x0 && e.clientX - box.left <= x1 && e.clientY - box.top >= y0 && e.clientY - box.top <= y1,
    };
  }

  brushStart(e) {
    if (e.button !== 0 || !this.dom || e.target.classList.contains("disc")) return;
    const p = this.local(e);
    if (!p.inside) return;
    e.preventDefault();
    this.svg.setPointerCapture(e.pointerId);
    this.brush = { x: p.x, y: p.y };
  }

  brushRectFor(e) {
    const p = this.local(e);
    const b = this.brush;
    return { x: Math.min(b.x, p.x), y: Math.min(b.y, p.y), w: Math.abs(p.x - b.x), h: Math.abs(p.y - b.y) };
  }

  brushMove(e) {
    if (!this.brush) return;
    const r = this.brushRectFor(e);
    set(this.brushRect, { x: r.x, y: r.y, width: r.w, height: r.h });
    this.brushRect.style.display = r.w >= MIN_BRUSH || r.h >= MIN_BRUSH ? "" : "none";
  }

  // brushEnd zooms to the brushed rectangle, extended to whole speed rows and
  // half units of stability
  brushEnd(e) {
    if (!this.brush) return;
    const r = e && this.brushRectFor(e);
    this.brush = null;
    this.brushRect.style.display = "none";
    if (!r || r.w < MIN_BRUSH || r.h < MIN_BRUSH) return;

    const { inv } = this.scales(this.dom);
    const a = inv(r.x, r.y);
    const b = inv(r.x + r.w, r.y + r.h);
    let s0 = Math.floor(Math.min(a.stab, b.stab) * 2) / 2;
    let s1 = Math.ceil(Math.max(a.stab, b.stab) * 2) / 2;
    if (s1 - s0 < 1) [s0, s1] = [(s0 + s1) / 2 - 0.5, (s0 + s1) / 2 + 0.5];
    const v0 = Math.floor(Math.min(a.speed, b.speed) - 0.5) + 0.5;
    const v1 = Math.ceil(Math.max(a.speed, b.speed) - 0.5) + 0.5;
    this.setZoom({ speed: [v0, Math.max(v1, v0 + 1)], stab: [s0, s1] });
  }

  recolor(color) {
    for (const it of this.items.values()) {
      const { fill, stroke } = color(it.disc);
      it.dot.setAttribute("fill", fill);
      it.dot.setAttribute("stroke", stroke);
    }
  }

  scales(dom) {
    const { w, h } = this.size;
    const x0 = MARGIN.left;
    const x1 = w - MARGIN.right;
    const y0 = MARGIN.top;
    const y1 = h - MARGIN.bottom;
    // widen the domain so it maps to the plot inset by PAD_X and PAD_Y
    const padS = (PAD_X * (dom.stab[1] - dom.stab[0])) / Math.max(1, x1 - x0 - 2 * PAD_X);
    const padV = (PAD_Y * (dom.speed[1] - dom.speed[0])) / Math.max(1, y1 - y0 - 2 * PAD_Y);
    const s0 = dom.stab[0] - padS;
    const s1 = dom.stab[1] + padS;
    const v0 = dom.speed[0] - padV;
    const v1 = dom.speed[1] + padV;
    return {
      s0,
      s1,
      v0,
      v1,
      sx: (v) => x0 + ((s1 - v) / (s1 - s0)) * (x1 - x0),
      sy: (v) => y0 + ((v1 - v) / (v1 - v0)) * (y1 - y0),
      inv: (x, y) => ({
        stab: s1 - ((x - x0) / (x1 - x0)) * (s1 - s0),
        speed: v1 - ((y - y0) / (y1 - y0)) * (v1 - v0),
      }),
      x0,
      x1,
      y0,
      y1,
    };
  }

  // layout spreads discs sharing a speed into lanes within their speed row,
  // storing each disc's lane in lanePos (0 is the row's center, negative is
  // above) and its pixel offset in toLane.
  //
  // So that changing filters doesn't reshuffle the chart, discs already shown
  // keep their lane, even if it's crowded, or the nearest one if the row has
  // lost lanes, then slide toward the center through any lanes left free by
  // removed discs. Sliding one free lane at a time never passes a disc that
  // overlaps horizontally, so their order is kept. A disc whose dot overlaps
  // another's moves to the nearest lane where it doesn't, if there is one;
  // hiding a disc is worse than moving it. New discs then take the
  // lane nearest the center where their whole flight line fits without
  // overlapping another, or failing that, where at least their dot does.
  layout(dom) {
    const { sx, sy } = this.scales(dom);
    const pxPerSpeed = Math.abs(sy(1) - sy(0));
    const gap = this.R * 2 + 1;
    // hidden discs keep their lane while they fade out, and take up no room
    const shown = [];
    for (const it of this.items.values()) {
      if (it.toVis) shown.push(it);
      else it.toLane = it.lane;
    }
    const rows = Map.groupBy(shown, (it) => it.disc.speed);
    const apart = ([a, b], [c, d]) => b <= c || d <= a;
    for (const [speed, row] of rows) {
      // keep dots inside their row, and discs with a half speed, which sit on
      // a row boundary, near it; at the domain's edge that means inside PAD_Y
      let halfBand = Number.isInteger(speed) ? pxPerSpeed / 2 - this.R - 2 : pxPerSpeed * 0.15;
      if (speed <= dom.speed[0] || speed >= dom.speed[1]) halfBand = Math.min(halfBand, PAD_Y - this.R - 1);
      // a row needs a lane for each disc sharing a spot; if they don't fit a
      // dot apart, space lanes closer so dots overlap partly instead of one
      // hiding another entirely
      const stack = Math.max(...Map.groupBy(row, (it) => stab(it.disc)).values().map((g) => g.length));
      let m = Math.max(0, Math.floor(halfBand / gap));
      let spacing = gap;
      if (2 * m + 1 < stack && halfBand > 0) {
        m = Math.ceil((stack - 1) / 2);
        spacing = Math.max(MIN_LANE, halfBand / m);
        m = Math.min(m, Math.floor(halfBand / spacing));
      }
      const preference = [0];
      for (let i = 1; i <= m; i++) preference.push(-i, i);
      const lanes = new Map(preference.map((p) => [p, []]));

      // whole: the flight line must fit, not just the dot
      const fits = (p, x, whole) => lanes.get(p)?.every((o) => apart(o.dot, x.dot) && (!whole || apart(o.span, x.span)));
      // clashes counts the dots in lane p that x's dot would overlap
      const clashes = (p, x) => lanes.get(p).filter((o) => !apart(o.dot, x.dot)).length;
      const put = (p, x) => {
        lanes.get(p).push(x);
        x.it.lanePos = p;
        x.it.toLane = p * spacing;
      };

      const kept = [];
      const fresh = [];
      for (const it of row) {
        const d = it.disc;
        const xs = [sx(0), sx(d.turn), sx(stab(d))];
        const x = { it, span: [Math.min(...xs) - this.R, Math.max(...xs) + this.R], dot: [xs[2] - gap / 2, xs[2] + gap / 2] };
        if (it.lanePos != null) {
          put(Math.max(-m, Math.min(m, it.lanePos)), x);
          kept.push(x);
        } else fresh.push(x);
      }

      kept.sort((a, b) => Math.abs(a.it.lanePos) - Math.abs(b.it.lanePos));
      for (const x of kept) {
        let p = x.it.lanePos;
        const lane = lanes.get(p);
        lane.splice(lane.indexOf(x), 1);
        while (p !== 0 && fits(p - Math.sign(p), x, true)) p -= Math.sign(p);
        put(p, x);
      }
      for (const x of kept) {
        if (lanes.get(x.it.lanePos).every((o) => o === x || apart(o.dot, x.dot))) continue;
        const p = x.it.lanePos;
        const lane = lanes.get(p);
        const q = preference
          .filter((q) => q !== p && fits(q, x, false))
          .sort((a, b) => Math.abs(a - p) - Math.abs(b - p))[0];
        if (q === undefined) continue;
        lane.splice(lane.indexOf(x), 1);
        put(q, x);
      }

      fresh.sort((a, b) => a.span[0] - b.span[0]);
      for (const x of fresh) {
        const p =
          preference.find((q) => fits(q, x, true)) ??
          preference.find((q) => fits(q, x, false)) ??
          preference.reduce((best, q) => (clashes(q, x) < clashes(best, x) ? q : best), 0);
        put(p, x);
      }
    }
  }

  animate(from, to) {
    cancelAnimationFrame(this.raf);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.draw(to, 1);
      this.finish();
      return;
    }
    const start = performance.now();
    const tick = (now) => {
      const t = ease(Math.min(1, (now - start) / DURATION));
      this.draw(
        { speed: from.speed.map((v, i) => lerp(v, to.speed[i], t)), stab: from.stab.map((v, i) => lerp(v, to.stab[i], t)) },
        t,
      );
      if (t < 1) this.raf = requestAnimationFrame(tick);
      else this.finish();
    };
    this.raf = requestAnimationFrame(tick);
  }

  draw(dom, t) {
    this.dom = dom;
    const scales = this.scales(dom);
    const { sx, sy } = scales;
    this.drawAxes(scales);

    this.ghosts.forEach((d, i) => {
      const c = this.ghostLayer.children[i];
      c.setAttribute("cx", sx(stab(d)));
      c.setAttribute("cy", sy(d.speed));
    });

    const x0 = sx(0);
    for (const it of this.items.values()) {
      const d = it.disc;
      it.lane = lerp(it.fromLane, it.toLane, t);
      const y = sy(d.speed) + it.lane;
      const xt = sx(d.turn);
      const xd = sx(stab(d));
      set(it.turn, { x1: x0, y1: y, x2: xt, y2: y });
      set(it.fade, { x1: xt, y1: y, x2: xd, y2: y });
      set(it.dot, { cx: xd, cy: y, r: this.R });
      it.vis = lerp(it.fromVis, it.toVis, t);
      const opacity = it.vis * (it.entering ? t : 1);
      const display = opacity > 0 ? "" : "none";
      it.dot.style.opacity = it.lines.style.opacity = opacity === 1 ? "" : opacity;
      it.dot.style.display = it.lines.style.display = display;
      // existing labels follow their discs until drawLabels places them anew
      if (it.label) {
        set(it.label.el, { x: xd + it.label.dx, y: y + it.label.dy });
        it.label.el.style.opacity = it.dot.style.opacity;
        it.label.el.style.display = display;
      }
    }
  }

  drawAxes({ s0, s1, v0, v1, sx, sy, x0, x1, y0, y1 }) {
    const pxPerSpeed = (y1 - y0) / (v1 - v0);
    const speedStep = pxPerSpeed < 16 ? 2 : 1;
    const out = [];

    // vertical grid lines at each whole stability, labelled along the top
    for (let s = Math.ceil(s0); s <= s1; s++) {
      const x = sx(s).toFixed(1);
      out.push(`<line class="${s === 0 ? "zero" : "grid"}" x1="${x}" x2="${x}" y1="${y0}" y2="${y1}"/>`);
      out.push(`<text x="${x}" y="${y0 - 8}" text-anchor="middle">${s}</text>`);
    }
    // speed rows are bounded by grid lines at the half speeds
    for (let v = Math.ceil(v0 - 0.5) + 0.5; v <= v1; v++) {
      const y = sy(v).toFixed(1);
      out.push(`<line class="grid" x1="${x0}" x2="${x1}" y1="${y}" y2="${y}"/>`);
    }
    for (let v = Math.ceil(v0); v <= v1; v++) {
      if (v % speedStep) continue;
      out.push(`<text x="${x0 - 10}" y="${sy(v).toFixed(1)}" dy="0.35em" text-anchor="end">${v}</text>`);
    }

    const mid = (x0 + x1) / 2;
    out.push(`<text class="axis-title" x="${mid}" y="20" text-anchor="middle">Stability (Turn + Fade)</text>`);
    out.push(`<text x="${x0}" y="20">← overstable</text>`);
    out.push(`<text x="${x1}" y="20" text-anchor="end">understable →</text>`);
    const ym = (y0 + y1) / 2;
    out.push(`<text class="axis-title" transform="translate(18 ${ym}) rotate(-90)" text-anchor="middle">Speed</text>`);
    this.axisLayer.innerHTML = out.join("");
  }

  // finish runs after the last frame of a transition, which draw has already
  // left at full opacity
  finish() {
    for (const it of this.items.values()) it.entering = false;
    this.drawLabels();
  }

  // drawLabels places each label below, above, right or left of its dot,
  // skipping any label that would collide with another label or dot. Discs
  // with the most stock at Marshall Street, a stand-in for popularity, are
  // labelled first, so they win when labels compete for space.
  drawLabels() {
    this.labelLayer.replaceChildren();
    for (const it of this.items.values()) it.label = null;
    if (this.visible > LABEL_LIMIT) return;
    const { sx, sy, x0, x1, y0, y1 } = this.scales(this.dom);
    const R = this.R;
    const pos = [...this.items.values()].filter((it) => it.toVis).map((it) => ({
      it,
      x: sx(stab(it.disc)),
      y: sy(it.disc.speed) + it.lane,
    }));
    const dots = pos.map(({ x, y }) => ({ x: x - R, y: y - R, w: 2 * R, h: 2 * R }));
    const placed = [];
    const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

    const order = pos.map((_, i) => i);
    order.sort((a, b) => (pos[b].it.disc.in_stock_products ?? 0) - (pos[a].it.disc.in_stock_products ?? 0));

    for (const i of order) {
      const { it, x, y } = pos[i];
      const text = it.disc.model;
      const w = measure(text);
      const h = LABEL_HEIGHT;
      const box = [
        { x: x - w / 2, y: y + R + 1 },
        { x: x - w / 2, y: y - R - 1 - h },
        { x: x + R + 3, y: y - h / 2 },
        { x: x - R - 3 - w, y: y - h / 2 },
      ]
        .map((b) => ({ ...b, w, h }))
        .find(
          (b) =>
            b.x >= x0 &&
            b.x + b.w <= x1 &&
            b.y >= y0 &&
            b.y + b.h <= y1 &&
            !placed.some((p) => hits(b, p)) &&
            !dots.some((d, j) => j !== i && hits(b, d)),
        );
      if (!box) continue;
      placed.push(box);
      const label = el("text", { class: "label", x: box.x, y: box.y + h - 2 });
      label.textContent = text;
      this.labelLayer.append(label);
      it.label = { el: label, dx: box.x - x, dy: box.y + h - 2 - y };
    }
  }

  highlight(it) {
    this.lineLayer.querySelector(".hover")?.classList.remove("hover");
    this.dotLayer.querySelector(".hover")?.classList.remove("hover");
    if (!it) return;
    it.lines.classList.add("hover");
    it.dot.classList.add("hover");
    // raise the hovered disc above its neighbours
    if (this.dotLayer.lastChild !== it.dot) {
      this.lineLayer.append(it.lines);
      this.dotLayer.append(it.dot);
    }
  }
}

function set(e, attrs) {
  for (const k in attrs) e.setAttribute(k, attrs[k]);
}
