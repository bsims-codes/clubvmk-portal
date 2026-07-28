/* ============================================================
   CLUBVMK — tiny SVG chart kit (no dependencies).

   Three forms, each picked for the job the data does:
     areaChart  — one measure over time (change over time)
     barsH      — magnitude across named things, sorted, direct-labelled
     heatmap    — magnitude across two cyclical keys (weekday × hour)

   Rules baked in, so callers can't get them wrong:
   • one y-axis per chart, always from zero. Two measures = two charts.
   • 2px lines, bars square at the baseline with a 4px rounded data-end and a
     2px gap between them, recessive grid and axes.
   • every chart gets a hover layer: crosshair + tooltip on the area chart,
     per-mark tooltip on bars and cells.
   • colours are passed in (validated against the dark panel by the caller);
     all TEXT stays in the ink tokens, never the series colour.
   ============================================================ */
(function (root) {
const SVG = "http://www.w3.org/2000/svg";
const el = (n, attrs = {}) => {
  const e = document.createElementNS(SVG, n);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};
const escape_ = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nice = (n) => Number(n || 0).toLocaleString();

/* A tooltip shared by every chart on the page — one node, moved around. */
let tipEl;
function tip() {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "ch-tip";
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
function showTip(html, x, y) {
  const t = tip();
  t.innerHTML = html;
  t.classList.add("on");
  const r = t.getBoundingClientRect();
  // keep it on screen: flip left near the right edge, sit above the cursor
  const left = Math.min(Math.max(8, x - r.width / 2), window.innerWidth - r.width - 8);
  const top = y - r.height - 12 < 8 ? y + 18 : y - r.height - 12;
  t.style.left = left + "px";
  t.style.top = top + "px";
}
function hideTip() { if (tipEl) tipEl.classList.remove("on"); }
// a tooltip anchored to viewport coords goes stale the moment anything scrolls
document.addEventListener("scroll", hideTip, true);
window.addEventListener("scroll", hideTip, { passive: true });
window.addEventListener("wheel", hideTip, { passive: true });

/* Nice round ticks for a 0..max axis, about `count` of them. The last tick is
   always >= max — otherwise the top of the scale sits under the peak and the
   line draws outside the plot. */
function ticks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  // everything this kit plots is a count, so never step in fractions of one
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10);
  const out = [];
  for (let v = 0; ; v += step) {
    out.push(Math.round(v * 1000) / 1000);
    if (v >= max - step * 0.001) break;
  }
  return out;
}

/* ---------- area + line: one measure over time ---------- */
/* points: [{x: Date|number, y: number, label: string}] — label is what the
   tooltip calls that bucket. `color` paints the mark; text never uses it. */
function areaChart(host, { points, color, unit = "", height = 190 }) {
  host.innerHTML = "";
  if (!points.length) {
    host.innerHTML = `<p class="ch-empty">Nothing recorded in this window.</p>`;
    return;
  }
  const W = Math.max(260, host.clientWidth || 600), H = height;
  const P = { t: 12, r: 12, b: 24, l: 42 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const max = Math.max(1, ...points.map((p) => p.y));
  const tk = ticks(max);
  const top = tk[tk.length - 1];
  const X = (i) => P.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const Y = (v) => P.t + ih - (v / top) * ih;

  const svg = el("svg", { width: W, height: H, class: "ch", role: "img" });
  // recessive gridlines + value axis
  for (const v of tk) {
    svg.appendChild(el("line", { x1: P.l, x2: W - P.r, y1: Y(v), y2: Y(v), class: "ch-grid" }));
    const t = el("text", { x: P.l - 8, y: Y(v) + 4, class: "ch-axis", "text-anchor": "end" });
    t.textContent = nice(v);
    svg.appendChild(t);
  }
  const line = points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
  const gid = "chg" + Math.random().toString(36).slice(2, 8);
  const defs = el("defs");
  defs.innerHTML = `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity=".42"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient>`;
  svg.appendChild(defs);
  svg.appendChild(el("path", {
    d: `${line}L${X(points.length - 1).toFixed(1)},${P.t + ih}L${X(0).toFixed(1)},${P.t + ih}Z`,
    fill: `url(#${gid})`,
  }));
  svg.appendChild(el("path", { d: line, fill: "none", stroke: color, "stroke-width": 2,
                               "stroke-linejoin": "round", "stroke-linecap": "round" }));
  // a single bucket has no line to read — show it as a dot instead
  if (points.length === 1) {
    svg.appendChild(el("circle", { cx: X(0), cy: Y(points[0].y), r: 4.5, fill: color }));
  }

  // time axis: first, middle and last, so labels can't collide
  const idx = points.length > 2 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : points.map((_, i) => i);
  for (const i of [...new Set(idx)]) {
    const t = el("text", { x: X(i), y: H - 7, class: "ch-axis",
                           "text-anchor": i === 0 ? "start" : i === points.length - 1 ? "end" : "middle" });
    t.textContent = points[i].label;
    svg.appendChild(t);
  }

  // hover layer: crosshair + marker on the nearest bucket
  const cross = el("line", { class: "ch-cross", y1: P.t, y2: P.t + ih, opacity: 0 });
  const dot = el("circle", { r: 4.5, fill: color, class: "ch-dot", opacity: 0,
                             stroke: "var(--panel)", "stroke-width": 2 });
  svg.appendChild(cross); svg.appendChild(dot);
  const hit = el("rect", { x: P.l, y: P.t, width: iw, height: ih, fill: "transparent" });
  svg.appendChild(hit);
  hit.addEventListener("mousemove", (e) => {
    const bb = svg.getBoundingClientRect();
    const rel = e.clientX - bb.left;
    let best = 0, bd = Infinity;
    points.forEach((_, i) => { const d = Math.abs(X(i) - rel); if (d < bd) { bd = d; best = i; } });
    const p = points[best];
    cross.setAttribute("x1", X(best)); cross.setAttribute("x2", X(best)); cross.setAttribute("opacity", 1);
    dot.setAttribute("cx", X(best)); dot.setAttribute("cy", Y(p.y)); dot.setAttribute("opacity", 1);
    showTip(`<b>${escape_(p.label)}</b><span>${nice(p.y)}${unit ? " " + escape_(unit) : ""}</span>`,
            e.clientX, bb.top + Y(p.y));
  });
  hit.addEventListener("mouseleave", () => {
    cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); hideTip();
  });
  host.appendChild(svg);
}

/* ---------- horizontal bars: magnitude across named things ---------- */
/* rows: [{label, value, sub}] — already sorted by the caller. */
function barsH(host, { rows, color, unit = "", max }) {
  host.innerHTML = "";
  if (!rows.length) {
    host.innerHTML = `<p class="ch-empty">Nothing recorded in this window.</p>`;
    return;
  }
  const top = Math.max(1, max ?? Math.max(...rows.map((r) => r.value)));
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "ch-bar";
    row.innerHTML = `<span class="ch-bar-name">${escape_(r.label)}</span>
      <span class="ch-bar-track"><span class="ch-bar-fill"></span></span>
      <span class="ch-bar-val">${nice(r.value)}</span>`;
    const fill = row.querySelector(".ch-bar-fill");
    fill.style.width = `${Math.max(1.5, (r.value / top) * 100)}%`;
    fill.style.background = color;
    row.addEventListener("mousemove", (e) => showTip(
      `<b>${escape_(r.label)}</b><span>${nice(r.value)}${unit ? " " + escape_(unit) : ""}</span>`
      + (r.sub ? `<span class="s">${escape_(r.sub)}</span>` : ""), e.clientX, e.clientY));
    row.addEventListener("mouseleave", hideTip);
    frag.appendChild(row);
  }
  host.appendChild(frag);
}

/* ---------- heatmap: magnitude across weekday × hour ---------- */
/* Sequential single hue, light→dark, monotonic in lightness (checked). */
const HEAT_RAMP = ["#1b2038", "#3d3320", "#5f4a1c", "#87661a", "#b08420", "#d8a63a", "#f7c96a"];
function heatmap(host, { cells, rowLabels, colLabels, max, unit = "", describe }) {
  host.innerHTML = "";
  const top = Math.max(1, max ?? Math.max(0, ...cells.map((c) => c.v)));
  const grid = document.createElement("div");
  grid.className = "ch-heat";
  grid.style.gridTemplateColumns = `auto repeat(${colLabels.length}, 1fr)`;
  const at = {};
  for (const c of cells) at[c.y + ":" + c.x] = c.v;

  grid.appendChild(Object.assign(document.createElement("span"), { className: "ch-heat-corner" }));
  colLabels.forEach((l, i) => {
    const s = document.createElement("span");
    s.className = "ch-heat-col";
    s.textContent = i % 3 === 0 ? l : "";   // every 3rd hour, so labels don't collide
    grid.appendChild(s);
  });
  rowLabels.forEach((rl, y) => {
    const s = document.createElement("span");
    s.className = "ch-heat-row";
    s.textContent = rl;
    grid.appendChild(s);
    colLabels.forEach((cl, x) => {
      const v = at[y + ":" + x] || 0;
      const step = v === 0 ? 0 : 1 + Math.round((HEAT_RAMP.length - 2) * Math.sqrt(v / top));
      const cell = document.createElement("span");
      cell.className = "ch-heat-cell" + (v === 0 ? " zero" : "");
      cell.style.background = HEAT_RAMP[step];
      cell.addEventListener("mousemove", (e) => showTip(
        `<b>${escape_(describe ? describe(rl, cl) : `${rl} ${cl}`)}</b>
         <span>${nice(v)}${unit ? " " + escape_(unit) : ""}</span>`, e.clientX, e.clientY));
      cell.addEventListener("mouseleave", hideTip);
      grid.appendChild(cell);
    });
  });
  host.appendChild(grid);

  const key = document.createElement("div");
  key.className = "ch-key";
  key.innerHTML = `<span>Quieter</span>`
    + HEAT_RAMP.map((c) => `<i style="background:${c}"></i>`).join("")
    + `<span>Busier</span><span class="ch-key-max">peak ${nice(top)}${unit ? " " + escape_(unit) : ""}</span>`;
  host.appendChild(key);
}

root.CHARTS = { areaChart, barsH, heatmap, HEAT_RAMP };
})(window);
