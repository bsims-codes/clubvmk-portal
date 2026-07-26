/* ============================================================
   CLUBVMK — Player admin. Every mutation is queued into
   admin_actions; the bot drains the queue and writes back a result.
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const ADMIN_IDS = ["886570059974201405"];
const RARITY = ["legendary", "epic", "rare", "uncommon", "common"];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (n) => Number(n || 0).toLocaleString();
const baseItemId = (id) => (id.includes("*") ? id.slice(0, id.lastIndexOf("*")) : id);

const P = { me: null, players: [], sel: null, catalog: {}, themes: {}, inv: [], q: "" };

let toastT;
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 3600);
}

function discordIdFromSession(session) {
  const u = session?.user; if (!u) return null;
  const m = u.user_metadata || {};
  const ident = (u.identities || []).find((i) => i.provider === "discord") || {};
  return m.provider_id || m.sub || ident.id || ident.identity_data?.provider_id || null;
}

/* ---------- queue a change for the bot ---------- */
async function queueAction(action, payload, label) {
  if (!P.sel) return;
  const { error } = await sb.from("admin_actions").insert({
    action, discord_id: P.sel.discord_id, guild_id: P.sel.guild_id,
    payload, created_by: String(P.me),
  });
  if (error) return toast("Failed: " + error.message, true);
  toast(`Queued: ${label}`);
  // give the bot a moment, then refresh what we show
  setTimeout(() => selectPlayer(P.sel, true), 2500);
}

/* ---------- data ---------- */
async function loadStatic() {
  const [cat, themes] = await Promise.all([
    fetch("data/catalog.min.json", { cache: "no-cache" }).then((r) => r.json()),
    fetch("data/themes.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({})),
  ]);
  for (const it of cat) P.catalog[it.id] = it;
  P.themes = themes || {};
  // rarity comes from the curator overrides, same rule as everywhere else
  try {
    const map = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("overrides").select("item_id,tier")
        .order("item_id").range(from, from + 999);
      if (error) throw error;
      for (const o of data || []) map[o.item_id] = o.tier;
      if (!data || data.length < 1000) break;
    }
    for (const id in P.catalog) P.catalog[id].r = map[baseItemId(id)] || "common";
  } catch (e) { /* keep baked rarities */ }
}

async function loadPlayers() {
  const { data, error } = await sb.rpc("admin_list_players");
  if (error) {
    $("#note").innerHTML = `⚠️ Player list unavailable — run <code>webportal/schema_admin_actions.sql</code> in Supabase.`;
    return;
  }
  P.players = (data || []).sort((a, b) =>
    (b.items || 0) - (a.items || 0) || String(a.display_name).localeCompare(String(b.display_name)));
  renderList();
}

function renderList() {
  const q = P.q.toLowerCase();
  const rows = P.players.filter((p) =>
    !q || String(p.display_name || "").toLowerCase().includes(q) || p.discord_id.includes(q));
  $("#plist").innerHTML = rows.map((p, i) => {
    const on = P.sel && P.sel.discord_id === p.discord_id && P.sel.guild_id === p.guild_id;
    return `<div class="prow${on ? " on" : ""}" data-i="${i}">
      <span>${esc(p.display_name || p.discord_id)}<br><small>${esc(p.guild_name || p.guild_id)}</small></span>
      <small>${num(p.items)} items</small></div>`;
  }).join("") || `<p class="muted2">No players found.</p>`;
  $("#plist").querySelectorAll(".prow").forEach((el) => {
    el.onclick = () => selectPlayer(rows[+el.dataset.i]);
  });
}

async function selectPlayer(p, quiet) {
  P.sel = p;
  if (!quiet) renderList();
  const { data, error } = await sb.rpc("admin_player_items",
    { target: p.discord_id, guild: p.guild_id });
  P.inv = error ? [] : (data || []);
  renderDetail();
  if (!quiet) renderList();
}

/* ---------- detail + tools ---------- */
function renderDetail() {
  const p = P.sel;
  const total = P.inv.reduce((n, r) => n + Number(r.count || 0), 0);
  const byTier = {};
  for (const r of P.inv) {
    const it = P.catalog[r.item_id];
    if (it) byTier[it.r] = (byTier[it.r] || 0) + Number(r.count || 0);
  }
  const themeOpts = Object.entries(P.themes)
    .map(([k, t]) => `<option value="${esc(k)}">${esc(t.name || k)}</option>`).join("");

  $("#detail").innerHTML = `
    <div class="who"><h2>${esc(p.display_name || p.discord_id)}</h2>
      <span class="muted2">${esc(p.guild_name || p.guild_id)}</span>
      <span class="muted2">· id ${esc(p.discord_id)}</span></div>
    <div class="stats">
      <div class="stat"><div class="v">${num(total)}</div><div class="k">Copies</div></div>
      <div class="stat"><div class="v">${num(P.inv.length)}</div><div class="k">Unique</div></div>
      ${RARITY.map((r) => `<div class="stat"><div class="v">${num(byTier[r] || 0)}</div>
        <div class="k">${r}</div></div>`).join("")}
    </div>

    <div class="tools">
      <div class="tool">
        <h3>💸 Refund a purchase</h3>
        <p>Takes the item back and returns Club Coins — for a double-buy in the shop.</p>
        <div class="row">
          <input id="rfItem" type="text" list="ownedList" class="grow" placeholder="Item they own…" />
          <input id="rfQty" type="number" value="1" min="1" />
          <input id="rfCoins" type="number" value="0" min="0" placeholder="coins" />
          <button class="btn gold" id="rfGo">Refund</button>
        </div>
        <div class="hintline">Pick from what they actually hold; coins are added back.</div>
      </div>

      <div class="tool">
        <h3>🎁 Give / take items</h3>
        <div class="row">
          <input id="giItem" type="text" list="allList" class="grow" placeholder="Any item…" />
          <input id="giQty" type="number" value="1" min="1" max="100" />
          <button class="btn" id="giGive">Give</button>
          <button class="btn danger" id="giTake">Take</button>
        </div>
      </div>

      <div class="tool">
        <h3>🪙 Adjust coins</h3>
        <div class="row">
          <select id="cKind"><option value="club">Club Coins</option><option value="yeti">Yeti Credits</option></select>
          <input id="cAmt" type="number" value="0" placeholder="+/-" />
          <button class="btn" id="cGo">Apply</button>
        </div>
        <div class="hintline">Negative removes. The bot refuses to go below zero.</div>
      </div>

      <div class="tool">
        <h3>🎨 Themes</h3>
        <div class="row">
          <select id="thKey" class="grow">${themeOpts}</select>
          <button class="btn" id="thGrant">Grant</button>
          <button class="btn danger" id="thRevoke">Revoke</button>
        </div>
      </div>

      <div class="tool">
        <h3>⏱️ Clear cooldown</h3>
        <div class="row">
          <input id="cdKey" type="text" class="grow" value="all" placeholder="genie, dash, daily… or all" />
          <button class="btn" id="cdGo">Clear</button>
        </div>
      </div>
    </div>

    <datalist id="ownedList">${P.inv.map((r) => {
      const it = P.catalog[r.item_id];
      return `<option value="${esc(r.item_id)}">${esc(it ? it.n : r.item_id)} ×${r.count}</option>`;
    }).join("")}</datalist>
    <datalist id="allList">${Object.values(P.catalog).slice(0, 2000).map((it) =>
      `<option value="${esc(it.id)}">${esc(it.n)}</option>`).join("")}</datalist>`;

  const v = (id) => $("#" + id).value.trim();
  const n = (id) => Number($("#" + id).value || 0);
  $("#rfGo").onclick = () => v("rfItem")
    ? queueAction("refund", { item_id: v("rfItem"), qty: n("rfQty") || 1, coins: n("rfCoins") },
                  `refund ${v("rfItem")}`)
    : toast("Pick an item first", true);
  $("#giGive").onclick = () => v("giItem")
    ? queueAction("give", { item_id: v("giItem"), qty: n("giQty") || 1 }, `give ${v("giItem")}`)
    : toast("Pick an item first", true);
  $("#giTake").onclick = () => v("giItem")
    ? queueAction("take", { item_id: v("giItem"), qty: n("giQty") || 1 }, `take ${v("giItem")}`)
    : toast("Pick an item first", true);
  $("#cGo").onclick = () => n("cAmt")
    ? queueAction("coins", { kind: v("cKind"), amount: n("cAmt") }, `${v("cKind")} ${n("cAmt")}`)
    : toast("Enter a non-zero amount", true);
  $("#thGrant").onclick = () => queueAction("theme", { theme: v("thKey") }, `grant ${v("thKey")}`);
  $("#thRevoke").onclick = () => queueAction("theme", { theme: v("thKey"), revoke: true },
                                             `revoke ${v("thKey")}`);
  $("#cdGo").onclick = () => queueAction("cooldown", { key: v("cdKey") || "all" },
                                         `clear ${v("cdKey") || "all"}`);
}

/* ---------- boot ---------- */
async function render(session) {
  const id = discordIdFromSession(session);
  P.me = id;
  const isAdmin = id && ADMIN_IDS.includes(String(id));
  if (!session || !isAdmin) {
    $("#gate").style.display = ""; $("#panel").style.display = "none";
    if (session && !isAdmin) {
      $("#signInBtn").style.display = "none";
      $("#gateMsg").textContent = `This account isn't an admin. (${id || "no id"})`;
    }
    return;
  }
  $("#gate").style.display = "none"; $("#panel").style.display = "";
  await loadStatic();
  await loadPlayers();
}

async function boot() {
  $("#signInBtn").onclick = () => sb.auth.signInWithOAuth({
    provider: "discord",
    options: { redirectTo: location.href.split("#")[0], scopes: "identify" },
  });
  $("#signOutBtn").onclick = async (e) => { e.preventDefault(); await sb.auth.signOut(); location.reload(); };
  $("#search").oninput = (e) => { P.q = e.target.value.trim(); renderList(); };
  sb.auth.onAuthStateChange((_e, s) => render(s));
  const { data } = await sb.auth.getSession();
  render(data.session);
}
boot();
