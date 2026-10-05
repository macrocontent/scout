# ScoutAPI (self-host image)

Public home for the **ScoutAPI** self-hosted Docker image:

```bash
docker pull ghcr.io/macrocontent/scout:latest
```

Product code and releases are built from the private [MacroContent](https://github.com/macrocontent/MacroContent) monorepo (`apps/scout`). This repository exists so the GHCR package can be **public** (private repos cannot host anonymously pullable packages).

## Install

Docs: https://docs.macrocontent.dev/scout/self-hosted/install

1. Get a `lic_scout_…` license in the Scout console (Stripe for paid tiers).
2. Use the console deploy bundle (compose + `.env`).
3. `docker compose up -d` — no GHCR login required.

## Support

Self-hosted tiers are **capacity classes** (deployments + workers). You operate the stack yourself; Macro does not sell tiered premium support for self-host.
