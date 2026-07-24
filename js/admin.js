/* ============================================================
   CLUBVMK — Theme Admin (upload backgrounds, crop/frame, set prices)
   Writes the public.themes table + theme-images bucket. The bot
   hot-loads both every ~2 minutes, so changes go live with no restart.
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const ADMIN_IDS = ["886570059974201405"];   // Discord ids allowed to manage themes
const $ = (s) => document.querySelector(s);
const IMG_BASE = `${CFG.SUPABASE_URL}/storage/v1/object/public/theme-images/`;

const A = { discordId: null, themes: [], editing: null, users: [],
            img: null, crop: null, cropURL: null, rafPending: false };

/* ---------- helpers ---------- */
const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
function toHex(rgb) { return "#" + rgb.map((v) => clamp(v).toString(16).padStart(2, "0")).join(""); }
function fromHex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
function slug(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "theme"; }
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.className = "toast show"; clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 3600); }

/* ---------- auth ---------- */
async function signIn() { await sb.auth.signInWithOAuth({ provider: "discord", options: { redirectTo: location.href.split("#")[0] } }); }
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
  if (!session) { $("#gate").style.display = ""; $("#panel").style.display = "none"; $("#gateMsg").textContent = "Sign in with Discord to manage profile themes."; return; }
  if (!isAdmin) { $("#gate").style.display = ""; $("#panel").style.display = "none"; $("#signInBtn").style.display = "none"; $("#gateMsg").textContent = "This account isn't a theme admin. (" + (A.discordId || "no id") + ")"; return; }
  $("#gate").style.display = "none"; $("#panel").style.display = "";
  await loadThemes();
  loadUsers();   // for the "unlock for a player" picker (best-effort)
}

async function loadUsers() {
  try {
    const { data, error } = await sb.rpc("admin_users");
    if (error) throw error;
    A.users = (data || []).filter((u) => u.discord_id);
  } catch (e) { A.users = []; }
  const sel = $("#grantUser");
  sel.innerHTML = A.users.length
    ? A.users.map((u) => `<option value="${u.discord_id}">${(u.display_name || u.discord_id)}</option>`).join("")
    : `<option value="">(run schema_theme_grants.sql to enable)</option>`;
}

async function grantTheme() {
  const t = A.editing; if (!t) return;
  const uid = $("#grantUser").value;
  if (!uid) return toast("Pick a player (and run schema_theme_grants.sql if the list is empty).");
  const name = (A.users.find((u) => u.discord_id === uid) || {}).display_name || uid;
  const { error } = await sb.from("theme_grants").insert({ discord_id: uid, theme_id: t.id, created_by: String(A.discordId) });
  if (error) return toast("Grant failed: " + error.message);
  toast(`Unlocking "${t.name}" for ${name} — applies within a few seconds.`);
}

/* ---------- data ---------- */
async function loadThemes() {
  const { data, error } = await sb.from("themes").select("*").order("sort");
  if (error) { toast("Load failed: " + error.message); return; }
  A.themes = data || [];
  renderGrid();
}
function bgStyleFor(t) {
  if (t.image_name) return `background-image:url('${IMG_BASE}${t.image_name}')`;
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
  nw.className = "ta-card newcard"; nw.textContent = "+ New theme"; nw.onclick = () => openEditor(null);
  g.appendChild(nw);
  for (const t of A.themes) {
    const c = document.createElement("div");
    c.className = "ta-card";
    c.innerHTML = `<div class="ta-bg" style="${bgStyleFor(t)}"></div>` +
      (t.enabled ? "" : `<div class="ta-off">hidden</div>`) +
      `<div class="ta-meta"><div class="nm">${t.name || t.id}</div><div class="pr">${priceLabel(t)}</div></div>`;
    c.onclick = () => openEditor(t);
    g.appendChild(c);
  }
}

/* ---------- crop / frame tool ---------- */
function showCropper(img) {
  A.img = img;
  $("#dropEmpty").style.display = "none";
  $("#cropWrap").style.display = "";
  const vp = $("#cropVp").getBoundingClientRect();
  const sMin = Math.max(vp.width / img.naturalWidth, vp.height / img.naturalHeight);
  A.crop = { vpW: vp.width, vpH: vp.height, sMin, scale: sMin, panX: 0, panY: 0 };
  // centre
  A.crop.panX = (vp.width - img.naturalWidth * sMin) / 2;
  A.crop.panY = (vp.height - img.naturalHeight * sMin) / 2;
  $("#cropImg").src = img.src;
  $("#cropZoom").value = 1;
  applyCropTransform();
  refreshCropOutput(true);   // sample colours from the initial framing
}
function clampPan() {
  const c = A.crop, dW = A.img.naturalWidth * c.scale, dH = A.img.naturalHeight * c.scale;
  c.panX = Math.min(0, Math.max(c.vpW - dW, c.panX));
  c.panY = Math.min(0, Math.max(c.vpH - dH, c.panY));
}
function applyCropTransform() {
  clampPan();
  const c = A.crop;
  $("#cropImg").style.transform = `translate(${c.panX}px, ${c.panY}px) scale(${c.scale})`;
}
function exportCrop(outW) {
  const c = A.crop, outH = Math.round(outW * 520 / 900);
  const sx = -c.panX / c.scale, sy = -c.panY / c.scale, sW = c.vpW / c.scale, sH = c.vpH / c.scale;
  const cv = document.createElement("canvas"); cv.width = outW; cv.height = outH;
  cv.getContext("2d").drawImage(A.img, sx, sy, sW, sH, 0, 0, outW, outH);
  return cv;
}
function sampleCanvas(cv) {
  const s = document.createElement("canvas"); s.width = 64; s.height = 37;
  const x = s.getContext("2d"); x.drawImage(cv, 0, 0, 64, 37);
  const d = x.getImageData(0, 0, 64, 37).data;
  let r = 0, g = 0, b = 0, n = 0, best = null, bestScore = -1;
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    r += R; g += G; b += B; n++;
    const mx = Math.max(R, G, B), score = (mx - Math.min(R, G, B)) * 0.7 + mx * 0.3;
    if (mx > 45 && mx < 245 && score > bestScore) { bestScore = score; best = [R, G, B]; }
  }
  const avg = [r / n, g / n, b / n], scale = (c, f) => c.map((v) => clamp(v * f));
  let accent = best || avg; const mx = Math.max(...accent);
  if (mx < 185) accent = accent.map((v) => clamp(v * (185 / (mx || 1))));
  return { bg: scale(avg, 0.16), panel: scale(avg, 0.30), accent: accent.map(clamp) };
}
function refreshCropOutput(sample) {
  const cv = exportCrop(540);
  if (sample) {
    try {
      const s = sampleCanvas(cv);
      $("#edBg").value = toHex(s.bg); $("#edPanel").value = toHex(s.panel); $("#edAccent").value = toHex(s.accent);
      $("#sampleHint").textContent = "· auto-sampled (tweak below)";
    } catch (e) { $("#sampleHint").textContent = "· set colours manually"; }
  }
  A.cropURL = cv.toDataURL("image/jpeg", 0.86);
  refreshPreview();
}
function scheduleCropOutput() {
  if (A.rafPending) return;
  A.rafPending = true;
  requestAnimationFrame(() => { A.rafPending = false; refreshCropOutput(false); });
}

/* pan by dragging */
function initDrag() {
  const vp = $("#cropVp"); let dragging = false, lx = 0, ly = 0;
  vp.addEventListener("pointerdown", (e) => { if (!A.crop) return; dragging = true; lx = e.clientX; ly = e.clientY; vp.classList.add("drag"); vp.setPointerCapture(e.pointerId); });
  vp.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    A.crop.panX += e.clientX - lx; A.crop.panY += e.clientY - ly; lx = e.clientX; ly = e.clientY;
    applyCropTransform(); scheduleCropOutput();
  });
  const end = (e) => { if (dragging) { dragging = false; vp.classList.remove("drag"); try { vp.releasePointerCapture(e.pointerId); } catch (_) {} refreshCropOutput(false); } };
  vp.addEventListener("pointerup", end); vp.addEventListener("pointercancel", end);
}

/* ---------- live preview ---------- */
function refreshPreview() {
  const card = $("#pvCard");
  card.style.setProperty("--accent", $("#edAccent").value);
  card.style.setProperty("--panel", $("#edPanel").value);
  card.style.setProperty("--bg", $("#edBg").value);
  $("#pvName").textContent = $("#edName").value.trim() || "Collector";
  $("#pvDim").style.opacity = A.hasBgImage() ? $("#edDim").value : 0;
  const bg = $("#pvBg");
  if (A.cropURL) bg.style.cssText = `background-image:url('${A.cropURL}')`;
  else if (A.editing && A.editing.image_name) bg.style.cssText = `background-image:url('${IMG_BASE}${A.editing.image_name}')`;
  else if (A.editing && A.editing.grad) bg.style.cssText = `background:linear-gradient(160deg,rgb(${A.editing.grad[0]}),rgb(${A.editing.grad[1]}))`;
  else bg.style.cssText = `background:${$("#edBg").value}`;
}
A.hasBgImage = () => !!(A.cropURL || (A.editing && A.editing.image_name));

/* ---------- editor ---------- */
function openEditor(t) {
  A.editing = t; A.img = null; A.crop = null; A.cropURL = null;
  $("#edTitle").textContent = t ? `Edit — ${t.name}` : "New theme";
  $("#delBtn").style.display = t ? "" : "none";
  $("#grantFld").style.display = t ? "" : "none";   // grant only after a theme has an id
  $("#sampleHint").textContent = "";
  $("#cropWrap").style.display = "none";
  $("#dropEmpty").style.display = "";
  $("#file").value = "";
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
  refreshPreview();
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

function onFile(file) {
  if (!file) return;
  A.newFile = file;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => showCropper(img);   // keep the object URL alive for the cropper canvas
  img.src = url;
}

async function save() {
  const name = $("#edName").value.trim();
  if (!name) return toast("Give the theme a name.");
  const editing = A.editing;
  if (!editing && !A.img) return toast("Upload a background image for a new theme.");
  const id = editing ? editing.id : uniqueId(slug(name));
  const uType = $("#edUnlockType").value;
  const costNum = parseInt($("#edCost").value || "0", 10);

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
    if (A.img && A.crop) {
      // export the framed crop (already at the card's 900:520 aspect) as a JPEG
      const blob = await new Promise((res) => exportCrop(1350).toBlob(res, "image/jpeg", 0.9));
      const fname = `${id}_${Date.now()}.jpg`;
      const up = await sb.storage.from("theme-images").upload(fname, blob, { contentType: "image/jpeg", upsert: true });
      if (up.error) throw up.error;
      row.image_name = fname; row.fx = "image"; row.animated = false; row.grad = null;
    }
    const { error } = await sb.from("themes").upsert(row, { onConflict: "id" });
    if (error) throw error;
    toast(`Saved "${name}" — live in Discord within ~2 min.`);
    closeEditor(); await loadThemes();
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
  const t = A.editing; if (!t) return;
  if (!confirm(`Delete theme "${t.name}"? Players who own it will fall back to Classic.`)) return;
  const { error } = await sb.from("themes").delete().eq("id", t.id);
  if (error) return toast("Delete failed: " + error.message);
  toast(`Deleted "${t.name}".`); closeEditor(); await loadThemes();
}

/* ---------- boot ---------- */
async function boot() {
  $("#signInBtn").onclick = signIn;
  $("#signOutBtn").onclick = signOut;
  $("#newBtn").onclick = () => openEditor(null);
  $("#cancelBtn").onclick = closeEditor;
  $("#saveBtn").onclick = save;
  $("#delBtn").onclick = del;
  $("#grantBtn").onclick = grantTheme;
  $("#dropEmpty").onclick = () => $("#file").click();
  $("#cropChange").onclick = () => $("#file").click();
  $("#file").onchange = (e) => onFile(e.target.files[0]);
  $("#cropZoom").oninput = (e) => { if (!A.crop) return; A.crop.scale = A.crop.sMin * parseFloat(e.target.value); applyCropTransform(); scheduleCropOutput(); };
  $("#edUnlockType").onchange = syncUnlockFields;
  $("#edDim").oninput = (e) => { $("#dimVal").textContent = (+e.target.value).toFixed(2); refreshPreview(); };
  for (const id of ["edName", "edBg", "edPanel", "edAccent"]) $("#" + id).addEventListener("input", refreshPreview);
  $("#overlay").onclick = (e) => { if (e.target.id === "overlay") closeEditor(); };
  initDrag();

  sb.auth.onAuthStateChange((_e, session) => render(session));
  const { data } = await sb.auth.getSession();
  render(data.session);
}
boot();
