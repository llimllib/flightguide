import { Chart } from "./chart.js";

const $ = (s) => document.querySelector(s);
const filters = $("#filters");
const RANGES = [
  ["speed", "Speed"],
  ["glide", "Glide"],
  ["turn", "Turn"],
  ["fade", "Fade"],
  ["stability", "Turn + Fade"],
];

const CATEGORY_COLORS = {
  Putters: "#a78bfa",
  "Approach Discs": "#f472b6",
  "Midrange Drivers": "#2dd4bf",
  "Hybrid Drivers": "#facc15",
  "Control Drivers": "#fb923c",
  "Distance Drivers": "#f87171",
};
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

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nums = (d) => [d.speed, d.glide, d.turn, d.fade].join(" | ");

async function getJSON(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

let meta;
let allDiscs;
let chart;
let inflight;

async function init() {
  [meta, allDiscs] = await Promise.all([getJSON("/api/meta"), getJSON("/api/discs")]);

  $("#categories").innerHTML = meta.categories
    .map((c) => `<label class="check"><input type="checkbox" name="category" value="${esc(c)}"> ${esc(c)}</label>`)
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
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#detail").open) chart.setZoom(null);
  });

  filters.addEventListener("submit", (e) => e.preventDefault());
  let timer;
  filters.addEventListener("input", (e) => {
    if (e.target.id === "brand-search") return filterBrandList(e.target.value);
    const range = e.target.closest(".range");
    if (range) syncSlider(range.dataset.range);
    clearTimeout(timer);
    timer = setTimeout(update, 150);
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
  return p;
}

function uiParams() {
  const p = filterParams();
  // out of production discs are hidden by default, so the URL records showing them
  p.delete("oop");
  if (!$("#hide-oop").checked) p.set("oop", "1");
  if ($("#color").value !== "brand") p.set("color", $("#color").value);
  if (!$("#ghosts").checked) p.set("ghosts", "0");
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
  $("#color").value = p.get("color") ?? "brand";
  $("#ghosts").checked = p.get("ghosts") !== "0";
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

async function update() {
  saveURL();
  const params = filterParams();
  $("#clear-brands").hidden = !params.has("brand");

  inflight?.abort();
  inflight = new AbortController();
  let discs;
  try {
    discs = await getJSON(`/api/discs?${params}`, inflight.signal);
  } catch (err) {
    if (err.name === "AbortError") return;
    throw err;
  }

  const ids = new Set(discs.map((d) => d.id));
  const ghosts = $("#ghosts").checked ? allDiscs.filter((d) => !ids.has(d.id)) : [];
  chart.setData(discs, ghosts, meta.ranges, colorers[$("#color").value]);

  $("#count").textContent =
    discs.length === allDiscs.length ? `${discs.length} discs` : `${discs.length} of ${allDiscs.length} discs`;
  drawLegend(discs);
}

// showEmpty explains an empty chart: either no discs match the filters, or
// some do but none are in the zoomed area
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
  if (mode === "category") entries = Object.entries(CATEGORY_COLORS).map(([k, c]) => [k, c, "#0009"]);
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

function showTooltip(d, e) {
  const tip = $("#tooltip");
  if (!d) {
    tip.hidden = true;
    return;
  }
  const extra = [
    d.category,
    d.stability && `grade ${d.stability} (${d.stability_group})`,
    d.out_of_production && "out of production",
    d.in_stock_products ? `${d.in_stock_products} in stock` : "not in stock",
  ].filter(Boolean);
  tip.innerHTML = `<strong>${esc(d.model)}</strong> <span class="muted">${esc(d.brand)}</span>
    <div class="nums">${nums(d)}</div>
    <div class="muted">${extra.map(esc).join(" · ")}</div>`;
  tip.hidden = false;
  const box = tip.parentElement.getBoundingClientRect();
  let x = e.clientX - box.left + 14;
  let y = e.clientY - box.top + 14;
  if (x + tip.offsetWidth > box.width) x -= tip.offsetWidth + 28;
  if (y + tip.offsetHeight > box.height) y -= tip.offsetHeight + 28;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

async function showDetail(summary) {
  $("#tooltip").hidden = true;
  const d = await getJSON(`/api/discs/${summary.id}`);
  // the description is HTML from Marshall Street; show only its text
  const desc = new DOMParser().parseFromString(d.description ?? "", "text/html").body.textContent.trim();
  const specs = [
    ["Category", d.category],
    ["Stability", d.stability && `${d.stability} (${d.stability_group})`],
    ["PDGA name", d.pdga_model],
    ["Diameter", d.diameter_cm && `${d.diameter_cm} cm`],
    ["Height", d.height_cm && `${d.height_cm} cm`],
    ["Rim depth", d.rim_depth_cm && `${d.rim_depth_cm} cm`],
    ["Rim thickness", d.rim_thickness_cm && `${d.rim_thickness_cm} cm`],
    ["Max weight", d.max_weight_g && `${d.max_weight_g} g`],
    ["PDGA approved", d.pdga_approved_date],
    ["In stock", d.in_stock_products ? `${d.in_stock_products} products${d.on_sale ? ", on sale" : ""}` : "no"],
    ["Out of production", d.out_of_production ? "yes" : null],
  ].filter(([, v]) => v);
  $("#detail-body").innerHTML = `
    ${d.image ? `<img src="${esc(d.image)}" alt="">` : ""}
    <h2>${esc(d.model)}</h2>
    <div class="muted">${esc(d.brand)}</div>
    <p class="nums">${nums(d)}</p>
    <dl>${specs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${desc ? `<p>${esc(desc)}</p>` : ""}
    ${d.link ? `<p><a href="${esc(d.link)}" target="_blank" rel="noopener">View at Marshall Street →</a></p>` : ""}`;
  $("#detail").showModal();
}

init();
