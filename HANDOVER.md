# Handover: getting FreeZer to the grandparents' iPad

Status: planned, not started (2026-09-28).

## Decision

Host the existing Docker image on a free VPS, reach it privately over Tailscale,
and use it from the iPad as a home-screen web app. No native app (no paid Apple
developer account, and free signing expires every 7 days), no account system.

- The PWA side is already done: `static/manifest.webmanifest`, icons in
  `static/icons/`, Apple meta tags in `templates/index.html`.
- Tailscale gives each device a fixed name, so a changed VPS IP doesn't break anything.
- Downside: the iPad needs internet to use it.

## 1. Get a VPS

Free options (check current terms before signing up):

- **Oracle Cloud Always Free** (first choice). ARM VM, which the image supports.
  - The home region is permanent and Always Free only runs there. Pick Stockholm,
    Marseille or Milan; Frankfurt/Amsterdam are often out of ARM capacity.
  - Needs a card for verification. Oracle reclaims idle Always Free VMs, so
    upgrade the account to Pay As You Go (still free within the limits) and set a
    budget alert.
- **Google Cloud e2-micro**: free, but US regions only (fine latency-wise).
- Paid fallback: Hetzner, about €4/month.
- Don't use Render/Railway free tiers: the disk is wiped, so the SQLite DB is lost.

## 2. Set up the server

```bash
# install Docker + Tailscale, then:
sudo tailscale up
mkdir freezer && cd freezer
curl -O https://raw.githubusercontent.com/DragonFlyersx/FreeZer/main/docker-compose.yml
docker compose up -d
```

Don't open port 5177 to the internet (cloud firewall / security list). Only
Tailscale should reach it. The app has no auth.

## 3. Backups

The whole inventory is one SQLite file in the `freezer-data` volume. Nightly
cron on your own machine:

```bash
scp vps:/var/lib/docker/volumes/freezer_freezer-data/_data/freezer.db ~/freezer-backups/$(date +%F).db
```

Restore = run the compose file anywhere and copy the latest `.db` back in.
Worst case, a day of changes is lost.

## 4. iPad (do it in person)

1. Install Tailscale from the App Store and sign in. Either:
   - their own free account + share only the VPS to it (admin console: Machines → Share), or
   - your account (simpler, but they can reach all your devices).
2. Admin console: **disable key expiry** for the iPad, or it logs out after ~6 months.
3. If the Tailscale app has an "on demand" / auto-connect option, turn it on (unverified).
4. Safari → `http://<vps-tailscale-name>:5177` → Share → Add to Home Screen.
5. Tell them: "if FreeZer won't load, open Tailscale and turn it on."
