import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Guild, type GuildMember } from 'discord.js';
import { and, eq, lte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { ballots, type VoteRow, votes } from '../db/schema.js';
import { COLORS, profileOf, receiptEmbed, welcomeEmbed } from '../discord/receipt.js';
import { log } from '../lib/logger.js';
import { snowflakeToDate } from '../lib/snowflake.js';
import { type Placement, type PlacementStatus, place, type Rubric } from '../scoring/index.js';
import { type GuildConfig, getGuild } from './guilds.js';
import {
  applyStage,
  dmUser,
  logAudit,
  quoteStatement,
  sendTo,
  syncTierRoles,
  upsertLink,
} from './members.js';
import { openReview } from './reviews.js';
import { loadScore } from './scores.js';
import type { Scored } from './verification.js';

export type VoteOutcome = 'admitted' | 'rejected' | 'escalated';

/** Does this placement go to a community vote under the guild's rubric? Pure. */
export function shouldVote(status: PlacementStatus, rubric: Rubric): boolean {
  const v = rubric.vote;
  if (!v.enabled || status === 'blocked') return false;
  switch (v.scope) {
    case 'review':
      return status === 'review';
    case 'admitted':
      return status === 'review' || status === 'admitted';
    case 'all':
      return true;
  }
}

/** Decide a closed vote. Pure. */
export function tallyOutcome(yes: number, no: number, quorum: number, thresholdPct: number): VoteOutcome {
  const total = yes + no;
  if (total < quorum) return 'escalated';
  return (100 * yes) / total >= thresholdPct ? 'admitted' : 'rejected';
}

export function voteChannel(g: GuildConfig): string | null {
  return g.rubric.vote.channelId ?? g.row.reviewChannelId ?? g.row.verifyChannelId;
}

/** Can this member vote on this applicant? */
export function voterEligibility(
  member: GuildMember,
  rubric: Rubric,
  applicantId: string,
): { ok: true } | { ok: false; reason: string } {
  if (member.user.bot) return { ok: false, reason: 'Bots do not vote.' };
  if (member.id === applicantId) return { ok: false, reason: 'You cannot vote on your own application.' };
  const need = rubric.vote.eligibleRoleId;
  if (need) {
    return member.roles.cache.has(need)
      ? { ok: true }
      : { ok: false, reason: `Only <@&${need}> members can vote.` };
  }
  const tierRoles = rubric.tiers.map((t) => t.roleId).filter((r): r is string => Boolean(r));
  if (!tierRoles.length) return { ok: true };
  return tierRoles.some((r) => member.roles.cache.has(r))
    ? { ok: true }
    : { ok: false, reason: 'Only verified members (holding a tier role) can vote.' };
}

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export function voteButtons(voteId: number, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`vote:yes:${voteId}`)
      .setLabel('Admit')
      .setEmoji('👍')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`vote:no:${voteId}`)
      .setLabel('Reject')
      .setEmoji('👎')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`vote:close:${voteId}`)
      .setLabel('Close now (mods)')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

export function renderVoteContent(v: VoteRow, total: number, tierName: string): string {
  const head = `**Vote #${v.id}** · <@${v.discordId}> as [${v.githubLogin}](<https://github.com/${v.githubLogin}>) · scored **${total}** (${tierName})`;
  const rule = `needs **${v.thresholdPct}%** yes of at least **${v.quorum}** ballots`;
  const why = quoteStatement(v.statement);
  if (v.status === 'open') {
    return `${head}${why}\n👍 **${v.yes}** · 👎 **${v.no}** · ${rule} · closes <t:${unix(v.closesAt)}:R>`;
  }
  const verdict = {
    admitted: `✅ **Admitted** as ${v.tier}`,
    rejected: '❌ **Rejected** by vote',
    escalated: '🟡 **Quorum not met**, sent to mod review',
    cancelled: '⚪ **Cancelled**',
    open: '',
  }[v.status];
  return `${head}\n👍 **${v.yes}** · 👎 **${v.no}** · ${rule}\n${verdict}${v.closedBy && v.closedBy !== 'scheduler' ? ` · closed early by <@${v.closedBy}>` : ''}`;
}

/** Post a vote for an applicant. Returns the row. */
export async function openVote(
  ctx: AppContext,
  guild: Guild,
  g: GuildConfig,
  discordId: string,
  scored: Scored,
  placement: Placement,
): Promise<VoteRow> {
  const v = g.rubric.vote;
  const channelId = voteChannel(g);
  const closesAt = new Date(Date.now() + v.durationHours * 3_600_000).toISOString();
  const inserted = ctx.db
    .insert(votes)
    .values({
      guildId: guild.id,
      discordId,
      githubId: scored.analysis.profile.id,
      githubLogin: scored.analysis.profile.login,
      scoreId: scored.scoreId,
      tier: placement.grantTier.name,
      statement: scored.statement ?? null,
      channelId,
      quorum: v.quorum,
      thresholdPct: Math.round(v.threshold * 100),
      closesAt,
    })
    .returning()
    .get();
  const messageId = await sendTo(ctx, channelId, {
    content: renderVoteContent(inserted, scored.result.total, placement.tier.name),
    embeds: [receiptEmbed(scored.result, placement, profileOf(scored.analysis), { compact: true })],
    components: [voteButtons(inserted.id)],
    allowedMentions: { parse: [] },
  });
  if (messageId) ctx.db.update(votes).set({ messageId }).where(eq(votes.id, inserted.id)).run();
  logAudit(
    ctx,
    guild.id,
    discordId,
    'vote:open',
    discordId,
    `#${inserted.id} ${scored.analysis.profile.login}`,
  );
  return { ...inserted, messageId };
}

export function getVote(ctx: AppContext, id: number): VoteRow | null {
  return ctx.db.select().from(votes).where(eq(votes.id, id)).get() ?? null;
}

export function openVoteFor(ctx: AppContext, guildId: string, discordId: string): VoteRow | null {
  return (
    ctx.db
      .select()
      .from(votes)
      .where(and(eq(votes.guildId, guildId), eq(votes.discordId, discordId), eq(votes.status, 'open')))
      .get() ?? null
  );
}

/** Record or change a ballot and return the refreshed vote row plus what happened. */
export function castBallot(
  ctx: AppContext,
  vote: VoteRow,
  voterId: string,
  choice: 'yes' | 'no',
): { vote: VoteRow; changed: 'new' | 'switched' | 'same' } {
  const existing = ctx.db
    .select()
    .from(ballots)
    .where(and(eq(ballots.voteId, vote.id), eq(ballots.voterId, voterId)))
    .get();
  let changed: 'new' | 'switched' | 'same';
  if (!existing) {
    ctx.db.insert(ballots).values({ voteId: vote.id, voterId, choice }).run();
    changed = 'new';
  } else if (existing.choice === choice) {
    changed = 'same';
  } else {
    ctx.db
      .update(ballots)
      .set({ choice, at: new Date().toISOString() })
      .where(eq(ballots.id, existing.id))
      .run();
    changed = 'switched';
  }
  const all = ctx.db
    .select({ choice: ballots.choice })
    .from(ballots)
    .where(eq(ballots.voteId, vote.id))
    .all();
  const yes = all.filter((b) => b.choice === 'yes').length;
  const no = all.length - yes;
  ctx.db.update(votes).set({ yes, no }).where(eq(votes.id, vote.id)).run();
  return { vote: { ...vote, yes, no }, changed };
}

async function editVoteMessage(
  ctx: AppContext,
  v: VoteRow,
  content: string,
  disabled: boolean,
): Promise<void> {
  if (!v.channelId || !v.messageId) return;
  try {
    const ch = await ctx.client.channels.fetch(v.channelId);
    if (!ch?.isTextBased()) return;
    const msg = await ch.messages.fetch(v.messageId);
    await msg.edit({ content, components: [voteButtons(v.id, disabled)], allowedMentions: { parse: [] } });
  } catch (err) {
    log.warn({ voteId: v.id, err: String(err) }, 'could not edit vote message');
  }
}

/** Re-render the live tally on the vote message. */
export async function refreshVoteMessage(ctx: AppContext, v: VoteRow): Promise<void> {
  const s = loadScore(ctx, v.scoreId);
  const g = getGuild(ctx, v.guildId);
  const tierName = s ? (placementFor(v, g, s.result, s.analysis)?.tier.name ?? v.tier) : v.tier;
  await editVoteMessage(ctx, v, renderVoteContent(v, s?.result.total ?? 0, tierName), v.status !== 'open');
}

function placementFor(
  v: VoteRow,
  g: GuildConfig,
  result: NonNullable<ReturnType<typeof loadScore>>['result'],
  analysis: NonNullable<ReturnType<typeof loadScore>>['analysis'],
): Placement | null {
  if (!analysis) return null;
  return place(result, analysis, g.rubric, {
    discordCreatedAt: snowflakeToDate(v.discordId),
    sharedGithub: false,
  });
}

/** Close a vote and apply the outcome. Idempotent: a vote that is not open is left alone. */
export async function resolveVote(
  ctx: AppContext,
  v: VoteRow,
  closedBy: string,
): Promise<VoteOutcome | null> {
  const fresh = getVote(ctx, v.id);
  if (fresh?.status !== 'open') return null;
  const outcome = tallyOutcome(fresh.yes, fresh.no, fresh.quorum, fresh.thresholdPct);
  const closedAt = new Date().toISOString();
  ctx.db.update(votes).set({ status: outcome, closedAt, closedBy }).where(eq(votes.id, v.id)).run();
  const done: VoteRow = { ...fresh, status: outcome, closedAt, closedBy };

  const guild = await ctx.client.guilds.fetch(fresh.guildId).catch(() => null);
  const g = getGuild(ctx, fresh.guildId);
  const s = loadScore(ctx, fresh.scoreId);
  const tier = g.rubric.tiers.find((t) => t.name === fresh.tier) ?? g.rubric.tiers[0]!;
  const login = fresh.githubLogin;
  const mention = `<@${fresh.discordId}>`;

  if (outcome === 'admitted' && guild) {
    if (s?.analysis) upsertLink(ctx, fresh.guildId, fresh.discordId, s.analysis, s.result, tier.name);
    try {
      const member = await guild.members.fetch(fresh.discordId);
      await syncTierRoles(member, g.rubric, tier.roleId);
      await applyStage(member, g.rubric, 'accepted');
    } catch (err) {
      log.warn({ voteId: v.id, err: String(err) }, 'role sync after vote failed');
    }
    if (s?.analysis) {
      const pl = placementFor(fresh, g, s.result, s.analysis);
      if (pl) {
        await sendTo(ctx, g.row.verifyChannelId, {
          embeds: [welcomeEmbed(s.result, { ...pl, grantTier: tier }, profileOf(s.analysis), mention)],
        });
      }
    }
    await dmUser(ctx, fresh.discordId, {
      content: `✅ The community voted you in to **${guild.name}** as **${tier.name}** (👍 ${fresh.yes} · 👎 ${fresh.no}).`,
    });
  } else if (outcome === 'rejected') {
    await dmUser(ctx, fresh.discordId, {
      content: `❌ The community vote in **${guild?.name ?? 'the server'}** did not pass (👍 ${fresh.yes} · 👎 ${fresh.no}, needed ${fresh.thresholdPct}%). You can ask a mod for a manual review.`,
    });
  } else if (outcome === 'escalated' && guild && s?.analysis) {
    const pl = placementFor(fresh, g, s.result, s.analysis);
    if (pl) {
      await openReview(ctx, guild, g, {
        discordId: fresh.discordId,
        analysis: s.analysis,
        result: s.result,
        scoreId: fresh.scoreId,
        placement: pl,
        reasons: [
          `Vote #${fresh.id} closed without quorum (👍 ${fresh.yes} · 👎 ${fresh.no}, needed ${fresh.quorum})`,
        ],
        statement: fresh.statement,
      });
    }
    await dmUser(ctx, fresh.discordId, {
      content: `🟡 Not enough members voted on your application in **${guild.name}**. A mod will review it manually.`,
    });
  }

  await editVoteMessage(ctx, done, renderVoteContent(done, s?.result.total ?? 0, tier.name), true);
  const icon = { admitted: '✅', rejected: '❌', escalated: '🟡' }[outcome];
  await sendTo(ctx, g.row.modlogChannelId, {
    content: `${icon} vote #${fresh.id} for ${mention} (${login}) closed: **${outcome}** · 👍 ${fresh.yes} · 👎 ${fresh.no}`,
    allowedMentions: { parse: [] },
  });
  logAudit(
    ctx,
    fresh.guildId,
    closedBy,
    `vote:${outcome}`,
    fresh.discordId,
    `#${fresh.id} ${login} ${fresh.yes}/${fresh.no}`,
  );
  log.info(
    { voteId: fresh.id, guild: fresh.guildId, outcome, yes: fresh.yes, no: fresh.no, closedBy },
    'vote closed',
  );
  return outcome;
}

/** Close every open vote whose deadline has passed. Called on an interval. */
export async function sweepVotes(ctx: AppContext, now = new Date()): Promise<number> {
  const due = ctx.db
    .select()
    .from(votes)
    .where(and(eq(votes.status, 'open'), lte(votes.closesAt, now.toISOString())))
    .all();
  for (const v of due) {
    try {
      await resolveVote(ctx, v, 'scheduler');
    } catch (err) {
      log.error({ voteId: v.id, err: String(err) }, 'vote sweep failed');
    }
  }
  return due.length;
}

export function listOpenVotes(ctx: AppContext, guildId: string): VoteRow[] {
  return ctx.db
    .select()
    .from(votes)
    .where(and(eq(votes.guildId, guildId), eq(votes.status, 'open')))
    .all();
}

export function cancelOpenVotes(ctx: AppContext, guildId: string, discordId: string, by: string): void {
  const open = openVoteFor(ctx, guildId, discordId);
  if (!open) return;
  ctx.db
    .update(votes)
    .set({ status: 'cancelled', closedAt: new Date().toISOString(), closedBy: by })
    .where(eq(votes.id, open.id))
    .run();
  void editVoteMessage(
    ctx,
    { ...open, status: 'cancelled', closedBy: by },
    renderVoteContent({ ...open, status: 'cancelled', closedBy: by }, 0, open.tier),
    true,
  );
}

export const VOTE_COLOR = COLORS.review;
