/* ============================================================
   CLUBVMK Collector's Vault — portal logic
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const RARITY = ["legendary", "epic", "rare", "uncommon", "common"];
// Card layouts — keep in sync with bot.CARD_LAYOUTS. `max` drives the showcase
// slot count, so the picker below changes how many items you can feature.
const CARD_LAYOUTS = {
  classic: { label: "Classic", max: 8,  blurb: "8 items, with their names", cost: 0 },
  gallery: { label: "Gallery", max: 15, blurb: "15 items, pictures only", cost: 25 },
};
const DEFAULT_CARD_LAYOUT = "classic";
// Selecting nothing is allowed and means "give all that room to the showcase".
// Stored as ["none"] because an empty list has always meant "show everything".
const CARD_STATS_NONE = "none";
// Highlights that can be shown or hidden on the card (bot.CARD_HIGHLIGHTS).
const CARD_HIGHLIGHTS = [
  ["total", "Total items"], ["unique", "Unique items"], ["catches", "Catches"],
  ["yeti", "Yeti Credits"], ["club", "Club Coins"], ["fastest", "Fastest grab"],
  ["rarity", "Rarity breakdown"],
];
// How many showcase slots the current draft has.
const featMax = () =>
  (CARD_LAYOUTS[S.draft?.card_layout] || CARD_LAYOUTS[DEFAULT_CARD_LAYOUT]).max;
const FEATURED_PER_ROW = 4;    // slots per row, matching the rendered card's grid
const $ = (s) => document.querySelector(s);

// Combined Magics carry a "*<stars>" suffix; everything about them (rarity,
// artwork family) derives from the base pin.
const baseItemId = (id) => (id.includes("*") ? id.slice(0, id.lastIndexOf("*")) : id);

// Stand-in for an item the catalogue doesn't know (stale cache, brand-new item).
// Falls back to the base pin's art where it can, so combined Magics still look right.
function unknownItem(id) {
  const base = S.catalog[baseItemId(id)];
  const stars = itemStars(id);
  return { n: (stars > 1 ? `${stars}★ ` : "") + (base ? base.n : id),
           r: base ? base.r : "common",
           c: base ? base.c : "pin", img: base ? base.img : "" };
}

// Anything the player can actually show off. The bot's CATALOG contains the
// starred Magic variants (it generates them at runtime); catalog.min.json does
// NOT, so gating the showcase on the catalogue alone silently refused every
// combined Magic. Ownership is the real test — art and name fall back to the
// base pin.
const showableItem = (id) => S.catalog[id] || (ownedCount(id) > 0 ? unknownItem(id) : null);
const itemStars = (id) => (id.includes("*") ? Number(id.slice(id.lastIndexOf("*") + 1)) || 1 : 1);

// How many copies of an item the player holds. An item may take more than one
// showcase slot, but never more slots than they own copies.
const ownedCount = (id) => S.inv.find((r) => r.item_id === id)?.count || 0;
const featCount = (id) => S.draft.featured.filter((x) => x === id).length;

// Mirror of the bot's clamp_featured(): drop unknown/unowned ids, allow a
// duplicate only up to the number of copies held, then cap at the layout's max.
function clampFeatured(feat) {
  const out = [], used = {};
  for (const id of Array.isArray(feat) ? feat : []) {
    const n = used[id] || 0;
    if (!showableItem(id) || n >= ownedCount(id)) continue;
    out.push(id); used[id] = n + 1;
    if (out.length >= featMax()) break;
  }
  return out;
}

const S = {
  user: null, discordId: null, name: "Collector", avatar: null,
  guilds: [], guild: null,
  catalog: {},           // id -> {n,r,c,img}
  themes: {},            // id -> theme def
  inv: [],               // [{item_id,count}] for current guild
  // editable profile draft:
  draft: { theme: CFG.DEFAULT_THEME, accent_color: null, featured: [], bio: "" },
  saved: null,           // JSON snapshot of last-saved draft
  invPage: 0, invSearch: "", invRarity: "all", invCat: "all", invSort: "rarity_desc",
  invDupes: false,       // show only stacks you hold 2+ of
};
const PER = 24;

/* ---------- themes (admin-managed via the `themes` table, JSON fallback) ---------- */
function dbThemeToDef(r) {
  const t = { name: r.name, bg: r.bg, panel: r.panel, accent: r.accent, fx: r.fx || null };
  if (r.grad) t.grad = r.grad;
  if (r.dim != null) t.dim = r.dim;
  if (r.image_name) t.image = `${CFG.SUPABASE_URL}/storage/v1/object/public/theme-images/${r.image_name}`;
  const u = { type: r.unlock_type || "club" };
  if ((u.type === "club" || u.type === "buy") && r.cost != null) u.cost = r.cost;
  if (u.type === "total" && r.unlock_value != null) u.value = r.unlock_value;
  if (u.type === "rarity") { if (r.unlock_tier) u.tier = r.unlock_tier; if (r.unlock_value != null) u.value = r.unlock_value; }
  t.unlock = u;
  return t;
}
async function loadThemes() {
  try {
    const { data, error } = await sb.from("themes").select("*").eq("enabled", true).order("sort");
    if (error || !data || !data.length) throw error || new Error("no themes rows");
    const out = {};
    for (const r of data) out[r.id] = dbThemeToDef(r);
    return out;
  } catch (e) {
    return fetch("data/themes.json").then((r) => r.json());  // fallback to the baked catalogue
  }
}

/* ---------- boot ---------- */
async function boot() {
  const [cat, thm, ttl] = await Promise.all([
    // no-cache = revalidate with the server (cheap, ETag). Without it a browser
    // holding an older catalogue silently hides any newly-added item — combined
    // Magics vanished from inventories this way.
    fetch("data/catalog.min.json", { cache: "no-cache" }).then((r) => r.json()),
    loadThemes(),
    fetch("data/titles.json").then((r) => r.json()).catch(() => ({ levels: {}, totals: [] })),
  ]);
  for (const it of cat) S.catalog[it.id] = it;
  S.themes = thm;
  S.titles = ttl;
  await applyRarityOverrides();
  // after the overrides: custom items aren't in that table, and its
  // "not listed means common" rule would flatten every one of them
  await window.mergeCustomItems(sb, S.catalog);

  $("#signInBtn").onclick = signIn;
  document.addEventListener("click", (e) => { if (!e.target.closest("#ctxMenu")) hideCtxMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideCtxMenu(); });
  window.addEventListener("scroll", hideCtxMenu, true);
  sb.auth.onAuthStateChange((_e, session) => render(session));
  const { data } = await sb.auth.getSession();
  render(data.session);
}

// Apply the same rarity overrides the bot uses, from the curator's `overrides`
// table, so the portal shows identical rarities/colours/counts to Discord.
async function applyRarityOverrides() {
  // The overrides table is the SINGLE source of truth for rarity (same as the bot):
  // every item defaults to common, then the table sets the rest. The baked rarity
  // in catalog.min.json is ignored so the portal can never disagree with the game.
  try {
    const map = {};
    let from = 0; const page = 1000;
    for (;;) {
      const { data, error } = await sb.from("overrides").select("item_id,tier").order("item_id").range(from, from + page - 1);
      if (error) throw error;
      for (const o of data || []) map[o.item_id] = o.tier;
      if (!data || data.length < page) break;
      from += page;
    }
    // A combined Magic ("pin:3703*5") inherits its base pin's rarity — the
    // overrides table only ever lists base ids.
    // curated wins; unjudged keeps its baked rarity ("hold" for a fresh import)
    for (const id in S.catalog)
      S.catalog[id].r = map[baseItemId(id)] || S.catalog[id].r || "common";
  } catch (e) { console.warn("overrides load failed — keeping baked rarities as fallback:", e.message); }
}

async function signIn() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "discord",
    options: { redirectTo: window.location.href.split("#")[0], scopes: "identify" },
  });
  if (error) toast(error.message, true);
}
async function signOut() { await sb.auth.signOut(); location.reload(); }

/* ---------- render top-level state ---------- */
async function render(session) {
  if (!session) return showLanding();
  S.user = session.user;
  const m = S.user.user_metadata || {};
  const ident = (S.user.identities || []).find((i) => i.provider === "discord") || {};
  S.discordId = m.provider_id || m.sub || ident.id || ident.identity_data?.provider_id || ident.identity_data?.sub;
  S.name = m.global_name || m.full_name || m.name || m.custom_claims?.global_name || "Collector";
  S.avatar = m.avatar_url || m.picture || ident.identity_data?.avatar_url || ident.identity_data?.picture || null;

  $("#authSlot").innerHTML =
    `<a class="btn ghost tiny" href="remy.html">🐀 Remy's Kitchen</a>
     <a class="btn ghost tiny" href="trade.html">🔄 Trading Post</a>
     <div class="who">${S.avatar ? `<img src="${S.avatar}" alt="">` : ""}<b>${esc(S.name)}</b>
     <button class="out" id="outBtn">Sign out</button></div>`;
  $("#outBtn").onclick = signOut;

  $("#landing").classList.add("hidden");
  $("#app").classList.remove("hidden");
  await loadData();
}

function showLanding() {
  $("#app").classList.add("hidden");
  $("#landing").classList.remove("hidden");
  $("#authSlot").innerHTML = "";
}

/* ---------- load player data ---------- */
// PostgREST caps a single response (1000 rows by default), and it does NOT tell
// you the result was truncated. A big collection silently lost everything past
// the cap — items were in the database and visible in Discord but simply never
// reached the page. Always page through with a stable order: without ORDER BY,
// paging can skip and repeat rows.
async function fetchAllRows(table, columns, order) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(columns)
      .order(order).range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    out.push(...(data || []));
    if (!data || data.length < PAGE) return { data: out, error: null };
  }
}

async function loadData() {
  // which guild(s) does this player have data in?
  const { data: rows, error } = await fetchAllRows(
    "player_items", "guild_id,item_id,count", "item_id");
  if (error) {
    if (/relation|does not exist/i.test(error.message))
      return notReady("The database isn't set up yet — run schema.sql in Supabase.");
    return notReady(error.message);
  }
  S.guilds = [...new Set((rows || []).map((r) => r.guild_id))];
  if (!S.guilds.length) return notReady(
    "No inventory has synced for your account yet. Once the bot's sync is live, your items will appear here.");

  S.guild = S.guild && S.guilds.includes(S.guild) ? S.guild : S.guilds[0];
  // Server names come only from YOUR own profiles rows (RLS-scoped) — never a
  // public list. If the guild_name column doesn't exist yet, labels fall back.
  S.guildNames = {};
  try {
    const { data: gn } = await sb.from("profiles").select("guild_id,guild_name");
    for (const r of gn || []) if (r.guild_name) S.guildNames[r.guild_id] = r.guild_name;
  } catch { /* column not added yet — use fallback labels */ }
  renderGuildBar();
  S.inv = rows.filter((r) => r.guild_id === S.guild).map((r) => ({ item_id: r.item_id, count: r.count }));

  // existing saved profile for this guild
  const { data: prof } = await sb.from("profiles").select("*").eq("guild_id", S.guild).maybeSingle();
  // does the profiles table have the hidden_titles column yet? (gates the titles feature)
  try { const { error } = await sb.from("profiles").select("hidden_titles").limit(1); S.hasHidden = !error; }
  catch (e) { S.hasHidden = false; }
  try { const { error } = await sb.from("profiles").select("card_layout").limit(1); S.hasCard = !error; }
  catch (e) { S.hasCard = false; }
  S.layoutsOwned = Array.isArray(prof?.layouts_owned) ? prof.layouts_owned : [];
  S.draft = {
    theme: prof?.theme || CFG.DEFAULT_THEME,
    accent_color: prof?.accent_color || null,
    card_layout: CARD_LAYOUTS[prof?.card_layout] ? prof.card_layout : DEFAULT_CARD_LAYOUT,
    // stored empty = show everything, which is what an untouched card does
    card_stats: !Array.isArray(prof?.card_stats) || !prof.card_stats.length
      ? CARD_HIGHLIGHTS.map(([k]) => k)                       // unset = show everything
      : (prof.card_stats.includes(CARD_STATS_NONE) ? [] : prof.card_stats.slice()),
    featured: [],
    bio: prof?.bio || "",
    hidden_titles: Array.isArray(prof?.hidden_titles) ? prof.hidden_titles.slice() : [],
  };
  // clamped after the draft exists, since the cap depends on the chosen layout
  S.draft.featured = clampFeatured(prof?.featured);
  S.saved = JSON.stringify(S.draft);
  // unlock state (mirrored from the bot): purchased/granted themes + inventory stats
  S.themesOwned = Array.isArray(prof?.themes_owned) ? prof.themes_owned : [];
  // supporter perk flag, mirrored from the bot; null/undefined until it syncs = locked
  S.mybgAllowed = !!prof?.mybg_allowed;
  S.totalItems = S.inv.reduce((n, r) => n + r.count, 0);
  S.byTier = {};
  for (const r of S.inv) { const it = S.catalog[baseItemId(r.item_id)]; if (it) S.byTier[it.r] = (S.byTier[it.r] || 0) + r.count; }
  wireEditor();
  renderAll();
  doRender(true);   // show the real, true-size card straight away
}

// Mirror of the bot's theme_available(): is this theme unlocked for this player?
function themeUnlocked(id, t) {
  const u = t.unlock || {};
  if (S.themesOwned.includes(id)) return true;
  if (u.type === "default") return true;
  if (u.type === "total") return S.totalItems >= u.value;
  if (u.type === "rarity") return (S.byTier[u.tier] || 0) >= u.value;
  return false;   // buy/club themes require purchase (themes_owned) in Discord
}

function notReady(msg) {
  $("#guildBar").classList.add("hidden");
  $("#cardPreview").innerHTML = `<div class="empty">${esc(msg)}</div>`;
  $(".stack").innerHTML = `<div class="panel"><p class="hint" style="font-size:14px">${esc(msg)}</p></div>`;
}

function renderGuildBar() {
  const bar = $("#guildBar");
  if (S.guilds.length < 2) return bar.classList.add("hidden");
  bar.classList.remove("hidden");
  const label = (g) => (S.guildNames && S.guildNames[g]) || "Server " + g.slice(-4);
  bar.innerHTML = `<span>Server:</span>` + S.guilds.map((g) =>
    `<button data-g="${g}" class="${g === S.guild ? "on" : ""}">${esc(label(g))}</button>`).join("");
  bar.querySelectorAll("button").forEach((b) => b.onclick = () => { S.guild = b.dataset.g; loadData(); });
}

/* ---------- editor wiring ---------- */
function wireEditor() {
  const bio = $("#bioInput"); bio.value = S.draft.bio;
  bio.oninput = () => { S.draft.bio = bio.value; touch(); renderPreview(); };
  const col = $("#colorInput");
  col.value = S.draft.accent_color || rgbHex(S.themes[S.draft.theme]?.accent || [61, 139, 253]);
  col.oninput = () => { S.draft.accent_color = col.value; touch(); renderPreview(); };
  $("#colorReset").onclick = () => {
    S.draft.accent_color = null;
    // snap the swatch back to the theme's own accent, otherwise it keeps showing
    // the cleared colour and the button looks like it did nothing
    col.value = rgbHex(S.themes[S.draft.theme]?.accent || [61, 139, 253]);
    touch(); renderAll();
  };
  $("#saveBtn").onclick = save;
  $("#renderBtn").onclick = () => doRender(false);
  $("#invSearch").oninput = (e) => { S.invSearch = e.target.value.toLowerCase(); S.invPage = 0; renderInv(); };
  const sort = $("#invSort"); sort.value = S.invSort;
  sort.onchange = (e) => { S.invSort = e.target.value; S.invPage = 0; renderInv(); };
  const dup = $("#invDupes");
  dup.checked = S.invDupes;
  dup.onchange = (e) => { S.invDupes = e.target.checked; S.invPage = 0; renderInv(); };
}

/* ---------- render everything ---------- */
function renderAll() { renderThemes(); renderMyBg(); renderCardStyle(); renderTitles(); renderFeatured(); renderRarityFilter(); renderInv(); renderCombine(); renderPreview(); syncSaveState(); }

/* ============================================================
   Magic combining — a straight port of the bot's plan_combine().

   A Magic is a PIN whose name starts with "Magic - " (the clothing "Magic - …"
   items aren't combinable, exactly as is_magic() has it). Fusing spends the
   pieces, so the plan prefers spending the LOWEST-starred copies and already-
   combined items survive where they can. The portal only ever queues the
   request — combine_requests, drained by the bot, which re-checks everything.
   ============================================================ */
const STAR_MAX = 5;
const isMagic = (it) => it && it.c === "pin" && (it.n || "").startsWith("Magic - ");
const starLabel = (n) => (n <= 1 ? "plain" : `${n}★`);

// Python compares tuples element-by-element; JS `<` on arrays compares them as
// STRINGS, which picks a different plan. Compare numerically, explicitly.
function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

// counts: {stars: available} -> {stars: used} landing exactly on `target`, or
// null. Same lexicographic preference as the bot: maximise plain copies spent.
function planCombine(counts, target) {
  let best = null;
  const used = {};
  (function rec(star, left) {
    if (left === 0) {
      if (Object.values(used).reduce((a, b) => a + b, 0) < 2) return;  // no self-fusing
      const key = [];
      for (let s = 1; s <= STAR_MAX; s++) key.push(-(used[s] || 0));
      if (!best || cmpKey(key, best.key) < 0) best = { key, plan: { ...used } };
      return;
    }
    if (star > STAR_MAX || left < 0) return;
    const most = Math.min(counts[star] || 0, Math.floor(left / star));
    for (let n = most; n >= 0; n--) {
      if (n) used[star] = n;
      rec(star + 1, left - star * n);
      delete used[star];
    }
  })(1, target);
  return best ? best.plan : null;
}

const combinableTargets = (counts) => {
  const out = [];
  for (let t = 2; t <= STAR_MAX; t++) if (planCombine(counts, t)) out.push(t);
  return out;
};

/* {base_id: {stars: count}} for every Magic pin the player holds. */
function magicHoldings() {
  const out = {};
  for (const r of S.inv) {
    const base = S.catalog[baseItemId(r.item_id)];
    if (!isMagic(base)) continue;
    const n = itemStars(r.item_id);
    (out[baseItemId(r.item_id)] ||= {})[n] = (out[baseItemId(r.item_id)][n] || 0) + r.count;
  }
  return out;
}

const describePlan = (plan) => Object.keys(plan).map(Number).sort((a, b) => a - b)
  .map((s) => `${plan[s]}× ${starLabel(s)}`).join(" + ");

function renderCombine() {
  const box = $("#combineList");
  if (!box) return;
  const holdings = magicHoldings();
  const rows = Object.entries(holdings)
    .map(([baseId, counts]) => ({ baseId, counts, targets: combinableTargets(counts) }))
    .filter((r) => r.targets.length)
    .sort((a, b) => (S.catalog[a.baseId]?.n || "").localeCompare(S.catalog[b.baseId]?.n || ""));

  const owned = Object.keys(holdings).length;
  $("#combineCount").textContent = rows.length
    ? `${rows.length} ready` : owned ? `${owned} Magic${owned === 1 ? "" : "s"} held` : "";
  if (!rows.length) {
    box.innerHTML = `<p class="combine-empty">${owned
      ? "None of your Magics can be fused yet — you need at least two pieces of the same one that add up to 5★ or less."
      : "You have no Magic pins yet. They're pins named <b>Magic - …</b> — collect duplicates of one, then fuse them here."}</p>`;
    return;
  }
  box.innerHTML = "";
  for (const r of rows) {
    const base = S.catalog[r.baseId] || unknownItem(r.baseId);
    const have = Object.keys(r.counts).map(Number).sort((a, b) => a - b)
      .map((s) => `${r.counts[s]}× ${starLabel(s)}`).join(", ");
    const el = document.createElement("div");
    el.className = "combine-row";
    el.innerHTML = `<img src="${imgUrl(base.img)}" alt="" loading="lazy" />
      <span><span class="who">${esc(base.n)}</span>
        <span class="have">You hold ${esc(have)}</span></span>
      <span class="acts">
        <select>${r.targets.map((t) =>
          `<option value="${t}"${t === r.targets[r.targets.length - 1] ? " selected" : ""}
            >Make ${t}★</option>`).join("")}</select>
        <button class="btn tiny gold">✨ Combine</button>
      </span>`;
    const sel = el.querySelector("select"), btn = el.querySelector("button");
    btn.onclick = () => confirmCombine(r.baseId, Number(sel.value), r.counts);
    box.appendChild(el);
  }
}

/* Fusing is destructive and irreversible, so it always asks — showing exactly
   which pieces get spent, the same line the bot's confirm shows. */
function confirmCombine(baseId, target, counts) {
  const base = S.catalog[baseId] || unknownItem(baseId);
  const plan = planCombine(counts, target);
  if (!plan) return toast("Those pieces don't add up any more — reload.", true);
  const wrap = document.createElement("div");
  wrap.className = "modal-wrap";
  wrap.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm combine">
      <img src="${imgUrl(base.img)}" alt="" />
      <h3>Combine into <span class="stars">${"⭐".repeat(target)}</span> ${esc(base.n)}?</h3>
      <p class="why">This spends <b>${esc(describePlan(plan))}</b> and gives you
        <b>one ${starLabel(target)}</b> Magic.<br><b>It can't be undone.</b></p>
      <div class="acts">
        <button class="btn ghost" id="cNo">Cancel</button>
        <button class="btn gold" id="cYes">✨ Combine</button>
      </div>
    </div>`;
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  document.body.appendChild(wrap);
  document.addEventListener("keydown", onKey);
  wrap.querySelector("#cNo").onclick = close;
  wrap.querySelector("#cYes").onclick = () => { close(); doCombine(baseId, target, plan); };
}

async function doCombine(baseId, target, plan) {
  toast("✨ Sending it to the bot…");
  const { data, error } = await sb.from("combine_requests")
    .insert({ discord_id: String(S.discordId), guild_id: String(S.guild),
              base_id: baseId, target })
    .select("id").single();
  if (error) {
    return toast(/does not exist|schema cache/i.test(error.message)
      ? "Combining isn't set up in Supabase yet — run webportal/schema_combine.sql."
      : "Couldn't queue that: " + error.message, true);
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const { data: row } = await sb.from("combine_requests")
      .select("status,result,gained_item").eq("id", data.id).single();
    if (!row || row.status === "pending") continue;
    if (row.status === "error") return toast(row.result || "The combine failed.", true);
    // the bot has already moved the items; keep our copy in step rather than
    // waiting up to 45s for the next mirror sync
    for (const s of Object.keys(plan)) {
      const id = Number(s) <= 1 ? baseId : `${baseId}*${s}`;
      const row_ = S.inv.find((x) => x.item_id === id);
      if (row_) row_.count -= plan[s];
    }
    S.inv = S.inv.filter((x) => x.count > 0);
    const gained = row.gained_item || `${baseId}*${target}`;
    const have = S.inv.find((x) => x.item_id === gained);
    if (have) have.count++; else S.inv.push({ item_id: gained, count: 1 });
    S.draft.featured = clampFeatured(S.draft.featured);   // a spent piece can't stay featured
    renderAll();
    return toast(`✨ Combined into a ${target}★ — posted in Discord!`);
  }
  toast("The bot hasn't answered yet — check back in a moment.", true);
}

/* ---------- level titles: pick which earned ones show on the card ---------- */
function earnedTitles() {
  const out = [];   // [{cat, title}] in card order — highest reached per tier, then total
  const lv = (S.titles && S.titles.levels) || {};
  for (const cat of Object.keys(lv)) {
    const cnt = S.byTier[cat] || 0;
    let best = null;
    for (const [thr, title] of lv[cat]) if (cnt >= thr) best = title;
    if (best) out.push({ cat, title: best });
  }
  let bestTotal = null;
  for (const [thr, title] of (S.titles?.totals || [])) if (S.totalItems >= thr) bestTotal = title;
  if (bestTotal) out.push({ cat: "total", title: bestTotal });
  return out;
}
/* ---------- card style: showcase layout + which highlights to draw ---------- */
// [] = show everything, ["none"] = show nothing, otherwise the exact subset.
function cardStatsWire() {
  const picked = S.draft.card_stats || [];
  if (!picked.length) return [CARD_STATS_NONE];
  if (picked.length === CARD_HIGHLIGHTS.length) return [];
  return picked;
}

function ownsLayout(key) {
  return !CARD_LAYOUTS[key].cost || (S.layoutsOwned || []).includes(key);
}

async function buyLayout(key) {
  const cost = CARD_LAYOUTS[key].cost;
  if (!confirm(`Unlock the ${CARD_LAYOUTS[key].label} card for ${cost} coins?

` +
               `Club Coins are spent first, Yeti Credits top up the rest.`)) return;
  const { error } = await sb.from("layout_purchases")
    .insert({ discord_id: S.discordId, guild_id: S.guild, layout: key });
  if (error) return toast("Couldn't ask for that: " + error.message, true);
  toast("Asking the bot to unlock it… this takes a few seconds.");
  // the bot charges the coins and writes layouts_owned back; pick it up shortly
  setTimeout(async () => {
    const { data } = await sb.from("profiles").select("layouts_owned,card_layout")
      .eq("guild_id", S.guild).maybeSingle();
    S.layoutsOwned = Array.isArray(data?.layouts_owned) ? data.layouts_owned : S.layoutsOwned;
    if (ownsLayout(key)) {
      S.draft.card_layout = key;
      S.saved = JSON.stringify(S.draft);      // the bot already stored it
      toast(`${CARD_LAYOUTS[key].label} unlocked! ✨`);
    } else {
      toast("That didn't go through — check you have enough coins.", true);
    }
    renderCardStyle(); renderFeatured(); renderPreview(); syncSaveState();
  }, 9000);
}

function renderCardStyle() {
  const panel = $("#cardPanel");
  if (panel) panel.style.display = S.hasCard ? "" : "none";
  if (!S.hasCard) return;
  const cur = S.draft.card_layout || DEFAULT_CARD_LAYOUT;
  const note = $("#cardNote");
  if (note) note.textContent = `${CARD_LAYOUTS[cur].label} · ${featMax()} slots`;

  const grid = $("#layoutGrid");
  if (grid) {
    grid.innerHTML = Object.entries(CARD_LAYOUTS).map(([key, l]) => {
      const owned = ownsLayout(key);
      const price = owned ? "" : `<span class="price">🪙 ${l.cost} to unlock</span>`;
      return `<button class="layout-opt${key === cur ? " on" : ""}${owned ? "" : " locked"}"
                data-k="${key}"><b>${l.label}</b><small>${l.blurb}</small>${price}</button>`;
    }).join("");
    grid.querySelectorAll(".layout-opt").forEach((b) => {
      b.onclick = () => {
        const key = b.dataset.k;
        if (!ownsLayout(key)) return buyLayout(key);
        S.draft.card_layout = key;
        // a smaller card can't hold as many, so trim to what it will actually show
        S.draft.featured = S.draft.featured.slice(0, featMax());
        touch(); renderCardStyle(); renderFeatured(); renderInv(); renderPreview();
      };
    });
  }

  const box = $("#highlightBox");
  if (box) {
    const on = new Set(S.draft.card_stats || []);
    box.innerHTML = CARD_HIGHLIGHTS.map(([k, label]) =>
      `<label class="title-chip"><input type="checkbox" data-h="${k}"${on.has(k) ? " checked" : ""}/>
        <span>${label}</span></label>`).join("");
    box.querySelectorAll("input[data-h]").forEach((cb) => {
      cb.onchange = () => {
        const k = cb.dataset.h;
        const set = new Set(S.draft.card_stats || []);
        cb.checked ? set.add(k) : set.delete(k);
        S.draft.card_stats = CARD_HIGHLIGHTS.map(([x]) => x).filter((x) => set.has(x));
        touch(); renderCardStyle(); renderPreview();
      };
    });
  }
  const fm = $("#featMaxNote");
  if (fm) fm.textContent = `up to ${featMax()}`;
}

function renderTitles() {
  const panel = $("#titlesPanel"); if (panel) panel.style.display = S.hasHidden ? "" : "none";
  const box = $("#titlesBox"); if (!box || !S.hasHidden) return;
  const earned = earnedTitles();
  const hidden = new Set(S.draft.hidden_titles || []);
  if (!earned.length) { box.innerHTML = `<span class="muted">No level titles earned yet — collect more to unlock them.</span>`; return; }
  const shown = earned.filter((e) => !hidden.has(e.cat)).length;
  $("#titlesNote").textContent = `${shown} of ${earned.length} shown · the card displays up to 4`;
  box.innerHTML = earned.map((e) => {
    const on = !hidden.has(e.cat);
    return `<button class="title-chip${on ? " on" : ""}" data-cat="${e.cat}">${on ? "✓" : "＋"} ${esc(e.title)}</button>`;
  }).join("");
  box.querySelectorAll(".title-chip").forEach((b) => b.onclick = () => {
    const cat = b.dataset.cat, h = new Set(S.draft.hidden_titles || []);
    if (h.has(cat)) h.delete(cat); else h.add(cat);
    S.draft.hidden_titles = [...h];
    touch(); renderTitles(); doRender(true);
  });
}

function renderThemes() {
  const g = $("#themeGrid"); g.innerHTML = "";
  const entries = Object.entries(S.themes);
  const nOwned = entries.filter(([id, t]) => themeUnlocked(id, t)).length;
  $("#themeCount").textContent = `${nOwned} of ${entries.length} unlocked`;
  for (const [id, t] of entries) {
    const unlocked = themeUnlocked(id, t);
    const cell = document.createElement("div");
    cell.className = "theme-cell" + (id === S.draft.theme ? " on" : "") + (unlocked ? "" : " locked");
    const bg = t.image ? `background-image:url('${t.image}')`
      : t.grad ? `background:linear-gradient(160deg,${rgb(t.grad[0])},${rgb(t.grad[1])})`
      : `background:${rgb(t.bg)}`;
    const u = t.unlock || {};
    let lock = "";
    if (!unlocked) {
      if (u.type === "club") lock = `🔒 🪙${u.cost}`;
      else if (u.type === "buy") lock = `🔒 ❄️${u.cost}`;
      else if (u.type === "total") lock = `🔒 ${u.value} items`;
      else if (u.type === "rarity") lock = `🔒 ${u.value} ${u.tier}`;
      else if (u.type === "supporter") lock = "🔒 ☕ supporters";
      else lock = "🔒";
    }
    cell.innerHTML = `<div class="tc-bg" style="${bg}"></div>` +
      (lock ? `<div class="tc-lock">${lock}</div>` : "") +
      `<div class="tc-name">${esc(t.name)}</div>`;
    cell.onclick = () => {
      if (!unlocked) return toast("🔒 Unlock this theme in Discord first (/theme).");
      S.draft.theme = id;
      if (!S.draft.accent_color) $("#colorInput").value = rgbHex(t.accent);
      touch(); renderThemes(); renderMyBg(); renderPreview();
    };
    g.appendChild(cell);
  }
  // The player's own uploaded background lives OUTSIDE the themes catalogue as
  // the pseudo-theme "custom" — the bot grants it via themes_owned when a
  // custom background is applied. Show it as a normal selectable tile then, so
  // the grid never breaks while S.draft.theme === "custom".
  if (S.themesOwned.includes("custom")) {
    const cell = document.createElement("div");
    cell.className = "theme-cell" + (S.draft.theme === "custom" ? " on" : "");
    cell.innerHTML = `<div class="tc-bg" style="background:linear-gradient(160deg,#2a3048,#111420)"></div>
      <div class="tc-name">🖼️ My Background</div>`;
    cell.onclick = () => {
      S.draft.theme = "custom";
      touch(); renderThemes(); renderMyBg(); renderPreview();
    };
    g.appendChild(cell);
  }
}

/* ============================================================
   Custom background — a supporter perk (profiles.mybg_allowed, mirrored from
   the bot). The portal uploads the image to the `custom-bgs` bucket, then only
   ASKS via custom_bg_requests; the bot re-checks the perk, processes the image
   and flips the player's theme to "custom" — same queue-and-poll dance as
   Remy's kitchen.
   ============================================================ */
let mybgBusy = false;

function renderMyBg() {
  const box = $("#mybgBox"); if (!box) return;
  const note = $("#mybgNote");
  // Rebuild only when the panel's shape changes (locked ↔ unlocked, remove
  // button appearing), so an already-picked file survives unrelated re-renders.
  const shape = !S.mybgAllowed ? "locked" : "open" + (S.draft.theme === "custom" ? "+rm" : "");
  if (note) note.textContent = !S.mybgAllowed ? "supporter perk"
    : S.draft.theme === "custom" ? "in use" : "";
  if (box.dataset.shape === shape) return;
  box.dataset.shape = shape;

  if (!S.mybgAllowed) {
    box.innerHTML = `<p class="hint" style="margin-top:2px">🔒 Custom backgrounds are a
      supporter perk — see <b>/supporter</b> in Discord.</p>`;
    return;
  }
  const dim = Number.isFinite(S.mybgDim) ? S.mybgDim : 45;
  box.innerHTML = `
    <label class="field"><span>Image</span>
      <input id="mybgFile" type="file" accept="image/*" />
    </label>
    <label class="field"><span>Darkness · <b id="mybgDimVal">${dim}%</b></span>
      <input id="mybgDim" class="mybg-range" type="range" min="0" max="90" value="${dim}" />
      <span class="hint" style="margin:0">Darkens the image so the card's text stays readable.</span>
    </label>
    <div class="mybg-acts">
      <button id="mybgUpload" class="btn gold">Upload &amp; apply</button>
      ${S.draft.theme === "custom"
        ? `<button id="mybgRemove" class="btn ghost">Remove custom background</button>` : ""}
    </div>
    <p class="hint">JPEG / PNG / WebP up to 10 MB. Small animated GIFs (&lt;4 MB) stay animated
      on your card.</p>`;
  const range = $("#mybgDim");
  range.oninput = () => { S.mybgDim = Number(range.value); $("#mybgDimVal").textContent = range.value + "%"; };
  $("#mybgUpload").onclick = uploadMyBg;
  const rm = $("#mybgRemove");
  if (rm) rm.onclick = removeMyBg;
}

// Poll a custom_bg_requests row until the bot answers: ~3s × 15 ≈ 45s.
async function pollMyBg(id) {
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data: row } = await sb.from("custom_bg_requests")
      .select("status,note").eq("id", id).single();
    if (row && row.status !== "pending") return row;
  }
  return null;   // still pending — the bot is probably down
}

// After a done request the bot has already written theme/themes_owned back to
// profiles — adopt them (same convention as buyLayout) and re-render the real
// card, which now shows the new background.
async function refreshAfterMyBg() {
  const { data: prof } = await sb.from("profiles")
    .select("theme,themes_owned,mybg_allowed").eq("guild_id", S.guild).maybeSingle();
  if (prof) {
    S.themesOwned = Array.isArray(prof.themes_owned) ? prof.themes_owned : S.themesOwned;
    S.mybgAllowed = !!prof.mybg_allowed;
    if (prof.theme) S.draft.theme = prof.theme;
    S.saved = JSON.stringify(S.draft);   // the bot already stored it
  }
  const box = $("#mybgBox");
  if (box) delete box.dataset.shape;     // force a rebuild (also clears the file input)
  renderThemes(); renderMyBg(); syncSaveState();
  doRender(true);
}

async function uploadMyBg() {
  if (mybgBusy) return;
  const file = $("#mybgFile")?.files?.[0];
  if (!file) return toast("Pick an image first.", true);
  if (!/^image\//.test(file.type || "")) return toast("That file isn't an image.", true);
  if (file.size > 10 * 1024 * 1024) return toast("That image is too big — 10 MB max.", true);
  // Storage RLS only accepts object names that start with YOUR discord id and
  // an underscore — keep this exact shape.
  let ext = (file.name.includes(".") ? file.name.split(".").pop() : "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!ext || ext.length > 5) ext = ((file.type.split("/")[1] || "png").replace(/[^a-z0-9]/g, "")) || "png";
  const name = `${S.discordId}_${Date.now()}.${ext}`;

  const btn = $("#mybgUpload");
  mybgBusy = true; btn.disabled = true; btn.textContent = "Uploading…";
  const fail = (msg) => {
    mybgBusy = false; btn.disabled = false; btn.textContent = "Upload & apply";
    toast(msg, true);
  };
  const { error: upErr } = await sb.storage.from("custom-bgs").upload(name, file);
  if (upErr) return fail("Upload failed: " + upErr.message);

  const dim = (Number.isFinite(S.mybgDim) ? S.mybgDim : 45) / 100;
  const { data, error } = await sb.from("custom_bg_requests")
    .insert({ discord_id: String(S.discordId), guild_id: String(S.guild),
              action: "set", object_name: name, dim })
    .select("id").single();
  if (error) return fail(/does not exist|schema cache/i.test(error.message)
    ? "Custom backgrounds aren't set up in Supabase yet — run the custom_bg schema."
    : "Couldn't queue that: " + error.message);

  btn.textContent = "Applying…";
  const row = await pollMyBg(data.id);
  if (!row) return fail("The bot hasn't answered yet — check back in a moment.");
  if (row.status === "error") return fail(row.note || "The bot couldn't apply that image.");
  mybgBusy = false; btn.disabled = false; btn.textContent = "Upload & apply";
  toast("🖼️ Background applied! Rendering your card…");
  await refreshAfterMyBg();
}

async function removeMyBg() {
  if (mybgBusy) return;
  const btn = $("#mybgRemove");
  mybgBusy = true; btn.disabled = true; btn.textContent = "Removing…";
  const fail = (msg) => {
    mybgBusy = false; btn.disabled = false; btn.textContent = "Remove custom background";
    toast(msg, true);
  };
  const { data, error } = await sb.from("custom_bg_requests")
    .insert({ discord_id: String(S.discordId), guild_id: String(S.guild), action: "remove" })
    .select("id").single();
  if (error) return fail("Couldn't queue that: " + error.message);
  const row = await pollMyBg(data.id);
  if (!row) return fail("The bot hasn't answered yet — check back in a moment.");
  if (row.status === "error") return fail(row.note || "The bot couldn't remove it.");
  mybgBusy = false;
  toast("Background removed.");
  await refreshAfterMyBg();
}

function renderFeatured() {
  const row = $("#featuredRow"); row.innerHTML = "";
  row.style.setProperty("--feat-cols", FEATURED_PER_ROW);   // wrap like the rendered card
  for (let i = 0; i < featMax(); i++) {
    const id = S.draft.featured[i];
    const it = id && showableItem(id);
    const slot = document.createElement("div");
    slot.className = "fslot" + (it ? " filled" : "");
    slot.dataset.slot = i;
    if (it) {
      slot.setAttribute("draggable", "true");
      slot.innerHTML = `<span class="x" title="Remove">✕</span><img src="${imgUrl(it.img)}" alt=""><span>${esc(it.n)}</span>`;
      slot.querySelector(".x").onclick = (e) => {
        e.stopPropagation(); S.draft.featured.splice(i, 1); touch(); renderFeatured(); renderInv();
      };
      slot.ondragstart = (e) => {
        e.dataTransfer.setData("text/plain", "feat:" + i);
        e.dataTransfer.effectAllowed = "move"; slot.classList.add("dragging");
        document.body.classList.add("dragging-item");
      };
      slot.ondragend = () => {
        slot.classList.remove("dragging");
        document.body.classList.remove("dragging-item");
      };
    } else {
      slot.innerHTML = `<span class="plus">+</span>`;
    }
    slot.ondragover = (e) => { e.preventDefault(); slot.classList.add("drop-hover"); };
    slot.ondragleave = () => slot.classList.remove("drop-hover");
    slot.ondrop = (e) => {
      e.preventDefault(); slot.classList.remove("drop-hover");
      const d = e.dataTransfer.getData("text/plain") || "";
      if (d.startsWith("inv:")) dropInvOnSlot(i, d.slice(4));
      else if (d.startsWith("feat:")) moveFeatured(parseInt(d.slice(5), 10), i);
    };
    row.appendChild(slot);
  }
  const used = S.draft.featured.filter(Boolean).length;
  const note = $("#featMaxNote");
  if (note) note.textContent = `${used} of ${featMax()}`;
  const fill = $("#featFill");
  if (fill) fill.style.width = `${Math.round((used / featMax()) * 100)}%`;
}

function dropInvOnSlot(i, itemId) {
  if (!showableItem(itemId)) return;
  const f = S.draft.featured.slice();
  if (i < f.length) f[i] = itemId; else f.push(itemId);   // replace that slot, or fill next
  const owned = ownedCount(itemId);                       // dupes are fine — spare copies aren't
  if (f.filter((x) => x === itemId).length > owned)
    return toast(owned ? `You only own ${owned}× that item.` : "You don't own that item.", true);
  S.draft.featured = f.slice(0, featMax());
  touch(); renderFeatured(); renderInv();
}

function moveFeatured(from, to) {
  const f = S.draft.featured.slice();
  if (from < 0 || from >= f.length) return;
  const [x] = f.splice(from, 1);
  f.splice(Math.max(0, Math.min(to, f.length)), 0, x);
  S.draft.featured = f.slice(0, featMax());
  touch(); renderFeatured(); renderInv();
}

function renderRarityFilter() {
  const f = $("#rarityFilter");
  const opts = ["all", ...RARITY];
  f.innerHTML = opts.map((r) =>
    `<button data-r="${r}" class="${r === S.invRarity ? "on" : ""}">${r === "all" ? "All" : cap(r)}</button>`).join("");
  f.querySelectorAll("button").forEach((b) => b.onclick = () => { S.invRarity = b.dataset.r; S.invPage = 0; renderInv(); });
}

function filteredInv() {
  const list = S.inv
    // An item missing from the catalogue still belongs to the player — show a
    // placeholder rather than dropping it, so nothing ever silently disappears.
    .map((r) => ({ ...r, it: S.catalog[r.item_id] || unknownItem(r.item_id) }))
    .filter((r) => S.invRarity === "all" || r.it.r === S.invRarity)
    .filter((r) => S.invCat === "all" || r.it.c === S.invCat)
    .filter((r) => !S.invDupes || r.count > 1)
    .filter((r) => nameMatches(r.it.n, S.invSearch));
  const byName = (a, b) => a.it.n.localeCompare(b.it.n);
  const rIdx = (x) => RARITY.indexOf(x.it.r);
  const sorts = {
    rarity_desc: (a, b) => rIdx(a) - rIdx(b) || byName(a, b),
    rarity_asc: (a, b) => rIdx(b) - rIdx(a) || byName(a, b),
    az: byName,
    za: (a, b) => byName(b, a),
    copies_desc: (a, b) => b.count - a.count || byName(a, b),
    copies_asc: (a, b) => a.count - b.count || byName(a, b),
  };
  return list.sort(sorts[S.invSort] || sorts.rarity_desc);
}

function renderTypeFilter() {
  const f = $("#typeFilter");
  const cats = [...new Set(S.inv.map((r) => (S.catalog[r.item_id] || unknownItem(r.item_id)).c).filter(Boolean))].sort();
  const label = { pin: "Pins", clothing: "Clothing" };
  f.innerHTML = ["all", ...cats].map((c) =>
    `<button data-c="${c}" class="${c === S.invCat ? "on" : ""}">${c === "all" ? "All types" : (label[c] || cap(c))}</button>`).join("");
  f.querySelectorAll("button").forEach((b) => b.onclick = () => { S.invCat = b.dataset.c; S.invPage = 0; renderInv(); });
}

function renderInv() {
  renderRarityFilter();
  renderTypeFilter();
  const all = filteredInv();
  const total = S.inv.reduce((n, r) => n + r.count, 0);
  $("#invCount").textContent = `${total} items · ${S.inv.length} unique`;
  const grid = $("#invGrid");
  if (!all.length) { grid.innerHTML = `<div class="empty-inv">No items match.</div>`; $("#invPager").innerHTML = ""; return; }
  const pages = Math.ceil(all.length / PER);
  S.invPage = Math.min(S.invPage, pages - 1);
  const slice = all.slice(S.invPage * PER, S.invPage * PER + PER);
  // Magic piles that could be fused right now get a badge, so the combine panel
  // below isn't the only way to notice
  const fusable = new Set(Object.entries(magicHoldings())
    .filter(([, counts]) => combinableTargets(counts).length).map(([id]) => id));
  grid.innerHTML = slice.map((r) => {
    const nfeat = featCount(r.item_id);
    const stars = itemStars(r.item_id);
    return `<div class="inv-item${nfeat ? " featured" : ""}" data-r="${r.it.r}" data-id="${r.item_id}">
      <span class="ct${r.count > 1 ? " dup" : ""}">${nfeat > 1 ? `★${nfeat} · ` : ""}×${r.count}</span>
      ${fusable.has(baseItemId(r.item_id)) ? `<span class="mg" title="Can be combined — see Combine Magic below">✨${
        stars > 1 ? ` ${stars}★` : ""}</span>` : stars > 1 ? `<span class="mg">${stars}★</span>` : ""}
      <img loading="lazy" src="${imgUrl(r.it.img)}" alt=""><div class="nm">${esc(r.it.n)}</div></div>`;
  }).join("");
  grid.querySelectorAll(".inv-item").forEach((el) => {
    el.setAttribute("draggable", "true");
    el.ondragstart = (e) => {
      e.dataTransfer.setData("text/plain", "inv:" + el.dataset.id);
      e.dataTransfer.effectAllowed = "copy";
      document.body.classList.add("dragging-item");   // lights up the showcase rail
    };
    el.ondragend = () => document.body.classList.remove("dragging-item");
    el.onclick = () => toggleFeature(el.dataset.id);
    el.oncontextmenu = (e) => { e.preventDefault(); showItemMenu(e.clientX, e.clientY, el.dataset.id); };
  });
  $("#invPager").innerHTML = pages > 1
    ? `<button id="pp" ${S.invPage === 0 ? "disabled" : ""}>◀</button>
       <span>${S.invPage + 1} / ${pages}</span>
       <button id="pn" ${S.invPage >= pages - 1 ? "disabled" : ""}>▶</button>` : "";
  if (pages > 1) {
    $("#pp").onclick = () => { S.invPage--; renderInv(); };
    $("#pn").onclick = () => { S.invPage++; renderInv(); };
  }
}

/* ---------- inventory right-click menu ---------- */
function showItemMenu(x, y, id) {
  const it = showableItem(id); if (!it) return;
  const m = $("#ctxMenu");
  const rows = [`<div class="ctx-head">Feature: ${esc(it.n)}</div>`];
  const acts = [];
  for (let i = 0; i < featMax(); i++) {
    const occId = S.draft.featured[i];
    const occ = occId ? (occId === id ? "★ this item" : (showableItem(occId)?.n || "item")) : "empty";
    rows.push(`<button class="ctx-item" data-i="${acts.length}">Slot ${i + 1} <span class="ctx-sub">${esc(occ)}</span></button>`);
    acts.push(() => dropInvOnSlot(i, id));
  }
  const nfeat = featCount(id);
  if (nfeat) {
    rows.push(`<button class="ctx-item danger" data-i="${acts.length}">Remove from showcase${
      nfeat > 1 ? ` <span class="ctx-sub">1 of ${nfeat}</span>` : ""}</button>`);
    acts.push(() => {
      const idx = S.draft.featured.indexOf(id);
      if (idx >= 0) { S.draft.featured.splice(idx, 1); touch(); renderFeatured(); renderInv(); }
    });
  }
  m.innerHTML = rows.join("");
  m.querySelectorAll(".ctx-item").forEach((b) => b.onclick = () => { acts[+b.dataset.i](); hideCtxMenu(); });
  m.classList.remove("hidden");
  // position, keeping it on screen
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
}
function hideCtxMenu() { $("#ctxMenu").classList.add("hidden"); }

// Click cycles: add a copy while spares remain, then clear one on the next
// click. (Single-copy items behave exactly as before — add, then remove.)
function toggleFeature(id) {
  if (featCount(id) >= ownedCount(id)) {
    const i = S.draft.featured.indexOf(id);
    if (i >= 0) S.draft.featured.splice(i, 1);
    else return;                                  // owns none of it
  } else if (S.draft.featured.length >= featMax()) {
    return toast(`Showcase is full (${featMax()}). Remove one first.`);
  } else {
    S.draft.featured.push(id);
  }
  touch(); renderFeatured(); renderInv(); renderPreview();
}

/* ---------- preview ----------
   The preview is ALWAYS the real bot-rendered card (see doRender), so it matches
   /profile exactly. renderPreview() is kept as a no-op so edit handlers can call
   it harmlessly; the actual refresh is the debounced real render from touch(). */
function renderPreview() { /* intentionally empty — the exact card is the preview */ }

/* ---------- save ---------- */
let renderTimer;
function touch() { syncSaveState(); scheduleRealRender(); }
function scheduleRealRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => doRender(true), 800);
}
function syncSaveState() {
  const dirty = JSON.stringify(S.draft) !== S.saved;
  const el = $("#saveState");
  el.textContent = dirty ? "● Unsaved changes" : (S.saved ? "✓ Saved" : "");
  el.className = "save-state " + (dirty ? "dirty" : "saved");
}

async function save() {
  if (!S.guild) return toast("No server to save to yet.", true);
  const row = {
    discord_id: S.discordId, guild_id: S.guild, display_name: S.name,
    bio: S.draft.bio || null, theme: S.draft.theme, accent_color: S.draft.accent_color,
    featured: S.draft.featured, updated_by: "portal", updated_at: new Date().toISOString(),
  };
  if (S.hasHidden) row.hidden_titles = S.draft.hidden_titles || [];
  if (S.hasCard) {
    row.card_layout = S.draft.card_layout;
    row.card_stats = cardStatsWire();
  }
  const { error } = await sb.from("profiles").upsert(row, { onConflict: "discord_id,guild_id" });
  if (error) return toast("Save failed: " + error.message, true);
  S.saved = JSON.stringify(S.draft);
  syncSaveState();
  toast("Saved! Your /profile will update shortly. ✨");
}

/* ---------- render the REAL card via the bot (auto on edits + manual button) ---------- */
async function doRender(auto) {
  if (!S.guild) { if (!auto) toast("Nothing to render yet.", true); return; }
  const cp = $("#cardPreview");
  if (!cp.querySelector("img")) cp.innerHTML = `<div class="empty">Rendering your card…</div>`;
  cp.classList.add("rendering");
  if (!auto) { $("#renderBtn").disabled = true; $("#renderBtn").textContent = "Rendering…"; }
  const preview = { theme: S.draft.theme, accent_color: S.draft.accent_color, featured: S.draft.featured, bio: S.draft.bio };
  if (S.hasHidden) preview.hidden_titles = S.draft.hidden_titles;
  // the preview has to show the layout you're *considering*, not the saved one
  if (S.hasCard) {
    preview.card_layout = S.draft.card_layout;
    preview.card_stats = cardStatsWire();
  }
  const { data, error } = await sb.from("render_requests")
    .insert({ discord_id: S.discordId, guild_id: S.guild, preview }).select().single();
  if (error) { finishRender(); if (!auto) toast("Render request failed: " + error.message, true); return; }

  let done = false;
  const finish = (row) => {
    if (done) return; done = true;
    finishRender();
    if (row.status === "done" && row.png_url)
      cp.innerHTML = `<img src="${row.png_url}?t=${Date.now()}" alt="Your profile card">`;
    else if (!auto) toast(row.error || "The bot couldn't render that.", true);
  };
  const chan = sb.channel("render-" + data.id)
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "render_requests", filter: `id=eq.${data.id}` },
      (p) => { if (p.new.status !== "pending") { finish(p.new); sb.removeChannel(chan); } })
    .subscribe();
  setTimeout(async () => {
    if (done) return;
    const { data: row } = await sb.from("render_requests").select("*").eq("id", data.id).single();
    if (row && row.status !== "pending") finish(row);
    else { finishRender(); if (!auto) toast("Still waiting on the bot — is the render worker running?", true); }
    sb.removeChannel(chan);
  }, 12000);
}
function finishRender() {
  $("#cardPreview").classList.remove("rendering");
  const b = $("#renderBtn"); b.disabled = false; b.textContent = "⟳ Render exact card";
}

/* ---------- helpers ---------- */
// custom items carry an absolute bucket URL; everything else is a local filename
function imgUrl(f) { return /^https?:/.test(f) ? f : CFG.ITEM_IMG_BASE + f; }
// Item names carry punctuation ("Room Pin - Oogie's Lair", "Lanyard - Black"),
// so a plain substring match misses what people type ("oogie lair"). Strip the
// punctuation and require every word, in any order.
const normName = (s) => String(s ?? "").toLowerCase()
  .replace(/[‘’'`´]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
function nameMatches(name, query) {
  const terms = normName(query).split(" ").filter(Boolean);
  if (!terms.length) return true;
  const hay = normName(name);
  return terms.every((t) => hay.includes(t));
}
function rgb(a) { return `rgb(${a[0]},${a[1]},${a[2]})`; }
function rgbHex(a) { return "#" + a.map((n) => n.toString(16).padStart(2, "0")).join(""); }
function cap(s) { return s[0].toUpperCase() + s.slice(1); }
function esc(s) { return (s ?? "").toString().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
let toastT;
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastT); toastT = setTimeout(() => t.className = "toast", 3200);
}

boot().catch((e) => { console.error(e); $("#landingNote").textContent = "Load error: " + e.message; });
