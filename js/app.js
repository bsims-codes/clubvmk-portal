/* ============================================================
   CLUBVMK Collector's Vault — portal logic
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const RARITY = ["legendary", "epic", "rare", "uncommon", "common"];
const $ = (s) => document.querySelector(s);

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
};
const PER = 24;

/* ---------- boot ---------- */
async function boot() {
  const [cat, thm] = await Promise.all([
    fetch("data/catalog.min.json").then((r) => r.json()),
    fetch("data/themes.json").then((r) => r.json()),
  ]);
  for (const it of cat) S.catalog[it.id] = it;
  S.themes = thm;
  await applyRarityOverrides();

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
  try {
    let from = 0; const page = 1000;
    for (;;) {
      const { data, error } = await sb.from("overrides").select("item_id,tier").range(from, from + page - 1);
      if (error) throw error;
      for (const o of data || []) if (S.catalog[o.item_id]) S.catalog[o.item_id].r = o.tier;
      if (!data || data.length < page) break;
      from += page;
    }
  } catch (e) { console.warn("overrides load failed:", e.message); }
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
    `<div class="who">${S.avatar ? `<img src="${S.avatar}" alt="">` : ""}<b>${esc(S.name)}</b>
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
async function loadData() {
  // which guild(s) does this player have data in?
  const { data: rows, error } = await sb.from("player_items").select("guild_id,item_id,count");
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
  S.draft = {
    theme: prof?.theme || CFG.DEFAULT_THEME,
    accent_color: prof?.accent_color || null,
    featured: Array.isArray(prof?.featured) ? prof.featured.slice(0, 3) : [],
    bio: prof?.bio || "",
  };
  S.saved = JSON.stringify(S.draft);
  // unlock state (mirrored from the bot): purchased/granted themes + inventory stats
  S.themesOwned = Array.isArray(prof?.themes_owned) ? prof.themes_owned : [];
  S.totalItems = S.inv.reduce((n, r) => n + r.count, 0);
  S.byTier = {};
  for (const r of S.inv) { const it = S.catalog[r.item_id]; if (it) S.byTier[it.r] = (S.byTier[it.r] || 0) + r.count; }
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
  $("#colorReset").onclick = () => { S.draft.accent_color = null; touch(); renderAll(); };
  $("#saveBtn").onclick = save;
  $("#renderBtn").onclick = () => doRender(false);
  $("#invSearch").oninput = (e) => { S.invSearch = e.target.value.toLowerCase(); S.invPage = 0; renderInv(); };
  const sort = $("#invSort"); sort.value = S.invSort;
  sort.onchange = (e) => { S.invSort = e.target.value; S.invPage = 0; renderInv(); };
}

/* ---------- render everything ---------- */
function renderAll() { renderThemes(); renderFeatured(); renderRarityFilter(); renderInv(); renderPreview(); syncSaveState(); }

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
      else lock = "🔒";
    }
    cell.innerHTML = `<div class="tc-bg" style="${bg}"></div>` +
      (lock ? `<div class="tc-lock">${lock}</div>` : "") +
      `<div class="tc-name">${esc(t.name)}</div>`;
    cell.onclick = () => {
      if (!unlocked) return toast("🔒 Unlock this theme in Discord first (/theme).");
      S.draft.theme = id;
      if (!S.draft.accent_color) $("#colorInput").value = rgbHex(t.accent);
      touch(); renderThemes(); renderPreview();
    };
    g.appendChild(cell);
  }
}

function renderFeatured() {
  const row = $("#featuredRow"); row.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const id = S.draft.featured[i];
    const it = id && S.catalog[id];
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
      };
      slot.ondragend = () => slot.classList.remove("dragging");
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
}

function dropInvOnSlot(i, itemId) {
  if (!S.catalog[itemId]) return;
  let f = S.draft.featured.slice();
  if (i < f.length) f[i] = itemId; else f.push(itemId);   // replace that slot, or fill next
  const seen = new Set();                                  // dedup (item can't be featured twice)
  f = f.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
  S.draft.featured = f.slice(0, 3);
  touch(); renderFeatured(); renderInv();
}

function moveFeatured(from, to) {
  const f = S.draft.featured.slice();
  if (from < 0 || from >= f.length) return;
  const [x] = f.splice(from, 1);
  f.splice(Math.max(0, Math.min(to, f.length)), 0, x);
  S.draft.featured = f.slice(0, 3);
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
    .map((r) => ({ ...r, it: S.catalog[r.item_id] }))
    .filter((r) => r.it)
    .filter((r) => S.invRarity === "all" || r.it.r === S.invRarity)
    .filter((r) => S.invCat === "all" || r.it.c === S.invCat)
    .filter((r) => !S.invSearch || r.it.n.toLowerCase().includes(S.invSearch));
  const byName = (a, b) => a.it.n.localeCompare(b.it.n);
  const rIdx = (x) => RARITY.indexOf(x.it.r);
  const sorts = {
    rarity_desc: (a, b) => rIdx(a) - rIdx(b) || byName(a, b),
    rarity_asc: (a, b) => rIdx(b) - rIdx(a) || byName(a, b),
    az: byName,
    za: (a, b) => byName(b, a),
  };
  return list.sort(sorts[S.invSort] || sorts.rarity_desc);
}

function renderTypeFilter() {
  const f = $("#typeFilter");
  const cats = [...new Set(S.inv.map((r) => S.catalog[r.item_id]?.c).filter(Boolean))].sort();
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
  grid.innerHTML = slice.map((r) => {
    const feat = S.draft.featured.includes(r.item_id);
    return `<div class="inv-item${feat ? " featured" : ""}" data-r="${r.it.r}" data-id="${r.item_id}">
      ${r.count > 1 ? `<span class="ct">×${r.count}</span>` : ""}
      <img loading="lazy" src="${imgUrl(r.it.img)}" alt=""><div class="nm">${esc(r.it.n)}</div></div>`;
  }).join("");
  grid.querySelectorAll(".inv-item").forEach((el) => {
    el.setAttribute("draggable", "true");
    el.ondragstart = (e) => {
      e.dataTransfer.setData("text/plain", "inv:" + el.dataset.id);
      e.dataTransfer.effectAllowed = "copy";
    };
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
  const it = S.catalog[id]; if (!it) return;
  const m = $("#ctxMenu");
  const rows = [`<div class="ctx-head">Feature: ${esc(it.n)}</div>`];
  const acts = [];
  for (let i = 0; i < 3; i++) {
    const occId = S.draft.featured[i];
    const occ = occId ? (occId === id ? "★ this item" : (S.catalog[occId]?.n || "item")) : "empty";
    rows.push(`<button class="ctx-item" data-i="${acts.length}">Slot ${i + 1} <span class="ctx-sub">${esc(occ)}</span></button>`);
    acts.push(() => dropInvOnSlot(i, id));
  }
  if (S.draft.featured.includes(id)) {
    rows.push(`<button class="ctx-item danger" data-i="${acts.length}">Remove from showcase</button>`);
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

function toggleFeature(id) {
  const i = S.draft.featured.indexOf(id);
  if (i >= 0) S.draft.featured.splice(i, 1);
  else { if (S.draft.featured.length >= 3) return toast("Showcase is full (3). Remove one first."); S.draft.featured.push(id); }
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
function imgUrl(f) { return CFG.ITEM_IMG_BASE + f; }
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
