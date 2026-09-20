import type { Guild } from 'discord.js';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { reviews } from '../db/schema.js';
import { profileOf, receiptEmbed, reviewButtons } from '../discord/receipt.js';
import type { Analysis } from '../github/types.js';
import type { Placement, ScoreResult } from '../scoring/index.js';
import type { GuildConfig } from './guilds.js';
import { quoteStatement, sendTo } from './members.js';

/** Create a review row and post it to the review channel with Approve / Deny buttons. */
export async function openReview(
  ctx: AppContext,
  guild: Guild,
  g: GuildConfig,
  input: {
    discordId: string;
    analysis: Analysis;
    result: ScoreResult;
    scoreId: number;
    placement: Placement;
    reasons: string[];
    /** the applicant's intake answer, if the guild asks for one */
    statement?: string | null;
  },
): Promise<number> {
  const { discordId, analysis, result, scoreId, placement, reasons } = input;
  const statement = input.statement ?? null;
  const login = analysis.profile.login;
  const row = ctx.db
    .insert(reviews)
    .values({
      guildId: guild.id,
      discordId,
      githubId: analysis.profile.id,
      githubLogin: login,
      scoreId,
      tier: placement.grantTier.name,
      reason: reasons.join('\n'),
      statement,
    })
    .returning({ id: reviews.id })
    .get();
  const messageId = await sendTo(ctx, g.row.reviewChannelId, {
    content: `Review #${row.id} · <@${discordId}> as **${login}**\n${reasons.map((r) => `• ${r}`).join('\n')}${quoteStatement(statement)}`,
    embeds: [receiptEmbed(result, placement, profileOf(analysis), { compact: true })],
    components: [reviewButtons(row.id)],
    allowedMentions: { parse: [] },
  });
  if (messageId) ctx.db.update(reviews).set({ messageId }).where(eq(reviews.id, row.id)).run();
  return row.id;
}
