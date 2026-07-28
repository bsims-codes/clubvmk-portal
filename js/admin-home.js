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
const A = { me: null };

async function loadGuilds() {
  const { data, error } = await sb.rpc("admin_list_players");
  const seen = {};
  for (const r of (error ? [] : data || [])) seen[r.guild_id] = r.guild_name || r.guild_id;
  const opts = Object.entries(seen);
  const html = (opts.length ? opts : [["", "— no servers found —"]])
    .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join("")
    + `<option value="">All servers</option>`;
  // the announcement and vault tools both pick a server the same way
  for (const sel of [$("#annGuild"), $("#lrGuild")]) if (sel) sel.innerHTML = html;
}

/* ---------- legendary crate vault ---------- */
async function openVault() {
  const mins = Number($("#lrMins").value || 0);
  if (!(mins >= 1 && mins <= 60)) return toast("Pick 1–60 minutes", true);
  const payload = { minutes: mins, host: "the CLUBVMK crew" };
  const ch = $("#lrChannel").value.trim();
  if (ch) payload.channel_id = ch;
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
  sb.auth.onAuthStateChange((_e, s) => render(s));
  const { data } = await sb.auth.getSession();
  render(data.session);
  setInterval(() => { if ($("#panel").style.display !== "none") loadQueue(); }, 8000);
}
boot();
