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
// Reflects `paused` from the profiles mirror; the bot is the source of truth, so
// the switch always redraws from a fresh read rather than assuming it worked.
async function loadPauseState() {
  const gid = $("#pzGuild").value;
  const btn = $("#pzToggle");
  btn.disabled = true;
  let paused = false;
  try {
    const { data } = await sb.from("guild_state").select("paused").eq("guild_id", gid).maybeSingle();
    paused = !!data?.paused;
  } catch (e) { /* guild_state not created yet — show it as running */ }
  A.paused = paused;
  btn.setAttribute("aria-checked", String(paused));
  btn.disabled = !gid;
  $("#pzLabel").innerHTML = paused
    ? `Spawning is <b>paused</b>` : `Spawning is <b>on</b>`;
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
  A.paused = next;
  btn.setAttribute("aria-checked", String(next));
  $("#pzLabel").innerHTML = next
    ? `Pausing…` : `Resuming…`;
  toast(next ? "Pausing spawns…" : "Resuming spawns…");
  setTimeout(() => { loadPauseState(); loadQueue(); }, 2500);
}

/* ---------- legendary crate vault ---------- */
async function openVault() {
  const mins = Number($("#lrMins").value || 0);
  if (!(mins >= 1 && mins <= 60)) return toast("Pick 1–60 minutes", true);
  const payload = { minutes: mins, host: "the CLUBVMK crew" };
  const ch = $("#lrChannel").value.trim();
  if (ch) payload.channel_id = ch;
  const ping = $("#lrPing").value.trim();
  if (ping) payload.ping_role = ping;
  const { error } = await sb.from("admin_actions").insert({
    action: "legendary_rush", discord_id: String(A.me),
    guild_id: $("#lrGuild").value || null, payload, created_by: String(A.me),
  });
  if (error) return toast("Failed: " + error.message, true);
  toast(`Queued — the vault opens for ${mins} min within a few seconds.`);
  setTimeout(loadQueue, 2500);
}

async function sendAnnouncement() {
  const text = $("#annText").value.trim();
  if (!text) return toast("Write a message first", true);
  const guild = $("#annGuild").value || null;
  const payload = { text, embed: $("#annEmbed").checked };
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
