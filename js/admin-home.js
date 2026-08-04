/* ============================================================
   CLUBVMK — Admin home: hub tiles + the recent action queue
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const ADMIN_IDS = ["886570059974201405"];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function discordIdFromSession(session) {
  const u = session?.user;
  if (!u) return null;
  const m = u.user_metadata || {};
  const ident = (u.identities || []).find((i) => i.provider === "discord") || {};
  return m.provider_id || m.sub || ident.id || ident.identity_data?.provider_id || null;
}

async function render(session) {
  const id = discordIdFromSession(session);
  const isAdmin = id && ADMIN_IDS.includes(String(id));
  if (!session) {
    $("#gate").style.display = ""; $("#panel").style.display = "none";
    $("#gateMsg").textContent = "Sign in with Discord to continue.";
    return;
  }
  if (!isAdmin) {
    $("#gate").style.display = ""; $("#panel").style.display = "none";
    $("#signInBtn").style.display = "none";
    $("#gateMsg").textContent = `This account isn't an admin. (${id || "no id"})`;
    return;
  }
  $("#gate").style.display = "none"; $("#panel").style.display = "";
  A.me = id;
  loadGuilds();
  loadQueue();
}

/* ---------- announcements ---------- */
const A = { me: null, paused: false };

async function loadGuilds() {
  const { data, error } = await sb.rpc("admin_list_players");
  const seen = {};
  for (const r of (error ? [] : data || [])) seen[r.guild_id] = r.guild_name || r.guild_id;
  const opts = Object.entries(seen);
  const html = (opts.length ? opts : [["", "— no servers found —"]])
    .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join("")
    + `<option value="">All servers</option>`;
  // every tool here picks a server the same way
  for (const sel of [$("#annGuild"), $("#lrGuild"), $("#pzGuild")]) if (sel) sel.innerHTML = html;
  // the pause switch is per-server, so it has to re-read when the server changes
  const pz = $("#pzGuild");
  if (pz) {
    pz.value = opts.length ? opts[0][0] : "";
    pz.onchange = loadPauseState;
    loadPauseState();
  }
}

/* ---------- pause switch ---------- */
// The bot owns this state and only mirrors it after its queue loop picks the
// action up (~6s), so the switch never reports success from the click alone —
// it polls guild_state until the bot agrees, and says "applying…" until then.
async function readPaused(gid) {
  const { data, error } = await sb.from("guild_state")
    .select("paused").eq("guild_id", gid).maybeSingle();
  if (error) return null;         // table missing, or no read access
  return data ? !!data.paused : false;   // no row yet = the bot has never paused it
}

function paintPause(paused, pending) {
  const btn = $("#pzToggle"), lbl = $("#pzLabel");
  // aria-checked tracks SPAWNING (on = checked), so knob-right/green reads as
  // "running" the way a switch labelled "Spawning" should
  btn.setAttribute("aria-checked", String(!paused));
  lbl.innerHTML = pending
    ? `<span class="muted2">applying…</span>`
    : (paused ? `Spawning is <b>paused</b>` : `Spawning is <b>on</b>`);
}

async function loadPauseState() {
  const gid = $("#pzGuild").value;
  const btn = $("#pzToggle");
  if (!gid) { btn.disabled = true; return; }
  const paused = await readPaused(gid);
  if (paused === null) {
    btn.disabled = true;
    $("#pzLabel").innerHTML =
      `<span class="muted2">Run <code>webportal/schema_guild_state.sql</code> to enable this.</span>`;
    return;
  }
  A.paused = paused;
  btn.disabled = false;
  paintPause(paused, false);
}

async function togglePause() {
  const gid = $("#pzGuild").value;
  if (!gid) return toast("Pick a server first", true);
  const next = !A.paused;
  const btn = $("#pzToggle");
  btn.disabled = true;
  const payload = { paused: next, announce: $("#pzAnn").checked };
  const note = $("#pzNote").value.trim();
  if (note && payload.announce) payload.note = note;
  const { error } = await sb.from("admin_actions").insert({
    action: "pause", discord_id: String(A.me), guild_id: gid,
    payload, created_by: String(A.me),
  });
  if (error) { btn.disabled = false; return toast("Failed: " + error.message, true); }
  paintPause(next, true);
  toast(next ? "Pausing spawns…" : "Resuming spawns…");

  // poll until the bot's mirror matches what we asked for — a single early read
  // lands before the queue loop has run and would show the stale value
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const now = await readPaused(gid);
    if (now === next) {
      A.paused = now;
      btn.disabled = false;
      paintPause(now, false);
      loadQueue();
      return;
    }
  }
  // the bot never confirmed — show what's actually true, not what we hoped
  await loadPauseState();
  loadQueue();
  toast("The bot hasn't confirmed that yet — check it's running.", true);
}

/* ---------- crate vault (any rarity) ---------- */
async function openVault() {
  const mins = Number($("#lrMins").value || 0);
  if (!(mins >= 1 && mins <= 60)) return toast("Pick 1–60 minutes", true);
  const rarity = $("#lrRarity").value || "legendary";
  const payload = { minutes: mins, rarity, host: "the CLUBVMK crew" };
  const ch = $("#lrChannel").value.trim();
  if (ch) payload.channel_id = ch;
  const ping = $("#lrPing").value.trim();
  if (ping) payload.ping_role = ping;
  const note = $("#lrNote") && $("#lrNote").value.trim();
  if (note) payload.note = note;
  const { error } = await sb.from("admin_actions").insert({
    action: "legendary_rush", discord_id: String(A.me),
    guild_id: $("#lrGuild").value || null, payload, created_by: String(A.me),
  });
  if (error) return toast("Failed: " + error.message, true);
  if ($("#lrNote")) $("#lrNote").value = "";
  toast(`Queued — the ${rarity} vault opens for ${mins} min within a few seconds.`);
  setTimeout(loadQueue, 2500);
}

async function sendAnnouncement() {
  const text = $("#annText").value.trim();
  const file = $("#annFile") && $("#annFile").files[0];
  if (!text && !file) return toast("Write a message or attach a file first", true);
  const guild = $("#annGuild").value || null;
  const payload = { text, embed: $("#annEmbed").checked };
  if (file) {
    // Discord's bot upload cap follows the server's boost tier (10 MB
    // unboosted). The bot re-checks against the real limit before posting.
    if (file.size > 100 * 1024 * 1024) return toast("File is over 100 MB", true);
    toast("Uploading " + file.name + "…");
    const name = Date.now() + "_" + file.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const up = await sb.storage.from("announce-media")
      .upload(name, file, { contentType: file.type || "application/octet-stream" });
    if (up.error) return toast("Upload failed: " + up.error.message
      + " (run schema_announce_media.sql?)", true);
    payload.media = name;
  }
  const ch = $("#annChannel").value.trim();
  if (ch) payload.channel_id = ch;
  const title = $("#annTitle").value.trim();
  if (title) payload.title = title;
  const ping = $("#annPing").value.trim();
  if (ping) payload.ping_role = ping;
  const { error } = await sb.from("admin_actions").insert({
    action: "announce", discord_id: String(A.me), guild_id: guild,
    payload, created_by: String(A.me),
  });
  if (error) return toast("Failed: " + error.message, true);
  $("#annText").value = ""; $("#annTitle").value = "";
  if ($("#annFile")) $("#annFile").value = "";
  toast("Queued — the bot will post it within a few seconds.");
  setTimeout(loadQueue, 2500);
}

let toastT;
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 3600);
}

async function loadQueue() {
  const tb = $("#queueTbl").querySelector("tbody");
  const { data, error } = await sb.from("admin_actions")
    .select("action,discord_id,guild_id,payload,status,result,created_at")
    .order("created_at", { ascending: false }).limit(20);
  if (error) {
    tb.innerHTML = `<tr><td colspan="5" class="muted2">Queue unavailable — run
      <code>webportal/schema_admin_actions.sql</code> in Supabase.</td></tr>`;
    return;
  }
  if (!data.length) {
    tb.innerHTML = `<tr><td colspan="5" class="muted2">Nothing yet.</td></tr>`;
    return;
  }
  tb.innerHTML = data.map((r) => {
    const when = new Date(r.created_at).toLocaleString();
    const detail = Object.entries(r.payload || {})
      .map(([k, v]) => `${k}=${v}`).join(" ");
    return `<tr>
      <td class="muted2">${esc(when)}</td>
      <td><b>${esc(r.action)}</b> <span class="muted2">${esc(detail)}</span></td>
      <td class="muted2">${esc(r.discord_id)}</td>
      <td class="muted2">${esc(r.result || "—")}</td>
      <td><span class="pill s-${esc(r.status)}">${esc(r.status)}</span></td>
    </tr>`;
  }).join("");
}

async function boot() {
  $("#signInBtn").onclick = () => sb.auth.signInWithOAuth({
    provider: "discord",
    options: { redirectTo: location.href.split("#")[0], scopes: "identify" },
  });
  $("#signOutBtn").onclick = async (e) => { e.preventDefault(); await sb.auth.signOut(); location.reload(); };
  $("#annSend").onclick = sendAnnouncement;
  $("#lrGo").onclick = openVault;
  $("#pzToggle").onclick = togglePause;
  sb.auth.onAuthStateChange((_e, s) => render(s));
  const { data } = await sb.auth.getSession();
  render(data.session);
  setInterval(() => { if ($("#panel").style.display !== "none") loadQueue(); }, 8000);
}
boot();
