/* ============================================================
   CLUBVMK — Remy's Kitchen.

   The Discord picker can only page through a dropdown; here you get the whole
   common half of your collection with search, type filter, sort and a
   duplicates-only toggle, so filling the pot takes seconds.

   Cooking itself stays on the bot: this page inserts a `cook_requests` row
   (see webportal/schema_remy.sql) and polls it. The bot re-checks ownership
   against its own database, takes the commons, rolls the reward on the bot's
   odds and announces it in Discord — the portal never moves an item.
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const $ = (s) => document.querySelector(s);
const NEED = CFG.REMY_NEED || 3;
const PER = 60;                       // items per page in the picker
const UPGRADE_LINE = {
  rare: "✨ A pinch of something special!",
  epic: "🌟 Remy outdid himself!",
  legendary: "🏆 A five-star masterpiece!",
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const imgUrl = (f) => CFG.ITEM_IMG_BASE + f;
const baseItemId = (id) => (id.includes("*") ? id.slice(0, id.lastIndexOf("*")) : id);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Item names are full of punctuation ("Room Pin - Oogie's Lair"), so a plain
// substring match fails on what people actually type ("oogie lair"). Strip it
// out and require every word, in any order.
const normName = (s) => String(s ?? "").toLowerCase()
  .replace(/[‘’'`´]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
function nameMatches(name, query) {
  const terms = normName(query).split(" ").filter(Boolean);
  if (!terms.length) return true;
  const hay = normName(name);
  return terms.every((t) => hay.includes(t));
}

const R = {
  me: null,
  catalog: {},
  guilds: [],            // [guild_id]
  guildNames: {},
  guild: null,
  inv: {},               // item_id -> count, current guild
  pot: [],               // chosen item_ids (length <= NEED)
  page: 0, q: "", cat: "all", sort: "copies_desc", dupOnly: false,
  busy: false,
};

let toastT;
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 3800);
}

// PostgREST silently caps a response at 1000 rows, so a big collection has to
// be paged — without a stable order, paging skips and repeats rows.
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

function discordIdFromSession(session) {
  const u = session?.user; if (!u) return null;
  const m = u.user_metadata || {};
  const ident = (u.identities || []).find((i) => i.provider === "discord") || {};
  return m.provider_id || m.sub || ident.id || ident.identity_data?.provider_id || null;
}

/* ---------- catalogue (names + live rarities, same source as the bot) ------ */
async function loadCatalog() {
  const cat = await fetch("data/catalog.min.json", { cache: "no-cache" }).then((r) => r.json());
  for (const it of cat) R.catalog[it.id] = it;
  // rarity comes from the curator's overrides table, never the baked value —
  // otherwise the portal would offer items the bot doesn't think are common
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
    for (const id in R.catalog) R.catalog[id].r = map[baseItemId(id)] || "common";
  } catch (e) { console.warn("overrides load failed:", e.message); }
}

/* ---------- inventory ---------- */
async function loadInv() {
  const { data, error } = await fetchAllRows("player_items", "guild_id,item_id,count",
    (q) => q.gt("count", 0));
  if (error) { toast("Couldn't load your items: " + error.message, true); return; }
  R.guilds = [...new Set((data || []).map((r) => r.guild_id))];
  if (!R.guilds.length) {
    $("#panel").innerHTML = `<h1>🐀 Remy's Kitchen</h1>
      <p class="lede">No collection found yet — catch a few items in Discord first,
      then come back and cook the spares.</p>`;
    return;
  }
  if (!R.guild || !R.guilds.includes(R.guild)) R.guild = R.guilds[0];
  try {
    const { data: gn } = await sb.from("profiles").select("guild_id,guild_name");
    for (const r of gn || []) if (r.guild_name) R.guildNames[r.guild_id] = r.guild_name;
  } catch (e) { /* guild_name column may not exist yet — ids are a fine fallback */ }
  R.inv = {};
  for (const r of data) if (r.guild_id === R.guild) R.inv[r.item_id] = r.count;
  R.pot = [];
  renderGuilds();
  renderAll();
}

/* Everything cookable: commons the player owns, after search/type/dupe filters. */
function commons() {
  const out = [];
  for (const id in R.inv) {
    const it = R.catalog[id];
    if (!it || it.r !== "common") continue;
    if (R.dupOnly && R.inv[id] < 2) continue;
    if (R.cat !== "all" && it.c !== R.cat) continue;
    if (!nameMatches(it.n, R.q)) continue;
    out.push({ id, count: R.inv[id], it });
  }
  const byName = (a, b) => a.it.n.localeCompare(b.it.n);
  const sorts = {
    copies_desc: (a, b) => b.count - a.count || byName(a, b),
    copies_asc: (a, b) => a.count - b.count || byName(a, b),
    az: byName,
    za: (a, b) => byName(b, a),
  };
  return out.sort(sorts[R.sort] || sorts.copies_desc);
}

const potCount = (id) => R.pot.filter((x) => x === id).length;
const freeCount = (id) => (R.inv[id] || 0) - potCount(id);

/* ---------- render: guild picker ---------- */
function renderGuilds() {
  const row = $("#guildRow");
  if (R.guilds.length < 2) { row.innerHTML = ""; return; }
  const label = (g) => R.guildNames[g] || "Server " + g.slice(-4);
  row.innerHTML = `<span class="muted2" style="font-size:13px">Server:</span>
    <div class="rarity-filter">` + R.guilds.map((g) =>
      `<button data-c="${esc(g)}" class="${g === R.guild ? "on" : ""}">${esc(label(g))}</button>`)
      .join("") + `</div>`;
  row.querySelectorAll("button").forEach((b) => (b.onclick = () => {
    R.guild = b.dataset.c; R.page = 0; loadInv();
  }));
}

/* ---------- render: the pot ---------- */
function renderPot() {
  const slots = $("#potSlots");
  if (!slots) return;   // mid-cook the pot is replaced by the sizzling pan
  slots.innerHTML = "";
  for (let i = 0; i < NEED; i++) {
    const id = R.pot[i];
    const el = document.createElement("div");
    el.className = "slot" + (id ? " full" : "");
    if (id) {
      const it = R.catalog[id];
      el.innerHTML = `<img src="${imgUrl(it.img)}" alt="${esc(it.n)}" loading="lazy" />
        <span class="x">✕</span>`;
      el.title = "Remove " + it.n;
      el.onclick = () => { R.pot.splice(i, 1); renderAll(); };
    } else {
      el.textContent = "+";
    }
    slots.appendChild(el);
  }
  const counts = {};
  for (const id of R.pot) counts[id] = (counts[id] || 0) + 1;
  $("#potNames").innerHTML = R.pot.length
    ? Object.entries(counts).map(([id, n]) =>
        `${esc(R.catalog[id]?.n || id)}${n > 1 ? ` ×${n}` : ""}`).join(" · ")
    : `<span class="muted2">The pot is empty.</span>`;
  const btn = $("#cookBtn");
  btn.disabled = R.busy || R.pot.length !== NEED;
  btn.textContent = R.busy ? "🍳 Cooking…"
    : R.pot.length === NEED ? "🍳 Cook!" : `🍳 Cook! (${R.pot.length}/${NEED})`;
}

/* ---------- render: the picker grid ---------- */
function renderGrid() {
  const all = commons();
  const owned = Object.entries(R.inv)
    .filter(([id]) => R.catalog[id]?.r === "common")
    .reduce((n, [, c]) => n + c, 0);
  $("#commonCount").textContent = `${owned} in stock`;
  $("#dupWrap").className = "toggle" + (R.dupOnly ? " on" : "");

  const grid = $("#grid");
  if (!all.length) {
    grid.innerHTML = `<div class="empty-inv">${
      owned ? "No commons match those filters." : "No commons to cook right now."}</div>`;
    $("#pager").innerHTML = "";
    return;
  }
  const pages = Math.ceil(all.length / PER);
  R.page = Math.min(R.page, pages - 1);
  const slice = all.slice(R.page * PER, R.page * PER + PER);
  grid.innerHTML = slice.map((r) => {
    const inPot = potCount(r.id);
    const free = r.count - inPot;
    return `<div class="inv-item${free <= 0 ? " maxed" : ""}" data-r="common" data-id="${esc(r.id)}">
      <span class="ct${r.count > 1 ? " dup" : ""}">×${r.count}</span>
      ${inPot ? `<span class="inpot">in pot ${inPot}</span>` : ""}
      <img loading="lazy" src="${imgUrl(r.it.img)}" alt="" />
      <div class="nm">${esc(r.it.n)}</div>
      <span class="add">${free > 0 ? "+ Add to pot" : "none free"}</span>
    </div>`;
  }).join("");
  grid.querySelectorAll(".inv-item").forEach((el) => {
    el.onclick = () => addToPot(el.dataset.id);
  });
  $("#pager").innerHTML = pages > 1
    ? `<button id="pp" ${R.page === 0 ? "disabled" : ""}>◀</button>
       <span>${R.page + 1} / ${pages} · ${all.length} kinds</span>
       <button id="pn" ${R.page >= pages - 1 ? "disabled" : ""}>▶</button>` : "";
  if (pages > 1) {
    $("#pp").onclick = () => { R.page--; renderGrid(); };
    $("#pn").onclick = () => { R.page++; renderGrid(); };
  }
}

function renderAll() { renderPot(); renderGrid(); }

function addToPot(id) {
  if (R.busy) return;
  if (R.pot.length >= NEED) return toast("The pot's already full — hit Cook!", true);
  if (freeCount(id) <= 0) return toast("You've no more of that one free.", true);
  R.pot.push(id);
  renderAll();
}

/* ---------- cooking ---------- */
async function cook() {
  if (R.busy || R.pot.length !== NEED) return;
  const counts = {};
  for (const id of R.pot) counts[id] = (counts[id] || 0) + 1;
  const items = Object.entries(counts).map(([item_id, count]) => ({ item_id, count }));
  R.busy = true;
  renderPot();
  $("#potBody").innerHTML = `<div class="cooking"><span class="pan">🍳</span>
    Remy's cooking… the bot is working the pan.</div>`;

  const { data, error } = await sb.from("cook_requests")
    .insert({ discord_id: String(R.me), guild_id: String(R.guild), items })
    .select("id").single();
  if (error) {
    R.busy = false;
    restorePot();
    if (/does not exist|schema cache/i.test(error.message)) return showSetupNote();
    return toast("Couldn't send that to the kitchen: " + error.message, true);
  }

  // poll the row — the bot picks it up within ~6s
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const { data: row } = await sb.from("cook_requests")
      .select("status,result,gained_item,gained_rarity").eq("id", data.id).single();
    if (!row || row.status === "pending") continue;
    R.busy = false;
    if (row.status === "error") {
      restorePot();
      toast(row.result || "The cook failed.", true);
      loadRecent();
      return;
    }
    // the bot has already taken the commons and handed over the reward; keep
    // our copy in step rather than waiting up to 45s for the next mirror sync
    for (const id of R.pot) R.inv[id] = Math.max(0, (R.inv[id] || 0) - 1);
    for (const id in R.inv) if (!R.inv[id]) delete R.inv[id];
    if (row.gained_item) R.inv[row.gained_item] = (R.inv[row.gained_item] || 0) + 1;
    R.pot = [];
    showResult(row);
    loadRecent();
    return;
  }
  // never resolved: the bot is probably down. Leave the pot alone — nothing was
  // taken unless the request actually ran.
  R.busy = false;
  restorePot();
  toast("The kitchen hasn't answered — is the bot running? Check back in a moment.", true);
  loadRecent();
}

function restorePot() {
  $("#potBody").innerHTML = `<div class="pot" id="potSlots"></div>
    <p class="potnames" id="potNames"></p>
    <button class="btn gold cookbtn" id="cookBtn">🍳 Cook!</button>`;
  $("#cookBtn").onclick = cook;
  renderAll();
}

function showResult(row) {
  const it = R.catalog[row.gained_item];
  const rar = row.gained_rarity || it?.r || "uncommon";
  const up = UPGRADE_LINE[rar];
  $("#potBody").innerHTML = `
    <div class="result pop">
      ${it ? `<img src="${imgUrl(it.img)}" alt="" />` : ""}
      ${up ? `<p class="up">${esc(up)}</p>` : ""}
      <div class="nm">${esc(it?.n || row.gained_item)}</div>
      <div class="rr r-${esc(rar)}">${esc(cap(rar))}</div>
      <p class="muted2" style="font-size:12.5px;margin:12px 0 14px">
        It's in your collection — and posted in Discord.</p>
      <button class="btn gold cookbtn" id="againBtn">🍲 Cook another</button>
    </div>`;
  $("#againBtn").onclick = restorePot;
  renderGrid();
}

function showSetupNote() {
  const n = $("#setupNote");
  n.classList.remove("hidden");
  n.innerHTML = `Remy's kitchen isn't set up in Supabase yet — run
    <code>webportal/schema_remy.sql</code> in the SQL editor, then reload.`;
}

/* ---------- recent cooks ---------- */
async function loadRecent() {
  const box = $("#recent");
  const { data, error } = await sb.from("cook_requests")
    .select("status,result,gained_item,gained_rarity,created_at")
    .order("created_at", { ascending: false }).limit(8);
  if (error) { if (/does not exist|schema cache/i.test(error.message)) showSetupNote(); return; }
  if (!data?.length) { box.innerHTML = `<span class="muted2">Nothing yet.</span>`; return; }
  box.innerHTML = data.map((r) => {
    const it = R.catalog[r.gained_item];
    const rar = r.gained_rarity || "";
    const what = r.status === "done"
      ? `Cooked up <b class="r-${esc(rar)}">${esc(it?.n || r.gained_item || "an item")}</b>`
      : esc(r.result || cap(r.status));
    return `<div class="qrow">
      <span class="pill s-${esc(r.status)}">${esc(r.status)}</span>
      <span>${what}</span>
      <span class="when">${esc(new Date(r.created_at).toLocaleString())}</span>
    </div>`;
  }).join("");
}

/* ---------- type filter ---------- */
function renderTypeFilter() {
  const cats = [...new Set(Object.keys(R.inv)
    .map((id) => R.catalog[id]).filter((it) => it && it.r === "common")
    .map((it) => it.c).filter(Boolean))].sort();
  const label = { pin: "Pins", clothing: "Clothing" };
  $("#typeFilter").innerHTML = ["all", ...cats].map((c) =>
    `<button data-c="${c}" class="${c === R.cat ? "on" : ""}">${
      c === "all" ? "All types" : (label[c] || cap(c))}</button>`).join("");
  $("#typeFilter").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    R.cat = b.dataset.c; R.page = 0; renderTypeFilter(); renderGrid();
  }));
}

/* ---------- boot ---------- */
async function render(session) {
  R.me = discordIdFromSession(session);
  $("#signInBtn").classList.toggle("hidden", !!session);
  $("#signOutBtn").classList.toggle("hidden", !session);
  if (!session) {
    $("#gate").classList.remove("hidden"); $("#panel").classList.add("hidden");
    return;
  }
  $("#gate").classList.add("hidden"); $("#panel").classList.remove("hidden");
  $("#needN").textContent = String(NEED);
  await loadInv();
  renderTypeFilter();
  loadRecent();
}

async function boot() {
  $("#signInBtn").onclick = () => sb.auth.signInWithOAuth({
    provider: "discord",
    options: { redirectTo: location.href.split("#")[0], scopes: "identify" },
  });
  $("#signOutBtn").onclick = async () => { await sb.auth.signOut(); location.reload(); };
  $("#cookBtn").onclick = cook;
  let timer;
  $("#q").oninput = (e) => {
    R.q = e.target.value; R.page = 0;
    clearTimeout(timer); timer = setTimeout(renderGrid, 120);
  };
  $("#sort").onchange = (e) => { R.sort = e.target.value; R.page = 0; renderGrid(); };
  $("#dupOnly").onchange = (e) => { R.dupOnly = e.target.checked; R.page = 0; renderGrid(); };
  await loadCatalog();
  sb.auth.onAuthStateChange((_e, s) => render(s));
  const { data } = await sb.auth.getSession();
  render(data.session);
}
boot().catch((e) => { console.error(e); $("#gateMsg").textContent = "Load error: " + e.message; });
