# crackedbot — Roadmap

Build order, with a time budget per item. Nothing on this list should take more than about two hours. If an item threatens to, it gets split or cut. Total budget for a launchable v1: **about 17 hours** of focused work.

Legend: `[ ]` todo, `[~]` in progress, `[x]` done. Each phase ends with a checkpoint that must be true before moving on.

---

## Phase 0 — Skeleton (1 h) — done 2026-09-04

- [x] `pnpm init`, TypeScript strict, ESM, Node 22 target
- [x] deps: `discord.js`, `hono`, `@hono/node-server`, `better-sqlite3`, `drizzle-orm`, `drizzle-kit`, `zod`, `pino`, `dotenv`
- [x] dev deps: `vitest`, `tsx`, `@biomejs/biome` (lint + format in one tool), `@types/better-sqlite3`
- [x] `src/` layout:
  ```
  src/
    index.ts            boots db, discord client, http server
    config.ts           env parsing with zod, fails loud
    db/schema.ts        drizzle tables
    db/index.ts         connection + migrate on boot
    discord/            client, command registry, handlers/
    http/               hono app: auth, badge, health
    github/             graphql queries, analyzer
    scoring/            signals, dimensions, trust, rubric, presets
    lib/                state signing, logger, cache
  test/                 fixtures/ + *.test.ts
  ```
- [x] `Dockerfile` (multi-stage, `node:22-alpine`, non-root), `.dockerignore`
- [x] GitHub Actions: `ci.yml` runs biome, tsc, vitest on push and PR
- [x] `.env.example` with every variable documented in one line each

**Checkpoint:** `pnpm test` passes with one trivial test, `docker build` succeeds, CI green.

---

## Phase 1 — Core loop end to end (3 h) — built 2026-09-04, live test pending

- [x] DB schema: `guilds`, `links`, `scores`, `reviews`, `audit` + first migration
- [x] Discord client with `Guilds` intent only, global command registration on boot
- [x] `/setup` v1: modal-free wizard using channel select and role select menus, stores config per guild
- [x] `/verify`: ephemeral reply with **Link GitHub** button carrying a signed state
- [x] `lib/state.ts`: HMAC-signed, 10-minute expiry, replay-safe (nonce stored in memory map with TTL)
- [x] Hono routes: `GET /auth/start`, `GET /auth/callback`, `GET /health`
- [x] GitHub OAuth exchange, `viewer` lookup, uniqueness check against `links`
- [x] Analyzer v1: Q1 only (profile + contributions), scoring v1 with the Consistency and Depth dimensions
- [x] Tier placement, role add via REST, edit the original ephemeral message through the interaction webhook
- [x] Modlog line on every attempt
- [x] Callback page: three-line HTML, "Done, go back to Discord", no framework

**Checkpoint:** a real user on a real test server runs `/verify`, links GitHub, and receives a tier role within 10 seconds. Nothing typed by the user is trusted anywhere.

---

## Phase 2 — Full scoring engine and trust layer (3 h)

- [x] Q2 (repos + craft probes) and Q3 (merged PRs, follower sample, stargazer sample)
- [x] All six dimensions from `BLUEPRINT.md §6.1`, each signal a pure function `(analysis) => number in [0,1]`
- [x] Trust flags from `§6.2`, multiplier stacking, floor 0.15
- [x] `scoring/explain.ts`: produces strengths, weaknesses, and "what would raise your score" from the signal table
- [x] Fixtures in `test/fixtures/`: `solid-mid.json`, `cracked.json`, `newbie.json`, and adversarial `star-farm.json`, `commit-bot.json`, `fork-farm.json`, `empty-alt.json`, `dormant-old.json`
- [x] Tests: every fixture asserts a tier range and expected flags; adversarial fixtures must land at or below Tinkerer
- [x] Raw response stored gzip-compressed with a 30-day expiry
- [x] Missing data policy: a failed sub-query zeros its signals and adds an `INCOMPLETE` flag that routes to review, never skips

**Checkpoint:** `pnpm test` runs the whole scorer offline in under a second. Changing a weight that lets an adversarial fixture through turns CI red.

---

## Phase 3 — Rubric system (2 h)

- [x] `scoring/rubric.ts`: zod schema for the rubric JSON in `BLUEPRINT.md §7`
- [x] Presets: `general`, `systems`, `web`, `ml`, `mobile`, `gamedev`, `hackathon`
- [x] `/rubric view` renders the rubric as an embed
- [x] `/rubric preset <name>`
- [ ] `/rubric set weights|gates|tiers` via a modal with a JSON text field, validated by zod, errors shown inline
- [x] `/rubric export` returns a JSON attachment; `/rubric import` accepts an attachment
- [x] Hard gates evaluated before placement: account age, required languages, external merged PR, block flags
- [x] `reviewBelowScore` routes borderline cases to the review queue instead of rejecting

**Checkpoint:** two test guilds with different rubrics place the same GitHub account into different tiers, and the receipt explains why.

---

## Phase 4 — Moderation tools (2 h)

- [x] `reviews` queue: created on gate failure, on `DISCORD_FRESH`, on `INCOMPLETE`, or on the **Request review** button
- [~] Review channel post per case with **Approve**, **Deny** buttons and the receipt embed (Note button not built yet)
- [~] Approve assigns the tier role and logs; Deny logs (Note modal not built yet)
- [x] `/review` lists open cases
- [x] `/rescore <user>` forces a fresh analysis using the bot's app token in read-only public mode (no private contributions, flagged as such)
- [x] `/whois <user>` for mods
- [~] `/unlink` for self (mod-forced unlink not built yet)
- [x] Audit table written on every role change with actor, target, reason
- [x] Community voting (added 2026-09-07): `/rubric vote` settings, `votes` + `ballots` tables, vote post with Admit/Reject/Close buttons and live tally, eligibility rules, 60 s sweeper, escalation to mod review below quorum, DMs on every outcome, `/votes` list, pure `tallyOutcome`/`shouldVote` under test
- [x] Intake question (added 2026-09-21): `/rubric intake`, modal before the GitHub link, answer shown on vote and review posts
- [x] Lifecycle roles (added 2026-09-21): `/rubric roles` for unverified / verified / accepted, opt-in member intent for the on-join role, `/unlink` resets

**Checkpoint:** a mod can handle a borderline applicant entirely from Discord without touching the server.

---

## Phase 5 — Growth surfaces (2 h)

- [x] `GET /badge/:login.svg`: shields-style SVG with score and tier, 24 h cache, `Cache-Control` header, links to the repo
- [x] Receipt card: unicode bars per dimension, top 3 strengths, top 3 improvements, flags section
- [x] `/score` self view, mod view of others
- [x] `/leaderboard` per guild with per-user opt-out stored on the link
- [x] Public welcome embed on placement, ephemeral breakdown for the applicant
- [~] README written (hero GIF and real invite link pending a deployed instance)
- [~] `PRIVACY.md`, MIT `LICENSE` (CONTRIBUTING.md and issue templates not written yet)

**Checkpoint:** someone who has never seen the project can install the bot on their server and place a member inside 10 minutes using only the README.

---

## Phase 6 — Operations (1.5 h)

- [ ] Score cache: 24 h per GitHub id, bypassed by `/rescore`
- [ ] Re-score scheduler: in-process, runs hourly, picks links older than `rescore.everyDays`, spreads them out, promotes always, demotes only if `rescore.demote` is on
- [ ] GitHub rate-limit guard: read `x-ratelimit-remaining`, back off, surface budget in `/crackedbot stats`
- [ ] Retention sweeper: raw blobs after 30 days, failed attempts after 90 days
- [~] Structured logs; `/health` reports discord gateway and last successful analysis (request ids not added)
- [x] Graceful shutdown on SIGTERM so Fly deploys do not drop in-flight OAuth callbacks

**Checkpoint:** the bot survives a redeploy mid-verification and a GitHub outage without corrupting state.

---

## Phase 7 — Launch (1 h)

- [ ] Follow `DEPLOY.md` end to end on a fresh Fly app
- [ ] Register the GitHub App as public, add the support email, register for the GitHub Developer Program
- [ ] Demo server with a pinned "try it" channel
- [ ] Launch post material: one GIF of `/verify` to receipt, one screenshot of the badge in a README
- [ ] Tag `v1.0.0`

---

## Phase 8 — Optional, after launch

- [ ] AI craft review module (opt-in, guild-provided Anthropic key), never affects the score (1.5 h)
- [ ] Rubric gallery: a `rubrics/` folder in the repo where communities PR their presets (30 min)
- [ ] `/compare @a @b` side-by-side receipt for fun (45 min)
- [ ] Cross-guild abuse signal: hashed GitHub ids blocked in N guilds raise a flag, opt-in per guild (1 h)
- [ ] Web leaderboard page at `/g/:guildId` (1 h)

---

## Cut list (things that sound good and are not worth it now)

- Image-rendered scorecards. Needs a headless browser or font rasterizer. Unicode bars are enough and cost nothing.
- Postgres. SQLite handles this load for years.
- A web dashboard for configuration. Slash commands with select menus do the job and keep everyone inside Discord.
- Cloning repos to analyze code. Resource heavy, slow, and the GraphQL probes give 80% of the signal.
- Machine-learned scoring. Deterministic, explainable, testable beats clever here.
