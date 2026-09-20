import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),
  DISCORD_APP_ID: z.string().regex(/^\d{17,20}$/, 'DISCORD_APP_ID must be a Discord snowflake'),
  GITHUB_CLIENT_ID: z.string().min(1, 'GITHUB_CLIENT_ID is required'),
  GITHUB_CLIENT_SECRET: z.string().min(1, 'GITHUB_CLIENT_SECRET is required'),
  STATE_SECRET: z.string().min(32, 'STATE_SECRET must be at least 32 characters'),
  PUBLIC_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, '')),
  PORT: z.coerce.number().int().positive().default(8080),
  DATA_DIR: z.string().default('./data'),
  GITHUB_APP_FALLBACK_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  REPO_URL: z.string().default('https://github.com/crackedbot/crackedbot'),
  /**
   * '1' subscribes to member joins so the unverified role can be given on arrival.
   * Requires the privileged Server Members Intent to be switched on in the Discord Developer Portal,
   * otherwise login fails with "Used disallowed intents". Off by default.
   */
  ENABLE_MEMBER_INTENT: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}\nCopy .env.example to .env and fill it in.`);
  }
  return parsed.data;
}

let cached: Config | null = null;
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
