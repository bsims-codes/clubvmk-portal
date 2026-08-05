/* ============================================================
   CLUBVMK — Supporters admin: the Buy Me a Coffee pipeline.
   Reads/writes public.supporter_events (the webhook queue the bot
   drains every minute) and public.supporter_config (the reward
   tiers the bot re-reads every ~5 minutes).
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const ADMIN_IDS = ["886570059974201405"];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const A = { me: null, events: [], filter: "all" };

let toastT;
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 3600);
}

/* ---------- auth ---------- */
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
  loadEvents();
  loadConfig();
}

/* ============================================================
   A. Donations list
   ============================================================ */
async function loadEvents() {
  const { data, error } = await sb.from("supporter_events")
    .select("id,event_id,type,amount,currency,supporter_name,supporter_email,message,discord_id,status,note,created_at,processed_at")
    .order("created_at", { ascending: false }).limit(200);
  if (error) {
    $("#donTbl").querySelector("tbody").innerHTML =
      `<tr><td colspan="8" class="muted2">Load failed: ${esc(error.message)}</td></tr>`;
    return;
  }
  A.events = data || [];
  renderEvents();
}

function fmtAmount(r) {
  if (r.amount == null) return "—";
  const cur = (r.currency || "USD").toUpperCase();
  const n = Number(r.amount);
  return (cur === "USD" ? "$" : cur + " ") + (Number.isFinite(n) ? n.toFixed(2) : r.amount);
}

function renderEvents() {
  const tb = $("#donTbl").querySelector("tbody");
  const rows = A.filter === "all" ? A.events : A.events.filter((r) => r.status === A.filter);
  // chip counts
  const counts = {};
  for (const r of A.events) counts[r.status] = (counts[r.status] || 0) + 1;
  document.querySelectorAll("#chips .chip[data-f]").forEach((c) => {
    const f = c.dataset.f;
    const n = f === "all" ? A.events.length : (counts[f] || 0);
    c.innerHTML = `${f[0].toUpperCase()}${f.slice(1)}<span class="n">${n}</span>`;
    c.classList.toggle("on", f === A.filter);
  });
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="8" class="muted2">${A.events.length ? "Nothing with that status." : "No donations yet."}</td></tr>`;
    return;
  }
  tb.innerHTML = rows.map((r) => {
    const when = new Date(r.created_at).toLocaleString();
    const um = r.status === "unmatched";
    const who = `<div class="don-who"><b>${esc(r.supporter_name || "—")}</b>` +
      (r.supporter_email ? `<span>${esc(r.supporter_email)}</span>` : "") + `</div>`;
    return `<tr class="${um ? "unmatched-row" : ""}" data-id="${esc(r.id)}">
      <td class="muted2" style="white-space:nowrap">${esc(when)}</td>
      <td class="muted2">${esc(r.type || "—")}</td>
      <td class="amt">${esc(fmtAmount(r))}</td>
      <td>${who}</td>
      <td><div class="don-msg">${esc(r.message || "—")}</div></td>
      <td><div class="idcell">
        <input type="text" class="rq-id" value="${esc(r.discord_id || "")}"
               placeholder="paste Discord id" />
        <button class="btn small requeue" data-id="${esc(r.id)}">Requeue</button>
      </div></td>
      <td><span class="pill s-${esc(r.status)}">${esc(r.status)}</span></td>
      <td class="muted2" style="max-width:180px">${esc(r.note || "—")}</td>
    </tr>`;
  }).join("");
  tb.querySelectorAll(".requeue").forEach((b) => (b.onclick = () => requeue(b)));
}

async function requeue(btn) {
  const tr = btn.closest("tr");
  const id = tr.dataset.id;
  const uid = tr.querySelector(".rq-id").value.trim();
  if (!uid) return toast("Paste the player's Discord id first", true);
  if (!/^\d{15,21}$/.test(uid)) return toast("That doesn't look like a Discord id (15–21 digits)", true);
  btn.disabled = true;
  const { error } = await sb.from("supporter_events")
    .update({ discord_id: uid, status: "pending", note: null })
    .eq("id", id);
  btn.disabled = false;
  if (error) return toast("Requeue failed: " + error.message, true);
  toast("Requeued — the bot grants it within a minute.");
  loadEvents();
}

/* ============================================================
   B. Manual grant
   ============================================================ */
async function manualGrant() {
  const uid = $("#mgId").value.trim();
  const amt = parseFloat($("#mgAmt").value);
  const kind = $("#mgKind").value;
  if (!/^\d{15,21}$/.test(uid)) return toast("That doesn't look like a Discord id (15–21 digits)", true);
  if (!(amt > 0)) return toast("Enter the USD amount", true);
  $("#mgGo").disabled = true;
  const { error } = await sb.from("supporter_events").insert({
    event_id: "manual_" + Date.now(),
    type: kind === "membership" ? "membership.manual" : "donation.manual",
    amount: amt,
    currency: "USD",
    supporter_name: "(manual)",
    discord_id: uid,
    status: "pending",
    note: "manual grant from admin portal",
  });
  $("#mgGo").disabled = false;
  if (error) return toast("Failed: " + error.message, true);
  $("#mgId").value = ""; $("#mgAmt").value = "";
  toast("Queued — the bot applies the matching tier within a minute.");
  loadEvents();
}

/* ============================================================
   C. Reward config editor
   ============================================================ */
const DEFAULT_CONFIG = {
  sub_days: 33,
  subs: [
    { min: 10, tier: 2, badge: "VIP", club: 50, yeti: 25, crates: { legendary: 5 },
      cd_scale: 0.5, daily_mult: 2.0, mybg: true, themes: ["wishes"] },
    { min: 5, tier: 1, badge: "SUPPORTER", club: 30, yeti: 15, crates: { legendary: 1 } },
  ],
  gifts: [
    { min: 25, club: 40, yeti: 25, crates: { legendary: 6 }, boost_days: 90,
      cd_scale: 0.67, daily_mult: 1.5, mybg: true },
    { min: 16, club: 30, yeti: 20, crates: { legendary: 4 } },
    { min: 6, club: 25, yeti: 10, crates: { epicplus: 2 }, themes: ["wishes"] },
    { min: 0.01, club: 15, yeti: 5, crates: { epicplus: 1 } },
  ],
};

async function loadConfig() {
  const { data, error } = await sb.from("supporter_config")
    .select("config").eq("id", 1).maybeSingle();
  $("#cfgLoading").style.display = "none";
  if (error) {
    $("#cfgLoading").style.display = "";
    $("#cfgLoading").textContent = "Config unavailable: " + error.message;
    return;
  }
  if (!data || !data.config) {
    $("#cfgMissing").style.display = "";
    $("#cfgEditor").style.display = "none";
    return;
  }
  $("#cfgMissing").style.display = "none";
  $("#cfgEditor").style.display = "";
  paintConfig(data.config);
}

function paintConfig(cfg) {
  $("#cfgSubDays").value = cfg.sub_days ?? 33;
  const subsTb = $("#subsTbl").querySelector("tbody");
  const giftsTb = $("#giftsTbl").querySelector("tbody");
  subsTb.innerHTML = ""; giftsTb.innerHTML = "";
  for (const t of cfg.subs || []) subsTb.insertAdjacentHTML("beforeend", tierRowHTML(t, true));
  for (const t of cfg.gifts || []) giftsTb.insertAdjacentHTML("beforeend", tierRowHTML(t, false));
  wireRemoveButtons();
}

// A number input whose value is blank when the tier doesn't carry the key —
// blank/0 means "omit from the saved json".
function numCell(key, val, opts = {}) {
  const v = val == null ? "" : val;
  return `<td><input type="number" data-k="${key}" value="${esc(v)}"
    min="0" step="${opts.step || 1}" class="${opts.narrow ? "narrow" : ""}"
    placeholder="${opts.ph || "—"}" /></td>`;
}

function tierRowHTML(t, isSub) {
  const crates = t.crates || {};
  // Stash the whole original tier on the row: keys this editor has no inputs
  // for (frames, pets, gift badges, future additions) survive a Save intact.
  let h = `<tr data-orig="${esc(JSON.stringify(t))}">`;
  h += numCell("min", t.min, { step: 0.01 });
  if (isSub) {
    h += numCell("tier", t.tier, { narrow: true });
    h += `<td><input type="text" data-k="badge" value="${esc(t.badge || "")}" placeholder="—" style="width:96px" /></td>`;
  }
  h += numCell("club", t.club);
  h += numCell("yeti", t.yeti);
  h += numCell("legendary", crates.legendary, { narrow: true });
  h += numCell("epicplus", crates.epicplus, { narrow: true });
  if (!isSub) h += numCell("boost_days", t.boost_days, { narrow: true });
  // gifts table puts boost_days before cd_scale to match its header order
  h += numCell("cd_scale", t.cd_scale, { step: 0.01, narrow: true });
  h += numCell("daily_mult", t.daily_mult, { step: 0.1, narrow: true });
  h += `<td style="text-align:center"><input type="checkbox" data-k="mybg" ${t.mybg ? "checked" : ""} /></td>`;
  h += `<td><input type="text" data-k="themes" value="${esc((t.themes || []).join(", "))}" placeholder="—" /></td>`;
  h += `<td><button class="btn small rm" title="Remove tier">✕</button></td>`;
  h += `</tr>`;
  return h;
}

function wireRemoveButtons() {
  document.querySelectorAll(".cfg-tbl .rm").forEach((b) => {
    b.onclick = () => b.closest("tr").remove();
  });
}

function addTierRow(isSub) {
  const tb = $(isSub ? "#subsTbl" : "#giftsTbl").querySelector("tbody");
  tb.insertAdjacentHTML("beforeend", tierRowHTML({ min: 0 }, isSub));
  wireRemoveButtons();
}

// Read one <tr> back into a tier object, keeping the jsonb shape the bot
// expects: keys are omitted when empty/zero (never null) — except "min",
// which is always written. The crates object only exists when a count > 0.
function readTierRow(tr, isSub) {
  const get = (k) => tr.querySelector(`[data-k="${k}"]`);
  const num = (k) => { const v = parseFloat(get(k)?.value); return Number.isFinite(v) ? v : 0; };
  // Start from the stashed original so keys without editor inputs are kept,
  // then clear every managed key and re-set it from the DOM below.
  let orig = {};
  try { orig = JSON.parse(tr.dataset.orig || "{}"); } catch (e) {}
  const t = { ...orig };
  for (const k of ["min", "tier", "club", "yeti", "crates", "boost_days",
                   "cd_scale", "daily_mult", "mybg", "themes"]) delete t[k];
  if (isSub) delete t.badge;   // gift badges have no input; keep the stashed one
  t.min = num("min");
  if (isSub) {
    const tier = num("tier"); if (tier > 0) t.tier = tier;
    const badge = get("badge").value.trim(); if (badge) t.badge = badge;
  }
  const club = num("club"); if (club > 0) t.club = club;
  const yeti = num("yeti"); if (yeti > 0) t.yeti = yeti;
  const crates = {};
  const leg = num("legendary"); if (leg > 0) crates.legendary = leg;
  const ep = num("epicplus"); if (ep > 0) crates.epicplus = ep;
  if (Object.keys(crates).length) t.crates = crates;
  if (!isSub) { const bd = num("boost_days"); if (bd > 0) t.boost_days = bd; }
  const cd = num("cd_scale"); if (cd > 0) t.cd_scale = cd;
  const dm = num("daily_mult"); if (dm > 0) t.daily_mult = dm;
  if (get("mybg").checked) t.mybg = true;
  const themes = get("themes").value.split(",").map((s) => s.trim()).filter(Boolean);
  if (themes.length) t.themes = themes;
  return t;
}

function buildConfig() {
  const subDays = parseInt($("#cfgSubDays").value, 10);
  const readAll = (sel, isSub) =>
    [...$(sel).querySelectorAll("tbody tr")].map((tr) => readTierRow(tr, isSub));
  // highest tier first — the bot takes the first tier whose min the amount clears
  const byMinDesc = (a, b) => b.min - a.min;
  return {
    sub_days: Number.isFinite(subDays) && subDays > 0 ? subDays : 33,
    subs: readAll("#subsTbl", true).sort(byMinDesc),
    gifts: readAll("#giftsTbl", false).sort(byMinDesc),
  };
}

async function saveConfig() {
  const config = buildConfig();
  for (const t of [...config.subs, ...config.gifts]) {
    if (!(t.min > 0)) return toast("Every tier needs a min amount above 0", true);
  }
  $("#cfgSave").disabled = true;
  const { error } = await sb.from("supporter_config").upsert({
    id: 1, config, updated_by: "admin-portal", updated_at: new Date().toISOString(),
  }, { onConflict: "id" });
  $("#cfgSave").disabled = false;
  if (error) return toast("Save failed: " + error.message, true);
  toast("Saved — the bot re-reads it within ~5 minutes.");
  paintConfig(config);   // re-render so the omit-empty normalisation shows
}

async function createDefaults() {
  $("#cfgCreate").disabled = true;
  const { error } = await sb.from("supporter_config").upsert({
    id: 1, config: DEFAULT_CONFIG, updated_by: "admin-portal", updated_at: new Date().toISOString(),
  }, { onConflict: "id" });
  $("#cfgCreate").disabled = false;
  if (error) return toast("Create failed: " + error.message, true);
  toast("Default config created.");
  loadConfig();
}

/* ---------- boot ---------- */
async function boot() {
  $("#signInBtn").onclick = () => sb.auth.signInWithOAuth({
    provider: "discord",
    options: { redirectTo: location.href.split("#")[0], scopes: "identify" },
  });
  $("#signOutBtn").onclick = async (e) => { e.preventDefault(); await sb.auth.signOut(); location.reload(); };
  document.querySelectorAll("#chips .chip[data-f]").forEach((c) => {
    c.onclick = () => { A.filter = c.dataset.f; renderEvents(); };
  });
  $("#refreshBtn").onclick = loadEvents;
  $("#mgGo").onclick = manualGrant;
  $("#cfgSave").onclick = saveConfig;
  $("#cfgCreate").onclick = createDefaults;
  $("#subsAdd").onclick = () => addTierRow(true);
  $("#giftsAdd").onclick = () => addTierRow(false);

  sb.auth.onAuthStateChange((_e, s) => render(s));
  const { data } = await sb.auth.getSession();
  render(data.session);
  // auto-refresh the donations list — but never yank a half-typed Discord id
  // out from under the admin, so skip while focus is inside the table
  setInterval(() => {
    if ($("#panel").style.display === "none") return;
    if ($("#donTbl").contains(document.activeElement)) return;
    loadEvents();
  }, 30000);
}
boot();
