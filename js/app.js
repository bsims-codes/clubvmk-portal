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
  invPage: 0, invSearch: "", invRarity: "all",
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
  try {
    S.guildNames = await fetch(CFG.SUPABASE_URL + "/storage/v1/object/public/previews/guilds.json")
      .then((r) => (r.ok ? r.json() : {}));
  } catch { S.guildNames = {}; }

  $("#signInBtn").onclick = signIn;
  sb.auth.onAuthStateChange((_e, session) => render(session));
  const { data } = await sb.auth.getSession();
  render(data.session);
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
  wireEditor();
  renderAll();
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
  $("#renderBtn").onclick = requestRender;
  $("#invSearch").oninput = (e) => { S.invSearch = e.target.value.toLowerCase(); S.invPage = 0; renderInv(); };
}

/* ---------- render everything ---------- */
function renderAll() { renderThemes(); renderFeatured(); renderRarityFilter(); renderInv(); renderPreview(); syncSaveState(); }

function renderThemes() {
  const g = $("#themeGrid"); g.innerHTML = "";
  const entries = Object.entries(S.themes);
  $("#themeCount").textContent = `${entries.length} themes`;
  for (const [id, t] of entries) {
    const cell = document.createElement("div");
    cell.className = "theme-cell" + (id === S.draft.theme ? " on" : "");
    const bg = t.image ? `background-image:url('${t.image}')`
      : t.grad ? `background:linear-gradient(160deg,${rgb(t.grad[0])},${rgb(t.grad[1])})`
      : `background:${rgb(t.bg)}`;
    const u = t.unlock || {};
    let lock = "";
    if (u.type === "club") lock = `🪙 ${u.cost}`;
    else if (u.type === "buy") lock = `❄️ ${u.cost}`;
    else if (u.type === "total") lock = `${u.value} items`;
    else if (u.type === "rarity") lock = `${u.value} ${u.tier}`;
    cell.innerHTML = `<div class="tc-bg" style="${bg}"></div>` +
      (lock ? `<div class="tc-lock">${lock}</div>` : "") +
      `<div class="tc-name">${esc(t.name)}</div>`;
    cell.onclick = () => { S.draft.theme = id; if (!S.draft.accent_color) $("#colorInput").value = rgbHex(t.accent); touch(); renderThemes(); renderPreview(); };
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
    if (it) {
      slot.innerHTML = `<span class="x">✕</span><img src="${imgUrl(it.img)}" alt=""><span>${esc(it.n)}</span>`;
      slot.onclick = () => { S.draft.featured.splice(i, 1); touch(); renderFeatured(); renderInv(); renderPreview(); };
    } else {
      slot.innerHTML = `<span class="plus">+</span>`;
    }
    row.appendChild(slot);
  }
}

function renderRarityFilter() {
  const f = $("#rarityFilter");
  const opts = ["all", ...RARITY];
  f.innerHTML = opts.map((r) =>
    `<button data-r="${r}" class="${r === S.invRarity ? "on" : ""}">${r === "all" ? "All" : cap(r)}</button>`).join("");
  f.querySelectorAll("button").forEach((b) => b.onclick = () => { S.invRarity = b.dataset.r; S.invPage = 0; renderInv(); });
}

function filteredInv() {
  return S.inv
    .map((r) => ({ ...r, it: S.catalog[r.item_id] }))
    .filter((r) => r.it)
    .filter((r) => S.invRarity === "all" || r.it.r === S.invRarity)
    .filter((r) => !S.invSearch || r.it.n.toLowerCase().includes(S.invSearch))
    .sort((a, b) => RARITY.indexOf(a.it.r) - RARITY.indexOf(b.it.r) || a.it.n.localeCompare(b.it.n));
}

function renderInv() {
  renderRarityFilter();
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
  grid.querySelectorAll(".inv-item").forEach((el) => el.onclick = () => toggleFeature(el.dataset.id));
  $("#invPager").innerHTML = pages > 1
    ? `<button id="pp" ${S.invPage === 0 ? "disabled" : ""}>◀</button>
       <span>${S.invPage + 1} / ${pages}</span>
       <button id="pn" ${S.invPage >= pages - 1 ? "disabled" : ""}>▶</button>` : "";
  if (pages > 1) {
    $("#pp").onclick = () => { S.invPage--; renderInv(); };
    $("#pn").onclick = () => { S.invPage++; renderInv(); };
  }
}

function toggleFeature(id) {
  const i = S.draft.featured.indexOf(id);
  if (i >= 0) S.draft.featured.splice(i, 1);
  else { if (S.draft.featured.length >= 3) return toast("Showcase is full (3). Remove one first."); S.draft.featured.push(id); }
  touch(); renderFeatured(); renderInv(); renderPreview();
}

/* ---------- live CSS preview ---------- */
function renderPreview() {
  const t = S.themes[S.draft.theme] || S.themes[CFG.DEFAULT_THEME];
  const accent = S.draft.accent_color || rgbHex(t.accent);
  const total = S.inv.reduce((n, r) => n + r.count, 0);
  const byTier = {};
  for (const r of S.inv) { const it = S.catalog[r.item_id]; if (it) byTier[it.r] = (byTier[it.r] || 0) + r.count; }
  const bg = t.image ? `background-image:url('${t.image}')`
    : t.grad ? `background:linear-gradient(160deg,${rgb(t.grad[0])},${rgb(t.grad[1])})`
    : `background:${rgb(t.bg)}`;
  const scrim = t.image ? "background:rgba(6,8,20,.5)" : "background:rgba(6,8,20,.15)";
  const slots = [0, 1, 2].map((i) => {
    const it = S.draft.featured[i] && S.catalog[S.draft.featured[i]];
    return it ? `<div class="slot"><img src="${imgUrl(it.img)}"><span>${esc(it.n)}</span></div>`
              : `<div class="slot"></div>`;
  }).join("");
  const tiles = [["TOTAL", total], ["UNIQUE", S.inv.length],
    ["LEGENDARY", byTier.legendary || 0], ["EPIC", byTier.epic || 0]]
    .map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join("");
  $("#cardPreview").innerHTML =
    `<div class="pv" style="--pv-accent:${accent}">
      <div class="pv-bg" style="${bg}"></div><div class="pv-scrim" style="${scrim}"></div>
      <div class="pv-body">
        <div class="pv-head">
          <div class="pv-av" style="border-color:${accent};${S.avatar ? `background-image:url('${S.avatar}')` : ""}"></div>
          <div><div class="pv-name">${esc(S.name)}</div><div class="pv-bio">${esc(S.draft.bio || "")}</div></div>
        </div>
        <div class="pv-tiles">${tiles}</div>
        <div class="pv-show">${slots}</div>
        <div class="pv-theme">Theme: ${esc(t.name)}</div>
      </div>
    </div>`;
}

/* ---------- save ---------- */
function touch() { syncSaveState(); }
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

/* ---------- request the real render from the bot ---------- */
async function requestRender() {
  if (!S.guild) return toast("Nothing to render yet.", true);
  $("#renderBtn").disabled = true; $("#renderBtn").textContent = "Rendering…";
  const preview = { theme: S.draft.theme, accent_color: S.draft.accent_color, featured: S.draft.featured, bio: S.draft.bio };
  const { data, error } = await sb.from("render_requests")
    .insert({ discord_id: S.discordId, guild_id: S.guild, preview }).select().single();
  if (error) { resetRenderBtn(); return toast("Render request failed: " + error.message, true); }

  let done = false;
  const finish = (row) => {
    if (done) return; done = true;
    resetRenderBtn();
    if (row.status === "done" && row.png_url)
      $("#cardPreview").innerHTML = `<img src="${row.png_url}?t=${Date.now()}" alt="Your profile card">`;
    else toast(row.error || "The bot couldn't render that.", true);
  };
  const chan = sb.channel("render-" + data.id)
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "render_requests", filter: `id=eq.${data.id}` },
      (p) => { if (p.new.status !== "pending") { finish(p.new); sb.removeChannel(chan); } })
    .subscribe();
  setTimeout(async () => {
    if (done) return;
    const { data: row } = await sb.from("render_requests").select("*").eq("id", data.id).single();
    if (row && row.status !== "pending") { finish(row); }
    else { resetRenderBtn(); toast("Still waiting on the bot — is the render worker running?", true); }
    sb.removeChannel(chan);
  }, 12000);
}
function resetRenderBtn() { const b = $("#renderBtn"); b.disabled = false; b.textContent = "⟳ Render exact card"; }

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
