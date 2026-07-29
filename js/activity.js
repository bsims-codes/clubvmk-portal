/* ============================================================
   CLUBVMK — command activity analytics
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const ADMIN_IDS = ["886570059974201405"];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (n) => Number(n || 0).toLocaleString();
const when = (t) => (t ? new Date(t).toLocaleString() : "—");

const RARITY = ["legendary", "epic", "rare", "uncommon", "common"];
const D = {
  since: 30, commands: [], players: [], targets: [], recent: [], names: {},
  trades: [], catalog: {},
  playerSort: { k: "uses", dir: -1 }, tgtSort: { k: "times", dir: -1 },
};

const baseItemId = (id) => (id.includes("*") ? id.slice(0, id.lastIndexOf("*")) : id);
const pill = (r) => `<span class="pill r-${r}">${r}</span>`;

/* The catalogue + curator overrides give rarity at display time, so a re-tiered
   item reads correctly in history rather than however it was tiered back then. */
async function loadCatalog() {
  if (Object.keys(D.catalog).length) return;
  const cat = await fetch("data/catalog.min.json", { cache: "no-cache" }).then((r) => r.json());
  for (const it of cat) D.catalog[it.id] = { id: it.id, n: it.n, r: it.r };
  try {
    const map = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("overrides").select("item_id,tier")
        .order("item_id").range(from, from + 999);
      if (error) throw error;
      for (const o of data || []) map[o.item_id] = o.tier;
      if (!data || data.length < 1000) break;
    }
    for (const id in D.catalog) D.catalog[id].r = map[baseItemId(id)] || "common";
  } catch (e) { /* keep the baked rarities */ }
}

/* PostgREST caps responses at 1000 rows; page through anything that can exceed it. */
async function rpcAll(name, args, orderCols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.rpc(name, args);
    for (const c of orderCols) q = q.order(c);
    const { data, error } = await q.range(from, from + 999);
    if (error) return { error };
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { data: out };
}

function discordIdFromSession(session) {
  const u = session?.user; if (!u) return null;
  const m = u.user_metadata || {};
  const ident = (u.identities || []).find((i) => i.provider === "discord") || {};
  return m.provider_id || m.sub || ident.id || ident.identity_data?.provider_id || null;
}

async function loadTrades() {
  const cutoff = new Date(Date.now() - D.since * 86400e3).toISOString();
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("trade_log")
      .select("ts,proposer_id,target_id,give_item,receive_item,status")
      .gte("ts", cutoff).order("ts", { ascending: false }).range(from, from + 999);
    if (error) return { error };
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { data: out };
}

async function loadAll() {
  await loadCatalog();
  const args = { since_days: D.since };
  const [c, p, t, r] = await Promise.all([
    rpcAll("activity_commands", args, ["command"]),
    rpcAll("activity_players", args, ["discord_id"]),
    rpcAll("activity_targets", args, ["command", "actor", "target"]),
    sb.from("command_log").select("ts,discord_id,command,target_id,result")
      .order("ts", { ascending: false }).limit(80),
  ]);
  if (c.error || p.error || t.error) {
    $("#note").innerHTML = `⚠️ Activity data unavailable — run
      <code>webportal/schema_activity.sql</code> in Supabase, then refresh.`;
    return;
  }
  $("#note").innerHTML = "";
  D.commands = c.data || [];
  D.players = p.data || [];
  D.targets = t.data || [];
  D.recent = r.data || [];
  if (r.error) {
    // the `result` column may not exist yet — fall back to the old shape so the
    // table still lists commands instead of going blank
    const { data } = await sb.from("command_log").select("ts,discord_id,command,target_id")
      .order("ts", { ascending: false }).limit(80);
    D.recent = data || [];
    D.noResultCol = true;
  }
  D.names = {};
  for (const x of D.players) if (x.display_name) D.names[x.discord_id] = x.display_name;
  for (const x of D.targets) {
    if (x.actor_name) D.names[x.actor] = x.actor_name;
    if (x.target_name) D.names[x.target] = x.target_name;
  }
  const tr = await loadTrades();
  D.trades = tr.error ? [] : (tr.data || []);
  $("#tradeNote").innerHTML = tr.error
    ? `⚠️ Trade history unavailable — run <code>webportal/schema_trades.sql</code> in Supabase.`
    : "Every offer and how it ended. Rarity is resolved from the live catalogue, " +
      "so re-tiered items always read correctly.";
  renderCards(); renderCommands(); renderPlayers(); renderTargetFilter(); renderTargets();
  renderTrades(); renderRecent();
}

/* ---------- trades ---------- */
const rarOf = (id) => D.catalog[id]?.r || "common";
const itemName = (id) => D.catalog[id]?.n?.trim() || id;

function renderTrades() {
  const all = D.trades, done = all.filter((t) => t.status === "accepted");
  const traders = new Set();
  for (const t of done) { traders.add(t.proposer_id); traders.add(t.target_id); }
  const cards = [
    ["Trades completed", num(done.length)],
    ["Offers made", num(all.length)],
    ["Declined", num(all.filter((t) => t.status === "declined").length)],
    ["Expired", num(all.filter((t) => t.status === "expired").length)],
    ["Accept rate", all.length ? `${Math.round(done.length / all.length * 100)}%` : "—"],
    ["Players trading", num(traders.size)],
  ];
  $("#tradeCards").innerHTML = cards.map(([k, v]) =>
    `<div class="card"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join("");

  // rarity of every item that actually changed hands (both sides of a trade)
  const byRar = {}, byItem = {};
  for (const t of done) {
    for (const id of [t.give_item, t.receive_item]) {
      const r = rarOf(id);
      byRar[r] = (byRar[r] || 0) + 1;
      byItem[id] = (byItem[id] || 0) + 1;
    }
  }
  const moved = Object.values(byRar).reduce((a, b) => a + b, 0);
  $("#tradeRarTbl").querySelector("tbody").innerHTML = RARITY.map((r) => {
    const n = byRar[r] || 0;
    return `<tr><td>${pill(r)}</td><td class="num">${num(n)}</td>
      <td class="num">${moved ? (n / moved * 100).toFixed(1) + "%" : "—"}</td></tr>`;
  }).join("");

  const top = Object.entries(byItem).sort((a, b) => b[1] - a[1]).slice(0, 25);
  $("#tradeItemTbl").querySelector("tbody").innerHTML = top.map(([id, n]) =>
    `<tr><td>${esc(itemName(id))}</td><td>${pill(rarOf(id))}</td>
     <td class="num">${num(n)}</td></tr>`).join("")
    || `<tr><td colspan="3" class="muted2">No completed trades yet.</td></tr>`;

  $("#tradeTbl").querySelector("tbody").innerHTML = all.slice(0, 40).map((t) =>
    `<tr><td class="muted2">${esc(when(t.ts))}</td>
     <td>${esc(nameOf(t.proposer_id))}</td>
     <td>${esc(itemName(t.give_item))} ${pill(rarOf(t.give_item))}</td>
     <td>${esc(nameOf(t.target_id))}</td>
     <td>${esc(itemName(t.receive_item))} ${pill(rarOf(t.receive_item))}</td>
     <td><span class="pill s-${esc(t.status)}">${esc(t.status)}</span></td></tr>`).join("")
    || `<tr><td colspan="6" class="muted2">No trades in this window.</td></tr>`;
}

const nameOf = (id) => D.names[id] || id || "—";

function renderCards() {
  const uses = D.commands.reduce((a, c) => a + Number(c.uses || 0), 0);
  const busiest = [...D.commands].sort((a, b) => b.uses - a.uses)[0];
  const keenest = [...D.players].sort((a, b) => b.uses - a.uses)[0];
  const cards = [
    ["Commands run", num(uses)],
    ["Distinct commands", num(D.commands.length)],
    ["Active players", num(D.players.length)],
    ["Most used", busiest ? `/${busiest.command}` : "—"],
    ["Most active", keenest ? nameOf(keenest.discord_id) : "—"],
    ["Targeted actions", num(D.targets.reduce((a, t) => a + Number(t.times || 0), 0))],
  ];
  $("#cards").innerHTML = cards.map(([k, v]) =>
    `<div class="card"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join("");
}

function renderCommands() {
  const rows = [...D.commands].sort((a, b) => b.uses - a.uses);
  const max = Math.max(1, ...rows.map((r) => Number(r.uses || 0)));
  $("#cmdChart").innerHTML = rows.map((r) => `
    <div class="ubar" title="${esc(r.command)} — ${num(r.uses)} uses by ${num(r.users)} players, last ${when(r.last_used)}">
      <span class="ubar-name">/${esc(r.command)}</span>
      <span class="ubar-track"><span class="ubar-fill" style="width:${(r.uses / max * 100).toFixed(2)}%"></span></span>
      <span class="ubar-val">${num(r.uses)}</span>
    </div>`).join("") || `<p class="muted2">No commands recorded in this window.</p>`;
}

function sortRows(rows, s, nameKey) {
  return rows.sort((a, b) => {
    let av = a[s.k], bv = b[s.k];
    if (s.k === nameKey) { av = String(av || "").toLowerCase(); bv = String(bv || "").toLowerCase(); }
    else if (s.k === "last_used") { av = new Date(av || 0); bv = new Date(bv || 0); }
    else { av = Number(av || 0); bv = Number(bv || 0); }
    return (av < bv ? -1 : av > bv ? 1 : 0) * s.dir;
  });
}

function renderPlayers() {
  const q = $("#playerSearch").value.trim().toLowerCase();
  let rows = D.players.map((p) => ({ ...p, name: nameOf(p.discord_id) }));
  if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q) || p.discord_id.includes(q));
  rows = sortRows(rows, D.playerSort, "name");
  $("#playerTotal").textContent = `${rows.length} players`;
  $("#playerTbl").querySelector("tbody").innerHTML = rows.map((p) =>
    `<tr><td>${esc(p.name)}</td><td class="num">${num(p.uses)}</td>
     <td class="num">${num(p.distinct_commands)}</td>
     <td class="muted2">${esc(when(p.last_used))}</td></tr>`).join("")
    || `<tr><td colspan="4" class="muted2">Nothing yet.</td></tr>`;
}

function renderTargetFilter() {
  const cmds = [...new Set(D.targets.map((t) => t.command))].sort();
  const cur = $("#tgtCmd").value || "all";
  $("#tgtCmd").innerHTML = `<option value="all">All commands</option>` +
    cmds.map((c) => `<option value="${esc(c)}">/${esc(c)}</option>`).join("");
  $("#tgtCmd").value = cmds.includes(cur) ? cur : "all";
}

function renderTargets() {
  const cmd = $("#tgtCmd").value, q = $("#tgtSearch").value.trim().toLowerCase();
  let rows = D.targets.map((t) => ({
    ...t, actor_name: nameOf(t.actor), target_name: nameOf(t.target),
  }));
  if (cmd !== "all") rows = rows.filter((t) => t.command === cmd);
  if (q) rows = rows.filter((t) =>
    t.actor_name.toLowerCase().includes(q) || t.target_name.toLowerCase().includes(q));
  rows = sortRows(rows, D.tgtSort, "actor_name");
  const total = rows.reduce((a, t) => a + Number(t.times || 0), 0);
  $("#tgtTotal").textContent = `${rows.length} pairs · ${num(total)} actions`;
  $("#tgtTbl").querySelector("tbody").innerHTML = rows.map((t) =>
    `<tr><td>/${esc(t.command)}</td><td>${esc(t.actor_name)}</td>
     <td>${esc(t.target_name)}</td><td class="num">${num(t.times)}</td></tr>`).join("")
    || `<tr><td colspan="4" class="muted2">No targeted commands in this window.</td></tr>`;
}

/* Outcomes are plain strings from the bot; a couple of shapes get a colour so
   wins/losses are scannable without reading every row. */
function resultCell(r) {
  const v = (r.result || "").trim();
  if (!v) {
    return D.noResultCol
      ? `<span class="muted2">—</span>`
      : `<span class="muted2">—</span>`;
  }
  const cls = /^WON|^healed|^\+/.test(v) ? "res-win"
            : /^LOST|^froze/.test(v) ? "res-lose" : "";
  return `<span class="${cls}">${esc(v)}</span>`;
}

function renderRecent() {
  $("#recentTbl").querySelector("tbody").innerHTML = D.recent.map((r) =>
    `<tr><td class="muted2">${esc(when(r.ts))}</td><td>${esc(nameOf(r.discord_id))}</td>
     <td>/${esc(r.command)}</td>
     <td class="muted2">${r.target_id ? esc(nameOf(r.target_id)) : "—"}</td>
     <td class="res">${resultCell(r)}</td></tr>`).join("")
    || `<tr><td colspan="5" class="muted2">Nothing yet.</td></tr>`;
  const note = $("#recentNote");
  if (note) {
    note.innerHTML = D.noResultCol
      ? `Outcomes need <code>webportal/schema_command_result.sql</code> run in Supabase.`
      : "";
  }
}

function wireSort(tblId, sortObj, rerender, nameKey) {
  $("#" + tblId).querySelectorAll("th[data-k]").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.k;
      if (sortObj.k === k) sortObj.dir *= -1;
      else { sortObj.k = k; sortObj.dir = k === nameKey ? 1 : -1; }
      rerender();
    };
  });
}

async function render(session) {
  const id = discordIdFromSession(session);
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
  loadAll();
}

async function boot() {
  $("#signInBtn").onclick = () => sb.auth.signInWithOAuth({
    provider: "discord",
    options: { redirectTo: location.href.split("#")[0], scopes: "identify" },
  });
  $("#signOutBtn").onclick = async (e) => { e.preventDefault(); await sb.auth.signOut(); location.reload(); };
  $("#refreshBtn").onclick = (e) => { e.preventDefault(); loadAll(); };
  $("#since").onchange = (e) => { D.since = Number(e.target.value); loadAll(); };
  $("#playerSearch").oninput = renderPlayers;
  $("#tgtSearch").oninput = renderTargets;
  $("#tgtCmd").onchange = renderTargets;
  wireSort("playerTbl", D.playerSort, renderPlayers, "name");
  wireSort("tgtTbl", D.tgtSort, renderTargets, "actor_name");
  sb.auth.onAuthStateChange((_e, s) => render(s));
  const { data } = await sb.auth.getSession();
  render(data.session);
}
boot();
