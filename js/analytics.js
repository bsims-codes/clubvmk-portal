/* ============================================================
   CLUBVMK — Admin Analytics
   Calls the security-definer analytics_* RPCs (admin-gated) and
   renders theme ownership, per-player stats, and item coverage.
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const ADMIN_IDS = ["886570059974201405"];
const $ = (s) => document.querySelector(s);
const RARITY = ["legendary", "epic", "rare", "uncommon", "common"];

const D = {
  discordId: null, catalog: {}, themeNames: {},
  players: [], themeOwners: [], itemStats: [],
  themeSort: { k: "owners", dir: -1 }, playerSort: { k: "distinct_items", dir: -1 }, itemSort: { k: "rarity", dir: 1 },
};

let toastT;
function toast(m) { const t = $("#toast"); t.textContent = m; t.className = "toast show"; clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 3600); }
function esc(s) { return (s ?? "").toString().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const num = (n) => (n ?? 0).toLocaleString();
function pill(r) { return `<span class="pill r-${r}">${r}</span>`; }

/* ---------- auth ---------- */
async function signIn() { await sb.auth.signInWithOAuth({ provider: "discord", options: { redirectTo: location.href.split("#")[0] } }); }
async function signOut() { await sb.auth.signOut(); location.reload(); }
function discordIdFromSession(session) {
  if (!session) return null;
  const ident = (session.user?.identities || []).find((i) => i.provider === "discord") || {};
  return ident.provider_id || ident.identity_data?.provider_id || session.user?.user_metadata?.provider_id || session.user?.user_metadata?.sub || null;
}
async function render(session) {
  D.discordId = discordIdFromSession(session);
  const isAdmin = D.discordId && ADMIN_IDS.includes(String(D.discordId));
  $("#whoami").textContent = session ? (isAdmin ? "Admin" : "Signed in") : "";
  if (!session) { $("#gate").style.display = ""; $("#panel").style.display = "none"; return; }
  if (!isAdmin) { $("#gate").style.display = ""; $("#panel").style.display = "none"; $("#signInBtn").style.display = "none"; $("#gateMsg").textContent = "This account isn't an analytics admin. (" + (D.discordId || "no id") + ")"; return; }
  $("#gate").style.display = "none"; $("#panel").style.display = "";
  // The command charts share no data with the inventory side — load them in
  // parallel so a slow (or failed) catalogue fetch can't leave them blank.
  loadActivity().catch((e) => { $("#actNote").textContent = "Activity failed: " + e.message; });
  await loadAll();
}

/* ---------- data ---------- */
async function loadCatalog() {
  if (Object.keys(D.catalog).length) return;
  const cat = await fetch("data/catalog.min.json", { cache: "no-cache" }).then((r) => r.json());
  for (const it of cat) D.catalog[it.id] = { id: it.id, n: it.n, r: it.r, c: it.c };
  // The overrides table is the SINGLE source of truth: default everything to common,
  // apply the table, and drop items the curator marked "remove" (as the bot does).
  // The baked rarity in catalog.min.json is ignored so this never disagrees with the game.
  D.removed = 0;
  try {
    const map = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("overrides").select("item_id,tier").order("item_id").range(from, from + 999);
      if (error) throw error;
      for (const o of data || []) map[o.item_id] = o.tier;
      if (!data || data.length < 1000) break;
    }
    // 'remove' and 'hold' are BOTH out of the game (bot.py skips each when
    // building the spawn pool), so neither belongs in the catalogue totals.
    D.held = 0; D.crafted = 0;
    // Combined Magics ("pin:3703*5") are crafted, never spawned, so they don't
    // belong in catalogue coverage — but they do inherit the base pin's rarity.
    for (const id in D.catalog) {
      if (id.includes("*")) { delete D.catalog[id]; D.crafted++; continue; }
      D.catalog[id].r = "common";
    }
    for (const id in map) {
      if (!D.catalog[id]) continue;
      if (map[id] === "remove") { delete D.catalog[id]; D.removed++; }
      else if (map[id] === "hold") { delete D.catalog[id]; D.held++; }
      else D.catalog[id].r = map[id];
    }
  } catch (e) { /* fetch failed — keep baked rarities as fallback */ }
  try {
    const { data } = await sb.from("themes").select("id,name");
    for (const t of data || []) D.themeNames[t.id] = t.name;
  } catch (e) { /* themes optional */ }
}

// PostgREST caps any response at 1000 rows, and these RPCs return one row per
// item/player — so a plain call silently truncates (the item stats sat at
// exactly 1000 for ages). Page through in 1000s, ordered so no row straddles a
// page boundary, exactly like the overrides fetch above.
async function rpcAll(name, orderCols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.rpc(name);
    for (const c of orderCols) q = q.order(c);   // ties would shuffle across pages
    const { data, error } = await q.range(from, from + 999);
    if (error) return { error };
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { data: out };
}

async function loadAll() {
  await loadCatalog();
  const [pl, to, is, pr] = await Promise.all([
    rpcAll("analytics_players", ["discord_id"]),
    rpcAll("analytics_theme_owners", ["theme_id", "discord_id"]),
    rpcAll("analytics_item_stats", ["item_id"]),
    rpcAll("analytics_player_rarity", ["discord_id", "tier"]),
  ]);
  for (const r of [pl, to, is]) if (r.error) { toast("Query failed: " + r.error.message + " — did you run schema_analytics.sql?"); return; }
  D.players = pl.data || [];
  D.themeOwners = to.data || [];
  D.itemStats = is.data || [];
  // Optional — present only once the newer schema_analytics.sql has been run.
  // analytics_players only gained the wallet columns in that same file, so its
  // absence is detected off a returned row rather than a separate probe.
  D.hasRarity = !pr.error;
  D.hasCoins = D.players.some((p) => p.club_coins !== undefined);
  D.playerRarity = pr.data || [];
  // fold the per-player rarity rows onto each player row: p.rar.legendary etc.
  const byPlayer = {};
  for (const r of D.playerRarity) (byPlayer[r.discord_id] ||= {})[r.tier] = Number(r.distinct_items || 0);
  for (const p of D.players) p.rar = byPlayer[p.discord_id] || {};
  renderCards();
  renderThemes(); renderRarity(); renderOwnerChart(); renderPlayers(); renderItems();
}

/* ---------- overview ---------- */
function renderCards() {
  // count only items still in the catalogue (removed items are already dropped)
  const inCat = D.itemStats.filter((r) => D.catalog[r.item_id]);
  const collectedInCat = inCat.length;
  const catN = Object.keys(D.catalog).length;
  const uncollected = catN - collectedInCat;
  const totalCopies = inCat.reduce((a, r) => a + Number(r.copies || 0), 0);
  const grants = D.themeOwners.length;
  const coverage = catN ? ((collectedInCat / catN) * 100).toFixed(1) + "%" : "—";
  const soleOwner = inCat.filter((r) => Number(r.owners || 0) === 1).length;
  const avgItems = D.players.length
    ? Math.round(D.players.reduce((a, p) => a + Number(p.distinct_items || 0), 0) / D.players.length) : 0;
  const club = D.players.reduce((a, p) => a + Number(p.club_coins || 0), 0);
  const yeti = D.players.reduce((a, p) => a + Number(p.yeti_credits || 0), 0);
  const cards = [
    ["Players", num(D.players.length)],
    ["Items in catalogue", num(catN)],
    ["Distinct items collected", num(collectedInCat)],
    ["Catalogue coverage", coverage],
    ["Never collected", num(uncollected)],
    ["Total copies owned", num(totalCopies)],
    ["Duplicate copies", num(totalCopies - collectedInCat)],
    ["Owned by one player", num(soleOwner)],
    ["Avg items / player", num(avgItems)],
    ["🪙 Club Coins in circulation", num(club)],
    ["❄️ Yeti Credits in circulation", num(yeti)],
    ["Theme purchases", num(grants)],
    ["Removed (excluded)", num(D.removed || 0)],
    ["Held (awaiting review)", num(D.held || 0)],
  ];
  $("#cards").innerHTML = cards.map(([k, v]) => `<div class="card"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");
}

/* ---------- theme ownership ---------- */
function themeGroups() {
  const m = {};
  for (const r of D.themeOwners) (m[r.theme_id] ||= []).push(r.display_name || r.discord_id);
  return Object.entries(m).map(([id, who]) => ({ id, name: D.themeNames[id] || id, owners: who.length, who: who.sort() }));
}
function renderThemes() {
  const q = $("#themeSearch").value.trim().toLowerCase();
  let rows = themeGroups().filter((t) => !q || t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
  const s = D.themeSort; rows.sort((a, b) => (s.k === "name" ? a.name.localeCompare(b.name) : a.owners - b.owners) * s.dir);
  $("#themeTotal").textContent = `${rows.length} themes`;
  $("#themeTbl").querySelector("tbody").innerHTML = rows.map((t) =>
    `<tr><td>${esc(t.name)} <span class="muted2">· ${esc(t.id)}</span></td><td class="num">${t.owners}</td>` +
    `<td class="owners">${t.owners ? esc(t.who.join(", ")) : "<span class=muted2>nobody yet</span>"}</td></tr>`).join("")
    || `<tr><td colspan="3" class="muted2">No theme purchases yet.</td></tr>`;
}

/* ---------- rarity coverage ---------- */
function renderRarity() {
  const stats = {}; for (const r of D.itemStats) stats[r.item_id] = r;
  const agg = {};
  for (const r of RARITY) agg[r] = { cat: 0, got: 0, copies: 0, sole: 0 };
  // D.catalog already has "remove"-tagged items dropped, so this only counts
  // items actually in the game.
  for (const it of Object.values(D.catalog)) {
    const a = agg[it.r];
    if (!a) continue;
    a.cat++;
    const s = stats[it.id];
    if (!s) continue;                       // in the catalogue, owned by nobody
    a.got++;
    a.copies += Number(s.copies || 0);
    if (Number(s.owners || 0) === 1) a.sole++;
  }
  $("#rarityTbl").querySelector("tbody").innerHTML = RARITY.map((r) => {
    const a = agg[r];
    const pct = a.cat ? ((a.got / a.cat) * 100).toFixed(1) : "0.0";
    return `<tr><td>${pill(r)}</td><td class="num">${num(a.cat)}</td>` +
      `<td class="num">${num(a.got)}</td><td class="num">${pct}%</td>` +
      `<td class="num">${num(a.cat - a.got)}</td><td class="num">${num(a.copies)}</td>` +
      `<td class="num">${num(a.sole)}</td></tr>`;
  }).join("");
}

/* ---------- owner bar chart ----------
   One series (the chosen rarity), so length carries magnitude and a single hue
   carries identity — no legend needed, the heading names it. */
const TIER_HUE = { legendary: "#f0a13c", epic: "#a45cf0", rare: "#3d8bfd",
                   uncommon: "#4caf7d", common: "#8a93b8" };

function renderOwnerChart() {
  const tier = $("#ownTier").value;
  const hideZero = $("#ownHideZero").checked;
  const stats = {}; for (const r of D.itemStats) stats[r.item_id] = r;
  let rows = Object.values(D.catalog).filter((it) => it.r === tier).map((it) => {
    const s = stats[it.id];
    return { id: it.id, name: it.n,
             owners: Number(s?.owners || 0), copies: Number(s?.copies || 0) };
  });
  const total = rows.length;
  const never = rows.filter((r) => !r.owners).length;
  if (hideZero) rows = rows.filter((r) => r.owners > 0);
  rows.sort((a, b) => b.owners - a.owners || a.name.localeCompare(b.name));

  const max = Math.max(1, ...rows.map((r) => r.owners));
  const hue = TIER_HUE[tier] || "var(--gold)";
  $("#ownTotal").textContent =
    `${num(total - never)} of ${num(total)} collected · ${num(never)} owned by nobody`;
  $("#ownChart").innerHTML = rows.map((r) => {
    const pct = (r.owners / max) * 100;
    const tip = `${r.name} — ${r.owners} owner${r.owners === 1 ? "" : "s"}, ` +
                `${r.copies} cop${r.copies === 1 ? "y" : "ies"} in circulation`;
    return `<div class="obar${r.owners ? "" : " zero"}" title="${esc(tip)}">
      <span class="obar-name">${esc(r.name)}</span>
      <span class="obar-track"><span class="obar-fill" style="width:${pct.toFixed(2)}%;background:${hue}"></span></span>
      <span class="obar-val">${num(r.owners)}</span>
    </div>`;
  }).join("") || `<p class="muted2">No ${esc(tier)} items to show.</p>`;
}

/* ---------- players ---------- */
// Sort key -> value, so rarity columns and the derived ones sort like the rest.
function playerVal(p, k) {
  if (k === "display_name") return p.name.toLowerCase();
  if (RARITY.includes(k)) return Number(p.rar?.[k] || 0);
  if (k === "dupes") return Number(p.total_copies || 0) - Number(p.distinct_items || 0);
  return Number(p[k] || 0);
}
function renderPlayers() {
  const q = $("#playerSearch").value.trim().toLowerCase();
  const catN = Object.keys(D.catalog).length || 1;
  let rows = D.players.map((p) => ({ ...p, name: p.display_name || p.discord_id }));
  rows = rows.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.discord_id || "").includes(q));
  const s = D.playerSort;
  rows.sort((a, b) => { const av = playerVal(a, s.k), bv = playerVal(b, s.k); return (av < bv ? -1 : av > bv ? 1 : 0) * s.dir; });
  $("#playerTotal").textContent = `${rows.length} players`;
  // A dash means "not available", never 0 — showing 0 would read as a real count.
  const NA = `<span class="muted2" title="Run webportal/schema_analytics.sql in Supabase">—</span>`;
  const cells = (p) => {
    const rar = RARITY.map((r) =>
      `<td class="num r-${r}">${D.hasRarity ? num(p.rar?.[r] || 0) : NA}</td>`).join("");
    const dupes = Number(p.total_copies || 0) - Number(p.distinct_items || 0);
    const pct = ((Number(p.distinct_items || 0) / catN) * 100).toFixed(1);
    return `<td>${esc(p.name)}</td>` +
      `<td class="num">${num(p.distinct_items)}</td>` +
      `<td class="num">${pct}%</td>` +
      rar +
      `<td class="num">${num(p.total_copies)}</td>` +
      `<td class="num">${num(dupes)}</td>` +
      `<td class="num">${D.hasCoins ? num(p.club_coins || 0) : NA}</td>` +
      `<td class="num">${D.hasCoins ? num(p.yeti_credits || 0) : NA}</td>` +
      `<td class="num">${num(p.themes)}</td>`;
  };
  const missing = [!D.hasRarity && "rarity breakdown", !D.hasCoins && "wallets"].filter(Boolean);
  $("#playerNote").innerHTML = missing.length
    ? `⚠️ ${missing.join(" and ")} unavailable — run <code>webportal/schema_analytics.sql</code> ` +
      `in Supabase → SQL Editor, then refresh.`
    : "";
  $("#playerTbl").querySelector("tbody").innerHTML =
    rows.map((p) => `<tr>${cells(p)}</tr>`).join("")
    || `<tr><td colspan="12" class="muted2">No players yet.</td></tr>`;
}

/* ---------- items ---------- */
function itemRows() {
  const mode = $("#itemMode").value;
  const stats = {}; for (const r of D.itemStats) stats[r.item_id] = r;
  let rows;
  if (mode === "uncollected") {
    rows = Object.values(D.catalog).filter((it) => !stats[it.id])
      .map((it) => ({ id: it.id, name: it.n, rarity: it.r, owners: 0, copies: 0 }));
  } else {
    rows = D.itemStats.filter((r) => D.catalog[r.item_id]).map((r) => ({
      id: r.item_id, name: D.catalog[r.item_id].n, rarity: D.catalog[r.item_id].r,
      owners: Number(r.owners || 0), copies: Number(r.copies || 0),
    }));
  }
  return rows;
}
function renderItems() {
  const rar = $("#rarityFilter").value, q = $("#itemSearch").value.trim().toLowerCase();
  let rows = itemRows();
  // rarity breakdown (before search filter) for the current mode
  const counts = {}; for (const r of rows) counts[r.rarity] = (counts[r.rarity] || 0) + 1;
  $("#rarityCounts").innerHTML = RARITY.map((r) => `${pill(r)} <b>${num(counts[r] || 0)}</b>`).join(" &nbsp; ");
  if (rar !== "all") rows = rows.filter((r) => r.rarity === rar);
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q));
  const s = D.itemSort;
  rows.sort((a, b) => {
    let av, bv;
    if (s.k === "rarity") { av = RARITY.indexOf(a.rarity); bv = RARITY.indexOf(b.rarity); }
    else if (s.k === "name") { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
    else { av = a[s.k]; bv = b[s.k]; }
    return (av < bv ? -1 : av > bv ? 1 : 0) * s.dir;
  });
  D._itemRowsCache = rows;
  $("#itemTotal").textContent = `${num(rows.length)} shown`;
  const cap = 500;
  const body = rows.slice(0, cap).map((r) =>
    `<tr><td>${esc(r.name)}</td><td>${pill(r.rarity)}</td><td class="num">${r.owners}</td><td class="num">${r.copies}</td></tr>`).join("");
  $("#itemTbl").querySelector("tbody").innerHTML = body +
    (rows.length > cap ? `<tr><td colspan="4" class="muted2">…and ${num(rows.length - cap)} more (use Export CSV for the full list).</td></tr>` : "")
    || `<tr><td colspan="4" class="muted2">None.</td></tr>`;
}
function exportCsv() {
  const rows = D._itemRowsCache || itemRows();
  const lines = ["name,rarity,owners,copies,id"].concat(
    rows.map((r) => [r.name, r.rarity, r.owners, r.copies, r.id].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `clubvmk_${$("#itemMode").value}_items.csv`; a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- sorting headers ---------- */
function wireSort(tblId, sortObj, rerender) {
  $("#" + tblId).querySelectorAll("th[data-k]").forEach((th) => {
    th.onclick = () => { const k = th.dataset.k; if (sortObj.k === k) sortObj.dir *= -1; else { sortObj.k = k; sortObj.dir = (k === "name" || k === "display_name") ? 1 : -1; } rerender(); };
  });
}

/* ============================================================
   Command activity — the time shape of play.

   Reads the bucketed activity_* RPCs (webportal/schema_activity_charts.sql).
   The log grows ~2,000 rows a day, so bucketing has to happen in Postgres; if
   those functions aren't installed yet the page falls back to aggregating raw
   command_log rows in the browser, capped, and says so rather than quietly
   drawing a partial window.
   ============================================================ */
const ACT = {
  // validated against the dark panel #141a33 (dataviz six checks, all pass):
  // adjacent ΔE 29.9 protan / 31.2 normal, both inside the dark L band.
  volColor: "#b8831f",     // commands — the brand gold, stepped into band
  userColor: "#3d8bfd",    // players  — the same blue the UI uses for "rare"
  commands: [], series: [], heat: [], hourly: false, note: "",
};
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = [...Array(24).keys()];
const EASTERN = { timeZone: "America/New_York" };

async function loadActivity() {
  const days = Number($("#actWindow").value || 7);
  const hourly = days <= 2;                    // a 2-day window is 2 dots as a daily chart
  ACT.hourly = hourly; ACT.note = "";
  const since = new Date(Date.now() - days * 86400e3);

  const [cmds, people, series, heat] = await Promise.all([
    sb.rpc("activity_commands", { since_days: days }),
    sb.rpc("activity_players", { since_days: days }),
    hourly ? sb.rpc("activity_hourly", { since_hours: days * 24 })
           : sb.rpc("activity_daily", { since_days: days }),
    sb.rpc("activity_heatmap", { since_days: days }),
  ]);

  if (cmds.error) {
    ACT.note = "Command log unavailable: " + cmds.error.message
      + " — has <code>schema_activity.sql</code> been run?";
    ACT.commands = []; ACT.series = []; ACT.heat = [];
    return renderActivity();
  }
  ACT.commands = cmds.data || [];
  ACT.people = people.error ? [] : (people.data || []);

  if (series.error || heat.error) {
    // the bucketing functions aren't installed — do it in the browser instead
    const built = await bucketClientSide(since, hourly);
    ACT.series = built.series; ACT.heat = built.heat;
    ACT.note = "Charting from raw events — run <code>webportal/schema_activity_charts.sql</code> "
      + "in Supabase for the full window (faster, and no cap)."
      + (built.capped ? ` Showing the most recent ${num(built.rows)} events only.` : "");
  } else {
    ACT.series = (series.data || []).map((r) => ({
      t: new Date(hourly ? r.hour : r.day + "T12:00:00Z"),
      uses: Number(r.uses || 0), users: Number(r.users || 0),
    }));
    ACT.heat = (heat.data || []).map((r) => ({
      dow: Number(r.dow), hour: Number(r.hour), uses: Number(r.uses || 0),
    }));
  }
  renderActivity();
}

/* Fallback path: pull the raw rows and bucket them here. Capped, because the
   log is thousands of rows a day and the browser shouldn't be paging forever. */
async function bucketClientSide(since, hourly) {
  const CAP = 12000;
  const rows = [];
  let capped = false;
  for (let from = 0; from < CAP; from += 1000) {
    const { data, error } = await sb.from("command_log")
      .select("ts,discord_id").gte("ts", since.toISOString())
      .order("ts", { ascending: false }).range(from, from + 999);
    if (error) break;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
    if (from + 1000 >= CAP) capped = true;
  }
  const buckets = new Map(), heat = new Map();
  for (const r of rows) {
    const d = new Date(r.ts);
    // bucket on the Eastern clock, matching what the SQL does
    const parts = new Intl.DateTimeFormat("en-CA", {
      ...EASTERN, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hour12: false, weekday: "short",
    }).formatToParts(d).reduce((o, p) => ((o[p.type] = p.value), o), {});
    const hour = Number(parts.hour) % 24;
    const key = hourly ? `${parts.year}-${parts.month}-${parts.day} ${hour}`
                       : `${parts.year}-${parts.month}-${parts.day}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { t: d, uses: 0, users: new Set() }));
    if (d < b.t) b.t = d;
    b.uses++; b.users.add(r.discord_id);
    const hk = DOW.indexOf(parts.weekday) + ":" + hour;
    heat.set(hk, (heat.get(hk) || 0) + 1);
  }
  return {
    rows: rows.length, capped,
    series: [...buckets.values()].sort((a, b) => a.t - b.t)
      .map((b) => ({ t: b.t, uses: b.uses, users: b.users.size })),
    heat: [...heat.entries()].map(([k, uses]) =>
      ({ dow: Number(k.split(":")[0]), hour: Number(k.split(":")[1]), uses })),
  };
}

function renderActivity() {
  const days = Number($("#actWindow").value || 7);
  $("#actNote").innerHTML = ACT.note;
  // an hour label needs its weekday too — "3pm" alone repeats across a 48h window
  const label = (d) => ACT.hourly
    ? d.toLocaleString([], { ...EASTERN, weekday: "short", hour: "numeric", hour12: true })
    : d.toLocaleDateString([], { ...EASTERN, month: "short", day: "numeric" });

  // ── headline tiles: the numbers you'd otherwise squint at the charts for
  const uses = ACT.series.reduce((a, b) => a + b.uses, 0);
  const peakBucket = ACT.series.reduce((a, b) => (b.uses > (a?.uses ?? -1) ? b : a), null);
  const byHour = {};
  for (const h of ACT.heat) byHour[h.hour] = (byHour[h.hour] || 0) + h.uses;
  const peakHour = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
  const activePlayers = (ACT.people || []).length;
  const perDay = ACT.hourly ? uses / Math.max(1, days) : uses / Math.max(1, ACT.series.length);
  const hourName = (h) => {
    const n = Number(h) % 12 || 12;
    return `${n}${Number(h) < 12 ? "am" : "pm"}`;
  };
  $("#actCards").innerHTML = [
    ["Commands run", num(uses)],
    ["Active players", num(activePlayers)],
    ["Distinct commands", num(ACT.commands.length)],
    [ACT.hourly ? "Busiest hour" : "Busiest day",
     peakBucket ? `${label(peakBucket.t)}` : "—", peakBucket ? `${num(peakBucket.uses)} runs` : ""],
    ["Peak time of day", peakHour ? hourName(peakHour[0]) : "—",
     peakHour ? `${num(peakHour[1])} runs` : ""],
    ["Average per day", num(Math.round(perDay))],
  ].map(([k, v, s]) => `<div class="card"><div class="v">${esc(v)}</div>
      <div class="k">${esc(k)}</div>${s ? `<div class="k">${esc(s)}</div>` : ""}</div>`).join("");

  $("#actRange").textContent = ACT.series.length
    ? `${label(ACT.series[0].t)} → ${label(ACT.series[ACT.series.length - 1].t)}`
    : "no activity in this window";
  $("#volSub").textContent = ACT.hourly ? "per hour" : "per day";

  // ── two measures, two charts: never a second y-axis on one plot
  CHARTS.areaChart($("#volChart"), {
    points: ACT.series.map((p) => ({ y: p.uses, label: label(p.t) })),
    color: ACT.volColor, unit: "commands",
  });
  CHARTS.areaChart($("#usersChart"), {
    points: ACT.series.map((p) => ({ y: p.users, label: label(p.t) })),
    color: ACT.userColor, unit: "players",
  });

  // ── magnitude across names: sorted bars, direct-labelled
  const top = [...ACT.commands].sort((a, b) => Number(b.uses) - Number(a.uses)).slice(0, 15);
  $("#topCmdSub").textContent = ACT.commands.length > 15
    ? `top 15 of ${ACT.commands.length}` : `all ${ACT.commands.length}`;
  CHARTS.barsH($("#topCmdChart"), {
    rows: top.map((c) => ({
      label: "/" + c.command, value: Number(c.uses || 0),
      sub: `${num(c.users)} player${Number(c.users) === 1 ? "" : "s"} · last ${when(c.last_used)}`,
    })),
    color: ACT.volColor, unit: "runs",
  });

  // ── two cyclical keys: sequential single hue, light → dark
  CHARTS.heatmap($("#heatChart"), {
    cells: ACT.heat.map((h) => ({ x: h.hour, y: h.dow, v: h.uses })),
    rowLabels: DOW, colLabels: HOURS.map(hourName), unit: "runs",
    describe: (d, h) => `${d} · ${h}`,
  });

  // ── the table view, so nothing here is chart-only
  const total = ACT.commands.reduce((a, c) => a + Number(c.uses || 0), 0) || 1;
  $("#actTbl").querySelector("tbody").innerHTML =
    [...ACT.commands].sort((a, b) => Number(b.uses) - Number(a.uses)).map((c) =>
      `<tr><td>/${esc(c.command)}</td><td class="num">${num(c.uses)}</td>
       <td class="num">${num(c.users)}</td>
       <td class="num">${((Number(c.uses) / total) * 100).toFixed(1)}%</td>
       <td class="muted2">${esc(when(c.last_used))}</td></tr>`).join("")
    || `<tr><td colspan="5" class="muted2">Nothing recorded in this window.</td></tr>`;
}

/* "3 min ago" / "2 days ago" — the activity page words it the same way. */
function when(ts) {
  if (!ts) return "never";
  const s = (Date.now() - new Date(ts)) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/* ---------- boot ---------- */
async function boot() {
  $("#signInBtn").onclick = signIn;
  $("#signOutBtn").onclick = (e) => { e.preventDefault(); signOut(); };
  $("#refreshBtn").onclick = (e) => { e.preventDefault(); loadAll(); loadActivity(); };
  $("#actWindow").onchange = loadActivity;
  // the SVG charts are sized in pixels, so a resize has to redraw them
  let rz;
  window.addEventListener("resize", () => {
    clearTimeout(rz);
    rz = setTimeout(() => { if (ACT.series.length || ACT.commands.length) renderActivity(); }, 180);
  });
  $("#themeSearch").oninput = renderThemes;
  $("#playerSearch").oninput = renderPlayers;
  $("#ownTier").onchange = renderOwnerChart;
  $("#ownHideZero").onchange = renderOwnerChart;
  $("#itemMode").onchange = renderItems;
  $("#rarityFilter").onchange = renderItems;
  $("#itemSearch").oninput = renderItems;
  $("#csvBtn").onclick = exportCsv;
  wireSort("themeTbl", D.themeSort, renderThemes);
  wireSort("playerTbl", D.playerSort, renderPlayers);
  wireSort("itemTbl", D.itemSort, renderItems);
  sb.auth.onAuthStateChange((_e, session) => render(session));
  const { data } = await sb.auth.getSession();
  render(data.session);
}
boot();
