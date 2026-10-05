# Scout Self-Hosted Install

1. **License** — Scout console → Self-hosted → issue or purchase a license. Copy `lic_scout_…` once.

2. **Files** — Download `docker-compose.yml` and `.env.example` from the console (or use the deploy bundle API).

3. **Configure** — Set:
   - `SCOUT_LICENSE_KEY`
   - `SCOUT_PLATFORM_API_BASE_URL=https://api.macrocontent.dev`
   - `SCOUT_API_KEYS` — JSON array of local keys for `/v1` (self-host does not use cloud credits)
   - `SCOUT_WORKER_COUNT` (≤ license limit)

4. **Registry** — Pull `ghcr.io/macrocontent/scout:latest` anonymously (public package). No GHCR login required for normal installs.

5. **Start** — `docker compose up -d`

6. **Verify** — `curl http://localhost:3009/health` → `license.valid: true` and `browser_pool.max_concurrent` matches your tier.

7. **Console** — Heartbeat appears under Self-hosted within ~15 minutes.

## Abuse protection

- One Developer license per account (non-commercial).
- Deployment and worker limits enforced at heartbeat and runtime.
- Revoked licenses stop working after offline grace expires.
- License heartbeats are rate-limited per key and IP.

## Security notes

- Do **not** put Macro cloud `SCOUT_PLATFORM_SECRET` / internal keys into customer self-host `.env` files.
- Keep `allowPrivateNetworks` off unless you intentionally target staging/VPN hosts.
- Use allow/block domain lists for SSRF-style protection on open instances.

Terms: https://macrocontent.dev/terms/#scout
