/* ============================================================
   CLUBVMK — Player admin. Every mutation is queued into
   admin_actions; the bot drains the queue and writes back a result.
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const ADMIN_IDS = ["886570059974201405"];
const RARITY = ["legendary", "epic", "rare", "uncommon", "common"];
// Every clearable cooldown, in the order /cooldown lists them. Keep in step with
// bot.COOLDOWN_INFO — a key missing here just can't be picked from the dropdown.
const COOLDOWN_KEYS = [
  ["flort", "🌀 Flort"], ["rps", "🪨 RPS"], ["esmeralda", "🔮 Esmeralda"],
  ["slinkydog", "🐕 Slinky Dog"], ["vanellope", "🍭 Vanellope"], ["hades", "🔥 Hades"],
  ["edna", "👓 Edna"], ["presto", "🐰 Presto"], ["petshop", "🐾 Pet shop"],
  ["baymax", "🏥 Baymax"], ["russell", "🎈 Russell"], ["yzma", "🧪 Yzma"],
  ["stitch", "🌀 Stitch"], ["dash", "⚡ Dash"], ["genie", "🧞 Genie"],
  ["walle", "🤖 Wall-E"], ["maleficent", "⚔️ Maleficent"], ["gator", "🐊 Gator"],
  ["scar", "🦁 Scar"], ["ursula", "🐙 Ursula"], ["cinderella", "🥿 Cinderella"],
  ["daily", "📅 Daily"], ["frozen", "❄️ Frozen (Elsa)"],
];

/* "ready in 3h 12m" from the unix second the bot says it frees up. */
function coolLeft(readyAt) {
  const s = Math.round(Number(readyAt) - Date.now() / 1000);
  if (!isFinite(s) || s <= 0) return null;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`;
}
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (n) => Number(n || 0).toLocaleString();
const baseItemId = (id) => (id.includes("*") ? id.slice(0, id.lastIndexOf("*")) : id);

const P = { me: null, players: [], sel: null, catalog: {}, themes: {}, inv: [], q: "",
            invQ: "", invSort: { k: "last_at", dir: -1 }, invTier: "all" };

/* Timestamps arrive as ISO from Postgres. Show them in the admin's own zone —
   the whole point is lining an item up against a Discord message. */
const dtFull = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});
function when(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : dtFull.format(d);
}
function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return "";
  const units = [[86400 * 365, "y"], [86400 * 30, "mo"], [86400, "d"], [3600, "h"], [60, "m"]];
  for (const [secs, label] of units) if (s >= secs) return `${Math.floor(s / secs)}${label} ago`;
  return "just now";
}

let toastT;
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 3600);
}

function discordIdFromSession(session) {
  const u = session?.user; if (!u) return null;
  const m = u.user_metadata || {};
  const ident = (u.identities || []).find((i) => i.provider === "discord") || {};
  return m.provider_id || m.sub || ident.id || ident.identity_data?.provider_id || null;
}

/* ---------- queue a change for the bot ---------- */
async function queueAction(action, payload, label) {
  if (!P.sel) return;
  const { error } = await sb.from("admin_actions").insert({
    action, discord_id: P.sel.discord_id, guild_id: P.sel.guild_id,
    payload, created_by: String(P.me),
  });
  if (error) return toast("Failed: " + error.message, true);
  toast(`Queued: ${label}`);
  // give the bot a moment, then refresh — the list carries the wallet, so it has
  // to be reloaded too or a coin change still shows the old balance
  setTimeout(refreshSelected, 2500);
}

async function refreshSelected() {
  const key = P.sel && `${P.sel.discord_id}|${P.sel.guild_id}`;
  await loadPlayers();
  if (!key) return;
  const fresh = P.players.find((p) => `${p.discord_id}|${p.guild_id}` === key);
  if (fresh) await selectPlayer(fresh);
}

/* ---------- data ---------- */
async function loadStatic() {
  const [cat, themes] = await Promise.all([
    fetch("data/catalog.min.json", { cache: "no-cache" }).then((r) => r.json()),
    fetch("data/themes.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({})),
  ]);
  for (const it of cat) P.catalog[it.id] = it;
  P.themes = themes || {};
  // rarity comes from the curator overrides, same rule as everywhere else
  try {
    const map = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("overrides").select("item_id,tier")
        .order("item_id").range(from, from + 999);
      if (error) throw error;
      for (const o of data || []) map[o.item_id] = o.tier;
      if (!data || data.length < 1000) break;
    }
    for (const id in P.catalog) P.catalog[id].r = map[baseItemId(id)] || "common";
  } catch (e) { /* keep baked rarities */ }
  // after the override pass: custom items aren't in that table, so the
  // "not listed means common" rule above would flatten every one of them
  await window.mergeCustomItems(sb, P.catalog);
}

async function loadPlayers() {
  const { data, error } = await sb.rpc("admin_list_players");
  if (error) {
    $("#note").innerHTML = `⚠️ Player list unavailable — run <code>webportal/schema_admin_actions.sql</code> in Supabase.`;
    return;
  }
  P.players = (data || []).sort((a, b) =>
    (b.items || 0) - (a.items || 0) || String(a.display_name).localeCompare(String(b.display_name)));
  renderList();
}

function renderList() {
  const q = P.q.toLowerCase();
  const rows = P.players.filter((p) =>
    !q || String(p.display_name || "").toLowerCase().includes(q) || p.discord_id.includes(q));
  $("#plist").innerHTML = rows.map((p, i) => {
    const on = P.sel && P.sel.discord_id === p.discord_id && P.sel.guild_id === p.guild_id;
    return `<div class="prow${on ? " on" : ""}" data-i="${i}">
      <span>${esc(p.display_name || p.discord_id)}<br><small>${esc(p.guild_name || p.guild_id)}</small></span>
      <small>${num(p.items)} items<br>🪙${num(p.club_coins)} ❄️${num(p.yeti_credits)}</small></div>`;
  }).join("") || `<p class="muted2">No players found.</p>`;
  $("#plist").querySelectorAll(".prow").forEach((el) => {
    el.onclick = () => selectPlayer(rows[+el.dataset.i]);
  });
}

async function selectPlayer(p, quiet) {
  P.sel = p;
  if (!quiet) renderList();
  // PostgREST caps every response at 1000 rows — page through, or a big
  // collection (5k+ uniques) silently loses everything past the first page.
  const inv = [];
  let failed = false;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.rpc("admin_player_items",
      { target: p.discord_id, guild: p.guild_id })
      .order("item_id").range(from, from + 999);
    if (error) { failed = true; break; }
    inv.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  P.inv = failed ? [] : inv;
  renderDetail();
  if (!quiet) renderList();
}

/* ---------- item pickers ----------
   A <datalist> renders the option's VALUE in bold and its text content
   underneath, so the value has to be the friendly name — otherwise the list
   reads as "clothing:74086". Names are unique for ~98% of the catalogue; the
   handful that collide get their id appended so they stay resolvable. */
// Some catalogue names carry stray leading/trailing spaces, so always compare
// trimmed — otherwise those items could never be matched back from the input.
const itemName = (it) => String(it.n || it.id || "").trim();

function pickerValue(it, dupeNames) {
  const n = itemName(it);
  return dupeNames.has(n) ? `${n}  (${it.id})` : n;
}

function resolveItemId(text, pool) {
  const t = (text || "").trim();
  if (!t) return null;
  if (P.catalog[t]) return t;                       // a raw id was typed
  const m = t.match(/\(([^)]+)\)\s*$/);             // "Name  (pin:1234)"
  if (m && P.catalog[m[1]]) return m[1];
  const hits = pool.filter((it) => itemName(it) === t);
  return hits.length === 1 ? hits[0].id : null;
}

function wireItemPicker(inputId, listId, poolFn, counts) {
  const input = $("#" + inputId), list = $("#" + listId);
  if (!input || !list) return;
  const refresh = () => {
    const q = input.value.trim().toLowerCase();
    const pool = poolFn();
    const seen = {}, dupes = new Set();
    for (const it of pool) {
      const n = itemName(it);
      if (seen[n]) dupes.add(n); else seen[n] = 1;
    }
    const rows = (q ? pool.filter((it) => itemName(it).toLowerCase().includes(q)) : pool)
      .slice(0, 60);   // datalists get sluggish past a few dozen entries
    list.innerHTML = rows.map((it) => {
      const c = counts ? counts[it.id] : null;
      return `<option value="${esc(pickerValue(it, dupes))}">${c ? `×${c} owned` : ""}</option>`;
    }).join("");
  };
  input.oninput = refresh;
  refresh();
}

const ownedPool = () => P.inv.map((r) => P.catalog[r.item_id] || { id: r.item_id, n: r.item_id })
                             .filter(Boolean);
const allPool = () => Object.values(P.catalog);
// custom items carry an absolute bucket URL; everything else is a local filename
const imgUrl = (f) => (/^https?:/.test(f) ? f : CFG.ITEM_IMG_BASE + f);

/* ---------- full inventory, with when each item was picked up ---------- */
function invRows() {
  const q = P.invQ.toLowerCase();
  let rows = P.inv.map((r) => {
    const it = P.catalog[r.item_id] || {};
    return {
      id: r.item_id,
      name: (it.n || "").trim() || r.item_id,
      tier: it.r || "common",
      img: it.img || "",
      count: Number(r.count || 0),
      first_at: r.first_at || null,
      last_at: r.last_at || null,
    };
  });
  if (P.invTier !== "all") rows = rows.filter((r) => r.tier === P.invTier);
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) ||
                                   r.id.toLowerCase().includes(q));
  const { k, dir } = P.invSort;
  return rows.sort((a, b) => {
    let x = a[k], y = b[k];
    if (k === "first_at" || k === "last_at") {
      // never-recorded timestamps sort to the bottom whichever way the column runs
      x = x ? Date.parse(x) : -Infinity; y = y ? Date.parse(y) : -Infinity;
    } else if (k === "tier") {
      x = RARITY.indexOf(a.tier); y = RARITY.indexOf(b.tier);
    }
    if (typeof x === "string") return dir * x.localeCompare(y);
    return dir * ((x > y) - (x < y));
  });
}

function renderInventory() {
  const rows = invRows();
  const copies = rows.reduce((n, r) => n + r.count, 0);
  const missing = rows.some((r) => !r.first_at);
  $("#invCount").textContent =
    `${num(rows.length)} unique · ${num(copies)} copies`;
  $("#invBody").innerHTML = rows.map((r) => `<tr>
      <td class="ic">${r.img ? `<img loading="lazy" src="${esc(imgUrl(r.img))}" alt="" />` : ""}</td>
      <td>${esc(r.name)}<br><small class="muted2">${esc(r.id)}</small></td>
      <td><span class="tier t-${esc(r.tier)}">${esc(r.tier)}</span></td>
      <td class="num">${r.count > 1 ? `×${num(r.count)}` : "1"}</td>
      <td>${esc(when(r.first_at))}<br><small class="muted2">${esc(ago(r.first_at))}</small></td>
      <td>${r.count > 1 || r.last_at ? esc(when(r.last_at)) : "—"}
        <br><small class="muted2">${esc(r.count > 1 || r.last_at ? ago(r.last_at) : "")}</small></td>
    </tr>`).join("") ||
    `<tr><td colspan="6" class="muted2">Nothing matches that filter.</td></tr>`;
  $("#invNote").innerHTML = missing
    ? `Some rows have no date yet — run <code>webportal/schema_player_item_times.sql</code>
       in Supabase, then wait for the next inventory change to sync.`
    : "";
}

function wireInventory() {
  $("#invSearch").oninput = (e) => { P.invQ = e.target.value.trim(); renderInventory(); };
  $("#invTier").onchange = (e) => { P.invTier = e.target.value; renderInventory(); };
  $("#invTbl").querySelectorAll("th[data-k]").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.k;
      // first click on a new column sorts descending — newest / most / rarest first
      P.invSort = P.invSort.k === k ? { k, dir: -P.invSort.dir } : { k, dir: -1 };
      renderInventory();
    };
  });
}

/* Cooldown picker for one player: anything currently running is listed first
   with how long is left, so the one you came to clear is the one at the top. */
function cooldownOptions(p) {
  const live = (p && p.cooldowns) || {};
  const running = [], idle = [];
  for (const [key, label] of COOLDOWN_KEYS) {
    const left = live[key] != null ? coolLeft(live[key]) : null;
    (left ? running : idle).push(
      `<option value="${esc(key)}">${esc(label)}${left ? ` — ${left} left` : ""}</option>`);
  }
  const n = running.length;
  return `<option value="all">🧹 All${n ? ` (${n} running)` : " (none running)"}</option>`
    + (running.length ? `<optgroup label="On cooldown now">${running.join("")}</optgroup>` : "")
    + `<optgroup label="Not running">${idle.join("")}</optgroup>`;
}

/* Is an Elsa freeze running on this player? The bot mirrors it in `cooldowns`
   like any other timer, so it's the same "ready at" unix second — here it's when
   they thaw. The mirror runs every ~45s, so treat this as "as of last sync" and
   never gate the thaw button on it. */
function freezeState(p) {
  const left = coolLeft(((p && p.cooldowns) || {}).frozen);
  return left
    ? { on: true, text: `❄️ <b>Frozen</b> — thaws in about ${esc(left)}.` }
    : { on: false, text: "☀️ Not frozen as of the last sync (~45s)." };
}

/* ---------- detail + tools ---------- */
function renderDetail() {
  const p = P.sel;
  const frz = freezeState(p);
  const total = P.inv.reduce((n, r) => n + Number(r.count || 0), 0);
  const byTier = {};
  for (const r of P.inv) {
    const it = P.catalog[r.item_id];
    if (it) byTier[it.r] = (byTier[it.r] || 0) + Number(r.count || 0);
  }
  const themeOpts = Object.entries(P.themes)
    .map(([k, t]) => `<option value="${esc(k)}">${esc(t.name || k)}</option>`).join("");

  $("#detail").innerHTML = `
    <div class="who"><h2>${esc(p.display_name || p.discord_id)}</h2>
      <span class="muted2">${esc(p.guild_name || p.guild_id)}</span>
      <span class="muted2">· id ${esc(p.discord_id)}</span>
      ${frz.on ? `<span class="muted2">· ❄️ frozen</span>` : ""}</div>
    <div class="stats">
      <div class="stat wallet"><div class="v">${num(p.club_coins)}</div><div class="k">🪙 Club Coins</div></div>
      <div class="stat wallet"><div class="v">${num(p.yeti_credits)}</div><div class="k">❄️ Yeti Credits</div></div>
      <div class="stat"><div class="v">${num(total)}</div><div class="k">Copies</div></div>
      <div class="stat"><div class="v">${num(P.inv.length)}</div><div class="k">Unique</div></div>
      ${RARITY.map((r) => `<div class="stat"><div class="v">${num(byTier[r] || 0)}</div>
        <div class="k">${r}</div></div>`).join("")}
    </div>

    <details class="invbox" id="invBox">
      <summary>🎒 Inventory <span class="muted2" id="invCount"></span></summary>
      <div class="row" style="margin:10px 0 8px">
        <label class="fld grow"><span>Find an item</span>
          <input id="invSearch" type="text" placeholder="Name or id…" /></label>
        <label class="fld"><span>Rarity</span>
          <select id="invTier"><option value="all">All</option>
            ${RARITY.map((r) => `<option value="${r}">${r}</option>`).join("")}</select></label>
      </div>
      <p class="hintline" id="invNote"></p>
      <div class="invwrap"><table id="invTbl"><thead><tr>
        <th></th>
        <th data-k="name">Item</th>
        <th data-k="tier">Rarity</th>
        <th data-k="count" class="num">Copies</th>
        <th data-k="first_at">First acquired</th>
        <th data-k="last_at">Latest copy</th>
      </tr></thead><tbody id="invBody"></tbody></table></div>
    </details>

    <div class="tools">
      <div class="tool">
        <h3>💸 Refund a purchase</h3>
        <p>Takes the item back and returns Club Coins — for a double-buy in the shop.</p>
        <div class="row">
          <label class="fld grow"><span>Item they own</span>
            <input id="rfItem" type="text" list="ownedList" placeholder="Start typing a name…" /></label>
          <label class="fld"><span>Copies to take</span>
            <input id="rfQty" type="number" value="1" min="1" /></label>
          <label class="fld"><span>🪙 Coins to return</span>
            <input id="rfCoins" type="number" value="0" min="0" /></label>
          <button class="btn gold" id="rfGo">Refund</button>
        </div>
        <label class="ann"><input type="checkbox" id="rfAnn" checked /> Announce in the server
          <span class="muted2">— keeps the correction transparent</span></label>
        <input id="rfNote" class="notein" type="text" maxlength="300"
               placeholder="Add a message to the announcement (optional)" />
      </div>

      <div class="tool">
        <h3>🎁 Give / take items</h3>
        <p>Give works on any item in the catalogue; take only on what they hold.</p>
        <div class="row">
          <label class="fld grow"><span>Item</span>
            <input id="giItem" type="text" list="allList" placeholder="Start typing a name…" /></label>
          <label class="fld"><span>Quantity</span>
            <input id="giQty" type="number" value="1" min="1" max="100" /></label>
          <button class="btn" id="giGive">Give</button>
          <button class="btn danger" id="giTake">Take</button>
        </div>
        <label class="ann"><input type="checkbox" id="giAnn" /> Announce in the server</label>
        <input id="giNote" class="notein" type="text" maxlength="300"
               placeholder="Add a message to the announcement (optional)" />
      </div>

      <div class="tool">
        <h3>🎁 Gift a crate</h3>
        <p>Posts a crate in the spawn channel with this player's name on it — only they can
          open it, and the pull is announced for everyone to see.</p>
        <div class="row">
          <label class="fld"><span>Rarity</span>
            <select id="crTier">
              ${RARITY.map((r) => `<option value="${r}"${r === "legendary" ? " selected" : ""}>${r}</option>`).join("")}
              ${/* prizes are usually promised as "rare or better", so a crate can
                    be too — otherwise honouring one means picking a single tier
                    and being either stingy or too generous */ ""}
              <optgroup label="or better">
                ${RARITY.filter((r) => r !== "legendary")
                        .map((r) => `<option value="${r}plus">${r} or better</option>`).join("")}
              </optgroup>
            </select></label>
          <button class="btn gold" id="crGo">Send crate</button>
        </div>
        <input id="crNote" class="notein" type="text" maxlength="300"
               placeholder="Note shown on the crate — e.g. why they're getting it (optional)" />
      </div>

      <div class="tool">
        <h3>🪙 Adjust coins</h3>
        <p>Negative removes. The bot refuses to take a balance below zero.</p>
        <div class="row">
          <label class="fld"><span>Currency</span>
            <select id="cKind"><option value="club">🪙 Club Coins</option>
              <option value="yeti">❄️ Yeti Credits</option></select></label>
          <label class="fld"><span>Amount (+ / −)</span>
            <input id="cAmt" type="number" value="0" /></label>
          <button class="btn" id="cGo">Apply</button>
        </div>
        <label class="ann"><input type="checkbox" id="cAnn" /> Announce in the server</label>
        <input id="cNote" class="notein" type="text" maxlength="300"
               placeholder="Add a message to the announcement (optional)" />
      </div>

      <div class="tool">
        <h3>🎨 Themes</h3>
        <div class="row">
          <label class="fld grow"><span>Theme</span>
            <select id="thKey">${themeOpts}</select></label>
          <button class="btn" id="thGrant">Grant</button>
          <button class="btn danger" id="thRevoke">Revoke</button>
        </div>
        <label class="ann"><input type="checkbox" id="thAnn" checked /> Announce in the server</label>
        <input id="thNote" class="notein" type="text" maxlength="300"
               placeholder="Add a message to the announcement (optional)" />
      </div>

      <div class="tool">
        <h3>⏱️ Clear cooldown</h3>
        <p>Give back a cooldown a bug or an outage ate. Announce it so the server
          knows why they're going again.</p>
        <div class="row">
          <label class="fld grow"><span>Cooldown</span>
            <select id="cdKey">${cooldownOptions(p)}</select></label>
          <button class="btn" id="cdGo">Clear</button>
        </div>
        <label class="ann"><input type="checkbox" id="cdAnn" /> Announce in the server</label>
        <input id="cdNote" class="notein" type="text" maxlength="300"
               placeholder="Add a message to the announcement (optional)" />
      </div>

      <div class="tool">
        <h3>❄️ Clear a freeze</h3>
        <p>Thaw an Elsa freeze early, without making them spend a Baymax heal on it.</p>
        <p class="hintline">${frz.text}</p>
        <div class="row">
          <button class="btn${frz.on ? " gold" : ""}" id="frzGo">Thaw now</button>
        </div>
        <label class="ann"><input type="checkbox" id="frzAnn" checked /> Announce in the server
          <span class="muted2">— they were frozen in public, so the thaw reads better in public too</span></label>
        <input id="frzNote" class="notein" type="text" maxlength="300"
               placeholder="Add a message to the announcement (optional)" />
      </div>
    </div>

    <datalist id="ownedList"></datalist>
    <datalist id="allList"></datalist>`;

  // populated live as you type, so the whole catalogue is reachable without
  // putting 14k <option> nodes in the DOM
  const counts = {};
  for (const r of P.inv) counts[r.item_id] = r.count;
  wireItemPicker("rfItem", "ownedList", ownedPool, counts);
  wireItemPicker("giItem", "allList", allPool, null);
  wireInventory();
  renderInventory();
  // an open inventory stays open across the refresh that follows a give/take
  if (P.invOpen) $("#invBox").open = true;
  $("#invBox").addEventListener("toggle", () => { P.invOpen = $("#invBox").open; });

  const v = (id) => $("#" + id).value.trim();
  const n = (id) => Number($("#" + id).value || 0);
  const ann = (id) => $("#" + id).checked;      // announce publicly in Discord?
  // free-text line quoted under the standard announcement wording; only sent
  // when that action is actually being announced
  const note = (annId, id) => (ann(annId) ? v(id) : "");
  // the note only does anything alongside a tick, so mirror the checkbox state
  for (const [a, nId] of [["rfAnn", "rfNote"], ["giAnn", "giNote"],
                          ["cAnn", "cNote"], ["thAnn", "thNote"],
                          ["cdAnn", "cdNote"], ["frzAnn", "frzNote"]]) {
    const box = $("#" + a), input = $("#" + nId);
    const sync = () => { input.disabled = !box.checked; };
    box.addEventListener("change", sync);
    sync();
  }
  // the inputs hold friendly names — turn them back into ids before queueing
  const itemFrom = (inputId, pool) => {
    const raw = v(inputId);
    if (!raw) { toast("Pick an item first", true); return null; }
    const id = resolveItemId(raw, pool());
    if (!id) toast(`Couldn't match "${raw}" to an item — pick one from the list.`, true);
    return id;
  };
  $("#rfGo").onclick = () => {
    const id = itemFrom("rfItem", ownedPool); if (!id) return;
    queueAction("refund", { item_id: id, qty: n("rfQty") || 1,
                            coins: n("rfCoins"), announce: ann("rfAnn"),
                            note: note("rfAnn", "rfNote") },
                `refund ${P.catalog[id]?.n || id}`);
  };
  $("#giGive").onclick = () => {
    const id = itemFrom("giItem", allPool); if (!id) return;
    queueAction("give", { item_id: id, qty: n("giQty") || 1, announce: ann("giAnn"),
                          note: note("giAnn", "giNote") },
                `give ${P.catalog[id]?.n || id}`);
  };
  $("#giTake").onclick = () => {
    const id = itemFrom("giItem", allPool); if (!id) return;
    queueAction("take", { item_id: id, qty: n("giQty") || 1, announce: ann("giAnn"),
                          note: note("giAnn", "giNote") },
                `take ${P.catalog[id]?.n || id}`);
  };
  // the crate post is public by its nature, so its note needs no announce tick
  $("#crGo").onclick = () => queueAction("crate", { rarity: v("crTier"), note: v("crNote") },
                                         `${v("crTier")} crate`);
  $("#cGo").onclick = () => n("cAmt")
    ? queueAction("coins", { kind: v("cKind"), amount: n("cAmt"), announce: ann("cAnn"),
                             note: note("cAnn", "cNote") },
                  `${v("cKind")} ${n("cAmt")}`)
    : toast("Enter a non-zero amount", true);
  $("#thGrant").onclick = () => queueAction("theme", { theme: v("thKey"), announce: ann("thAnn"),
                                                       note: note("thAnn", "thNote") },
                                            `grant ${v("thKey")}`);
  $("#thRevoke").onclick = () => queueAction("theme", { theme: v("thKey"), revoke: true,
                                                        announce: ann("thAnn"),
                                                        note: note("thAnn", "thNote") },
                                             `revoke ${v("thKey")}`);
  $("#cdGo").onclick = () => queueAction("cooldown",
                                         { key: v("cdKey") || "all", announce: ann("cdAnn"),
                                           note: note("cdAnn", "cdNote") },
                                         `clear ${v("cdKey") || "all"}`);
  // Same queue action as any cooldown — a freeze is stored as the "frozen" timer,
  // so clearing it is exactly what /baymax does to thaw someone.
  $("#frzGo").onclick = () => queueAction("cooldown",
                                          { key: "frozen", announce: ann("frzAnn"),
                                            note: note("frzAnn", "frzNote") },
                                          "thaw freeze");
}

/* ---------- boot ---------- */
async function render(session) {
  const id = discordIdFromSession(session);
  P.me = id;
  const isAdmin = id && ADMIN_IDS.includes(String(id));
  if (!session || !isAdmin) {
    $("#gate").style.display = ""; $("#panel").style.display = "none";
    if (session && !isAdmin) {
      $("#signInBtn").style.display = "none";
      $("#gateMsg").textContent = `This account isn't an admin. (${id || "no id"})`;
    }
    return;
  }
  $("#gate").style.display = "none"; $("#panel").style.display = "";
  await loadStatic();
  await loadPlayers();
}

async function boot() {
  $("#signInBtn").onclick = () => sb.auth.signInWithOAuth({
    provider: "discord",
    options: { redirectTo: location.href.split("#")[0], scopes: "identify" },
  });
  $("#signOutBtn").onclick = async (e) => { e.preventDefault(); await sb.auth.signOut(); location.reload(); };
  $("#search").oninput = (e) => { P.q = e.target.value.trim(); renderList(); };
  sb.auth.onAuthStateChange((_e, s) => render(s));
  const { data } = await sb.auth.getSession();
  render(data.session);
}
boot();
