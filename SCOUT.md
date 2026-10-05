# Macro Scout API Reference

**Version:** 0.7.0  
**Service:** `apps/scout` (`macro-scout`)  
**Base URL:** `https://api.scout.macrocontent.dev`  
**Auth:** `Authorization: Bearer <api-key>` or `X-Scout-Key: <api-key>`  
**Swagger UI:** `https://api.scout.macrocontent.dev/docs`  
**OpenAPI JSON:** `https://api.scout.macrocontent.dev/openapi.json`  
**Console:** not public yet (`apps/scout-app` local-only; host reserved)  
**Product docs:** https://docs.macrocontent.dev/scout/  
**TypeScript SDK:** `@macrocontent/scout` · https://docs.macrocontent.dev/scout/sdk/  
**CLI:** `@macrocontent/scout-cli` · https://docs.macrocontent.dev/scout/cli/  
**Python SDK:** `macrocontent-scout` (monorepo `packages/scout-python`; PyPI after org approval) · https://docs.macrocontent.dev/scout/python/  
**GitHub Action:** `macrocontent/scout-action@v1` · https://github.com/macrocontent/scout-action

Scout is Macrocontent’s **API-first Web Verification / Site Inspection** service.  
It returns **raw facts** (measurements, DOM extracts, TLS fields, axe nodes). It does **not** invent SEO scores, price alerts, or qualitative judgments.

---

## Principles

1. **Raw data only** — no scores, rankings, or “good/bad” productization beyond boolean pass/fail on customer-supplied expectations (e.g. visibility `expect`, pixel-diff `tolerance`).
2. **No content archive** — Scout does not store crawled page HTML/text for customers. Customers persist what they need. Exceptions: billing/usage counters, domain-verify metadata, templates, **short-lived** job results (webhook + poll TTL).
3. **Dogfooding** — Macro CMS uses the same public API with an **internal** API key (unlimited rate limit, domain-verify bypass, `evaluate` allowed). One code path.
4. **SDK-independent** — no Macro selectors inside Scout.
5. **Domain ownership verify** only for sensitive ops (interact / evaluate / client cookies / Basic Auth / mTLS). Open read-only crawl of third-party URLs remains allowed.

---

## Tiers & credits

Self-serve only (**no Enterprise sales**). Wallet scope = **Macrocontent account** (all `sk_scout_` keys share one credit wallet).

| Tier | Price | Credits / period | Rate limit | `evaluate` |
|---|---|---|---|---|
| `free` | €0 | 500 | ~30/min | no |
| `basic` | €29/mo | 10 000 | ~120/min | no |
| `pro` | €99/mo | 50 000 | ~250/min | yes |
| `internal` | — | unlimited | unlimited | yes |

- **PAYG** (opt-in, default off): when prepaid credits (plan + packs) are empty → overages tracked; if PAYG off → **`402 CREDITS_EXHAUSTED`** (429 remains rate-limit only).
- **Credit packs** (catalog): 1k/€5, 5k/€22, 25k/€100 — prepaid top-ups that **never expire**. Stripe Checkout from My Account → Scout → Plans.
- **Period rollover (rolling 30 days / Stripe invoice cycle):** unused **plan** credits expire; remaining **pack** credits stay; new period balance = fresh plan allowance + remaining packs; PAYG overage counter resets.
- **Stripe:** same platform account as Store (no Connect). Checkout + Customer Portal + webhooks on `/webhooks/stripe` (`metadata.product=scout`). Optional Price IDs: `STRIPE_SCOUT_PRICE_*`.
  - **Duplicate paid tiers:** before opening Checkout, live Stripe subscriptions for the customer are listed; same tier → sync wallet + reject (`409 ALREADY_ON_PLAN`); open incomplete Scout sessions are expired; after success, other live Scout subs are canceled. Confirm-on-return (`POST /scout/me/checkout/confirm`) applies entitlements if webhooks miss.
  - **Basic↔Pro change:** in-place subscription update with Stripe **proration** (`always_invoice`) — pay the difference only; wallet gets the **new** plan allowance immediately (no stacking old Basic remainder). Pack credits unchanged. Free→paid still uses Checkout.
  - Local listen: `stripe listen --project-name "macrocontent Sandbox" --forward-to http://127.0.0.1:3000/webhooks/stripe` (must match `STRIPE_SECRET_KEY` account) and put the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`.
- Console: **My Account** (`account.*`) → Scout (overview / keys / domains / plans). Not under the CMS dashboard.
- Account JWT API: `/scout/me`, `/scout/api-keys`, `/scout/domains`, `/scout/pricing`.
- Scout debit: `POST` platform `/internal/scout/authorize` (`SCOUT_PLATFORM_API_BASE_URL` + `SCOUT_PLATFORM_SECRET`).

Env: `SCOUT_INTERNAL_API_KEY`, `SCOUT_PLATFORM_API_BASE_URL`, `SCOUT_PLATFORM_SECRET`, optional legacy `SCOUT_API_KEYS` JSON.

Endpoint credit costs are documented in `backend/src/lib/scout/pricing.ts` (mirrored in Scout `credits/costs.ts`).

---

## Errors

All JSON error responses use:

```json
{
  "error": "Human readable message",
  "code": "TIMEOUT",
  "retryable": true,
  "details": {},
  "captcha_detected": false
}
```

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | no | Bad request body |
| `INVALID_URL` | 400 | no | Malformed / disallowed URL |
| `ROBOTS_BLOCKED` | 400 | no | robots.txt Disallow |
| `PRIVATE_NETWORK_BLOCKED` | 400 | no | SSRF / private IP |
| `SELECTOR_NOT_FOUND` | 400 | no | `wait_for_selector` missed |
| `UNAUTHORIZED` | 401 | no | Missing/invalid API key |
| `CREDITS_EXHAUSTED` | 402 | no | Wallet empty and PAYG off |
| `DOMAIN_NOT_VERIFIED` | 403 | no | Ownership required |
| `DOMAIN_VERIFY_EXPIRED` | 403 | no | Re-verify needed |
| `FORBIDDEN` | 403 | no | Tier/policy |
| `NOT_FOUND` / `TEMPLATE_NOT_FOUND` | 404 | no | Missing resource |
| `RATE_LIMITED` / `HTTP_TOO_MANY_REQUESTS` | 429 | yes | Rate limit |
| `CAPTCHA_DETECTED` | 422 | no | Challenge page (when used as hard fail) |
| `TIMEOUT` | 504 | yes | Navigation/wait timeout |
| `DNS_FAILED` | 502 | yes | DNS resolution |
| `NAVIGATION_FAILED` | 502 | yes | Browser navigation |
| `HTTP_FORBIDDEN` / `HTTP_ERROR` | 502 | yes | Upstream HTTP issues |
| `BROWSER_UNAVAILABLE` | 502 | yes | Chromium not installed |
| `INTERNAL_ERROR` | 500/502 | yes | Unexpected |

Successful JSON responses from extract/inspect may also include:

- `captcha_detected: boolean`
- `captcha_signals: [{ id, evidence }]`

Heuristics only (reCAPTCHA, hCaptcha, Turnstile, Cloudflare challenge, DataDome, …) — **not** a bypass.

---

## Domain verify

| Needs verified domain | Does **not** need verify |
|---|---|
| Journey with interact / `evaluate` / client cookies / `solve_captcha` | screenshot, extract, inspect, performance, visibility, dns, robots, crawl, files, pdf, a11y/tech/security, read-only journeys |
| `http_auth` / `client_certificates` | |

**Hosted:** verify on by default for sensitive ops.  
**Self-hosted:** `SCOUT_DEPLOYMENT_MODE=self_hosted` → domain verify is **never** required (`SCOUT_REQUIRE_DOMAIN_VERIFY` and JSON `requireDomainVerification` are ignored).

Flow (cloud): `POST /v1/domains` → DNS TXT or `/.well-known/scout-verify.txt` → `POST /v1/domains/:id/verify`  
Re-verify after `SCOUT_DOMAIN_REVERIFY_DAYS` (default 90).

---

## Common browse options

| Field | Type | Notes |
|---|---|---|
| `respect_robots` | boolean | Default on |
| `wait_for_selector` | string | Wait until selector attached after navigation |
| `wait_for_selector_timeout_ms` | number | Default 15000 |
| `wait_for_selector_required` | boolean | Default true → `SELECTOR_NOT_FOUND` |
| `dismiss_cookie_banner` | boolean | Best-effort known CMP accept (allowlist). **No domain verify.** Not free interact. |
| `device` | string | Preset from `GET /v1/devices` (UA, viewport, DPR, touch) |
| `detect_captcha` | boolean | Default true on extract/inspect |
| `solve_captcha` | boolean | Best-effort Turnstile/checkbox on **owned** sites. Cloud: verified domain. Self-hosted: always allowed. Not a stealth bypass. +2 credits |
| `capture_xhr` | string | Glob/substring matching XHR/fetch URLs (max 20). +1 credit |
| `fetch_mode` | `browser` \| `http` | `http` disables JS. Extract/inspect −1 credit (min 1) |
| `color_scheme` | `light` \| `dark` \| `no-preference` | |
| `locale` / `user_agent` / `headers` | | |
| `accept_language` / `encoding` | | |
| `block_resource_types` / `block_url_patterns` / `block_ads` | | |
| `record_har` | boolean | Retrieve via `/v1/screenshot/json` |
| `http_auth` / `client_certificates` | | Verified domain required |

---

## Webhook security (jobs)

`POST /v1/jobs` accepts `webhook_url` and optional `webhook_secret`.

Secret resolution order:
1. Job body `webhook_secret`
2. API key `webhookSecret` (in `SCOUT_API_KEYS`)
3. Env `SCOUT_WEBHOOK_SECRET`

When a secret is available, Scout sends:

- `X-Scout-Timestamp`: unix seconds
- `X-Scout-Signature`: `sha256=<hex>` where hex = HMAC-SHA256(secret, `"${timestamp}.${rawBody}"`)

Response includes `webhook_signed: true|false`.

Verify (Node):

```js
const crypto = require('crypto');
function verify(secret, timestamp, signatureHeader, rawBody, maxAge = 300) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > maxAge) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
```

---

## Efficiency (operational, not archive)

| Mechanism | Default | Env |
|---|---|---|
| Result / DNS / robots cache | Memory; Redis optional | `SCOUT_REDIS_URL` |
| Result TTL | 60s | `SCOUT_RESULT_CACHE_TTL_SECONDS` |
| In-flight dedup | same key coalesces | — |
| Job poll TTL | 1800s | `SCOUT_JOB_TTL_SECONDS` |

---

## Endpoints

### Meta

- `GET /health` — version `0.7.0`, cache/webhook hints
- `GET /` — discovery
- `GET /v1/usage` — per-key counters
- `GET /v1/devices` — mobile/desktop presets (iPhone 13, Pixel 7, …)

### DNS / robots / crawl

#### `POST /v1/dns`
Hostname record lookup (+ short cache).

#### `POST /v1/robots`
robots.txt decision + `sitemap_urls`.

#### `POST /v1/crawl`
Multi-page **link discovery** (no content archive):

```json
{
  "start_url": "https://example.com",
  "max_depth": 2,
  "max_pages": 25,
  "same_origin": true,
  "allow_hosts": [],
  "seed_from_sitemap": true,
  "respect_robots": true
}
```

Returns `pages[]`, `discovered_urls[]`, `truncated`. Feed URLs into `/v1/jobs` for inspect/extract.

### Domains

`GET|POST /v1/domains`, `GET /v1/domains/:id`, `POST /v1/domains/:id/verify`, `DELETE /v1/domains/:id`

### Templates (extract presets)

| Method | Path |
|---|---|
| `GET` | `/v1/templates` |
| `POST` | `/v1/templates` `{ name, slug?, hostname?, fields }` |
| `GET` | `/v1/templates/:idOrSlug` |
| `PATCH` | `/v1/templates/:id` |
| `DELETE` | `/v1/templates/:id` |

Then: `POST /v1/extract` `{ "url": "…", "template_id": "tpl_…" }` (or slug).

### Screenshot

- `POST /v1/screenshot` — binary jpeg/png/pdf (+ browse options / `device`)
- `POST /v1/screenshot/json` — base64 + optional HAR
- `POST /v1/screenshot/viewports` — multi shot; viewport entry may use `"device": "iPhone 13"`
- `POST /v1/screenshot/diff` — pixel diff vs client PNG reference

### Checks

- `POST /v1/checks/visibility`
- `POST /v1/checks/security` — TLS, headers, mixed content, CMP signals
- `POST /v1/checks/a11y` — axe + contrast/tab/ARIA raw
- `POST /v1/checks/tech` — CMS/framework/analytics facts

### Assert (0.7)

`POST /v1/assert` — one page load, up to 25 rules, response `{ passed, results[] }`.

```json
{
  "url": "https://example.com/pricing",
  "assert": [
    { "selector": "#buy", "visible": true },
    { "selector": ".price", "contains": "29" },
    { "selector": "img.hero", "count": 1 }
  ]
}
```

Operators: `exists`, `visible`, `not_covered`, `count` / `count_min` / `count_max`, `contains` / `text` / `matches`, `href_contains`, `attr`, `soft`.  
Credits: **3 + 1 per assert after the first**. Docs: https://docs.macrocontent.dev/scout/endpoints/assert/

### Browser facts (0.6)

Raw inventories from a browser session (no SEO scores; network is a **summary**, not full HAR by default):

| Route | Credits | Returns |
|---|---|---|
| `POST /v1/checks/cookies` | 3 | Cookie jar (not CMP) |
| `POST /v1/checks/console` | 3 | Console messages (cap 200) |
| `POST /v1/checks/network` | 4 | Status counts, CORS/mixed/failures; optional `top_slowest` |
| `POST /v1/checks/assets` | 3 | Failed css/img/font/script |
| `POST /v1/checks/resources` | 3 | Resource-type counts + size estimates |
| `POST /v1/checks/json-ld` | 3 | JSON-LD parse + common missing fields |
| `POST /v1/checks/canonical` | 3 | Redirect + canonical chain |
| `POST /v1/checks/sitemap` | 3 | robots/sitemap.xml inspection (max 3) |
| `POST /v1/checks/images` | 3 | `<img>` inventory (cap 200) |
| `POST /v1/checks/opengraph` | 3 / **8** w/ `screenshot` | og/twitter meta (+ optional viewport JPEG) |
| `POST /v1/checks/a11y-snapshot` | 3 | Headings/landmarks/buttons inventory (not axe) |
| `POST /v1/checks/forms` | 3 | Forms + inputs (cap 50) |
| `POST /v1/checks/links` | 3 | Shallow one-page internal link graph |
| `POST /v1/diff/dom` | 8 | Simplified DOM tree diff (`url_a`/`url_b`) |
| `POST /v1/diff/headers` | 4 | Response header diff |

Docs: https://docs.macrocontent.dev/scout/endpoints/browser-facts/

### Extract / inspect / files / PDF

- `POST /v1/extract` — fields **or** `template_id`; types include `similar` / `selector`; `adaptive` + `match_text`; optional `capture_xhr`, `fetch_mode`, `solve_captcha`; returns `captcha_detected`, `captured_xhr`, `selector_relocations`
- `POST /v1/inspect` — include: meta, headings, links, images, json_ld, headers, security, tech, files, a11y
- `POST /v1/files` — downloadable links
- `POST /v1/pdf/extract` — PDF text (no OCR)

### Journey / performance / sandbox / jobs

- `POST /v1/journey` — multi-step; sensitive steps need verified domain
  - **`debug`** (boolean or `{ screenshots?, on_error_only?, format?, quality? }`) — attach `debug.url` + optional viewport screenshot (`base64`) on each step for authoring. Credits: **+1 per step** when screenshots on every step; **+1** when `on_error_only`. Prefer `on_error_only` once stable.
- `POST /v1/performance`
- `POST /v1/sandbox`
- `POST /v1/jobs` — batch (`screenshot|extract|visibility|inspect|performance|journey|crawl`) + webhook (+ HMAC); nested journey supports `debug`
- `GET /v1/jobs/:id` — until `expires_at`

---

## Out of scope

- Anti-bot / fingerprint spoofing
- Wayback / scheduled content archive
- WHOIS / Geo-IP / OCR / Firefox/WebKit
- Scout-managed cron that stores page content
- Team / multi-user org model → [MAC-22](https://linear.app/proksch/issue/MAC-22)

---

## Macro dogfooding map

| Macro feature | Scout endpoint |
|---|---|
| Website screenshots | `POST /v1/screenshot` |
| Attribution crawl | `POST /v1/checks/visibility` |
| Domain probe | `POST /v1/extract` |
| Bundle preview | `POST /v1/sandbox` |

Client: `backend/src/lib/scout/client.ts`

---

## Local / deploy

```bash
pnpm --filter macro-scout browser:install
pnpm --filter macro-scout dev
```

Env: `SCOUT_INTERNAL_API_KEY`, `SCOUT_API_KEYS`, `SCOUT_WEBHOOK_SECRET`, `SCOUT_REDIS_URL`, TTL/robots/reverify vars — see `apps/scout/.env.example`.

Parent ticket: [MAC-16](https://linear.app/proksch/issue/MAC-16)

### Shipped gaps (0.5)

| Feature | Ticket |
|---|---|
| Multi-page crawl | [MAC-17](https://linear.app/proksch/issue/MAC-17) |
| Extract templates | [MAC-18](https://linear.app/proksch/issue/MAC-18) |
| Errors + captcha + wait_for_selector | [MAC-19](https://linear.app/proksch/issue/MAC-19) |
| Webhook HMAC | [MAC-20](https://linear.app/proksch/issue/MAC-20) |
| Device presets | [MAC-21](https://linear.app/proksch/issue/MAC-21) |

### Remaining backlog

| Gap | Ticket |
|---|---|
| Team / multi-user per API key | [MAC-22](https://linear.app/proksch/issue/MAC-22) |
