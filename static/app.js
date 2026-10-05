import { Chart } from "./chart.js";
import { flightPath } from "./flight.js";

const $ = (s) => document.querySelector(s);
const filters = $("#filters");
// each range is a filter slider and the value it compares against
const RANGES = [
  ["speed", "Speed", (d) => d.speed],
  ["glide", "Glide", (d) => d.glide],
  ["turn", "Turn", (d) => d.turn],
  ["fade", "Fade", (d) => d.fade],
  ["stability", "Turn + Fade", (d) => d.turn + d.fade],
];

const CATEGORY_COLORS = {
  Putters: "#a78bfa",
  "Approach Discs": "#f472b6",
  "Midrange Drivers": "#2dd4bf",
  "Hybrid Drivers": "#facc15",
  "Control Drivers": "#fb923c",
  "Distance Drivers": "#f87171",
};
// the data's category names come from the shop's navigation, where "Midrange
// Drivers" reads consistently beside its siblings. Here it's just long, so
// rename it for display; filter values and saved URLs keep the data's name
const CATEGORY_LABELS = { "Midrange Drivers": "Midranges" };
const catLabel = (c) => CATEGORY_LABELS[c] ?? c;

const STABILITY_COLORS = {
  "very overstable": "#f97316",
  overstable: "#facc15",
  stable: "#e5e7eb",
  understable: "#2dd4bf",
  "very understable": "#a78bfa",
};

const colorers = {
  brand: (d) => ({ fill: d.bg_color ?? "#888", stroke: d.text_color ?? "#000" }),
  category: (d) => ({ fill: CATEGORY_COLORS[d.category] ?? "#9ca3af", stroke: "#0009" }),
  stability: (d) => ({ fill: STABILITY_COLORS[d.stability_group] ?? "#9ca3af", stroke: "#0009" }),
};

const isTyping = (el) =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// the four flight numbers, which we label rather than printing bare: "12 | 5 |
// -1 | 3" only reads to someone who already knows the order
const RATINGS = [
  ["Speed", (d) => d.speed],
  ["Glide", (d) => d.glide],
  ["Turn", (d) => d.turn],
  ["Fade", (d) => d.fade],
];
const ratings = (d) =>
  `<div class="ratings">${RATINGS.map(([name, value]) => `<div><span>${name}</span><b>${esc(value(d))}</b></div>`).join("")}</div>`;

// the data's stability_group is already plain English. Marshall Street's A-Q
// grade isn't, and means nothing away from their chart, so we don't show it
const stability = (d) => d.stability_group?.replace(/^./u, (c) => c.toUpperCase());

// which hand the estimated flight path is drawn for; "it finishes left" is
// wrong for a third of players
let hand = "r";

// flightFigure draws the estimated path. The SVG's units are feet with the tee
// at the origin, so the geometry needs no conversion on the way in
function flightFigure(d) {
  const f = flightPath(d, hand);
  const side = f.land.x < 0 ? "left" : "right";
  const label = `Estimated flight path: carries about ${f.dist} feet and finishes about ${Math.abs(Math.round(f.land.x))} feet ${side}`;
  return `<figure class="flight" data-disc="${esc(d.id)}">
    <svg viewBox="${f.viewBox}" preserveAspectRatio="xMidYMax meet" role="img" aria-label="${esc(label)}">
      <line class="flight-centre" x1="0" y1="0" x2="0" y2="${-f.max}" />
      <path class="flight-line" d="${f.path}" />
      <circle class="flight-land" cx="${f.land.x.toFixed(1)}" cy="${f.land.y.toFixed(1)}" r="11" />
      <circle class="flight-tee" cx="0" cy="0" r="7" />
    </svg>
    <figcaption>
      <span>Estimated backhand path · about ${f.dist} ft</span>
      <span class="hand-toggle" role="group" aria-label="Throwing hand">
        <button type="button" data-hand="r" aria-pressed="${hand === "r"}">Right</button>
        <button type="button" data-hand="l" aria-pressed="${hand === "l"}">Left</button>
      </span>
    </figcaption>
  </figure>`;
}

// redrawFlights repoints every path on the page after the hand changes, rather
// than re-rendering the cards around them
function redrawFlights() {
  for (const fig of document.querySelectorAll(".flight")) {
    const d = allDiscs.find((x) => String(x.id) === fig.dataset.disc);
    if (!d) continue;
    const f = flightPath(d, hand);
    fig.querySelector(".flight-line").setAttribute("d", f.path);
    const land = fig.querySelector(".flight-land");
    land.setAttribute("cx", f.land.x.toFixed(1));
    land.setAttribute("cy", f.land.y.toFixed(1));
    for (const b of fig.querySelectorAll("[data-hand]")) b.setAttribute("aria-pressed", b.dataset.hand === hand);
  }
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// buildMeta derives the values the filter controls need from the full dataset
function buildMeta(discs) {
  const brands = new Map();
  const categories = new Map();
  for (const d of discs) {
    // a brand's discs all share its colors, so any row's colors will do
    const b = brands.get(d.brand) ?? { name: d.brand, count: 0, bg_color: d.bg_color, text_color: d.text_color };
    b.count++;
    brands.set(d.brand, b);
    if (d.category) categories.set(d.category, (categories.get(d.category) ?? 0) + 1);
  }
  const ranges = {};
  for (const [r, , value] of RANGES) {
    const vals = discs.map(value);
    ranges[r] = { min: Math.min(...vals), max: Math.max(...vals) };
  }
  return {
    brands: [...brands.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    categories: [...categories].sort((a, b) => b[1] - a[1]).map(([c]) => c),
    ranges,
  };
}

let meta;
let allDiscs;
let chart;

async function init() {
  allDiscs = await getJSON("data/discs.json");
  meta = buildMeta(allDiscs);

  $("#categories").innerHTML = meta.categories
    .map(
      (c) => `<label class="check"><input type="checkbox" name="category" value="${esc(c)}"> ${esc(catLabel(c))}</label>`,
    )
    .join("");
  $("#brands").innerHTML = meta.brands
    .map(
      (b) => `<label class="check" data-name="${esc(b.name.toLowerCase())}">
        <input type="checkbox" name="brand" value="${esc(b.name)}">
        <span class="swatch" style="background:${esc(b.bg_color)};border-color:${esc(b.text_color)}"></span>
        ${esc(b.name)}<span class="n">${b.count}</span></label>`,
    )
    .join("");
  buildSliders();

  restore(new URLSearchParams(location.search));

  chart = new Chart($("#chart"), {
    onHover: showTooltip,
    onClick: showDetail,
    onZoom: (zoomed) => {
      $("#reset-zoom").hidden = !zoomed;
      $("#zoom-hint").hidden = zoomed;
    },
    onVisible: showEmpty,
  });
  $("#reset-zoom").addEventListener("click", () => chart.setZoom(null));
  $("#empty-reset").addEventListener("click", () => chart.setZoom(null));
  // the toggle lives inside cards that are rebuilt as discs are opened
  document.addEventListener("click", (e) => {
    const pick = e.target.closest?.("[data-hand]");
    if (!pick || pick.dataset.hand === hand) return;
    hand = pick.dataset.hand;
    redrawFlights();
    saveURL();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#detail").open) chart.setZoom(null);
    // / jumps to the search box, as long as the reader isn't already typing
    if (e.key === "/" && !(e.ctrlKey || e.metaKey || e.altKey) && !isTyping(e.target)) {
      e.preventDefault(); // or the slash lands in the box, and Firefox quick-finds
      $("#q").focus();
      $("#q").select();
    }
  });

  filters.addEventListener("submit", (e) => e.preventDefault());
  filters.addEventListener("input", (e) => {
    if (e.target.id === "brand-search") return filterBrandList(e.target.value);
    const range = e.target.closest(".range");
    if (range) syncSlider(range.dataset.range);
    update();
  });
  // a slider's handles may cross while dragging; once released, put them back
  // in order so the min handle holds the low value
  filters.addEventListener("change", (e) => {
    const r = e.target.closest(".range")?.dataset.range;
    if (!r) return;
    const [lo, hi] = sliderValues(r);
    filters.elements[`${r}_min`].value = lo;
    filters.elements[`${r}_max`].value = hi;
  });
  $("#toolbar").addEventListener("change", (e) => {
    if (e.target.id === "color") {
      chart.recolor(colorers[e.target.value]);
      drawLegend();
      saveURL();
    } else update();
  });
  $("#clear-brands").addEventListener("click", () => {
    for (const cb of filters.querySelectorAll("[name=brand]:checked")) cb.checked = false;
    update();
  });
  $("#reset").addEventListener("click", () => {
    restore(new URLSearchParams());
    update();
  });
  $("#detail").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });

  update();
}

// filterParams returns the API query for the current filter controls
function filterParams() {
  const p = new URLSearchParams();
  const q = filters.elements.q.value.trim();
  if (q) p.set("q", q);
  // a slider at the end of its range doesn't filter
  for (const [r] of RANGES) {
    const [lo, hi] = sliderValues(r);
    const input = filters.elements[`${r}_min`];
    if (lo > Number(input.min)) p.set(`${r}_min`, lo);
    if (hi < Number(input.max)) p.set(`${r}_max`, hi);
  }
  for (const cb of filters.querySelectorAll("input[type=checkbox][name]:checked")) p.append(cb.name, cb.value);
  if ($("#hide-oop").checked) p.set("oop", "0");
  if ($("#popular").checked) p.set("popular", "1");
  return p;
}

function uiParams() {
  const p = filterParams();
  // out of production discs are hidden by default, so the URL records showing them
  p.delete("oop");
  if (!$("#hide-oop").checked) p.set("oop", "1");
  // likewise, only the popular molds are shown by default, so the URL records
  // having opened it up to everything
  p.delete("popular");
  if (!$("#popular").checked) p.set("popular", "0");
  if ($("#color").value !== "brand") p.set("color", $("#color").value);
  if (!$("#ghosts").checked) p.set("ghosts", "0");
  if (hand !== "r") p.set("hand", hand);
  return p;
}

function saveURL() {
  const qs = uiParams().toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

function restore(p) {
  filters.elements.q.value = p.get("q") ?? "";
  for (const [r] of RANGES) {
    const min = filters.elements[`${r}_min`];
    const max = filters.elements[`${r}_max`];
    // range inputs clamp and round these to their min, max and step
    min.value = p.get(`${r}_min`) ?? min.min;
    max.value = p.get(`${r}_max`) ?? max.max;
    syncSlider(r);
  }
  for (const cb of filters.querySelectorAll("input[type=checkbox][name]")) {
    cb.checked = p.getAll(cb.name).includes(cb.value);
  }
  $("#hide-oop").checked = p.get("oop") !== "1";
  $("#popular").checked = p.get("popular") !== "0";
  $("#color").value = p.get("color") ?? "brand";
  $("#ghosts").checked = p.get("ghosts") !== "0";
  hand = p.get("hand") === "l" ? "l" : "r";
  $("#brand-search").value = "";
  filterBrandList("");
}

// buildSliders creates a two-handle slider for each of RANGES, spanning the
// values in the data. Each is a pair of overlaid range inputs sharing a track.
function buildSliders() {
  $("#ranges").innerHTML = RANGES.map(([r, label]) => {
    const lo = Math.floor(meta.ranges[r].min * 2) / 2;
    const hi = Math.ceil(meta.ranges[r].max * 2) / 2;
    const attrs = `type="range" min="${lo}" max="${hi}" step="0.5"`;
    return `<div class="range" data-range="${r}">
        <div class="range-head"><span>${esc(label)}</span><output></output></div>
        <div class="dual">
          <input ${attrs} name="${r}_min" value="${lo}" aria-label="Minimum ${esc(label.toLowerCase())}">
          <input ${attrs} name="${r}_max" value="${hi}" aria-label="Maximum ${esc(label.toLowerCase())}">
        </div>
      </div>`;
  }).join("");
}

// sliderValues returns a slider's [low, high], whichever order its handles are in
function sliderValues(r) {
  const a = filters.elements[`${r}_min`].valueAsNumber;
  const b = filters.elements[`${r}_max`].valueAsNumber;
  return [Math.min(a, b), Math.max(a, b)];
}

// syncSlider updates a slider's highlighted track and value readout
function syncSlider(r) {
  const [lo, hi] = sliderValues(r);
  const input = filters.elements[`${r}_min`];
  const min = Number(input.min);
  const max = Number(input.max);
  const box = input.closest(".range");
  const pct = (v) => `${((v - min) / (max - min)) * 100}%`;
  box.style.setProperty("--lo", pct(lo));
  box.style.setProperty("--hi", pct(hi));
  box.querySelector("output").textContent = lo === hi ? `${lo}` : `${lo} to ${hi}`;
  box.classList.toggle("active", lo > min || hi < max);
}

function filterBrandList(text) {
  const t = text.trim().toLowerCase();
  for (const label of $("#brands").children) label.hidden = !label.dataset.name.includes(t);
}

// applyFilters returns the discs matching a filterParams() query. build_json.py
// writes them in the order the chart draws them, fastest and most overstable
// first, and filtering keeps that order.
function applyFilters(p) {
  const brands = new Set(p.getAll("brand"));
  const categories = new Set(p.getAll("category"));
  const q = (p.get("q") ?? "").toLowerCase();
  const hideOOP = p.get("oop") === "0";
  const popularOnly = p.get("popular") === "1";
  // only the sliders away from the ends of their track filter anything
  const bounds = RANGES.flatMap(([r, , value]) => {
    const lo = p.get(`${r}_min`);
    const hi = p.get(`${r}_max`);
    return lo === null && hi === null ? [] : [[value, Number(lo ?? -Infinity), Number(hi ?? Infinity)]];
  });

  return allDiscs.filter((d) => {
    if (brands.size && !brands.has(d.brand)) return false;
    if (categories.size && !categories.has(d.category)) return false;
    if (hideOOP && d.out_of_production) return false;
    if (popularOnly && !d.popular) return false;
    if (q && !d.model.toLowerCase().includes(q) && !(d.pdga_model ?? "").toLowerCase().includes(q)) return false;
    for (const [value, lo, hi] of bounds) {
      const v = value(d);
      if (v < lo || v > hi) return false;
    }
    return true;
  });
}

// update redraws the chart for the current filters. Filtering is local and
// fast, but redrawing every disc isn't, so while a slider is being dragged we
// coalesce to one redraw per frame.
let pending;
function update() {
  pending ??= requestAnimationFrame(() => {
    pending = null;
    redraw();
  });
}

function redraw() {
  saveURL();
  const params = filterParams();
  $("#clear-brands").hidden = !params.has("brand");

  let discs = applyFilters(params);
  // the curated foreground is a default, not a constraint. Rather than show an
  // empty chart and make the reader widen it themselves, fall back to every
  // disc whenever the popular filter is the only thing hiding matches. The
  // checkbox stays checked, so clearing the search restores the curated view.
  let relaxed = false;
  if (discs.length === 0 && params.has("popular")) {
    params.delete("popular");
    const beyond = applyFilters(params);
    relaxed = beyond.length > 0;
    if (relaxed) discs = beyond;
  }
  $("#relaxed").hidden = !relaxed;
  showSingle(discs.length === 1 ? discs[0] : null);

  const ids = new Set(discs.map((d) => d.id));
  const ghosts = $("#ghosts").checked ? allDiscs.filter((d) => !ids.has(d.id)) : [];
  chart.setData(discs, ghosts, meta.ranges, colorers[$("#color").value]);

  $("#count").textContent =
    discs.length === allDiscs.length ? `${discs.length} discs` : `${discs.length} of ${allDiscs.length} discs`;
  drawLegend(discs);
}

// showEmpty explains an empty chart: either no discs match the filters at all,
// or some do but none are in the zoomed area. Matches hidden only by the
// popular filter never get here, because redraw shows them instead.
function showEmpty(visible) {
  const zoomed = chart.discs.length > 0;
  $("#empty").hidden = visible > 0;
  $("#empty-text").textContent = zoomed ? "No discs in the zoomed area match these filters." : "No discs match these filters.";
  $("#empty-reset").hidden = !zoomed;
}

let legendDiscs = [];
function drawLegend(discs = legendDiscs) {
  legendDiscs = discs;
  let legend = $("#legend");
  if (!legend) {
    legend = document.createElement("span");
    legend.id = "legend";
    $("#toolbar").append(legend);
  }
  const mode = $("#color").value;
  let entries = [];
  if (mode === "category") entries = Object.entries(CATEGORY_COLORS).map(([k, c]) => [catLabel(k), c, "#0009"]);
  else if (mode === "stability") entries = Object.entries(STABILITY_COLORS).map(([k, c]) => [k, c, "#0009"]);
  else {
    const brands = new Set(discs.map((d) => d.brand));
    if (brands.size <= 8) {
      entries = meta.brands.filter((b) => brands.has(b.name)).map((b) => [b.name, b.bg_color, b.text_color]);
    }
  }
  legend.innerHTML = entries
    .map(
      ([name, fill, stroke]) =>
        `<span class="check"><span class="swatch" style="background:${esc(fill)};border-color:${esc(stroke)}"></span>${esc(name)}</span>`,
    )
    .join("");
}

// the tooltip is rebuilt only when the disc changes, since showTooltip is
// called again on every pointer move to reposition it
let tipId = null;

function showTooltip(d, e) {
  const tip = $("#tooltip");
  if (!d) {
    tip.hidden = true;
    tipId = null;
    return;
  }
  if (d.id !== tipId) {
    tipId = d.id;
    const extra = [catLabel(d.category), stability(d), d.out_of_production && "out of production"].filter(Boolean);
    tip.innerHTML = `<strong>${esc(d.model)}</strong> <span class="muted">${esc(d.brand)}</span>
      ${ratings(d)}
      <div class="muted">${extra.map(esc).join(" · ")}</div>
      ${flightFigure(d)}`;
  }
  tip.hidden = false;
  const box = tip.parentElement.getBoundingClientRect();
  let x = e.clientX - box.left + 14;
  let y = e.clientY - box.top + 14;
  if (x + tip.offsetWidth > box.width) x -= tip.offsetWidth + 28;
  if (y + tip.offsetHeight > box.height) y -= tip.offsetHeight + 28;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

// descriptions are two thirds of the data and only needed here, so they live in
// their own file, fetched the first time a disc is opened
let descriptions;

function describe(d) {
  descriptions ??= getJSON("data/descriptions.json");
  return descriptions.then((all) => all[d.id] ?? "");
}

// detailCard renders everything known about a disc. The dialog shows it on a
// click; when the filters leave a single disc, so does the chart.
function detailCard(d, desc) {
  const specs = [
    ["Category", catLabel(d.category)],
    ["Stability", stability(d)],
    ["PDGA name", d.pdga_model],
    ["Diameter", d.diameter_cm && `${d.diameter_cm} cm`],
    ["Height", d.height_cm && `${d.height_cm} cm`],
    ["Rim depth", d.rim_depth_cm && `${d.rim_depth_cm} cm`],
    ["Rim thickness", d.rim_thickness_cm && `${d.rim_thickness_cm} cm`],
    ["Max weight", d.max_weight_g && `${d.max_weight_g} g`],
    ["PDGA approved", d.pdga_approved_date],
    ["Out of production", d.out_of_production ? "yes" : null],
  ].filter(([, v]) => v);
  // Marshall Street's per-disc image is a flight curve derived from these same
  // four numbers, bolted to a spec table we already render below, so we draw
  // our own rather than hotlinking theirs
  return `
    ${flightFigure(d)}
    <h2>${esc(d.model)}</h2>
    <div class="muted">${esc(d.brand)}</div>
    ${ratings(d)}
    <dl>${specs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${desc ? `<p>${esc(desc)}</p>` : ""}
    ${d.link ? `<p><a href="${esc(d.link)}" target="_blank" rel="noopener">View at Marshall Street →</a></p>` : ""}`;
}

async function showDetail(d) {
  $("#tooltip").hidden = true;
  $("#detail-body").innerHTML = detailCard(d, await describe(d));
  $("#detail").showModal();
}

// showSingle fills the chart when the filters leave one disc. A lone dot plots
// only speed and turn+fade, so it can't show glide at all, and a disc like the
// Mako3 at 5/5/0/0 has no turn or fade line to draw either.
let singleId = null;
async function showSingle(d) {
  const panel = $("#inline-detail");
  panel.hidden = !d;
  if (!d) {
    singleId = null;
    return;
  }
  if (d.id === singleId) return;
  singleId = d.id;
  // render at once, then fill the description in when it arrives
  panel.innerHTML = detailCard(d, "");
  const desc = await describe(d);
  if (singleId === d.id) panel.innerHTML = detailCard(d, desc);
}

init();
