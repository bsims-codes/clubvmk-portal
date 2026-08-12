/* ============================================================
   CLUBVMK — Dressing Room.

   Paper-doll dress-up over your real collection. MyVMK's sprite format is
   already a paper doll: every layer carries a registration point in one shared
   skeleton origin, so layers from unrelated items line up with no per-item
   tuning. The rendering all happens on the bot — this page inserts a
   `render_requests` row whose `preview` carries an {avatar:…} spec, then waits
   on Realtime for the bot to drop a PNG in the previews bucket.

   Saving works the same way as the profile editor: upsert `profiles` with
   updated_by='portal' and let the bot's apply loop pull it into SQLite. The bot
   re-checks ownership on both paths, so this page can only ever *ask*.

   While the feature is in beta the bot refuses avatar work for anyone outside
   AVATAR_BETA_IDS. The gate below is cosmetic — it keeps the nav honest, it is
   not what enforces anything.
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const $ = (s) => document.querySelector(s);

const SLOTS = ["hat", "hair", "glasses", "makeup", "shirt", "pants", "shoes",
               "back", "wings", "aura", "neck", "held"];
const RARITY = ["legendary", "epic", "rare", "uncommon", "common"];
const RENDER_WAIT_MS = 25000;    // matches the profile card's wait

const S = {
  me: null, guild: null, guilds: [], guildNames: {},
  wear: {},        // slot -> raw id
  tone: "default", facing: "3",
  tab: "hat", slots: {}, owned: {}, saved: "",
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const imgUrl = (f) => (/^https?:/.test(f) ? f : CFG.ITEM_IMG_BASE + f);
// inventory ids look like "clothing:47071"; duplicates carry a "*n" suffix
const rawId = (id) => String(id).split(":").pop().split("*")[0];

let toastT;
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 3200);
}

function discordIdFromSession(session) {
  const u = session?.user; if (!u) return null;
  const m = u.user_metadata || {};
  const ident = (u.identities || []).find((i) => i.provider === "discord") || {};
  return m.provider_id || m.sub || ident.id || ident.identity_data?.provider_id || null;
}

/* PostgREST truncates at 1000 rows with no error — always page. */
async function fetchAllRows(table, columns, filter) {
  const PAGE = 1000; const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(columns);
    if (filter) q = filter(q);
    const { data, error } = await q.order("item_id").range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    out.push(...(data || []));
    if (!data || data.length < PAGE) return { data: out, error: null };
  }
}

/* ---------- load ---------- */
async function loadSlots() {
  const r = await fetch("data/avatar_slots.json", { cache: "no-cache" });
  if (!r.ok) throw new Error("wearable index missing (" + r.status + ")");
  S.slots = await r.json();
}

async function loadInv() {
  const { data, error } = await fetchAllRows("player_items", "guild_id,item_id,count",
    (q) => q.gt("count", 0));
  if (error) { toast("Couldn't load your items: " + error.message, true); return; }
  S.guilds = [...new Set((data || []).map((r) => r.guild_id))];
  if (!S.guilds.length) {
    $("#panel").innerHTML = `<h1>🧍 Dressing Room</h1>
      <p class="lede">No collection found yet — catch a few items in Discord first,
      then come back and get dressed.</p>`;
    return;
  }
  if (!S.guild || !S.guilds.includes(S.guild)) S.guild = S.guilds[0];
  try {
    const { data: gn } = await sb.from("profiles").select("guild_id,guild_name");
    for (const r of gn || []) if (r.guild_name) S.guildNames[r.guild_id] = r.guild_name;
  } catch (e) { /* column may not exist yet — ids are a fine fallback */ }

  S.owned = {};
  for (const r of data) {
    if (r.guild_id !== S.guild) continue;
    const raw = rawId(r.item_id);
    const meta = S.slots[raw];
    if (!meta || S.owned[raw]) continue;
    S.owned[raw] = meta;
  }
  await loadSavedOutfit();
  renderGuilds(); renderTabs(); renderGrid(); renderPicks();
  requestRender();
}

async function loadSavedOutfit() {
  try {
    const { data } = await sb.from("profiles")
      .select("avatar_worn").eq("discord_id", S.me).eq("guild_id", S.guild).maybeSingle();
    const av = data?.avatar_worn;
    if (av && typeof av === "object") {
      S.wear = {};
      for (const [k, v] of Object.entries(av)) {
        if (k === "_tone") { S.tone = String(v); continue; }
        if (k === "_facing") { S.facing = String(v); continue; }
        if (S.owned[String(v)] && S.owned[String(v)].s === k) S.wear[k] = String(v);
      }
      $("#tone").value = S.tone; $("#facing").value = S.facing;
    }
  } catch (e) {
    // avatar_worn column not added yet — dress-up still works, saving won't
    $("#dollHint").textContent = "Saving is off until the avatar_worn column exists.";
  }
  S.saved = JSON.stringify(wire());
}

/* ---------- render the page ---------- */
function renderGuilds() {
  const row = $("#guildRow");
  if (S.guilds.length < 2) { row.innerHTML = ""; return; }
  const label = (g) => S.guildNames[g] || "Server " + g.slice(-4);
  row.innerHTML = `<span class="muted2" style="font-size:13px">Server:</span>
    <div class="rarity-filter">` + S.guilds.map((g) =>
      `<button data-c="${esc(g)}" class="${g === S.guild ? "on" : ""}">${esc(label(g))}</button>`)
      .join("") + `</div>`;
  row.querySelectorAll("button").forEach((b) => (b.onclick = () => {
    S.guild = b.dataset.c; S.wear = {}; loadInv();
  }));
}

function bySlot(slot) {
  return Object.entries(S.owned).filter(([, m]) => m.s === slot)
    .sort((a, b) => RARITY.indexOf(a[1].r) - RARITY.indexOf(b[1].r) ||
                    a[1].n.localeCompare(b[1].n));
}

function renderTabs() {
  const counts = {};
  for (const m of Object.values(S.owned)) counts[m.s] = (counts[m.s] || 0) + 1;
  const live = SLOTS.filter((s) => counts[s]);
  if (live.length && !counts[S.tab]) S.tab = live[0];
  $("#tabs").innerHTML = live.map((s) =>
    `<button class="tab ${s === S.tab ? "on" : ""}" data-s="${s}">${s}<span class="n">${counts[s]}</span></button>`
  ).join("");
  $("#tabs").querySelectorAll(".tab").forEach((b) => (b.onclick = () => {
    S.tab = b.dataset.s; renderTabs(); renderGrid();
  }));
  const total = Object.keys(S.owned).length;
  $("#wardrobeHint").textContent =
    `${total} of your items have sprite art. Click one to put it on; click it again to take it off.`;
}

function renderGrid() {
  const list = bySlot(S.tab);
  const g = $("#grid");
  if (!list.length) { g.innerHTML = `<div class="empty">Nothing here yet.</div>`; return; }
  g.innerHTML = list.map(([raw, m]) =>
    `<div class="tile ${S.wear[m.s] === raw ? "on" : ""}" data-r="${esc(raw)}" data-s="${esc(m.s)}">
       <img src="${imgUrl(m.i)}" alt="${esc(m.n)}" loading="lazy" />
       <div class="nm">${esc(m.n)}</div>
     </div>`).join("");
  g.querySelectorAll(".tile").forEach((t) => (t.onclick = () => {
    const { r, s } = t.dataset;
    if (S.wear[s] === r) delete S.wear[s]; else S.wear[s] = r;
    renderGrid(); renderPicks(); queueRender();
  }));
}

function renderPicks() {
  const rows = SLOTS.filter((s) => S.wear[s]).map((s) =>
    `<div class="row"><span class="sl">${s}</span>
       <span class="nm">${esc((S.owned[S.wear[s]] || {}).n || S.wear[s])}</span></div>`);
  $("#picks").innerHTML = rows.join("") ||
    `<div class="row"><span class="sl">nothing on yet</span></div>`;
  $("#dollHint").textContent = rows.length
    ? `${rows.length} item${rows.length > 1 ? "s" : ""} on.`
    : "Pick something from the wardrobe.";
  syncSave();
}

function wire() {
  return { ...S.wear, _tone: S.tone, _facing: S.facing };
}
function syncSave() {
  $("#saveBtn").disabled = JSON.stringify(wire()) === S.saved;
}

/* ---------- ask the bot for the real render ---------- */
let renderT;
function queueRender() {
  clearTimeout(renderT);
  renderT = setTimeout(requestRender, 400);   // debounce a burst of clicks
}

async function requestRender() {
  const doll = $("#doll");
  if (!Object.keys(S.wear).length) {
    doll.classList.remove("rendering");
    doll.innerHTML = `<div class="ph">Nothing on yet.<br />Pick something from the wardrobe.</div>`;
    return;
  }
  doll.classList.add("rendering");
  const preview = { avatar: { worn: S.wear, tone: S.tone, facing: S.facing } };
  const { data, error } = await sb.from("render_requests")
    .insert({ discord_id: S.me, guild_id: S.guild, preview }).select().single();
  if (error) {
    doll.classList.remove("rendering");
    toast("Render request failed: " + error.message, true);
    return;
  }
  let done = false;
  const finish = (row) => {
    if (done) return; done = true;
    doll.classList.remove("rendering");
    if (row.status === "done" && row.png_url)
      doll.innerHTML = `<img src="${row.png_url}?t=${Date.now()}" alt="Your avatar" />`;
    else
      doll.innerHTML = `<div class="ph">${esc(row.error || "The bot couldn't render that.")}</div>`;
  };
  const chan = sb.channel("avatar-" + data.id)
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "render_requests", filter: `id=eq.${data.id}` },
      (p) => { if (p.new.status !== "pending") { finish(p.new); sb.removeChannel(chan); } })
    .subscribe();
  setTimeout(async () => {
    if (done) return;
    const { data: row } = await sb.from("render_requests").select("*").eq("id", data.id).single();
    if (row && row.status !== "pending") finish(row);
    else { doll.classList.remove("rendering"); toast("Still waiting on the bot.", true); }
    sb.removeChannel(chan);
  }, RENDER_WAIT_MS);
}

/* ---------- save ---------- */
async function save() {
  if (!S.guild) return toast("No server to save to yet.", true);
  const { error } = await sb.from("profiles").upsert({
    discord_id: S.me, guild_id: S.guild, avatar_worn: wire(),
    updated_by: "portal", updated_at: new Date().toISOString(),
  }, { onConflict: "discord_id,guild_id" });
  if (error) return toast("Save failed: " + error.message, true);
  S.saved = JSON.stringify(wire());
  syncSave();
  toast("Saved! Your /avatar will update shortly. ✨");
}

/* ---------- boot ---------- */
async function render(session) {
  S.me = discordIdFromSession(session);
  $("#signInBtn").classList.toggle("hidden", !!session);
  $("#signOutBtn").classList.toggle("hidden", !session);
  if (!session) {
    $("#gate").classList.remove("hidden"); $("#panel").classList.add("hidden");
    return;
  }
  const beta = (CFG.AVATAR_BETA || []).map(String);
  if (beta.length && !beta.includes(String(S.me))) {
    $("#gate").classList.remove("hidden"); $("#panel").classList.add("hidden");
    $("#gateMsg").textContent = "The dressing room is still in testing — not open yet!";
    return;
  }
  $("#gate").classList.add("hidden"); $("#panel").classList.remove("hidden");
  await loadInv();
}

async function boot() {
  $("#signInBtn").onclick = () => sb.auth.signInWithOAuth({
    provider: "discord",
    options: { redirectTo: location.href.split("#")[0], scopes: "identify" },
  });
  $("#signOutBtn").onclick = async () => { await sb.auth.signOut(); location.reload(); };
  $("#saveBtn").onclick = save;
  $("#tone").onchange = (e) => { S.tone = e.target.value; renderPicks(); queueRender(); };
  $("#facing").onchange = (e) => { S.facing = e.target.value; renderPicks(); queueRender(); };
  await loadSlots();
  sb.auth.onAuthStateChange((_e, s) => render(s));
  const { data } = await sb.auth.getSession();
  render(data.session);
}
boot().catch((e) => { console.error(e); $("#gateMsg").textContent = "Load error: " + e.message; });
