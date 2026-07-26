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
  await loadAll();
}

/* ---------- data ---------- */
async function loadCatalog() {
  if (Object.keys(D.catalog).length) return;
  const cat = await fetch("data/catalog.min.json").then((r) => r.json());
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
    D.held = 0;
    for (const id in D.catalog) D.catalog[id].r = "common";
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
  D.hasRarity = !pr.error;
  D.playerRarity = pr.data || [];
  if (pr.error) toast("Rarity/wallet columns need the updated schema_analytics.sql", true);
  // fold the per-player rarity rows onto each player row: p.rar.legendary etc.
  const byPlayer = {};
  for (const r of D.playerRarity) (byPlayer[r.discord_id] ||= {})[r.tier] = Number(r.distinct_items || 0);
  for (const p of D.players) p.rar = byPlayer[p.discord_id] || {};
  renderCards();
  renderThemes(); renderRarity(); renderPlayers(); renderItems();
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
  const cells = (p) => {
    const rar = RARITY.map((r) => `<td class="num r-${r}">${num(p.rar?.[r] || 0)}</td>`).join("");
    const dupes = Number(p.total_copies || 0) - Number(p.distinct_items || 0);
    const pct = ((Number(p.distinct_items || 0) / catN) * 100).toFixed(1);
    return `<td>${esc(p.name)}</td>` +
      `<td class="num">${num(p.distinct_items)}</td>` +
      `<td class="num">${pct}%</td>` +
      rar +
      `<td class="num">${num(p.total_copies)}</td>` +
      `<td class="num">${num(dupes)}</td>` +
      `<td class="num">${num(p.club_coins || 0)}</td>` +
      `<td class="num">${num(p.yeti_credits || 0)}</td>` +
      `<td class="num">${num(p.themes)}</td>`;
  };
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

/* ---------- boot ---------- */
async function boot() {
  $("#signInBtn").onclick = signIn;
  $("#signOutBtn").onclick = (e) => { e.preventDefault(); signOut(); };
  $("#refreshBtn").onclick = (e) => { e.preventDefault(); loadAll(); };
  $("#themeSearch").oninput = renderThemes;
  $("#playerSearch").oninput = renderPlayers;
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
