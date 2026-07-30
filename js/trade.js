/* ============================================================
   CLUBVMK — Trading Post.

   Two ways in, one ending:
     item first : search an item -> pick an owner  -> pick what you give
     user first : pick a player  -> pick their item -> pick what you give
   Both converge on the same offer card, which inserts a `trade_offers` row.
   The bot drains that queue and posts the real Accept/Decline offer in
   Discord — the portal never moves an item itself.

   Cross-player reads all go through the trade_* RPCs (see
   webportal/schema_trade_portal.sql); they scope every answer to servers the
   signed-in player is actually in.
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const $ = (s) => document.querySelector(s);
const RARITY = ["legendary", "epic", "rare", "uncommon", "common"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const imgUrl = (f) => CFG.ITEM_IMG_BASE + f;
const baseItemId = (id) => (id.includes("*") ? id.slice(0, id.lastIndexOf("*")) : id);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Item names are full of punctuation ("Room Pin - Oogie's Lair"), so a plain
// substring search fails on what people actually type ("oogie lair"). Strip
// punctuation and match every word instead, in any order.
const normName = (s) => String(s ?? "").toLowerCase()
  .replace(/[‘’'`´]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
function nameMatches(name, query) {
  const terms = normName(query).split(" ").filter(Boolean);
  if (!terms.length) return true;
  const hay = normName(name);
  return terms.every((t) => hay.includes(t));
}

/* Only these rarities are public — "hold" and anything else the curator uses
   internally never appears in a filter or a result list. */
const PUBLIC_RARITY = new Set(RARITY);
const CATEGORIES = [["", "All types"], ["pin", "📌 Pins"], ["clothing", "👕 Clothing"]];

/* One filter bar, reused by every list on the page. `onChange` re-runs whatever
   draw function owns the list; state lives on the returned object. */
function filterBar(id, onChange) {
  const f = { cat: "", rar: "" };
  const html = `<div class="row" style="margin-top:10px">
      <select id="${id}Cat" style="flex:0 1 160px">
        ${CATEGORIES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
      <select id="${id}Rar" style="flex:0 1 170px">
        <option value="">All rarities</option>
        ${RARITY.map((r) => `<option value="${r}">${cap(r)}</option>`).join("")}</select>
    </div>`;
  const wire = () => {
    const c = $("#" + id + "Cat"), r = $("#" + id + "Rar");
    if (!c || !r) return;
    c.value = f.cat; r.value = f.rar;
    c.onchange = () => { f.cat = c.value; onChange(); };
    r.onchange = () => { f.rar = r.value; onChange(); };
  };
  // an item passes when it's public AND matches both dropdowns
  f.ok = (it) => PUBLIC_RARITY.has(it.r)
    && (!f.cat || it.c === f.cat)
    && (!f.rar || it.r === f.rar);
  f.html = html;
  f.wire = wire;
  return f;
}

const T = {
  me: null,
  mode: "item",        // "item" | "user"
  catalog: {},
  list: [],            // searchable catalogue [{id,n,r,img}]
  players: [],         // trade_players() rows
  myInv: {},           // item_id -> count, for the guild in play
  want: null,          // {item, owner} — what you're asking for
  give: null,          // item you're offering
  owner: null,         // {discord_id, display_name, guild_id, guild_name}
  theirInv: [],        // [{item, count}] for the user-first flow
};

let toastT;
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 3800);
}

// PostgREST silently caps a response at 1000 rows, so anything reading a whole
// inventory has to page. `filter` applies the same where-clause to every page;
// the stable order stops paging from skipping or repeating rows.
async function fetchAllRows(table, columns, filter) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(columns);
    if (filter) q = filter(q);
    const { data, error } = await q.order("item_id").range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    out.push(...(data || []));
    if (!data || data.length < PAGE) return { data: out, error: null };
  }
}

// same cap applies to set-returning functions
async function fetchAllRpc(fn, args) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.rpc(fn, args)
      .order("item_id").range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    out.push(...(data || []));
    if (!data || data.length < PAGE) return { data: out, error: null };
  }
}

function discordIdFromSession(session) {
  const u = session?.user; if (!u) return null;
  const m = u.user_metadata || {};
  const ident = (u.identities || []).find((i) => i.provider === "discord") || {};
  return m.provider_id || m.sub || ident.id || ident.identity_data?.provider_id || null;
}

/* ---------- catalogue (names + rarities, same source as the bot) ---------- */
async function loadCatalog() {
  const cat = await fetch("data/catalog.min.json", { cache: "no-cache" }).then((r) => r.json());
  for (const it of cat) T.catalog[it.id] = it;
  // rarity comes from the curator's overrides table — never the baked value, so
  // the portal can't disagree with what Discord shows
  try {
    const map = {};
    let from = 0; const page = 1000;
    for (;;) {
      const { data, error } = await sb.from("overrides").select("item_id,tier")
        .order("item_id").range(from, from + page - 1);
      if (error) throw error;
      for (const o of data || []) map[o.item_id] = o.tier;
      if (!data || data.length < page) break;
      from += page;
    }
    for (const id in T.catalog) T.catalog[id].r = map[baseItemId(id)] || "common";
  } catch (e) { console.warn("overrides load failed:", e.message); }
  // after the overrides: custom items aren't in that table, and its
  // "not listed means common" rule would flatten every one of them
  await window.mergeCustomItems(sb, T.catalog);
  // only nameable items in a public rarity are worth searching
  T.list = Object.values(T.catalog)
    .filter((it) => (it.n || "").trim() && PUBLIC_RARITY.has(it.r));
}

/* ---------- little renderers ---------- */
const rar = (it) => `<span class="r-${esc(it.r)}">${cap(it.r)}</span>`;
const initial = (name) => esc((name || "?").trim()[0] || "?").toUpperCase();

function chosenRow(it, label, onClear) {
  const el = document.createElement("div");
  el.className = "chosen";
  el.innerHTML = `<img src="${imgUrl(it.img)}" alt="" loading="lazy" />
    <div><div class="t">${esc(it.n)}</div>
      <div class="s">${label} • ${rar(it)}</div></div>
    <button class="btn tiny ghost">Change</button>`;
  el.querySelector("button").onclick = onClear;
  return el;
}

function ownerRow(o, tail, onPick) {
  const b = document.createElement("button");
  b.className = "pick";
  b.innerHTML = `<span class="av">${initial(o.display_name)}</span>
    <span><span class="who">${esc(o.display_name)}</span>
      <span class="sub">${esc(o.guild_name)}</span></span>
    <span class="tail">${tail}</span>`;
  b.onclick = onPick;
  return b;
}

/* ---------- step chrome ---------- */
function renderSteps(active) {
  const labels = T.mode === "item"
    ? ["Find the item", "Choose an owner", "Offer a swap"]
    : ["Find a player", "Pick their item", "Offer a swap"];
  $("#steps").innerHTML = labels.map((l, i) => {
    const n = i + 1;
    return `<span class="step" data-on="${n === active}" data-done="${n < active}">
      <span class="n">${n < active ? "✓" : n}</span><b>${esc(l)}</b></span>`
      + (n < 3 ? '<span class="sep">›</span>' : "");
  }).join("");
}

/* ---------- flow: item first ---------- */
function itemFirst() {
  const flow = $("#flow");
  const f = filterBar("if", () => searchItems());
  flow.innerHTML = `
    <section class="card" id="c1">
      <h2>1 · Find the item you want</h2>
      <p class="hint">Search the whole catalogue — then see who's holding one.</p>
      <div class="row"><input class="search grow" id="itemQ" type="text"
        placeholder="Start typing an item name…" autocomplete="off" /></div>
      ${f.html}
      <div class="rows" id="itemHits"></div>
    </section>`;
  renderSteps(1);
  f.wire();
  const q = $("#itemQ"), hits = $("#itemHits");
  let timer;
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(searchItems, 140); };
  q.focus();

  function searchItems() {
    const s = q.value.trim().toLowerCase();
    if (s.length < 2 && !f.cat && !f.rar) {
      hits.innerHTML = `<span class="muted2">Type at least 2 letters, or filter above.</span>`;
      return;
    }
    const found = T.list.filter((it) => f.ok(it) && nameMatches(it.n, s))
      .sort((a, b) => RARITY.indexOf(a.r) - RARITY.indexOf(b.r) || a.n.localeCompare(b.n))
      .slice(0, 40);
    if (!found.length) { hits.innerHTML = `<span class="muted2">No item matches that.</span>`; return; }
    hits.innerHTML = "";
    for (const it of found) {
      const b = document.createElement("button");
      b.className = "pick";
      b.innerHTML = `<img src="${imgUrl(it.img)}" alt="" loading="lazy"
          style="width:38px;height:38px;object-fit:contain;flex:none" />
        <span><span class="who">${esc(it.n)}</span><span class="sub">${rar(it)}</span></span>
        <span class="tail">Who has it? ›</span>`;
      b.onclick = () => chooseOwnerFor(it);
      hits.appendChild(b);
    }
  }
}

async function chooseOwnerFor(item) {
  renderSteps(2);
  const flow = $("#flow");
  flow.innerHTML = `<section class="card done" id="c1"></section>
    <section class="card"><h2>2 · Choose an owner</h2>
      <p class="hint">Players in your servers holding this item.</p>
      <div class="rows" id="owners"><span class="muted2">Looking…</span></div></section>`;
  $("#c1").appendChild(chosenRow(item, "the item you want", itemFirst));

  const { data, error } = await sb.rpc("trade_owners", { p_item_id: item.id });
  const box = $("#owners");
  if (error) { box.innerHTML = `<span class="muted2">Couldn't load owners: ${esc(error.message)}</span>`; return; }
  if (!data?.length) {
    box.innerHTML = `<span class="muted2">Nobody in your servers has one of these yet.</span>`;
    return;
  }
  box.innerHTML = "";
  for (const o of data) {
    box.appendChild(ownerRow(o, `<b>${o.count}</b><br>owned`, () => {
      T.want = item; T.owner = o;
      offerStep();
    }));
  }
}

/* ---------- flow: user first ---------- */
async function userFirst() {
  renderSteps(1);
  const flow = $("#flow");
  flow.innerHTML = `
    <section class="card">
      <h2>1 · Find a player</h2>
      <p class="hint">Everyone you share a server with.</p>
      <div class="row"><input class="search grow" id="userQ" type="text"
        placeholder="Filter by name…" autocomplete="off" /></div>
      <div class="rows" id="userHits"><span class="muted2">Loading players…</span></div>
    </section>`;
  if (!T.players.length) {
    const { data, error } = await sb.rpc("trade_players");
    if (error) {
      $("#userHits").innerHTML = `<span class="muted2">Couldn't load players: ${esc(error.message)}</span>`;
      return;
    }
    T.players = data || [];
  }
  const q = $("#userQ");
  q.oninput = draw; q.focus();
  draw();

  function draw() {
    const s = (q.value || "").trim().toLowerCase();
    const box = $("#userHits");
    const rows = T.players.filter((p) => nameMatches(p.display_name, s));
    if (!rows.length) { box.innerHTML = `<span class="muted2">No player matches that.</span>`; return; }
    box.innerHTML = "";
    for (const p of rows.slice(0, 100)) {
      box.appendChild(ownerRow(p, `<b>${p.uniques}</b><br>unique`, () => browseInventory(p)));
    }
  }
}

async function browseInventory(player) {
  renderSteps(2);
  const flow = $("#flow");
  const theirFilter = filterBar("th", () => draw());
  flow.innerHTML = `
    <section class="card done">
      <div class="chosen"><span class="av" style="display:grid;place-items:center;width:42px;
          height:42px;border-radius:50%;background:var(--panel2);color:var(--gold-soft);
          font-weight:700">${initial(player.display_name)}</span>
        <div><div class="t">${esc(player.display_name)}</div>
          <div class="s">${esc(player.guild_name)}</div></div>
        <button class="btn tiny ghost" id="backUsers">Change</button></div>
    </section>
    <section class="card"><h2>2 · Pick what you want from them</h2>
      <p class="hint">Their collection, rarest first.</p>
      <div class="row"><input class="search grow" id="invQ" type="text"
        placeholder="Filter their items…" autocomplete="off" /></div>
      ${theirFilter.html}
      <div class="rows" id="theirs"><span class="muted2">Loading inventory…</span></div></section>`;
  $("#backUsers").onclick = userFirst;
  theirFilter.wire();

  // set-returning RPCs are capped the same way, so page this one too
  const { data, error } = await fetchAllRpc("trade_inventory", {
    p_discord_id: player.discord_id, p_guild_id: player.guild_id });
  const box = $("#theirs");
  if (error) { box.innerHTML = `<span class="muted2">Couldn't load: ${esc(error.message)}</span>`; return; }
  T.theirInv = (data || []).map((r) => ({ item: T.catalog[r.item_id], count: r.count }))
    .filter((r) => r.item)
    .sort((a, b) => RARITY.indexOf(a.item.r) - RARITY.indexOf(b.item.r)
      || a.item.n.localeCompare(b.item.n));
  if (!T.theirInv.length) { box.innerHTML = `<span class="muted2">They have nothing yet.</span>`; return; }

  const q = $("#invQ");
  q.oninput = draw;
  draw();

  function draw() {
    const s = ($("#invQ")?.value || "").trim().toLowerCase();
    const rows = T.theirInv.filter((r) => theirFilter.ok(r.item)
      && nameMatches(r.item.n, s));
    if (!rows.length) { box.innerHTML = `<span class="muted2">Nothing matches that.</span>`; return; }
    box.innerHTML = "";
    for (const r of rows.slice(0, 300)) {
      const b = document.createElement("button");
      b.className = "pick";
      b.innerHTML = `<img src="${imgUrl(r.item.img)}" alt="" loading="lazy"
          style="width:38px;height:38px;object-fit:contain;flex:none" />
        <span><span class="who">${esc(r.item.n || r.item.id)}</span>
          <span class="sub">${rar(r.item)}</span></span>
        <span class="tail"><b>${r.count}</b><br>owned</span>`;
      b.onclick = () => { T.want = r.item; T.owner = player; offerStep(); };
      box.appendChild(b);
    }
  }
}

/* ---------- step 3: what do you give? ---------- */
async function offerStep() {
  renderSteps(3);
  T.give = null;
  const back = T.mode === "item" ? () => chooseOwnerFor(T.want) : () => browseInventory(T.owner);
  const flow = $("#flow");
  const mineFilter = filterBar("mi", () => draw());
  flow.innerHTML = `
    <section class="card done" id="cWant"></section>
    <section class="card">
      <h2>3 · Pick what you'll give</h2>
      <p class="hint">From your collection in ${esc(T.owner.guild_name)}.</p>
      <div class="row"><input class="search grow" id="mineQ" type="text"
        placeholder="Filter your items…" autocomplete="off" /></div>
      ${mineFilter.html}
      <div class="rows" id="mine"><span class="muted2">Loading your inventory…</span></div>
    </section>
    <section class="card" id="dealCard"></section>`;
  $("#cWant").appendChild(chosenRow(T.want, `from ${T.owner.display_name}`, back));
  mineFilter.wire();
  drawDeal();

  // your own inventory in that same server (RLS already scopes this to you).
  // Paged: PostgREST truncates at 1000 rows without saying so, which would hide
  // the tail of a big collection from the "what you'll give" list.
  const { data, error } = await fetchAllRows(
    "player_items", "item_id,count",
    (q) => q.eq("guild_id", T.owner.guild_id).gt("count", 0));
  const box = $("#mine");
  if (error) { box.innerHTML = `<span class="muted2">Couldn't load: ${esc(error.message)}</span>`; return; }
  const mine = (data || []).map((r) => ({ item: T.catalog[r.item_id], count: r.count }))
    .filter((r) => r.item)
    .sort((a, b) => RARITY.indexOf(a.item.r) - RARITY.indexOf(b.item.r)
      || (a.item.n || "").localeCompare(b.item.n || ""));
  if (!mine.length) {
    box.innerHTML = `<span class="muted2">You have no items in that server yet.</span>`;
    return;
  }
  const q = $("#mineQ");
  q.oninput = draw;
  draw();

  function draw() {
    const s = ($("#mineQ")?.value || "").trim().toLowerCase();
    const rows = mine.filter((r) => mineFilter.ok(r.item)
      && nameMatches(r.item.n, s));
    if (!rows.length) { box.innerHTML = `<span class="muted2">Nothing matches that.</span>`; return; }
    box.innerHTML = "";
    for (const r of rows.slice(0, 300)) {
      const b = document.createElement("button");
      b.className = "pick";
      b.innerHTML = `<img src="${imgUrl(r.item.img)}" alt="" loading="lazy"
          style="width:38px;height:38px;object-fit:contain;flex:none" />
        <span><span class="who">${esc(r.item.n || r.item.id)}</span>
          <span class="sub">${rar(r.item)}</span></span>
        <span class="tail"><b>${r.count}</b><br>you own</span>`;
      b.onclick = () => { T.give = r.item; drawDeal();
        $("#dealCard").scrollIntoView({ behavior: "smooth", block: "nearest" }); };
      box.appendChild(b);
    }
  }
}

function sideHtml(it, label) {
  if (!it) return `<div class="side empty"><div class="lbl">${label}</div>Pick an item above</div>`;
  return `<div class="side"><div class="lbl">${label}</div>
    <img src="${imgUrl(it.img)}" alt="" />
    <div class="nm">${esc(it.n)}</div><div class="rr">${rar(it)}</div></div>`;
}

function drawDeal() {
  const card = $("#dealCard");
  if (!card) return;
  card.innerHTML = `
    <h2>Your offer</h2>
    <p class="hint">Posted in Discord for ${esc(T.owner.display_name)} to accept or decline.</p>
    <div class="deal">
      ${sideHtml(T.give, "You give")}
      <div class="swap">⇄</div>
      ${sideHtml(T.want, "You get")}
    </div>
    <button class="btn gold" id="sendOffer" ${T.give ? "" : "disabled style=opacity:.5"}>
      🤝 Send this offer</button>
    <p class="note">Nothing changes hands until ${esc(T.owner.display_name)} taps
      <b>Accept</b> on the offer in Discord.</p>`;
  if (T.give) $("#sendOffer").onclick = sendOffer;
}

async function sendOffer() {
  const btn = $("#sendOffer");
  btn.disabled = true; btn.textContent = "Sending…";
  const { error } = await sb.from("trade_offers").insert({
    proposer_id: String(T.me),
    target_id: String(T.owner.discord_id),
    guild_id: String(T.owner.guild_id),
    give_item: T.give.id,
    receive_item: T.want.id,
  });
  if (error) {
    btn.disabled = false; btn.textContent = "🤝 Send this offer";
    return toast("Couldn't send: " + error.message, true);
  }
  toast(`Offer sent to ${T.owner.display_name} — watch for it in Discord.`);
  btn.textContent = "✓ Sent";
  loadRecent();
  setTimeout(loadRecent, 4000);
}

/* ---------- incoming offers (you're the target) ---------- */
async function loadInbox() {
  const box = $("#inbox"), count = $("#inboxCount");
  const { data, error } = await sb.rpc("trade_incoming");
  if (error) {
    // the migration hasn't been run yet — say so instead of failing silently
    box.innerHTML = `<span class="muted2">Inbox unavailable — run
      <code>webportal/schema_trade_incoming.sql</code> in Supabase.</span>`;
    count.textContent = "";
    return;
  }
  const live = (data || []).filter((r) => r.status === "posted" && !r.decision);
  count.textContent = live.length ? `${live.length} waiting` : "";
  count.className = "pill" + (live.length ? " s-pending" : "");
  if (!data?.length) { box.innerHTML = `<span class="muted2">Nothing waiting.</span>`; return; }

  box.innerHTML = "";
  for (const r of data.slice(0, 12)) {
    // they give you `give_item`; you give them `receive_item`
    const theirs = T.catalog[r.give_item], yours = T.catalog[r.receive_item];
    const el = document.createElement("div");
    const answered = r.decision || r.status !== "posted";
    el.className = answered ? "qrow" : "offer";
    if (answered) {
      const label = r.decision && r.status === "posted" ? "sending…" : r.status;
      el.innerHTML = `<span class="pill s-${esc(r.status)}">${esc(label)}</span>
        <span>From <b>${esc(r.proposer_name)}</b>: <b>${esc(theirs?.n || r.give_item)}</b>
          ⇄ <b>${esc(yours?.n || r.receive_item)}</b></span>`;
      box.appendChild(el);
      continue;
    }
    el.innerHTML = `
      <span class="from"><b>${esc(r.proposer_name)}</b> · ${esc(r.guild_name)}</span>
      <span class="leg"><img src="${imgUrl(theirs?.img || "")}" alt="" loading="lazy" />
        <span><span class="lb">You get</span>${esc(theirs?.n || r.give_item)}</span></span>
      <span class="swap" style="font-size:18px">⇄</span>
      <span class="leg"><img src="${imgUrl(yours?.img || "")}" alt="" loading="lazy" />
        <span><span class="lb">You give</span>${esc(yours?.n || r.receive_item)}</span></span>
      <span class="acts">
        <button class="btn tiny good">Accept</button>
        <button class="btn tiny bad">Decline</button></span>`;
    const [acc, dec] = el.querySelectorAll("button");
    acc.onclick = () => answer(r, "accept", el);
    dec.onclick = () => answer(r, "decline", el);
    box.appendChild(el);
  }
}

async function answer(offer, decision, el) {
  el.querySelectorAll("button").forEach((b) => (b.disabled = true));
  // the portal only records the decision — the bot does the swap
  const { error } = await sb.from("trade_offers")
    .update({ decision, decided_at: new Date().toISOString() })
    .eq("id", offer.id);
  if (error) {
    el.querySelectorAll("button").forEach((b) => (b.disabled = false));
    return toast("Couldn't answer: " + error.message, true);
  }
  toast(decision === "accept"
    ? "Accepted — the bot is making the swap now."
    : "Declined.");
  loadInbox();
  setTimeout(loadInbox, 4000);
}

/* ---------- your recent offers ---------- */
async function loadRecent() {
  const box = $("#recent");
  const { data, error } = await sb.from("trade_offers")
    .select("give_item,receive_item,status,result,created_at,target_id,proposer_id")
    .eq("proposer_id", String(T.me))
    .order("created_at", { ascending: false }).limit(8);
  if (error || !data?.length) {
    box.innerHTML = `<span class="muted2">Nothing yet.</span>`;
    return;
  }
  box.innerHTML = data.map((r) => {
    const g = T.catalog[r.give_item], w = T.catalog[r.receive_item];
    return `<div class="qrow">
      <span class="pill s-${esc(r.status)}">${esc(r.status)}</span>
      <span>You offered <b>${esc(g?.n || r.give_item)}</b>
        ⇄ <b>${esc(w?.n || r.receive_item)}</b></span>
      <span class="muted2" style="margin-left:auto">${esc(r.result || "")}</span>
    </div>`;
  }).join("");
}

/* ---------- boot ---------- */
function setMode(mode) {
  T.mode = mode;
  $("#mItem").setAttribute("aria-selected", String(mode === "item"));
  $("#mUser").setAttribute("aria-selected", String(mode === "user"));
  T.want = T.give = T.owner = null;
  mode === "item" ? itemFirst() : userFirst();
}

async function render(session) {
  const id = discordIdFromSession(session);
  T.me = id;
  $("#signInBtn").classList.toggle("hidden", !!session);
  $("#signOutBtn").classList.toggle("hidden", !session);
  if (!session) {
    $("#gate").classList.remove("hidden"); $("#panel").classList.add("hidden");
    return;
  }
  $("#gate").classList.add("hidden"); $("#panel").classList.remove("hidden");
  setMode(T.mode);
  loadInbox();
  loadRecent();
}

async function boot() {
  $("#signInBtn").onclick = () => sb.auth.signInWithOAuth({
    provider: "discord",
    options: { redirectTo: location.href.split("#")[0], scopes: "identify" },
  });
  $("#signOutBtn").onclick = async () => { await sb.auth.signOut(); location.reload(); };
  $("#mItem").onclick = () => setMode("item");
  $("#mUser").onclick = () => setMode("user");
  await loadCatalog();
  sb.auth.onAuthStateChange((_e, s) => render(s));
  const { data } = await sb.auth.getSession();
  render(data.session);
}
boot().catch((e) => { console.error(e); $("#gateMsg").textContent = "Load error: " + e.message; });
