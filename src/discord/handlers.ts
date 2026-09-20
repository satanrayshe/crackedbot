import { gunzipSync } from 'node:zlib';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type Interaction,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { and, desc, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { links, reviews, scores } from '../db/schema.js';
import type { Analysis } from '../github/types.js';
import { log } from '../lib/logger.js';
import { snowflakeToDate } from '../lib/snowflake.js';
import { newNonce, signState } from '../lib/state.js';
import {
  applyPreset,
  DIMENSION_LABELS,
  DIMENSIONS,
  PRESETS,
  type PresetName,
  parseRubric,
  place,
  rubricSchema,
  type ScoreResult,
  tierIndex,
  type VoteScope,
} from '../scoring/index.js';
import { type GuildConfig, getGuild, isConfigured, updateGuild } from '../services/guilds.js';
import {
  applyPlacement,
  applyStage,
  latestScore,
  logAudit,
  runScore,
  sendTo,
  syncTierRoles,
  upsertLink,
} from '../services/verification.js';
import {
  cancelOpenVotes,
  castBallot,
  getVote,
  listOpenVotes,
  openVoteFor,
  refreshVoteMessage,
  resolveVote,
  voterEligibility,
} from '../services/votes.js';
import { COLORS, linkButton, receiptEmbed } from './receipt.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

function isMod(i: ChatInputCommandInteraction | ButtonInteraction): boolean {
  return Boolean(i.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

function scoreFromRow(row: typeof scores.$inferSelect): { result: ScoreResult; analysis: Analysis | null } {
  const result = JSON.parse(row.result) as ScoreResult;
  const analysis = row.analysis ? (JSON.parse(gunzipSync(row.analysis).toString('utf8')) as Analysis) : null;
  return { result, analysis };
}

export function makeInteractionHandler(ctx: AppContext) {
  return async (interaction: Interaction): Promise<void> => {
    try {
      if (interaction.isChatInputCommand()) await handleCommand(ctx, interaction);
      else if (interaction.isButton()) await handleButton(ctx, interaction);
      else if (interaction.isModalSubmit()) await handleModal(ctx, interaction);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.stack : String(err) }, 'interaction failed');
      if (interaction.isRepliable()) {
        const content = 'Something broke on my end. Try again, or ping a mod.';
        if (interaction.deferred || interaction.replied)
          await interaction.editReply({ content }).catch(() => {});
        else await interaction.reply({ content, ...EPHEMERAL }).catch(() => {});
      }
    }
  };
}

async function handleCommand(ctx: AppContext, i: ChatInputCommandInteraction): Promise<void> {
  if (!i.inCachedGuild()) {
    await i.reply({ content: 'Use this inside a server.', ...EPHEMERAL });
    return;
  }
  switch (i.commandName) {
    case 'verify':
      return verify(ctx, i);
    case 'score':
      return scoreCmd(ctx, i);
    case 'unlink':
      return unlink(ctx, i);
    case 'leaderboard':
      return leaderboard(ctx, i);
    case 'setup':
      return setup(ctx, i);
    case 'rubric':
      return rubric(ctx, i);
    case 'whois':
      return whois(ctx, i);
    case 'rescore':
      return rescore(ctx, i);
    case 'review':
      return reviewList(ctx, i);
    case 'votes':
      return votesList(ctx, i);
    default:
      await i.reply({ content: 'Unknown command.', ...EPHEMERAL });
  }
}

// ---------- member commands ----------

async function verify(ctx: AppContext, i: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const g = getGuild(ctx, i.guildId);
  if (!isConfigured(g)) {
    await i.reply({ content: 'This server has not run `/setup` yet. Ping an admin.', ...EPHEMERAL });
    return;
  }
  if (g.row.verifyChannelId && i.channelId !== g.row.verifyChannelId) {
    await i.reply({ content: `Run this in <#${g.row.verifyChannelId}>.`, ...EPHEMERAL });
    return;
  }
  const existing = ctx.db
    .select()
    .from(links)
    .where(and(eq(links.guildId, i.guildId), eq(links.discordId, i.user.id)))
    .get();
  if (existing) {
    await i.reply({
      content: `You're already verified as **${existing.githubLogin}** (${existing.tier}, ${existing.score}/100). Run \`/unlink\` first to link a different account.`,
      ...EPHEMERAL,
    });
    return;
  }
  const pending = openVoteFor(ctx, i.guildId, i.user.id);
  if (pending) {
    await i.reply({
      content: `Vote #${pending.id} on your application is still open and closes <t:${Math.floor(Date.parse(pending.closesAt) / 1000)}:R>. You'll get a DM with the result.`,
      ...EPHEMERAL,
    });
    return;
  }
  if (g.rubric.intake.askReason) {
    const input = new TextInputBuilder()
      .setCustomId('statement')
      .setLabel(g.rubric.intake.prompt)
      .setStyle(TextInputStyle.Paragraph)
      .setMinLength(10)
      .setMaxLength(500)
      .setRequired(true)
      .setPlaceholder('A few sentences. Members will see this when they vote.');
    await i.showModal(
      new ModalBuilder()
        .setCustomId('verify:intake')
        .setTitle('Before you link GitHub')
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
    );
    return;
  }
  await sendLink(ctx, i, null);
}

/** Reply with the one-time Link GitHub button, holding the interaction token and intake answer server-side. */
async function sendLink(
  ctx: AppContext,
  i: ChatInputCommandInteraction<'cached'> | ModalSubmitInteraction<'cached'>,
  statement: string | null,
): Promise<void> {
  const nonce = newNonce();
  ctx.verifier.remember(nonce, i.token, Date.now(), statement);
  const state = signState(ctx.cfg.STATE_SECRET, {
    g: i.guildId,
    u: i.user.id,
    c: i.channelId ?? '0',
    n: nonce,
  });
  const url = `${ctx.cfg.PUBLIC_URL}/auth/start?s=${encodeURIComponent(state)}`;
  await i.reply({
    content:
      'Click the button, sign in with GitHub, and come back. The link is yours only and expires in 10 minutes.\n' +
      'I read public data plus your own contribution counts. No repo access, and I never store the token.',
    components: [linkButton(url)],
    ...EPHEMERAL,
  });
}

async function handleModal(ctx: AppContext, i: ModalSubmitInteraction): Promise<void> {
  if (!i.inCachedGuild()) return;
  if (i.customId !== 'verify:intake') return;
  const statement = i.fields.getTextInputValue('statement').trim();
  await sendLink(ctx, i, statement || null);
}

async function scoreCmd(ctx: AppContext, i: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const target = i.options.getUser('user');
  if (target && target.id !== i.user.id && !isMod(i)) {
    await i.reply({ content: 'Only mods can view other members’ receipts.', ...EPHEMERAL });
    return;
  }
  const userId = target?.id ?? i.user.id;
  await showReceipt(ctx, i, userId);
}

async function showReceipt(
  ctx: AppContext,
  i: ChatInputCommandInteraction<'cached'>,
  userId: string,
): Promise<void> {
  const g = getGuild(ctx, i.guildId);
  const link = ctx.db
    .select()
    .from(links)
    .where(and(eq(links.guildId, i.guildId), eq(links.discordId, userId)))
    .get();
  if (!link) {
    await i.reply({
      content: userId === i.user.id ? 'You have not verified yet. Run `/verify`.' : 'Not linked.',
      ...EPHEMERAL,
    });
    return;
  }
  const row = latestScore(ctx, link.githubId);
  if (!row) {
    await i.reply({ content: 'Linked, but no stored score. Ask a mod to `/rescore`.', ...EPHEMERAL });
    return;
  }
  const { result, analysis } = scoreFromRow(row);
  const placement = analysis
    ? place(result, analysis, g.rubric, { discordCreatedAt: snowflakeToDate(userId), sharedGithub: false })
    : null;
  const profile = { login: link.githubLogin, avatarUrl: analysis?.profile.avatarUrl ?? '' };
  const embed = placement
    ? receiptEmbed(result, placement, profile)
    : new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle(`${link.githubLogin} · ${result.total}/100 · ${link.tier}`);
  await i.reply({ embeds: [embed], ...EPHEMERAL });
}

async function unlink(ctx: AppContext, i: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const g = getGuild(ctx, i.guildId);
  const link = ctx.db
    .select()
    .from(links)
    .where(and(eq(links.guildId, i.guildId), eq(links.discordId, i.user.id)))
    .get();
  if (!link) {
    await i.reply({ content: 'Nothing linked.', ...EPHEMERAL });
    return;
  }
  ctx.db.delete(links).where(eq(links.id, link.id)).run();
  cancelOpenVotes(ctx, i.guildId, i.user.id, i.user.id);
  const elsewhere = ctx.db
    .select({ id: links.id })
    .from(links)
    .where(eq(links.githubId, link.githubId))
    .get();
  if (!elsewhere) ctx.db.delete(scores).where(eq(scores.githubId, link.githubId)).run();
  try {
    await syncTierRoles(i.member, g.rubric, null);
    await applyStage(i.member, g.rubric, 'reset');
  } catch (err) {
    log.warn({ err: String(err) }, 'role removal failed on unlink');
  }
  logAudit(ctx, i.guildId, i.user.id, 'unlink', i.user.id, link.githubLogin);
  await i.reply({
    content: `Unlinked **${link.githubLogin}** and removed tier roles. Your stored data is gone.`,
    ...EPHEMERAL,
  });
}

async function leaderboard(ctx: AppContext, i: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const rows = ctx.db
    .select()
    .from(links)
    .where(and(eq(links.guildId, i.guildId), eq(links.leaderboardOptOut, false)))
    .orderBy(desc(links.score))
    .limit(10)
    .all();
  if (!rows.length) {
    await i.reply({ content: 'Nobody has verified yet.', ...EPHEMERAL });
    return;
  }
  const lines = rows.map(
    (r, idx) =>
      `**${idx + 1}.** <@${r.discordId}> · [${r.githubLogin}](<https://github.com/${r.githubLogin}>) · **${r.score}** · ${r.tier}`,
  );
  await i.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('Cracked leaderboard')
        .setDescription(lines.join('\n')),
    ],
    allowedMentions: { parse: [] },
  });
}

// ---------- admin commands ----------

async function setup(ctx: AppContext, i: ChatInputCommandInteraction<'cached'>): Promise<void> {
  if (!isMod(i)) return deny(i);
  const verifyCh = i.options.getChannel('verify-channel', true);
  const modlog = i.options.getChannel('modlog-channel');
  const review = i.options.getChannel('review-channel');
  const g = updateGuild(ctx, i.guildId, {
    verifyChannelId: verifyCh.id,
    modlogChannelId: modlog?.id ?? null,
    reviewChannelId: review?.id ?? null,
  });
  const me = await i.guild.members.fetchMe();
  const tierRoles = g.rubric.tiers.filter((t) => t.roleId);
  const unreachable = tierRoles.filter((t) => {
    const role = i.guild.roles.cache.get(t.roleId!);
    return role && role.position >= me.roles.highest.position;
  });
  const warn = unreachable.length
    ? `\n⚠️ My role sits below: ${unreachable.map((t) => `<@&${t.roleId}>`).join(', ')}. Move my role above them or I cannot assign them.`
    : '';
  const mapped = tierRoles.length
    ? tierRoles.map((t) => `${t.name} → <@&${t.roleId}>`).join(', ')
    : 'none yet, use `/rubric tier <name> <role>`';
  logAudit(ctx, i.guildId, i.user.id, 'setup');
  await i.reply({
    content: `Saved.\n• verify: <#${verifyCh.id}>\n• modlog: ${modlog ? `<#${modlog.id}>` : 'off'}\n• review: ${review ? `<#${review.id}>` : 'off'}\n• tier roles: ${mapped}\n• preset: ${g.rubric.preset}, entry tier: ${g.rubric.entryTier}${warn}`,
    allowedMentions: { parse: [] },
    ...EPHEMERAL,
  });
}

async function rubric(ctx: AppContext, i: ChatInputCommandInteraction<'cached'>): Promise<void> {
  if (!isMod(i)) return deny(i);
  const sub = i.options.getSubcommand();
  const g = getGuild(ctx, i.guildId);

  if (sub === 'view') {
    await i.reply({ embeds: [rubricEmbed(g)], ...EPHEMERAL });
    return;
  }
  if (sub === 'preset') {
    const name = i.options.getString('name', true) as PresetName;
    const next = updateGuild(ctx, i.guildId, { rubric: applyPreset(g.rubric, name) });
    logAudit(ctx, i.guildId, i.user.id, 'rubric:preset', undefined, name);
    await i.reply({
      content: `Applied **${name}**: ${PRESETS[name].description}`,
      embeds: [rubricEmbed(next)],
      ...EPHEMERAL,
    });
    return;
  }
  if (sub === 'tier') {
    const name = i.options.getString('name', true);
    const role = i.options.getRole('role');
    const idx = tierIndex(g.rubric, name);
    if (idx < 0) {
      await i.reply({
        content: `No tier named **${name}**. Tiers: ${g.rubric.tiers.map((t) => t.name).join(', ')}`,
        ...EPHEMERAL,
      });
      return;
    }
    const tiers = g.rubric.tiers.map((t, k) => (k === idx ? { ...t, roleId: role?.id ?? null } : t));
    const next = updateGuild(ctx, i.guildId, { rubric: rubricSchema.parse({ ...g.rubric, tiers }) });
    logAudit(ctx, i.guildId, i.user.id, 'rubric:tier', undefined, `${name}=${role?.id ?? 'none'}`);
    await i.reply({
      content: role
        ? `**${next.rubric.tiers[idx]!.name}** now grants <@&${role.id}>.`
        : `**${name}** no longer grants a role.`,
      allowedMentions: { parse: [] },
      ...EPHEMERAL,
    });
    return;
  }
  if (sub === 'entry') {
    const name = i.options.getString('name', true);
    const idx = tierIndex(g.rubric, name);
    if (idx < 0) {
      await i.reply({ content: `No tier named **${name}**.`, ...EPHEMERAL });
      return;
    }
    updateGuild(ctx, i.guildId, {
      rubric: rubricSchema.parse({ ...g.rubric, entryTier: g.rubric.tiers[idx]!.name }),
    });
    await i.reply({ content: `Entry tier is now **${g.rubric.tiers[idx]!.name}**.`, ...EPHEMERAL });
    return;
  }
  if (sub === 'vote') {
    const enabled = i.options.getBoolean('enabled');
    const scope = i.options.getString('scope') as VoteScope | null;
    const channel = i.options.getChannel('channel');
    const voters = i.options.getRole('voters');
    const hours = i.options.getInteger('hours');
    const quorum = i.options.getInteger('quorum');
    const threshold = i.options.getInteger('threshold');
    const changed = [enabled, scope, channel, voters, hours, quorum, threshold].some((x) => x !== null);
    if (changed) {
      const vote = {
        ...g.rubric.vote,
        ...(enabled !== null ? { enabled } : {}),
        ...(scope ? { scope } : {}),
        ...(channel ? { channelId: channel.id } : {}),
        ...(voters ? { eligibleRoleId: voters.id } : {}),
        ...(hours !== null ? { durationHours: hours } : {}),
        ...(quorum !== null ? { quorum } : {}),
        ...(threshold !== null ? { threshold: threshold / 100 } : {}),
      };
      updateGuild(ctx, i.guildId, { rubric: rubricSchema.parse({ ...g.rubric, vote }) });
      logAudit(ctx, i.guildId, i.user.id, 'rubric:vote', undefined, JSON.stringify(vote));
    }
    const v = getGuild(ctx, i.guildId).rubric.vote;
    const scopeText = {
      review: 'borderline cases only',
      admitted: 'everyone who would get in, plus borderline',
      all: 'everyone except hard blocks',
    }[v.scope];
    await i.reply({
      content:
        `${changed ? 'Saved. ' : ''}Community voting is **${v.enabled ? 'on' : 'off'}**.\n` +
        `• scope: ${v.scope} (${scopeText})\n` +
        `• channel: ${v.channelId ? `<#${v.channelId}>` : g.row.reviewChannelId ? `<#${g.row.reviewChannelId}> (review channel)` : 'verify channel'}\n` +
        `• voters: ${v.eligibleRoleId ? `<@&${v.eligibleRoleId}>` : 'anyone holding a tier role'}\n` +
        `• open for ${v.durationHours}h · quorum ${v.quorum} · needs ${Math.round(v.threshold * 100)}% yes\n` +
        `• below quorum → mod review`,
      allowedMentions: { parse: [] },
      ...EPHEMERAL,
    });
    return;
  }
  if (sub === 'intake') {
    const ask = i.options.getBoolean('ask-reason');
    const prompt = i.options.getString('prompt');
    const changed = ask !== null || prompt !== null;
    if (changed) {
      const intake = {
        ...g.rubric.intake,
        ...(ask !== null ? { askReason: ask } : {}),
        ...(prompt ? { prompt } : {}),
      };
      updateGuild(ctx, i.guildId, { rubric: rubricSchema.parse({ ...g.rubric, intake }) });
      logAudit(ctx, i.guildId, i.user.id, 'rubric:intake', undefined, JSON.stringify(intake));
    }
    const n = getGuild(ctx, i.guildId).rubric.intake;
    await i.reply({
      content:
        `${changed ? 'Saved. ' : ''}Intake question is **${n.askReason ? 'on' : 'off'}**.\n` +
        `• prompt: “${n.prompt}”\n` +
        '• the answer is shown on the vote post and the mod review post, and nowhere else',
      ...EPHEMERAL,
    });
    return;
  }
  if (sub === 'roles') {
    const picks = {
      unverifiedRoleId: i.options.getRole('unverified')?.id,
      verifiedRoleId: i.options.getRole('verified')?.id,
      acceptedRoleId: i.options.getRole('accepted')?.id,
    };
    const clear = i.options.getString('clear') as 'unverified' | 'verified' | 'accepted' | null;
    const changed = Boolean(clear) || Object.values(picks).some(Boolean);
    if (changed) {
      const roles = { ...g.rubric.roles };
      for (const [k, v] of Object.entries(picks)) if (v) roles[k as keyof typeof roles] = v;
      if (clear) roles[`${clear}RoleId`] = null;
      updateGuild(ctx, i.guildId, { rubric: rubricSchema.parse({ ...g.rubric, roles }) });
      logAudit(ctx, i.guildId, i.user.id, 'rubric:roles', undefined, JSON.stringify(roles));
    }
    const r = getGuild(ctx, i.guildId).rubric.roles;
    const show = (id: string | null) => (id ? `<@&${id}>` : 'not set');
    const me = await i.guild.members.fetchMe();
    const tooHigh = [r.unverifiedRoleId, r.verifiedRoleId, r.acceptedRoleId].filter((id) => {
      const role = id ? i.guild.roles.cache.get(id) : null;
      return role && role.position >= me.roles.highest.position;
    });
    const notes = [
      r.unverifiedRoleId && !ctx.cfg.ENABLE_MEMBER_INTENT
        ? '⚠️ Unverified-on-join is not active: the host must set `ENABLE_MEMBER_INTENT=1` and switch on **Server Members Intent** in the Discord Developer Portal. Verified and accepted work without it.'
        : null,
      tooHigh.length
        ? `⚠️ My role sits below ${tooHigh.map((id) => `<@&${id}>`).join(', ')}. Move my role above them or I cannot assign them.`
        : null,
    ].filter(Boolean);
    await i.reply({
      content:
        `${changed ? 'Saved. ' : ''}Lifecycle roles:\n` +
        `• on join → ${show(r.unverifiedRoleId)}\n` +
        `• GitHub ownership proven → ${show(r.verifiedRoleId)} (unverified removed)\n` +
        `• admitted by score, vote, or mod → ${show(r.acceptedRoleId)} plus the tier role\n` +
        '• promotion beyond that is yours to do by hand' +
        (notes.length ? `\n${notes.join('\n')}` : ''),
      allowedMentions: { parse: [] },
      ...EPHEMERAL,
    });
    return;
  }
  if (sub === 'export') {
    const file = new AttachmentBuilder(Buffer.from(JSON.stringify(g.rubric, null, 2)), {
      name: 'rubric.json',
    });
    await i.reply({ files: [file], ...EPHEMERAL });
    return;
  }
  if (sub === 'import') {
    const att = i.options.getAttachment('file', true);
    if (att.size > 64_000) {
      await i.reply({ content: 'File too large.', ...EPHEMERAL });
      return;
    }
    await i.deferReply(EPHEMERAL);
    let json: unknown;
    try {
      json = await (await fetch(att.url, { signal: AbortSignal.timeout(10_000) })).json();
    } catch {
      await i.editReply('Could not read that file as JSON.');
      return;
    }
    const parsed = parseRubric(json);
    if (!parsed.ok) {
      await i.editReply(`Invalid rubric:\n${parsed.errors.map((e) => `• ${e}`).join('\n')}`);
      return;
    }
    const next = updateGuild(ctx, i.guildId, { rubric: parsed.rubric });
    logAudit(ctx, i.guildId, i.user.id, 'rubric:import');
    await i.editReply({ content: 'Rubric replaced.', embeds: [rubricEmbed(next)] });
  }
}

function rubricEmbed(g: GuildConfig): EmbedBuilder {
  const r = g.rubric;
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`Rubric · preset ${r.preset}`)
    .addFields(
      { name: 'Weights', value: DIMENSIONS.map((d) => `${DIMENSION_LABELS[d]} ${r.weights[d]}`).join(' · ') },
      {
        name: 'Tiers',
        value: r.tiers
          .map(
            (t) =>
              `${t.name} ≥ ${t.min}${t.roleId ? ` → <@&${t.roleId}>` : ''}${t.name === r.entryTier ? ' (entry)' : ''}`,
          )
          .join('\n'),
      },
      {
        name: 'Gates',
        value: [
          `min account age ${r.gates.minAccountAgeDays}d`,
          r.gates.requireLanguagesAnyOf.length
            ? `languages: ${r.gates.requireLanguagesAnyOf.join(', ')}`
            : 'any language',
          r.gates.requireExternalMergedPR ? 'external merged PR required' : 'no PR requirement',
          `review if score ≥ ${r.gates.reviewBelowScore}`,
          `block on: ${r.gates.blockFlags.join(', ') || 'nothing'}`,
        ].join('\n'),
      },
      {
        name: 'Community vote',
        value: r.vote.enabled
          ? `on · scope ${r.vote.scope} · ${r.vote.durationHours}h · quorum ${r.vote.quorum} · ${Math.round(r.vote.threshold * 100)}% yes`
          : 'off (`/rubric vote enabled:true` to turn on)',
      },
    );
}

async function whois(ctx: AppContext, i: ChatInputCommandInteraction<'cached'>): Promise<void> {
  if (!isMod(i)) return deny(i);
  const user = i.options.getUser('user', true);
  await showReceipt(ctx, i, user.id);
}

async function rescore(ctx: AppContext, i: ChatInputCommandInteraction<'cached'>): Promise<void> {
  if (!isMod(i)) return deny(i);
  const token = ctx.cfg.GITHUB_APP_FALLBACK_TOKEN;
  if (!token) {
    await i.reply({ content: 'Set `GITHUB_APP_FALLBACK_TOKEN` to enable rescoring.', ...EPHEMERAL });
    return;
  }
  const user = i.options.getUser('user', true);
  const g = getGuild(ctx, i.guildId);
  const link = ctx.db
    .select()
    .from(links)
    .where(and(eq(links.guildId, i.guildId), eq(links.discordId, user.id)))
    .get();
  if (!link) {
    await i.reply({ content: 'That member has not linked a GitHub account.', ...EPHEMERAL });
    return;
  }
  await i.deferReply(EPHEMERAL);
  const scored = await runScore(ctx, token, link.githubLogin, g.rubric, false);
  const placement = place(scored.result, scored.analysis, g.rubric, {
    discordCreatedAt: snowflakeToDate(user.id),
    sharedGithub: false,
  });
  const prevIdx = tierIndex(g.rubric, link.tier);
  const nextIdx = tierIndex(g.rubric, placement.tier.name);
  const demote = g.rubric.rescore.demote;
  let note: string;
  if (placement.status === 'admitted' && (nextIdx > prevIdx || demote)) {
    upsertLink(ctx, i.guildId, user.id, scored.analysis, scored.result, placement.grantTier.name);
    const member = await i.guild.members.fetch(user.id);
    await syncTierRoles(member, g.rubric, placement.grantTier.roleId);
    note = `Updated: ${link.tier} → ${placement.grantTier.name}.`;
  } else {
    ctx.db
      .update(links)
      .set({ score: scored.result.total, rescoredAt: new Date().toISOString() })
      .where(eq(links.id, link.id))
      .run();
    note = `Score refreshed (${scored.result.total}). Tier kept at ${link.tier}${nextIdx < prevIdx && !demote ? ' because demotion is off' : ''}.`;
  }
  logAudit(ctx, i.guildId, i.user.id, 'rescore', user.id, note);
  await sendTo(ctx, g.row.modlogChannelId, {
    content: `🔁 <@${i.user.id}> rescored <@${user.id}>: ${note}`,
    allowedMentions: { parse: [] },
  });
  await i.editReply({
    content: note,
    embeds: [
      receiptEmbed(scored.result, placement, {
        login: link.githubLogin,
        avatarUrl: scored.analysis.profile.avatarUrl,
      }),
    ],
  });
}

async function reviewList(ctx: AppContext, i: ChatInputCommandInteraction<'cached'>): Promise<void> {
  if (!isMod(i)) return deny(i);
  const open = ctx.db
    .select()
    .from(reviews)
    .where(and(eq(reviews.guildId, i.guildId), eq(reviews.status, 'open')))
    .orderBy(desc(reviews.id))
    .limit(15)
    .all();
  if (!open.length) {
    await i.reply({ content: 'No open reviews.', ...EPHEMERAL });
    return;
  }
  const g = getGuild(ctx, i.guildId);
  const lines = open.map((r) => {
    const link =
      g.row.reviewChannelId && r.messageId
        ? `https://discord.com/channels/${i.guildId}/${g.row.reviewChannelId}/${r.messageId}`
        : null;
    return `**#${r.id}** <@${r.discordId}> as ${r.githubLogin}${link ? ` · [open](${link})` : ''}\n${r.reason
      .split('\n')
      .map((x) => `  • ${x}`)
      .join('\n')}`;
  });
  await i.reply({ content: lines.join('\n').slice(0, 1900), allowedMentions: { parse: [] }, ...EPHEMERAL });
}

async function votesList(ctx: AppContext, i: ChatInputCommandInteraction<'cached'>): Promise<void> {
  if (!isMod(i)) return deny(i);
  const open = listOpenVotes(ctx, i.guildId);
  if (!open.length) {
    await i.reply({ content: 'No open votes.', ...EPHEMERAL });
    return;
  }
  const lines = open.map((v) => {
    const link =
      v.channelId && v.messageId
        ? `https://discord.com/channels/${i.guildId}/${v.channelId}/${v.messageId}`
        : null;
    return `**#${v.id}** <@${v.discordId}> as ${v.githubLogin} · 👍 ${v.yes} · 👎 ${v.no} · closes <t:${Math.floor(Date.parse(v.closesAt) / 1000)}:R>${link ? ` · [open](${link})` : ''}`;
  });
  await i.reply({ content: lines.join('\n').slice(0, 1900), allowedMentions: { parse: [] }, ...EPHEMERAL });
}

async function deny(i: ChatInputCommandInteraction): Promise<void> {
  await i.reply({ content: 'Mods only.', ...EPHEMERAL });
}

// ---------- buttons ----------

async function handleButton(ctx: AppContext, i: ButtonInteraction): Promise<void> {
  if (!i.inCachedGuild()) return;
  const [ns, action, idStr] = i.customId.split(':');
  const id = Number(idStr);

  if (ns === 'review' && (action === 'approve' || action === 'deny')) {
    if (!isMod(i)) {
      await i.reply({ content: 'Mods only.', ...EPHEMERAL });
      return;
    }
    const r = ctx.db.select().from(reviews).where(eq(reviews.id, id)).get();
    if (!r || r.guildId !== i.guildId) {
      await i.reply({ content: 'Review not found.', ...EPHEMERAL });
      return;
    }
    if (r.status !== 'open') {
      await i.reply({ content: `Already ${r.status}.`, ...EPHEMERAL });
      return;
    }
    const g = getGuild(ctx, i.guildId);
    await i.deferUpdate();
    if (action === 'approve') {
      const row = ctx.db.select().from(scores).where(eq(scores.id, r.scoreId)).get();
      const { result, analysis } = row ? scoreFromRow(row) : { result: null, analysis: null };
      const tier =
        g.rubric.tiers.find((t) => t.name === r.tier) ??
        g.rubric.tiers[tierIndex(g.rubric, g.rubric.entryTier)]!;
      if (analysis && result) upsertLink(ctx, i.guildId, r.discordId, analysis, result, tier.name);
      let roleNote = '';
      try {
        const member = await i.guild.members.fetch(r.discordId);
        await syncTierRoles(member, g.rubric, tier.roleId);
        await applyStage(member, g.rubric, 'accepted');
      } catch {
        roleNote = ' (role assignment failed, check my role position)';
      }
      ctx.db
        .update(reviews)
        .set({ status: 'approved', resolvedAt: new Date().toISOString(), resolvedBy: i.user.id })
        .where(eq(reviews.id, id))
        .run();
      logAudit(ctx, i.guildId, i.user.id, 'review:approve', r.discordId, `${r.githubLogin} as ${tier.name}`);
      await i.editReply({
        content: `${i.message.content}\n\n✅ Approved by <@${i.user.id}> as **${tier.name}**${roleNote}`,
        components: [],
      });
      await sendTo(ctx, g.row.verifyChannelId, {
        content: `✅ <@${r.discordId}> verified as **${r.githubLogin}** (${tier.name}), approved by a mod.`,
      });
    } else {
      ctx.db
        .update(reviews)
        .set({ status: 'denied', resolvedAt: new Date().toISOString(), resolvedBy: i.user.id })
        .where(eq(reviews.id, id))
        .run();
      logAudit(ctx, i.guildId, i.user.id, 'review:deny', r.discordId, r.githubLogin);
      await i.editReply({ content: `${i.message.content}\n\n❌ Denied by <@${i.user.id}>`, components: [] });
    }
    return;
  }

  if (ns === 'vote') {
    const v = getVote(ctx, id);
    if (!v || v.guildId !== i.guildId) {
      await i.reply({ content: 'Vote not found.', ...EPHEMERAL });
      return;
    }
    if (v.status !== 'open') {
      await i.reply({ content: `That vote is already closed (${v.status}).`, ...EPHEMERAL });
      return;
    }
    if (action === 'close') {
      if (!isMod(i)) {
        await i.reply({ content: 'Only mods can close a vote early.', ...EPHEMERAL });
        return;
      }
      await i.deferUpdate();
      const outcome = await resolveVote(ctx, v, i.user.id);
      await i.followUp({
        content: `Vote #${v.id} closed: **${outcome ?? 'already closed'}**.`,
        ...EPHEMERAL,
      });
      return;
    }
    if (action !== 'yes' && action !== 'no') return;
    const g = getGuild(ctx, i.guildId);
    const eligible = voterEligibility(i.member, g.rubric, v.discordId);
    if (!eligible.ok) {
      await i.reply({ content: eligible.reason, allowedMentions: { parse: [] }, ...EPHEMERAL });
      return;
    }
    const { vote: updated, changed } = castBallot(ctx, v, i.user.id, action);
    await i.deferUpdate();
    await refreshVoteMessage(ctx, updated);
    const word = action === 'yes' ? '👍 admit' : '👎 reject';
    const note =
      changed === 'new'
        ? `Ballot recorded: ${word}.`
        : changed === 'switched'
          ? `Ballot changed to ${word}.`
          : `You already voted ${word}.`;
    await i.followUp({ content: `${note} Tally: 👍 ${updated.yes} · 👎 ${updated.no}.`, ...EPHEMERAL });
    return;
  }

  if (ns === 'verify' && action === 'review') {
    const g = getGuild(ctx, i.guildId);
    const row = ctx.db.select().from(scores).where(eq(scores.id, id)).get();
    if (!row) {
      await i.reply({ content: 'That result expired. Run `/verify` again.', ...EPHEMERAL });
      return;
    }
    const already = ctx.db
      .select({ id: reviews.id })
      .from(reviews)
      .where(
        and(eq(reviews.guildId, i.guildId), eq(reviews.discordId, i.user.id), eq(reviews.status, 'open')),
      )
      .get();
    if (already) {
      await i.reply({ content: `You already have review #${already.id} open.`, ...EPHEMERAL });
      return;
    }
    const { result, analysis } = scoreFromRow(row);
    if (!analysis) {
      await i.reply({ content: 'That result expired. Run `/verify` again.', ...EPHEMERAL });
      return;
    }
    const placement = place(result, analysis, g.rubric, {
      discordCreatedAt: snowflakeToDate(i.user.id),
      sharedGithub: false,
    });
    const forced = {
      ...placement,
      status: 'review' as const,
      reasons: ['Member requested manual review', ...placement.reasons],
    };
    // a member asking for a human look goes to mods, never to a vote
    const applied = await applyPlacement(
      ctx,
      i.guild,
      g,
      i.user.id,
      { analysis, result, scoreId: row.id },
      forced,
      { skipVote: true },
    );
    await i.update({
      content: `🟡 Review #${applied.reviewId} opened. A mod will take a look.`,
      components: [],
    });
  }
}
