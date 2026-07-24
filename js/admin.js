/* ============================================================
   CLUBVMK — Theme Admin (upload backgrounds, set prices)
   Writes the public.themes table + theme-images bucket. The bot
   hot-loads both every ~2 minutes, so changes go live with no restart.
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const ADMIN_IDS = ["886570059974201405"];   // Discord ids allowed to manage themes
const $ = (s) => document.querySelector(s);

const A = { discordId: null, themes: [], editing: null, newFile: null, newSample: null };

/* ---------- helpers ---------- */
const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
function toHex(rgb) { return "#" + rgb.map((v) => clamp(v).toString(16).padStart(2, "0")).join(""); }
function fromHex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
function slug(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "theme"; }
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.className = "toast show"; clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 3400); }

/* ---------- auth ---------- */
async function signIn() {
  await sb.auth.signInWithOAuth({ provider: "discord", options: { redirectTo: location.href.split("#")[0] } });
}
async function signOut() { await sb.auth.signOut(); location.reload(); }

function discordIdFromSession(session) {
  if (!session) return null;
  const ident = (session.user?.identities || []).find((i) => i.provider === "discord") || {};
  return ident.provider_id || ident.identity_data?.provider_id || session.user?.user_metadata?.provider_id || session.user?.user_metadata?.sub || null;
}

async function render(session) {
  A.discordId = discordIdFromSession(session);
  const isAdmin = A.discordId && ADMIN_IDS.includes(String(A.discordId));
  $("#whoami").textContent = session ? (isAdmin ? "Admin" : "Signed in") : "";
  if (!session) {
    $("#gate").style.display = ""; $("#panel").style.display = "none";
    $("#gateMsg").textContent = "Sign in with Discord to manage profile themes.";
    return;
  }
  if (!isAdmin) {
    $("#gate").style.display = ""; $("#panel").style.display = "none";
    $("#signInBtn").style.display = "none";
    $("#gateMsg").textContent = "This account isn't a theme admin. (" + (A.discordId || "no id") + ")";
    return;
  }
  $("#gate").style.display = "none"; $("#panel").style.display = "";
  await loadThemes();
}

/* ---------- data ---------- */
async function loadThemes() {
  const { data, error } = await sb.from("themes").select("*").order("sort");
  if (error) { toast("Load failed: " + error.message); return; }
  A.themes = data || [];
  renderGrid();
}

function bgStyle(t) {
  if (t.image_name) return `background-image:url('${CFG.SUPABASE_URL}/storage/v1/object/public/theme-images/${t.image_name}')`;
  if (t.grad) return `background:linear-gradient(160deg,rgb(${t.grad[0]}),rgb(${t.grad[1]}))`;
  return `background:rgb(${t.bg})`;
}
function priceLabel(t) {
  const u = t.unlock_type;
  if (u === "club") return `🪙 ${t.cost ?? 0}`;
  if (u === "buy") return `❄️ ${t.cost ?? 0}`;
  if (u === "total") return `${t.unlock_value ?? 0} items`;
  if (u === "rarity") return `${t.unlock_value ?? 0} ${t.unlock_tier || ""}`;
  return "free";
}

function renderGrid() {
  const g = $("#grid"); g.innerHTML = "";
  const nw = document.createElement("div");
  nw.className = "ta-card newcard"; nw.textContent = "+ New theme";
  nw.onclick = () => openEditor(null);
  g.appendChild(nw);
  for (const t of A.themes) {
    const c = document.createElement("div");
    c.className = "ta-card";
    c.innerHTML = `<div class="ta-bg" style="${bgStyle(t)}"></div>` +
      (t.enabled ? "" : `<div class="ta-off">hidden</div>`) +
      `<div class="ta-meta"><div class="nm">${(t.name || t.id)}</div><div class="pr">${priceLabel(t)}</div></div>`;
    c.onclick = () => openEditor(t);
    g.appendChild(c);
  }
}

/* ---------- colour sampling ---------- */
function sampleImage(img) {
  const c = document.createElement("canvas"); c.width = 64; c.height = 64;
  const x = c.getContext("2d"); x.drawImage(img, 0, 0, 64, 64);
  const d = x.getImageData(0, 0, 64, 64).data;
  let r = 0, g = 0, b = 0, n = 0, best = null, bestScore = -1;
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    r += R; g += G; b += B; n++;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    const score = (mx - mn) * 0.7 + mx * 0.3;    // saturated + bright wins
    if (mx > 45 && mx < 245 && score > bestScore) { bestScore = score; best = [R, G, B]; }
  }
  const avg = [r / n, g / n, b / n];
  const scale = (c, f) => c.map((v) => clamp(v * f));
  let accent = best || avg;
  const mx = Math.max(...accent);
  if (mx < 185) accent = accent.map((v) => clamp(v * (185 / (mx || 1))));   // lift dim accents
  return { bg: scale(avg, 0.16), panel: scale(avg, 0.30), accent: accent.map(clamp) };
}

/* ---------- editor ---------- */
function openEditor(t) {
  A.editing = t; A.newFile = null; A.newSample = null;
  $("#edTitle").textContent = t ? `Edit — ${t.name}` : "New theme";
  $("#delBtn").style.display = t ? "" : "none";
  $("#sampleHint").textContent = "";
  const drop = $("#drop");
  if (t && t.image_name) {
    drop.classList.add("hasimg");
    drop.innerHTML = `<img src="${CFG.SUPABASE_URL}/storage/v1/object/public/theme-images/${t.image_name}" />`;
  } else {
    drop.classList.remove("hasimg");
    drop.innerHTML = `Click to upload a background image<br><span class="hint">JPG / PNG / WebP — colours auto-sample from it</span>`;
  }
  $("#edName").value = t ? (t.name || "") : "";
  $("#edBg").value = toHex(t ? t.bg : [16, 18, 34]);
  $("#edPanel").value = toHex(t ? t.panel : [28, 32, 58]);
  $("#edAccent").value = toHex(t ? t.accent : [240, 186, 84]);
  const dim = t && t.dim != null ? t.dim : 0.5;
  $("#edDim").value = dim; $("#dimVal").textContent = (+dim).toFixed(2);
  $("#edUnlockType").value = t ? (t.unlock_type || "club") : "club";
  $("#edCost").value = t && t.cost != null ? t.cost : 5;
  $("#edTier").value = t && t.unlock_tier ? t.unlock_tier : "legendary";
  if (t && t.unlock_type === "total") $("#edCost").value = t.unlock_value ?? 50;
  if (t && t.unlock_type === "rarity") $("#edCost").value = t.unlock_value ?? 5;
  $("#edSort").value = t && t.sort != null ? t.sort : 100;
  $("#edEnabled").value = t ? String(!!t.enabled) : "true";
  syncUnlockFields();
  $("#overlay").classList.add("on");
}
function closeEditor() { $("#overlay").classList.remove("on"); }

function syncUnlockFields() {
  const u = $("#edUnlockType").value;
  $("#costFld").style.display = u === "default" ? "none" : "";
  $("#tierFld").style.display = u === "rarity" ? "" : "none";
  $("#costLbl").textContent = u === "club" ? "Price (Club Coins)" : u === "buy" ? "Price (Yeti Credits)"
    : u === "total" ? "Items required" : u === "rarity" ? "Count required" : "";
}

async function onFile(file) {
  if (!file) return;
  A.newFile = file;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const drop = $("#drop");
    drop.classList.add("hasimg");
    drop.innerHTML = ""; drop.appendChild(img.cloneNode());
    try {
      const s = sampleImage(img);
      A.newSample = s;
      $("#edBg").value = toHex(s.bg); $("#edPanel").value = toHex(s.panel); $("#edAccent").value = toHex(s.accent);
      $("#sampleHint").textContent = "· auto-sampled (tweak below)";
    } catch (e) { $("#sampleHint").textContent = "· couldn't sample (set manually)"; }
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

async function save() {
  const name = $("#edName").value.trim();
  if (!name) return toast("Give the theme a name.");
  const editing = A.editing;
  if (!editing && !A.newFile) return toast("Upload a background image for a new theme.");
  const id = editing ? editing.id : uniqueId(slug(name));
  const uType = $("#edUnlockType").value;
  const costNum = parseInt($("#edCost").value || "0", 10);

  // start from the existing row so procedural themes keep fx/grad/animated
  const row = Object.assign({}, editing || {}, {
    id, name,
    bg: fromHex($("#edBg").value), panel: fromHex($("#edPanel").value), accent: fromHex($("#edAccent").value),
    dim: parseFloat($("#edDim").value),
    unlock_type: uType,
    cost: (uType === "club" || uType === "buy") ? costNum : null,
    unlock_value: uType === "total" ? costNum : uType === "rarity" ? costNum : null,
    unlock_tier: uType === "rarity" ? $("#edTier").value : null,
    sort: parseInt($("#edSort").value || "100", 10),
    enabled: $("#edEnabled").value === "true",
    updated_by: String(A.discordId),
    updated_at: new Date().toISOString(),
  });
  if (!editing) { row.fx = "image"; row.animated = false; row.grad = null; }

  $("#saveBtn").disabled = true;
  try {
    if (A.newFile) {
      const ext = (A.newFile.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      const fname = `${id}_${Date.now()}.${ext}`;
      const up = await sb.storage.from("theme-images").upload(fname, A.newFile, { contentType: A.newFile.type || "image/jpeg", upsert: true });
      if (up.error) throw up.error;
      row.image_name = fname;
      row.fx = "image";      // an uploaded background is always a clean image theme
      row.animated = false;
      row.grad = null;
    }
    const { error } = await sb.from("themes").upsert(row, { onConflict: "id" });
    if (error) throw error;
    toast(`Saved "${name}" — live in Discord within ~2 min.`);
    closeEditor();
    await loadThemes();
  } catch (e) {
    toast("Save failed: " + (e.message || e));
  } finally {
    $("#saveBtn").disabled = false;
  }
}

function uniqueId(base) {
  const ids = new Set(A.themes.map((t) => t.id));
  if (!ids.has(base)) return base;
  let i = 2; while (ids.has(base + i)) i++;
  return base + i;
}

async function del() {
  const t = A.editing;
  if (!t) return;
  if (!confirm(`Delete theme "${t.name}"? Players who own it will fall back to Classic.`)) return;
  const { error } = await sb.from("themes").delete().eq("id", t.id);
  if (error) return toast("Delete failed: " + error.message);
  toast(`Deleted "${t.name}".`);
  closeEditor();
  await loadThemes();
}

/* ---------- boot ---------- */
async function boot() {
  $("#signInBtn").onclick = signIn;
  $("#signOutBtn").onclick = signOut;
  $("#newBtn").onclick = () => openEditor(null);
  $("#cancelBtn").onclick = closeEditor;
  $("#saveBtn").onclick = save;
  $("#delBtn").onclick = del;
  $("#drop").onclick = () => $("#file").click();
  $("#file").onchange = (e) => onFile(e.target.files[0]);
  $("#edUnlockType").onchange = syncUnlockFields;
  $("#edDim").oninput = (e) => ($("#dimVal").textContent = (+e.target.value).toFixed(2));
  $("#overlay").onclick = (e) => { if (e.target.id === "overlay") closeEditor(); };

  sb.auth.onAuthStateChange((_e, session) => render(session));
  const { data } = await sb.auth.getSession();
  render(data.session);
}
boot();
