/* ============================================================
   CLUBVMK — custom items made from the Custom Items admin page.

   They aren't in data/catalog.min.json (that's generated from the bot's
   items.json), so every page that resolves an item id has to fold them in
   after loading the static catalogue. Their art lives in a Supabase bucket
   rather than the portal's items/ directory, so `img` is an absolute URL —
   imgUrl() passes anything starting with http straight through.
   ============================================================ */
(function () {
  const CFG = window.CLUBVMK;
  const BUCKET = `${CFG.SUPABASE_URL}/storage/v1/object/public/custom-items/`;

  window.customItemUrl = (imageName) => BUCKET + imageName;

  /* Every live custom item, in the same shape as a catalog.min.json entry. */
  window.loadCustomItems = async function (sb) {
    try {
      const { data, error } = await sb.from("custom_items")
        .select("id,name,rarity,category,image_name")
        .eq("active", true);
      if (error) return [];        // table not created yet — feature is just off
      return (data || []).map((r) => ({
        id: r.id,
        n: r.name,
        r: r.rarity,
        c: r.category || "custom",
        img: BUCKET + r.image_name,
        custom: true,
      }));
    } catch (e) {
      return [];
    }
  };

  /* Fold them into a {id -> entry} catalogue. Call this AFTER the page's own
     override pass: the pages' "not listed means common" rule would flatten
     customs, so this does its own override lookup instead — a curated tier
     in the overrides table re-tiers a custom item exactly like everything
     else (the bot applies the same rule). */
  window.mergeCustomItems = async function (sb, catalog) {
    const items = await window.loadCustomItems(sb);
    if (items.length) {
      try {
        const { data } = await sb.from("overrides").select("item_id,tier")
          .like("item_id", "custom:%");
        const map = {};
        for (const row of data || []) map[row.item_id] = row.tier;
        for (const it of items) if (map[it.id]) it.r = map[it.id];
      } catch (e) { /* overrides unreachable — keep uploaded rarities */ }
    }
    for (const it of items) catalog[it.id] = it;
    return items.length;
  };
})();
