# CLUBVMK Collector — Web Portal

A GitHub Pages profile portal for the CLUBVMK Collector Discord bot. Players
**sign in with Discord** (Supabase Auth) to browse their inventory and customize
their profile card (theme, background, featured items, bio, accent colour), with
a live preview and an on-demand exact render from the bot.

- `index.html`, `css/`, `js/` — the static app (Supabase JS client).
- `data/catalog.min.json` — slim item catalog (id, name, rarity, category, image).
- `data/themes.json` — profile themes mirrored from the bot's config.
- `assets/bg/` — theme background images. `items/` — item PNGs.
- Backend schema + setup: see `webportal/` in the bot repo (`clubvmk-bot`).

Public config (Supabase URL + anon key) is baked into `js/config.js` — safe to
expose; Row-Level Security protects all data.
