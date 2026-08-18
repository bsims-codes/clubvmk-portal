/* ============================================================
   CLUBVMK — Reports: triage queue for player-filed /report rows

   Read through admin_list_reports() (security definer + an admin check, so the
   anon key alone can't enumerate other people's reports). Writes go straight to
   the table under the admin RLS policy, and always set updated_by='portal' —
   that flag is what the bot's apply loop watches for. Without it the change
   would sit here and never reach SQLite, which is the source of truth.
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const ADMIN_IDS = ["886570059974201405"];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let toastT;
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 3600);
}

function discordIdFromSession(session) {
  const u = session?.user;
  if (!u) return null;
  const m = u.user_metadata || {};
  const ident = (u.identities || []).find((i) => i.provider === "discord") || {};
  return m.provider_id || m.sub || ident.id || ident.identity_data?.provider_id || null;
}

const KINDS = { bug: "🐛 Bug", request: "💡 Request", idea: "✨ Idea" };
// Order doubles as the filter bar and as "how far along" a report is.
const STATUSES = ["open", "triaged", "planned", "building", "shipped", "declined"];
const R = { rows: [], filter: "open" };

function when(ts) {
  const d = new Date(ts);
  const days = (Date.now() - d) / 86400000;
  if (days < 1) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days < 7) return `${Math.floor(days)}d ago`;
  return d.toLocaleDateString();
}

function triageHtml(t) {
  if (!t || typeof t !== "object") return "";
  // Show whatever triage wrote, in a stable order, without hard-coding a schema
  // it might grow out of.
  const order = ["severity", "effort", "verdict", "cause", "notes"];
  const keys = [...order.filter((k) => t[k]), ...Object.keys(t).filter((k) => !order.includes(k))];
  if (!keys.length) return "";
  return `<div class="triage"><h3>Triage</h3><dl>${keys.map((k) =>
    `<dt>${esc(k)}</dt><dd>${esc(
      typeof t[k] === "object" ? JSON.stringify(t[k]) : t[k])}</dd>`).join("")}</dl></div>`;
}

function repHtml(r) {
  const terminal = r.status === "shipped" || r.status === "declined";
  return `<article class="rep ${r.status === "open" ? "is-open" : ""}" data-id="${r.local_id}">
    <div class="rhead">
      <h2>${esc(r.title)}</h2>
      <span class="pill k-${esc(r.kind)}">${esc(KINDS[r.kind] || r.kind)}</span>
      <span class="pill s-${esc(r.status)}">${esc(r.status)}</span>
    </div>
    <p class="rmeta"><span class="rid">#${r.local_id}</span> ·
      ${esc(r.user_name || r.discord_id)} · ${esc(when(r.ts))}
      ${r.announced ? " · <span title=\"the reporter has been told\">📣 announced</span>" : ""}</p>
    <p class="rbody">${esc(r.body)}</p>
    ${triageHtml(r.triage)}
    ${r.resolution ? `<p class="rres"><b>Resolution:</b> ${esc(r.resolution)}</p>` : ""}
    ${terminal ? `<p class="hint">Already resolved. Changing it again won't re-post
       — the reporter is only ever told once.</p>` : `
    <div class="racts">
      <input type="text" class="res" placeholder="Note for the reporter (posted publicly)…"
             value="${esc(r.resolution || "")}" />
      <button class="btn sm" data-act="planned">Plan</button>
      <button class="btn sm" data-act="declined">Decline</button>
      <button class="btn sm gold" data-act="shipped">Ship</button>
    </div>`}
  </article>`;
}

function paint() {
  const counts = {};
  for (const r of R.rows) counts[r.status] = (counts[r.status] || 0) + 1;
  $("#filters").innerHTML = [["all", "All"], ...STATUSES.map((s) => [s, s])]
    .map(([key, label]) => {
      const n = key === "all" ? R.rows.length : (counts[key] || 0);
      return `<button data-f="${key}" aria-pressed="${R.filter === key}">${esc(label)}
        <span class="count">${n}</span></button>`;
    }).join("");

  const shown = R.rows.filter((r) => R.filter === "all" || r.status === R.filter);
  $("#list").innerHTML = shown.length
    ? shown.map(repHtml).join("")
    : `<div class="empty">Nothing ${R.filter === "all" ? "here" : `in <b>${esc(R.filter)}</b>`} right now.</div>`;
}

async function load() {
  const { data, error } = await sb.rpc("admin_list_reports", { filter: null });
  if (error) {
    $("#list").innerHTML = `<div class="empty">Reports unavailable — run
      <code>webportal/schema_reports.sql</code> in Supabase.<br />
      <span class="muted2">${esc(error.message)}</span></div>`;
    return;
  }
  R.rows = data || [];
  paint();
}

async function setStatus(id, status, resolution) {
  if ((status === "shipped" || status === "declined") && !resolution.trim()) {
    return toast("Add a note first — it gets posted to the reporter.", true);
  }
  // updated_by='portal' is the handshake: the bot consumes the row, writes it
  // into SQLite and clears the flag. Setting status alone would go nowhere.
  const patch = { status, updated_by: "portal" };
  if (resolution.trim()) patch.resolution = resolution.trim();
  const { error } = await sb.from("reports").update(patch).eq("local_id", id);
  if (error) return toast("Failed: " + error.message, true);
  toast(status === "shipped" || status === "declined"
    ? "Saved — the bot will post about it shortly."
    : `Marked ${status}.`);
  load();
}

function wire() {
  $("#filters").onclick = (e) => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    R.filter = b.dataset.f;
    paint();
  };
  $("#list").onclick = (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const card = b.closest(".rep");
    b.disabled = true;
    setStatus(Number(card.dataset.id), b.dataset.act,
              card.querySelector(".res").value || "")
      .finally(() => { b.disabled = false; });
  };
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
  load();
}

async function boot() {
  $("#signInBtn").onclick = () => sb.auth.signInWithOAuth({
    provider: "discord",
    options: { redirectTo: location.href.split("#")[0], scopes: "identify" },
  });
  $("#signOutBtn").onclick = async (e) => {
    e.preventDefault(); await sb.auth.signOut(); location.reload();
  };
  wire();
  sb.auth.onAuthStateChange((_e, s) => render(s));
  const { data } = await sb.auth.getSession();
  render(data.session);
  setInterval(() => { if ($("#panel").style.display !== "none") load(); }, 15000);
}
boot();
