# crackedbot — Blueprint

> A Discord bot any engineering community can install to vet applicants by their GitHub.
> The applicant proves they own the account, the bot computes an explainable **Cracked Score**,
> and the community's own rubric decides which tier and which roles they get.

This file is the "what and why". `ROADMAP.md` is the "in what order". `DEPLOY.md` is the "where to click".

---

## 1. Product in one screen

```
/verify  →  "Link GitHub" button  →  GitHub OAuth (proves ownership)
         →  analyzer runs three GraphQL queries on the applicant's own token
         →  score 0–100 across 6 dimensions × trust multiplier
         →  rubric maps score + hard gates → tier → roles
         →  applicant gets a receipt card (why they scored what they scored)
         →  mods get a modlog line; borderline cases land in a review queue
```

Default tiers (a guild can rename and re-threshold them):

| Tier      | Score  | Meaning                                              |
|-----------|--------|------------------------------------------------------|
| Tourist   | 0–19   | account exists, nothing sustained                    |
| Tinkerer  | 20–39  | some real repos, sporadic activity                   |
| Builder   | 40–59  | ships consistently, mostly solo                      |
| Shipper   | 60–79  | consistent, collaborates, projects people use        |
| Cracked   | 80–100 | sustained output, external merged PRs, real impact   |

Each tier can map to a Discord role. Verification is not pass/fail. It is placement.

---

## 2. Decisions carried over from the prototype review

Kept:
- Ephemeral failures, public welcomes.
- Gate enforced in code, never by channel visibility alone.
- Every threshold configurable without a redeploy.
- The "here is exactly what to click" README attitude.

Rejected:
- Username-typed verification with no ownership proof. OAuth or nothing.
- Single-guild env config. Everything per guild in the database.
- AND-ed pass/fail thresholds. Weighted, explainable, tiered scoring instead.
- Fail-open checks. Missing data lowers the score or routes to review. It never skips.
- Reaction roles. Buttons and select menus only. No Manage Messages, no partials, no emoji round-trip bugs.
- JSON-file store. SQLite with migrations and atomic writes.
- Privileged gateway intents. None are required, so the bot scales past 100 servers without Discord's intent approval.
- Repo size in KB as a quality signal. Replaced by commit depth, CI, tests, README, license.

---

## 3. Stack

| Layer      | Choice                                  | Why                                                                  |
|------------|-----------------------------------------|----------------------------------------------------------------------|
| Runtime    | Node 22, TypeScript, ESM                | fast to write, best Discord library ecosystem                        |
| Discord    | discord.js v14 (gateway)                | buttons, modals, select menus, role management, no intents needed    |
| HTTP       | Hono                                    | tiny, same process, serves OAuth callback, badge, health             |
| GitHub     | GitHub App with user OAuth, GraphQL v4  | ownership proof, applicant's own 5000/hr quota, private contrib count |
| DB         | SQLite via better-sqlite3 + Drizzle ORM | one file, zero ops, thousands of guilds fine, trivial backups        |
| Validation | zod                                     | rubric JSON import must be bulletproof                               |
| Tests      | vitest + fixture GraphQL responses      | scoring is the product and must be pinned by tests                   |
| Logging    | pino                                    | structured, cheap                                                    |
| Packaging  | Docker, single image                    | runs on the cheapest Fly machine or any VPS                          |

One process. No Redis, no queue, no workers. Analysis is I/O bound and takes 2 to 4 seconds per applicant.

---

## 4. Ownership proof (GitHub App OAuth)

1. `/verify` replies ephemerally with a **Link GitHub** button.
2. The button URL is `https://<host>/auth/start?s=<state>`. `state` is an HMAC-signed token containing `{ guildId, discordUserId, interactionToken, exp: now + 10 min }`.
3. `/auth/start` verifies the state and redirects to `github.com/login/oauth/authorize` carrying the same state.
4. `/auth/callback` exchanges the code for a **user token** and calls `viewer { id login }`.
5. The analyzer runs with that user token. The token is used once, held in memory only, and discarded.
6. The result is stored, roles are assigned via REST, the original ephemeral message is edited through the interaction webhook (valid 15 min), and the browser shows "Done, go back to Discord".

Why a GitHub App rather than an OAuth App: user-to-server tokens get their own 5000 requests per hour per user, so API cost scales with applicants and not with the bot. Also `restrictedContributionsCount` (private contributions) is visible when the viewer is the user, which is real signal for people whose work is closed source.

Uniqueness rules:
- One GitHub account maps to one Discord user per guild. A second Discord user linking the same GitHub is blocked and logged.
- Re-linking a different GitHub to the same Discord user requires `/unlink` first, which strips tier roles.

---

## 5. The analyzer

Four GraphQL queries per applicant in two parallel phases, all on the applicant's token, about 4 rate-limit points in total. Measured live on 2026-09-04: a typical account takes 3 to 4 seconds, the kernel maintainer takes about 6 because GitHub has to count 1.5 million commits.

- Phase A runs Q1 (profile) and Q2a (repo list) together.
- Phase B runs Q2b (commit counts and craft probes on the top 10 repos only) and Q3 (collaboration and trust samples) together.

Commit counts and tree probes are only fetched for the top 10 repos because they are the expensive part: probing 80 repos at once made GitHub time out on accounts with over a thousand repos.

**Q1 profile and contributions**
- `createdAt, followers.totalCount, following.totalCount, bio, name, avatarUrl, company, websiteUrl, hasSponsorsListing, organizations.totalCount, gists.totalCount, starredRepositories.totalCount`
- `contributionsCollection` aliased three times for the last three 12-month windows: `totalCommitContributions, totalPullRequestContributions, totalPullRequestReviewContributions, totalIssueContributions, restrictedContributionsCount, contributionCalendar { weeks { contributionDays { contributionCount date } } }`
- current window only: `commitContributionsByRepository(maxRepositories: 25) { repository { nameWithOwner owner { login } stargazerCount } contributions { totalCount } }`
- `repositoriesContributedTo(first: 50, includeUserRepositories: false, contributionTypes: [COMMIT, PULL_REQUEST, PULL_REQUEST_REVIEW]) { totalCount nodes { stargazerCount isFork } }`

**Q2a repository list** (metadata only, cheap)
- `repositories(first: 30, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, orderBy: { field: STARGAZERS, direction: DESC })` plus a second aliased call ordered by `PUSHED_AT`, merged and de-duplicated client side.
- Per repo: `name isArchived isTemplate stargazerCount forkCount primaryLanguage languages(first: 5) description repositoryTopics(first: 5) licenseInfo pushedAt createdAt diskUsage` and the last commit date.

**Q2b probes** (top 10 repos by stars then recency, built per call with one alias per repo)
- `history(first: 1) { totalCount }` for all-time commit depth and `history(first: 1, since: <1 year ago>) { totalCount }` for recent depth.
- Craft probes via `object(expression:)`: `HEAD:README.md` (three casings), `HEAD:.github/workflows`, `HEAD:tests`, `HEAD:test`, `HEAD:__tests__`, `HEAD:spec`, `HEAD:Dockerfile`. The existence of a Tree or Blob is the signal. Nothing is downloaded.

**Q3 collaboration and trust samples**
- `pullRequests(first: 50, states: MERGED, orderBy: { field: CREATED_AT, direction: DESC }) { baseRepository { nameWithOwner owner { login } stargazerCount } mergedAt additions deletions }`
- `followers(first: 30) { createdAt followers { totalCount } repositories { totalCount } }` for the follower-farm probe.
- Top original repo by stars, only when it has between 10 and 5000 stars: `stargazers(first: 50, orderBy: STARRED_AT DESC) { createdAt followers { totalCount } }` for the star-farm probe. Nobody buys stars for a 200k-star repo, and sampling one is slow.

Raw responses are stored compressed for 30 days so a mod can ask "why" without re-fetching.

---

## 6. Scoring model

Every signal maps to `[0, 1]` through a saturation function `sat(x, k) = 1 - exp(-x / k)` so whales do not dominate and a first-year dev can still reach Builder. Each dimension is `0.8 × weighted mean of its signals + 0.2 × its best signal`, times 100. The weights (in `scoring/dimensions.ts`) favor signals that are expensive to fake, and the 20% excellence term stops signals that do not apply to someone's workflow from dragging down the ones they are exceptional at. The total is the rubric-weighted mean of the dimensions times the trust multiplier.

Calibration check on 2026-09-04, public data only: Torvalds 74 (Shipper), sindresorhus 87 (Cracked), octocat 33 (Tinkerer). Torvalds is not Cracked because he does not review, open PRs, or run CI on GitHub, and the receipt says exactly that. A flat mean had him at 57.

When scoring from public data (`/rescore`, the CLI), the `privateWork` signal is dropped rather than zeroed, and the `PUBLIC_ONLY` flag says so.

### 6.1 Dimensions (default weights)

**Consistency, weight 20**

| Signal        | Formula                                                    |
|---------------|------------------------------------------------------------|
| activeWeeks   | weeks with at least 1 contribution in the last 52, over 52 |
| longestStreak | sat(days, 30)                                              |
| tenure        | years among the last 3 with at least 100 contributions, over 3 |
| recency       | 1 if last contribution within 14 days, linear to 0 at 180 days |

**Impact, weight 20**

| Signal          | Formula                                                     |
|-----------------|-------------------------------------------------------------|
| qualityStars    | sat(sum of stars on original repos × starQuality, 300)      |
| forks           | sat(sum of forks on original repos, 60)                     |
| reachOfContribs | sat(sum of stars of repositoriesContributedTo, 5000)        |
| distinctUsed    | sat(original repos with at least 5 stars, 5)                |

**Collaboration, weight 20**

| Signal            | Formula                                                                                  |
|-------------------|------------------------------------------------------------------------------------------|
| externalMergedPRs | sat(sum over merged PRs into repos the user does not own of log10(targetStars + 10), 12) |
| distinctTargets   | sat(distinct external repos with a merged PR, 6)                                         |
| reviews           | sat(PR reviews in the last year, 30)                                                     |
| issues            | sat(issues opened in the last year, 20)                                                  |
| orgs              | sat(org memberships, 3)                                                                  |

**Craft, weight 20** (over the top 10 original non-archived repos by stars, then recency)

| Signal          | Formula                                              |
|-----------------|------------------------------------------------------|
| commitDepth     | mean of sat(commits, 150)                            |
| hasCI           | share of repos with `.github/workflows`              |
| hasTests        | share with a tests directory                         |
| documented      | share with README and description                    |
| licensed        | share with a license                                 |
| languageBreadth | sat(distinct primary languages, 4)                   |
| longevity       | share with pushedAt minus createdAt of 60 days or more |

**Community, weight 10**

| Signal      | Formula                                    |
|-------------|--------------------------------------------|
| followers   | sat(followers × followerQuality, 150)      |
| sponsorable | 1 if hasSponsorsListing                    |
| gists       | sat(gists, 10)                             |

**Depth, weight 10**

| Signal      | Formula                                                          |
|-------------|------------------------------------------------------------------|
| commitsYear | sat(total commit contributions in the last year, 600)            |
| privateWork | sat(restrictedContributionsCount, 300), only via the user's own token |
| prsYear     | sat(PRs opened in the last year, 60)                             |

### 6.2 Trust multiplier (floor 0.15, ceiling 1.0) and flags

Applied to the total. Every flag also appears on the receipt so the applicant knows what tripped.

| Flag          | Trigger                                                                        | Effect                        |
|---------------|--------------------------------------------------------------------------------|-------------------------------|
| NEW_ACCOUNT   | account younger than 30 days, or younger than 90 days                          | ×0.15, or ×0.5                |
| BURST         | max single day above 35% of yearly contributions and activeWeeks below 8       | ×0.5                          |
| FOLLOWER_FARM | 60%+ of sampled followers have 0 repos and median follower age below 90 days, only checked for accounts with 20 to 2000 followers (a famous account's newest followers are new users and look identical) | followerQuality 0.1, ×0.7 |
| STAR_FARM     | 50%+ of sampled stargazers created within one 30-day span with under 2 followers | starQuality 0.1, ×0.7       |
| FORK_FARM     | forks over repos above 0.8 and fewer than 2 original repos                     | ×0.6                          |
| HOLLOW_REPOS  | more than 70% of original repos have fewer than 3 commits                      | ×0.7                          |
| BOT_CADENCE   | commits above 500 but activeWeeks below 6                                      | ×0.4                          |
| NO_PROFILE    | no name, no bio, no avatar, no website                                         | ×0.9                          |
| DISCORD_FRESH | Discord account younger than 14 days                                           | route to review, no multiplier |
| SHARED_GITHUB | GitHub already linked to another Discord user in this guild                    | hard block                    |

Multipliers stack multiplicatively with a floor of 0.15.

### 6.3 Why this is hard to game cheaply

- Merged PRs into repos you do not own require another human maintainer, and are weighted by target popularity.
- Streaks and active weeks over 52 weeks cannot be backfilled in an afternoon. Back-dated commits are possible, but BURST, BOT_CADENCE, and commit history versus repo creation date catch the common scripts.
- Bought stars and followers leave a fingerprint (account-age clustering, zero repos) that the sampling probes see.
- Craft signals are per repo and need real project structure, not size.
- The rubric is per community, so there is no single global threshold to target.
- The test suite ships adversarial fixtures (star farm, commit bot, fork farm, empty alt, dormant old account) and asserts they score Tourist or Tinkerer. A scoring change that lets one through fails CI.

---

## 7. Rubric (per guild)

```jsonc
{
  "preset": "general",            // general | systems | web | ml | mobile | gamedev | hackathon
  "weights": { "consistency": 20, "impact": 20, "collaboration": 20, "craft": 20, "community": 10, "depth": 10 },
  "tiers": [
    { "name": "Tourist",  "min": 0,  "roleId": null },
    { "name": "Tinkerer", "min": 20, "roleId": "..." },
    { "name": "Builder",  "min": 40, "roleId": "..." },
    { "name": "Shipper",  "min": 60, "roleId": "..." },
    { "name": "Cracked",  "min": 80, "roleId": "..." }
  ],
  "entryTier": "Tinkerer",         // below this = not admitted, offered review
  "gates": {
    "minAccountAgeDays": 90,
    "requireLanguagesAnyOf": [],   // e.g. ["Rust", "C", "C++", "Zig"]
    "requireExternalMergedPR": false,
    "reviewBelowScore": 25,        // borderline goes to the review queue instead of a hard reject
    "blockFlags": ["SHARED_GITHUB", "BOT_CADENCE"]
  },
  "rescore": { "everyDays": 30, "demote": false }
}
```

Presets only change `weights`, `requireLanguagesAnyOf`, and tier names. Everything is overridable through `/rubric` and importable as JSON. Communities will share rubrics, which is a distribution loop.

---

## 8. Commands

| Command                                  | Who    | Does                                                                  |
|------------------------------------------|--------|-----------------------------------------------------------------------|
| `/verify`                                | anyone | starts the OAuth link, scores, places into a tier, posts the receipt  |
| `/score [user]`                          | anyone | ephemeral receipt for self; mods can view others                      |
| `/unlink`                                | anyone | removes link, tier roles, and stored results for self                 |
| `/setup`                                 | admin  | wizard: verify channel, modlog channel, review channel, tier→role map |
| `/rubric view\|preset\|set\|export\|import` | admin | edit weights, gates, tiers                                           |
| `/review`                                | mod    | lists pending; each has Approve, Deny, and Note buttons               |
| `/rescore <user>`                        | mod    | forces a fresh analysis                                               |
| `/whois <user>`                          | mod    | linked GitHub, score, flags, history                                  |
| `/leaderboard`                           | anyone | top 10 by score in this guild, opt-out honored                        |
| `/crackedbot stats`                      | admin  | verifications, pass rate, tier distribution, API budget               |

Buttons: **Link GitHub**, **Request review**, **Approve**, **Deny**, **Show breakdown**.

---

## 8b. Community voting

Per guild, off by default, configured with `/rubric vote`. The score still runs; voting decides what happens with the placement.

```jsonc
"vote": {
  "enabled": false,
  "scope": "review",        // review | admitted | all
  "channelId": null,        // falls back to the review channel, then the verify channel
  "eligibleRoleId": null,   // null = anyone holding a tier role (or anyone, if no tier roles are mapped)
  "durationHours": 24,
  "quorum": 3,
  "threshold": 0.6          // share of yes ballots needed
}
```

| Placement status | scope `review` | scope `admitted` | scope `all` |
|------------------|----------------|------------------|-------------|
| admitted         | admitted       | vote             | vote        |
| review           | vote           | vote             | vote        |
| rejected         | rejected       | rejected         | vote        |
| blocked          | blocked        | blocked          | blocked     |

Mechanics:
- One vote post per applicant with the compact receipt, 👍 Admit, 👎 Reject, and a mods-only Close now button. Content shows a live tally and a Discord relative timestamp for the deadline.
- Ballots live in their own table, one per voter per vote, changeable. Only counts are shown, never who voted which way.
- Eligibility: not a bot, not the applicant, holds the eligible role if set, otherwise holds any tier role.
- Resolution runs at the deadline from a 60-second in-process sweeper, or immediately when a mod closes early. Outcome is pure: below quorum escalates to the mod review queue, otherwise yes ÷ total at or above the threshold admits and anything else rejects.
- Admission grants the tier the score earned (never below the entry tier), posts the welcome, and DMs the applicant. Rejection and escalation DM the applicant too. Every outcome hits the modlog and the audit table.
- A member who clicks Request review on a rejection always goes to mods, never to a vote. `/unlink` cancels any open vote on that member.

Why this is the right shape: the score stays the source of truth about the GitHub, and the community decides what to do with it. Communities that distrust automation can set `scope: all`; communities that only want humans on the edge cases keep the default.

## 8c. Intake question and lifecycle roles

Both per guild, both off by default. Requested by the first community using the bot.

```jsonc
"intake": { "askReason": false, "prompt": "Why do you want to join?" },
"roles":  { "unverifiedRoleId": null, "verifiedRoleId": null, "acceptedRoleId": null }
```

**Intake.** With `askReason` on, `/verify` opens a modal with one paragraph field (10 to 500 characters) before the Link GitHub button. The answer is held in memory next to the interaction token, keyed by the OAuth nonce, so it never travels in a URL. It is stored on the vote or review row and rendered as a block quote on that post, with mentions defused. It does not affect the score.

**Lifecycle.** A second axis next to tiers, for communities that gate on process rather than on score:

| Stage | Trigger | Roles |
|---|---|---|
| joined | member joins | + unverified |
| verified | GitHub ownership proven, any score, unless hard-blocked | + verified, − unverified |
| accepted | admitted by score, by vote, or by a mod | + accepted, + verified, − unverified, plus the tier role |
| reset | `/unlink` | − verified, − accepted, + unverified |

Promotion beyond `accepted` (for example Trial Member to Member) is deliberately manual. The bot has no view of how active someone is, and a community's sense of "sufficiently active" should not be a number.

The `joined` stage is the only thing in the bot that needs a privileged gateway intent. It is opt-in through `ENABLE_MEMBER_INTENT=1` so that installs which do not use it keep working with zero privileged intents, and `/rubric roles` warns when an unverified role is mapped but the intent is off.

## 9. Growth features (each under one hour)

- **SVG badge**: `GET /badge/:login.svg`, shields style, "Cracked Score 78 · Shipper", cached 24 h. People paste it into their README and every badge links back to the repo.
- **Receipt card** in Discord: unicode progress bars per dimension, top 3 strengths, top 3 things that would raise the score. Screenshot friendly.
- **Leaderboard** per guild.
- **Rubric presets** communities can brag about ("our bar is the systems preset at Shipper").
- **Add to your server** button in the README plus a live demo server.

---

## 10. Data, privacy, retention

Tables: `guilds`, `links`, `scores`, `reviews`, `audit`. No GitHub tokens are ever written to disk. Raw analysis blobs expire after 30 days. Failed attempts expire after 90 days. `/unlink` deletes everything about that user in that guild immediately. A `PRIVACY.md` states all of this in plain language.

---

## 11. Resource budget

- RAM: about 90 MB idle, about 140 MB under load.
- CPU: negligible. Analysis is network bound.
- GitHub API: the applicant's own quota. The bot's app token is used only for badge refreshes, 1 GraphQL point per refresh, cached 24 h.
- Storage: about 10 KB per applicant with the compressed raw blob. 100k applicants is roughly 1 GB.
- Cost: one Fly.io shared-cpu-1x 256 MB machine plus a 1 GB volume, about $3 per month. Or any $4 VPS.

---

## 12. Optional module: AI craft review (off by default)

For guilds that provide their own Anthropic API key: after scoring, sample up to three source files from the top repo, ask Claude Haiku for a five-line craft note (structure, naming, error handling, tests) and attach it to the receipt. About $0.002 per applicant. It is a differentiator, but it never affects the score, so the core stays deterministic and testable.
