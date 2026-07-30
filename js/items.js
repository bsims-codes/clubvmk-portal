/* ============================================================
   CLUBVMK — Custom Items admin.

   Upload art, name it, pick a rarity. The art is squared and shrunk in the
   browser (item sprites are tiny; a phone photo would be megabytes) and
   uploaded to the custom-items bucket; the row is the bot's to-do item. The
   bot merges it into its live catalogue on the next sync and flips status.
   ============================================================ */
const CFG = window.CLUBVMK;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const ADMIN_IDS = ["886570059974201405"];
const MAX_PX = 512;              // longest edge of the stored art
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const S = { me: null, blob: null, items: [] };

let toastT;
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 3800);
}

function discordIdFromSession(session) {
  const u = session?.user; if (!u) return null;
  const m = u.user_metadata || {};
  const ident = (u.identities || []).find((i) => i.provider === "discord") || {};
  return m.provider_id || m.sub || ident.id || ident.identity_data?.provider_id || null;
}

/* ---------- name -> id ----------
   The id is what Discord autocomplete, trades and the profile card key off, so
   it has to be stable and url-safe. Derived from the name once, at creation. */
function slugify(name) {
  return String(name || "").toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
const itemIdFor = (name) => (slugify(name) ? `custom:${slugify(name)}` : "");

/* ---------- image ----------
   Squared on a transparent canvas so wildly different aspect ratios still line
   up in the inventory grid and on the card, then capped at MAX_PX. */
function squareShrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(MAX_PX, Math.max(img.width, img.height));
      const cv = document.createElement("canvas");
      cv.width = cv.height = side;
      const ctx = cv.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      const scale = Math.min(side / img.width, side / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (side - w) / 2, (side - h) / 2, w, h);
      URL.revokeObjectURL(url);
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode the image"))),
                "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("that file isn't an image")); };
    img.src = url;
  });
}

async function takeFile(file) {
  if (!file) return;
  try {
    const blob = await squareShrink(file);
    S.blob = blob;
    $("#preview").src = URL.createObjectURL(blob);
    $("#preview").style.display = "";
    $("#dropMsg").style.display = "none";
    $("#imgInfo").textContent =
      `${Math.round(blob.size / 1024)} KB · squared to ${MAX_PX}px · click to replace`;
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- create ---------- */
async function createItem() {
  const name = $("#name").value.trim();
  const id = itemIdFor(name);
  if (!S.blob) return toast("Add an image first", true);
  if (!name) return toast("Give it a name", true);
  if (!id) return toast("That name has no letters or numbers in it", true);
  if (S.items.some((i) => i.id === id)) return toast("An item with that name already exists", true);

  const btn = $("#create");
  btn.disabled = true; btn.textContent = "Creating…";
  try {
    // content-addressed enough to never collide, and replacing art later just
    // means uploading under a new name
    const imageName = `${slugify(name)}-${Date.now().toString(36)}.png`;
    const up = await sb.storage.from("custom-items")
      .upload(imageName, S.blob, { contentType: "image/png", upsert: true });
    if (up.error) throw up.error;

    const { error } = await sb.from("custom_items").insert({
      id, name, rarity: $("#rarity").value,
      category: $("#category").value.trim() || "custom",
      image_name: imageName,
      spawnable: $("#spawnable").checked,
      created_by: String(S.me),
    });
    if (error) throw error;

    toast(`Created ${name} — live in the bot within ~2 min`);
    $("#name").value = ""; $("#idPrev").textContent = "—";
    S.blob = null;
    $("#preview").style.display = "none"; $("#dropMsg").style.display = "";
    $("#imgInfo").textContent = "";
    $("#file").value = "";
    await loadItems();
  } catch (e) {
    toast("Failed: " + (e.message || e), true);
  } finally {
    btn.disabled = false; btn.textContent = "Create item";
  }
}

async function setActive(id, active) {
  const { error } = await sb.from("custom_items").update({ active }).eq("id", id);
  if (error) return toast("Failed: " + error.message, true);
  toast(active ? "Restored" : "Retired");
  await loadItems();
}

/* ---------- list ---------- */
async function loadItems() {
  const { data, error } = await sb.from("custom_items")
    .select("id,name,rarity,category,image_name,spawnable,active,status,result,created_at")
    .order("created_at", { ascending: false });
  if (error) {
    $("#note").innerHTML = `⚠️ Custom items unavailable — run
      <code>webportal/schema_custom_items.sql</code> in Supabase, then refresh.`;
    return;
  }
  $("#note").innerHTML = "";
  S.items = data || [];
  $("#count").textContent = S.items.length ? `· ${S.items.length}` : "";
  $("#list").innerHTML = S.items.map((it) => {
    const stat = it.status === "done" ? `<span class="pill ok">live</span>`
      : it.status === "error" ? `<span class="pill bad" title="${esc(it.result || "")}">error</span>`
      : `<span class="pill warn">waiting for the bot</span>`;
    return `<div class="irow">
      <img src="${esc(window.customItemUrl(it.image_name))}" alt="" loading="lazy" />
      <div class="meta">
        <div class="nm">${esc(it.name)}</div>
        <small>${esc(it.id)} · ${esc(it.category)}</small>
      </div>
      <span class="tier t-${esc(it.rarity)}">${esc(it.rarity)}</span>
      ${it.spawnable ? `<span class="pill">drops</span>` : `<span class="pill">hand-out only</span>`}
      ${it.active ? stat : `<span class="pill">retired</span>`}
      <button class="btn ${it.active ? "danger" : ""}" data-id="${esc(it.id)}"
              data-on="${it.active ? "0" : "1"}">${it.active ? "Retire" : "Restore"}</button>
    </div>`;
  }).join("") || `<p class="muted2">No custom items yet.</p>`;
  $("#list").querySelectorAll("button[data-id]").forEach((b) => {
    b.onclick = () => setActive(b.dataset.id, b.dataset.on === "1");
  });
}

/* ---------- boot ---------- */
async function render(session) {
  const id = discordIdFromSession(session);
  S.me = id;
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
  await loadItems();
}

async function boot() {
  $("#signInBtn").onclick = () => sb.auth.signInWithOAuth({
    provider: "discord",
    options: { redirectTo: location.href.split("#")[0], scopes: "identify" },
  });
  $("#signOutBtn").onclick = async (e) => { e.preventDefault(); await sb.auth.signOut(); location.reload(); };

  const drop = $("#drop");
  drop.onclick = () => $("#file").click();
  $("#file").onchange = (e) => takeFile(e.target.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => {
    e.preventDefault(); drop.classList.remove("over");
    takeFile(e.dataTransfer.files[0]);
  };
  $("#name").oninput = () => { $("#idPrev").textContent = itemIdFor($("#name").value) || "—"; };
  $("#create").onclick = createItem;

  sb.auth.onAuthStateChange((_e, s) => render(s));
  const { data } = await sb.auth.getSession();
  render(data.session);
}
boot();
