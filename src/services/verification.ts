import { gzipSync } from 'node:zlib';
import { type Guild, WebhookClient } from 'discord.js';
import { and, eq, ne } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { links, scores } from '../db/schema.js';
import {
  profileOf,
  receiptEmbed,
  requestReviewButton,
  statusLine,
  welcomeEmbed,
} from '../discord/receipt.js';
import { analyze } from '../github/analyzer.js';
import type { Analysis } from '../github/types.js';
import { log } from '../lib/logger.js';
import { snowflakeToDate } from '../lib/snowflake.js';
import type { VerifyState } from '../lib/state.js';
import { type Placement, place, type Rubric, type ScoreResult, score } from '../scoring/index.js';
import { type GuildConfig, getGuild } from './guilds.js';
import { applyStage, logAudit, sendTo, syncTierRoles, upsertLink } from './members.js';
import { openReview } from './reviews.js';
import { openVote, shouldVote, voteChannel } from './votes.js';

export { applyStage, logAudit, sendTo, syncTierRoles, upsertLink } from './members.js';
export { latestScore } from './scores.js';

const DAY = 86_400_000;

export interface Scored {
  analysis: Analysis;
  result: ScoreResult;
  scoreId: number;
  /** the applicant's intake answer, when the guild asks one and this run came from /verify */
  statement?: string | null;
}

/** Analyze + score + persist. Works with any token. */
export async function runScore(
  ctx: AppContext,
  token: string,
  login: string,
  rubric: Rubric,
  ownToken: boolean,
): Promise<Scored> {
  const analysis = await analyze(token, login, { ownToken });
  const result = score(analysis, rubric);
  const { analysis: _a, ...rest } = { ...result, analysis: undefined };
  const inserted = ctx.db
    .insert(scores)
    .values({
      githubId: analysis.profile.id,
      githubLogin: analysis.profile.login,
      total: result.total,
      raw: result.raw,
      result: JSON.stringify(rest),
      analysis: gzipSync(Buffer.from(JSON.stringify(analysis))),
      ownToken,
      expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
    })
    .returning({ id: scores.id })
    .get();
  ctx.lastAnalysisAt = Date.now();
  return { analysis, result, scoreId: inserted.id };
}

export function sharedGithub(ctx: AppContext, guildId: string, githubId: string, discordId: string): boolean {
  const other = ctx.db
    .select({ id: links.id })
    .from(links)
    .where(and(eq(links.guildId, guildId), eq(links.githubId, githubId), ne(links.discordId, discordId)))
    .get();
  return Boolean(other);
}

export type Route = Placement['status'] | 'vote';

/** What actually happens to this placement in this guild, once voting is taken into account. */
export function routeFor(placement: Placement, rubric: Rubric): Route {
  return shouldVote(placement.status, rubric) ? 'vote' : placement.status;
}

/**
 * Apply a placement inside a guild: roles, link row, review or vote post, welcome, modlog.
 * Returns the message the applicant should see.
 */
export async function applyPlacement(
  ctx: AppContext,
  guild: Guild,
  g: GuildConfig,
  discordId: string,
  scored: Scored,
  placement: Placement,
  opts: { skipVote?: boolean } = {},
): Promise<{ route: Route; content: string; roleError?: string; reviewId?: number; voteId?: number }> {
  const { analysis, result, scoreId } = scored;
  const login = analysis.profile.login;
  let roleError: string | undefined;
  let reviewId: number | undefined;
  let voteId: number | undefined;
  const route: Route = opts.skipVote ? placement.status : routeFor(placement, g.rubric);
  const icon = { admitted: '✅', review: '🟡', rejected: '❌', blocked: '⛔', vote: '🗳️' }[route];

  if (route === 'vote') {
    const v = await openVote(ctx, guild, g, discordId, scored, placement);
    voteId = v.id;
    const ch = voteChannel(g);
    const closes = Math.floor(Date.parse(v.closesAt) / 1000);
    const content =
      `🗳️ **Your application is up for a community vote**${ch ? ` in <#${ch}>` : ''}. ` +
      `It closes <t:${closes}:R>. You'll get a DM with the result.` +
      `\nYour score: **${result.total}/100 · ${placement.tier.name}**.`;
    await sendTo(ctx, g.row.modlogChannelId, {
      content: `${icon} <@${discordId}> → [${login}](<https://github.com/${login}>) · **${result.total}** · ${placement.tier.name} · vote #${v.id} opened`,
      allowedMentions: { parse: [] },
    });
    logAudit(ctx, guild.id, discordId, 'verify:vote', discordId, `${login} ${result.total} vote #${v.id}`);
    return { route, content, voteId };
  }

  if (route === 'admitted') {
    upsertLink(ctx, guild.id, discordId, analysis, result, placement.grantTier.name);
    try {
      const member = await guild.members.fetch(discordId);
      await syncTierRoles(member, g.rubric, placement.grantTier.roleId);
      await applyStage(member, g.rubric, 'accepted');
    } catch (err) {
      roleError =
        'Placed, but I could not update roles. A mod needs to move my role above the roles I assign.';
      log.warn({ guildId: guild.id, err: String(err) }, 'role sync failed');
    }
    await sendTo(ctx, g.row.verifyChannelId, {
      embeds: [welcomeEmbed(result, placement, profileOf(analysis), `<@${discordId}>`)],
    });
  }

  if (route === 'review') {
    reviewId = await openReview(ctx, guild, g, {
      discordId,
      analysis,
      result,
      scoreId,
      placement,
      reasons: placement.reasons,
      statement: scored.statement,
    });
  }

  await sendTo(ctx, g.row.modlogChannelId, {
    content: `${icon} <@${discordId}> → [${login}](<https://github.com/${login}>) · **${result.total}** · ${placement.tier.name} · ${route}${
      placement.flags.length ? ` · flags: ${placement.flags.map((f) => f.code).join(', ')}` : ''
    }`,
    allowedMentions: { parse: [] },
  });
  logAudit(ctx, guild.id, discordId, `verify:${route}`, discordId, `${login} ${result.total}`);

  return { route, content: statusLine(placement), roleError, reviewId };
}

/** Full pipeline after the OAuth callback. */
export async function completeVerification(
  ctx: AppContext,
  state: VerifyState,
  /** interaction token from /verify, null if the bot restarted since (falls back to a DM) */
  interactionToken: string | null,
  token: string,
  viewerLogin: string,
  viewerId: string,
  /** the applicant's intake answer, null when the guild does not ask one */
  statement: string | null = null,
): Promise<
  | { ok: true; status: Placement['status']; route: Route; login: string; total: number; tier: string }
  | { ok: false; message: string }
> {
  const guild = await ctx.client.guilds.fetch(state.g).catch(() => null);
  if (!guild) return { ok: false, message: 'I am no longer in that server.' };
  const g = getGuild(ctx, state.g);
  const webhook = interactionToken
    ? new WebhookClient({ id: ctx.cfg.DISCORD_APP_ID, token: interactionToken })
    : null;
  const edit = async (payload: Parameters<WebhookClient['editMessage']>[1]): Promise<void> => {
    if (webhook) {
      const ok = await webhook
        .editMessage('@original', payload)
        .then(() => true)
        .catch((err) => {
          log.warn({ err: String(err) }, 'webhook edit failed');
          return false;
        });
      if (ok) return;
    }
    // no usable interaction: DM the applicant instead
    const user = await ctx.client.users.fetch(state.u).catch(() => null);
    const { components: _c, ...dm } = payload as {
      components?: unknown;
      content?: string;
      embeds?: unknown[];
    };
    await user?.send(dm as Parameters<NonNullable<typeof user>['send']>[0]).catch(() => {});
  };

  const shared = sharedGithub(ctx, state.g, viewerId, state.u);

  let scored: Scored;
  try {
    scored = await runScore(ctx, token, viewerLogin, g.rubric, true);
  } catch (err) {
    log.error({ err: String(err), login: viewerLogin }, 'analysis failed');
    await edit({ content: 'GitHub analysis failed. Try again in a minute.', components: [] });
    return { ok: false, message: 'GitHub analysis failed. Go back to Discord and try again in a minute.' };
  }

  scored.statement = statement;

  const placement = place(scored.result, scored.analysis, g.rubric, {
    discordCreatedAt: snowflakeToDate(state.u),
    sharedGithub: shared,
  });

  // Ownership is proven at this point whatever the score says, so the verified role goes on now.
  // A hard block (shared GitHub, commit bot) is the one case that does not earn it.
  if (placement.status !== 'blocked') {
    try {
      const member = await guild.members.fetch(state.u);
      await applyStage(member, g.rubric, 'verified');
    } catch (err) {
      log.warn({ guildId: guild.id, err: String(err) }, 'could not apply verified role');
    }
  }

  const applied = await applyPlacement(ctx, guild, g, state.u, scored, placement);

  const components = applied.route === 'rejected' ? [requestReviewButton(scored.scoreId)] : [];
  await edit({
    content: [applied.content, applied.roleError].filter(Boolean).join('\n'),
    embeds: [receiptEmbed(scored.result, placement, profileOf(scored.analysis))],
    components,
  });

  log.info(
    {
      guild: state.g,
      user: state.u,
      login: viewerLogin,
      total: scored.result.total,
      tier: placement.tier.name,
      status: placement.status,
      flags: placement.flags.map((f) => f.code),
      ms: scored.analysis.durationMs,
      viaDm: !webhook,
    },
    'verification complete',
  );
  return {
    ok: true,
    status: placement.status,
    route: applied.route,
    login: viewerLogin,
    total: scored.result.total,
    tier: placement.tier.name,
  };
}
