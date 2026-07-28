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
  // only nameable, tradeable items are worth searching
  T.list = Object.values(T.catalog).filter((it) => (it.n || "").trim());
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
  flow.innerHTML = `
    <section class="card" id="c1">
      <h2>1 · Find the item you want</h2>
      <p class="hint">Search the whole catalogue — then see who's holding one.</p>
      <div class="row"><input class="search grow" id="itemQ" type="text"
        placeholder="Start typing an item name…" autocomplete="off" /></div>
      <div class="rows" id="itemHits"></div>
    </section>`;
  renderSteps(1);
  const q = $("#itemQ"), hits = $("#itemHits");
  let timer;
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(searchItems, 140); };
  q.focus();

  function searchItems() {
    const s = q.value.trim().toLowerCase();
    if (s.length < 2) { hits.innerHTML = `<span class="muted2">Type at least 2 letters.</span>`; return; }
    const found = T.list.filter((it) => it.n.toLowerCase().includes(s))
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
    const rows = T.players.filter((p) => !s || p.display_name.toLowerCase().includes(s));
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
      <div class="rows" id="theirs"><span class="muted2">Loading inventory…</span></div></section>`;
  $("#backUsers").onclick = userFirst;

  const { data, error } = await sb.rpc("trade_inventory", {
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
    const s = (q.value || "").trim().toLowerCase();
    const rows = T.theirInv.filter((r) => !s || (r.item.n || "").toLowerCase().includes(s));
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
  flow.innerHTML = `
    <section class="card done" id="cWant"></section>
    <section class="card">
      <h2>3 · Pick what you'll give</h2>
      <p class="hint">From your collection in ${esc(T.owner.guild_name)}.</p>
      <div class="row"><input class="search grow" id="mineQ" type="text"
        placeholder="Filter your items…" autocomplete="off" /></div>
      <div class="rows" id="mine"><span class="muted2">Loading your inventory…</span></div>
    </section>
    <section class="card" id="dealCard"></section>`;
  $("#cWant").appendChild(chosenRow(T.want, `from ${T.owner.display_name}`, back));
  drawDeal();

  // your own inventory in that same server (RLS already scopes this to you)
  const { data, error } = await sb.from("player_items")
    .select("item_id,count").eq("guild_id", T.owner.guild_id).gt("count", 0);
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
    const s = (q.value || "").trim().toLowerCase();
    const rows = mine.filter((r) => !s || (r.item.n || "").toLowerCase().includes(s));
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

/* ---------- your recent offers ---------- */
async function loadRecent() {
  const box = $("#recent");
  const { data, error } = await sb.from("trade_offers")
    .select("give_item,receive_item,status,result,created_at,target_id,proposer_id")
    .order("created_at", { ascending: false }).limit(8);
  if (error || !data?.length) {
    box.innerHTML = `<span class="muted2">Nothing yet.</span>`;
    return;
  }
  box.innerHTML = data.map((r) => {
    const g = T.catalog[r.give_item], w = T.catalog[r.receive_item];
    const mine = String(r.proposer_id) === String(T.me);
    const dir = mine ? "You offered" : "Offered to you:";
    return `<div class="qrow">
      <span class="pill s-${esc(r.status)}">${esc(r.status)}</span>
      <span>${dir} <b>${esc(g?.n || r.give_item)}</b> ⇄ <b>${esc(w?.n || r.receive_item)}</b></span>
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
