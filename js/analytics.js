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
  // apply live rarity overrides so counts match the game
  try {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("overrides").select("item_id,tier").range(from, from + 999);
      if (error || !data || !data.length) break;
      for (const o of data) if (D.catalog[o.item_id]) D.catalog[o.item_id].r = o.tier;
      if (data.length < 1000) break;
    }
  } catch (e) { /* overrides optional */ }
  try {
    const { data } = await sb.from("themes").select("id,name");
    for (const t of data || []) D.themeNames[t.id] = t.name;
  } catch (e) { /* themes optional */ }
}

async function loadAll() {
  await loadCatalog();
  const [pl, to, is] = await Promise.all([
    sb.rpc("analytics_players"),
    sb.rpc("analytics_theme_owners"),
    sb.rpc("analytics_item_stats"),
  ]);
  for (const r of [pl, to, is]) if (r.error) { toast("Query failed: " + r.error.message + " — did you run schema_analytics.sql?"); return; }
  D.players = pl.data || [];
  D.themeOwners = to.data || [];
  D.itemStats = is.data || [];
  renderCards();
  renderThemes(); renderPlayers(); renderItems();
}

/* ---------- overview ---------- */
function renderCards() {
  const collectedIds = new Set(D.itemStats.map((r) => r.item_id));
  const catN = Object.keys(D.catalog).length;
  const uncollected = catN - [...collectedIds].filter((id) => D.catalog[id]).length;
  const totalCopies = D.itemStats.reduce((a, r) => a + Number(r.copies || 0), 0);
  const grants = D.themeOwners.length;
  const cards = [
    ["Players", num(D.players.length)],
    ["Items in catalogue", num(catN)],
    ["Distinct items collected", num(collectedIds.size)],
    ["Never collected", num(uncollected)],
    ["Total copies owned", num(totalCopies)],
    ["Theme purchases", num(grants)],
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

/* ---------- players ---------- */
function renderPlayers() {
  const q = $("#playerSearch").value.trim().toLowerCase();
  let rows = D.players.map((p) => ({ ...p, name: p.display_name || p.discord_id }));
  rows = rows.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.discord_id || "").includes(q));
  const s = D.playerSort;
  rows.sort((a, b) => { const av = s.k === "display_name" ? a.name.toLowerCase() : Number(a[s.k] || 0), bv = s.k === "display_name" ? b.name.toLowerCase() : Number(b[s.k] || 0); return (av < bv ? -1 : av > bv ? 1 : 0) * s.dir; });
  $("#playerTotal").textContent = `${rows.length} players`;
  $("#playerTbl").querySelector("tbody").innerHTML = rows.map((p) =>
    `<tr><td>${esc(p.name)}</td><td class="num">${num(p.distinct_items)}</td><td class="num">${num(p.total_copies)}</td><td class="num">${num(p.themes)}</td></tr>`).join("")
    || `<tr><td colspan="4" class="muted2">No players yet.</td></tr>`;
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
