import { serve } from '@hono/node-server';
import { ActivityType, Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import type { AppContext } from './context.js';
import { openDb } from './db/index.js';
import { commands } from './discord/commands.js';
import { makeInteractionHandler } from './discord/handlers.js';
import { createApp } from './http/app.js';
import { log } from './lib/logger.js';
import { StateVerifier } from './lib/state.js';
import { getGuild } from './services/guilds.js';
import { applyStage } from './services/members.js';
import { sweepVotes } from './services/votes.js';

async function main(): Promise<void> {
  const cfg = config();
  const { db, sqlite } = openDb(cfg.DATA_DIR);
  log.info({ dataDir: cfg.DATA_DIR }, 'database ready');

  // GuildMembers is privileged and opt-in: it is only needed to hand out the unverified role on join.
  const intents = cfg.ENABLE_MEMBER_INTENT
    ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
    : [GatewayIntentBits.Guilds];
  const client = new Client({ intents });
  const ctx: AppContext = {
    cfg,
    db,
    client,
    verifier: new StateVerifier(cfg.STATE_SECRET),
    startedAt: Date.now(),
    lastAnalysisAt: null,
  };

  client.once(Events.ClientReady, async (c) => {
    log.info({ user: c.user.tag, guilds: c.guilds.cache.size }, 'discord ready');
    c.user.setActivity('/verify', { type: ActivityType.Listening });
    try {
      await c.application.commands.set(commands.map((x) => x.toJSON()));
      log.info({ count: commands.length }, 'global commands registered');
    } catch (err) {
      log.error({ err: String(err) }, 'command registration failed');
    }
  });
  client.on(Events.InteractionCreate, makeInteractionHandler(ctx));
  if (cfg.ENABLE_MEMBER_INTENT) {
    client.on(Events.GuildMemberAdd, (member) => {
      if (member.user.bot) return;
      const { rubric } = getGuild(ctx, member.guild.id);
      if (!rubric.roles.unverifiedRoleId) return;
      applyStage(member, rubric, 'joined').catch((err) =>
        log.warn({ guild: member.guild.id, err: String(err) }, 'could not assign unverified role on join'),
      );
    });
  }
  client.on(Events.GuildCreate, (g) => log.info({ guild: g.id, name: g.name }, 'joined guild'));
  client.on(Events.GuildDelete, (g) => log.info({ guild: g.id }, 'left guild'));
  client.on(Events.Error, (err) => log.error({ err: String(err) }, 'discord client error'));

  const app = createApp(ctx);
  const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: '0.0.0.0' }, (info) => {
    log.info({ port: info.port, publicUrl: cfg.PUBLIC_URL }, 'http listening');
  });

  await client.login(cfg.DISCORD_BOT_TOKEN);

  // close community votes whose deadline has passed
  const sweeper = setInterval(() => {
    if (!client.isReady()) return;
    sweepVotes(ctx)
      .then((n) => {
        if (n) log.info({ closed: n }, 'vote sweep');
      })
      .catch((err) => log.error({ err: String(err) }, 'vote sweep failed'));
  }, 60_000);
  sweeper.unref();

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    // give in-flight OAuth callbacks a moment to finish
    setTimeout(() => {
      server.close();
      client.destroy();
      sqlite.close();
      process.exit(0);
    }, 1500).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.stack : String(err) }, 'boot failed');
  process.exit(1);
});
