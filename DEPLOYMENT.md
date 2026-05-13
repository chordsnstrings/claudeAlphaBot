# Deployment

Production deployment to DigitalOcean droplet. The system runs as a
single Node process under PM2.

## Prerequisites

- DigitalOcean droplet (minimum 2GB RAM, 1 vCPU; bump to 4GB for
  full daily ingest of the 40-instrument universe)
- Domain pointed at the droplet (the cTrader OAuth callback URL
  must be HTTPS at a stable URL)
- Pepperstone cTrader Open API application credentials (registered
  at https://openapi.ctrader.com)

## One-time droplet setup

```bash
# Postgres 16 + TimescaleDB
apt update && apt install -y postgresql-16 postgresql-16-timescaledb

# Node 20 + pnpm
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pnpm pm2

# Caddy for TLS termination
apt install -y caddy
```

Create the DB user + databases:

```bash
sudo -u postgres psql <<SQL
CREATE USER trading WITH PASSWORD '<strong-password>';
CREATE DATABASE trading_prod OWNER trading;
\c trading_prod
CREATE EXTENSION IF NOT EXISTS timescaledb;
SQL
```

## Code deployment

```bash
git clone https://github.com/chordsnstrings/claudeAlphaBot /opt/trading
cd /opt/trading
pnpm install
pnpm -r build
DATABASE_URL=postgres://trading:...@localhost:5432/trading_prod \
  pnpm --filter @trading/data migrate
```

## Environment

Create `/opt/trading/.env`:

```bash
NODE_ENV=production
LOG_LEVEL=info
MODE=live
DATABASE_URL=postgres://trading:...@localhost:5432/trading_prod
DATABASE_POOL_SIZE=10
HTTP_PORT=3000

# Live mode (filled in after Phase 18 OAuth)
CTRADER_CLIENT_ID=...
CTRADER_CLIENT_SECRET=...
CTRADER_ACCOUNT_ID=5286746
CTRADER_ACCOUNT_TYPE=demo
CTRADER_ACCESS_TOKEN=...
CTRADER_REFRESH_TOKEN=...
CTRADER_REDIRECT_URL=https://bot.<your-domain>/oauth/callback

# Operational UI auth (generate via packages/web/scripts/hash-password.ts)
UI_USERNAME=operator
UI_PASSWORD_HASH=<hex>
UI_PASSWORD_SALT=<hex>
UI_SESSION_SECRET=<64-char random>
```

## PM2 ecosystem

Create `/opt/trading/ecosystem.config.cjs`:

```javascript
module.exports = {
  apps: [
    {
      name: "trading-web",
      cwd: "/opt/trading/packages/web",
      script: "dist/start.js",
      env_file: "/opt/trading/.env",
      max_memory_restart: "1G",
      restart_delay: 5000,
      max_restarts: 10,
      time: true,
    },
  ],
};
```

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup            # follow the printed command
```

## Caddy reverse proxy

`/etc/caddy/Caddyfile`:

```
bot.<your-domain> {
  reverse_proxy localhost:3000
}
```

Caddy auto-provisions a Let's Encrypt cert. Restart with
`systemctl reload caddy`.

## Phase 18: cTrader OAuth (one-time)

After deployment with empty `CTRADER_*` tokens:

1. Register a cTrader Open API application at
   https://openapi.ctrader.com. Set the redirect URL to
   `https://bot.<your-domain>/oauth/callback`.
2. Set `CTRADER_CLIENT_ID` + `CTRADER_CLIENT_SECRET` in `.env`,
   restart PM2.
3. Visit the auth URL — build it with
   `buildAuthorizationUrl({ clientId, redirectUri, state })` from
   `@trading/adapters`. Approve in cTrader.
4. The callback persists access + refresh tokens. The default
   persistence in `@trading/web/start.ts` is a no-op; wire
   `saveTokens` to write to the `.env` (and reload PM2) or to a
   secrets store of your choice.
5. Restart PM2 once more — the live adapters now see credentials
   and connect.

## Verification

```bash
curl https://bot.<your-domain>/api/health  # should return 200 + JSON
pm2 status                                  # trading-web online
journalctl -u caddy --since "1 hour ago"   # no TLS errors
```

Log in to `https://bot.<your-domain>/login` with the UI credentials.
The dashboard should show the connected live account.

## Backups

Add to `/etc/cron.daily/`:

```bash
#!/bin/bash
TS=$(date +%Y%m%d_%H%M%S)
sudo -u postgres pg_dump trading_prod | gzip > /backup/trading_${TS}.sql.gz
find /backup -name 'trading_*.sql.gz' -mtime +30 -delete
```

Test restore quarterly:

```bash
zcat /backup/trading_<ts>.sql.gz | sudo -u postgres psql trading_restore_test
```

## Log rotation

PM2 logs land in `~/.pm2/logs/`. Install `pm2 install
pm2-logrotate` and configure 30-day retention.
