import { z } from 'zod';
import { DIMENSIONS } from './dimensions.js';

export const FLAG_CODES = [
  'NEW_ACCOUNT',
  'BURST',
  'FOLLOWER_FARM',
  'STAR_FARM',
  'FORK_FARM',
  'HOLLOW_REPOS',
  'BOT_CADENCE',
  'NO_PROFILE',
  'INCOMPLETE',
  'PUBLIC_ONLY',
  'DISCORD_FRESH',
  'SHARED_GITHUB',
] as const;

export const PRESET_NAMES = ['general', 'systems', 'web', 'ml', 'mobile', 'gamedev', 'hackathon'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export const VOTE_SCOPES = ['review', 'admitted', 'all'] as const;
export type VoteScope = (typeof VOTE_SCOPES)[number];

/** a Discord id */
const snowflake = z.string().regex(/^\d{17,20}$/);

const tierSchema = z.object({
  name: z.string().min(1).max(32),
  min: z.number().int().min(0).max(100),
  roleId: z
    .string()
    .regex(/^\d{17,20}$/)
    .nullable()
    .default(null),
});

export const rubricSchema = z
  .object({
    preset: z.enum(PRESET_NAMES).default('general'),
    weights: z
      .object(
        Object.fromEntries(DIMENSIONS.map((d) => [d, z.number().min(0).max(100)])) as Record<
          (typeof DIMENSIONS)[number],
          z.ZodNumber
        >,
      )
      .refine((w) => Object.values(w).some((v) => v > 0), 'at least one weight must be above zero'),
    tiers: z
      .array(tierSchema)
      .min(2)
      .max(8)
      .refine((t) => t[0]!.min === 0, 'the first tier must start at 0')
      .refine(
        (t) => t.every((x, i) => i === 0 || x.min > t[i - 1]!.min),
        'tier minimums must strictly increase',
      )
      .refine(
        (t) => new Set(t.map((x) => x.name.toLowerCase())).size === t.length,
        'tier names must be unique',
      ),
    entryTier: z.string().min(1),
    gates: z
      .object({
        minAccountAgeDays: z.number().int().min(0).max(3650).default(90),
        requireLanguagesAnyOf: z.array(z.string().min(1)).max(20).default([]),
        requireExternalMergedPR: z.boolean().default(false),
        reviewBelowScore: z.number().int().min(0).max(100).default(25),
        blockFlags: z.array(z.enum(FLAG_CODES)).default(['SHARED_GITHUB', 'BOT_CADENCE']),
      })
      .prefault({}),
    rescore: z
      .object({
        everyDays: z.number().int().min(0).max(365).default(30),
        demote: z.boolean().default(false),
      })
      .prefault({}),
    /** Community voting on applicants. Off by default; the score decides. */
    vote: z
      .object({
        enabled: z.boolean().default(false),
        /**
         * review: only borderline cases (would have gone to mod review) get a vote
         * admitted: everyone who would be admitted or reviewed gets a vote; rejected stays rejected
         * all: everyone except hard blocks gets a vote, the score is advisory
         */
        scope: z.enum(VOTE_SCOPES).default('review'),
        /** where vote posts go; null falls back to the review channel, then the verify channel */
        channelId: z
          .string()
          .regex(/^\d{17,20}$/)
          .nullable()
          .default(null),
        /** who may vote; null means anyone holding a tier role, or anyone if no tier roles are mapped */
        eligibleRoleId: z
          .string()
          .regex(/^\d{17,20}$/)
          .nullable()
          .default(null),
        durationHours: z.number().int().min(1).max(168).default(24),
        /** minimum ballots for a decision; fewer escalates to mod review */
        quorum: z.number().int().min(1).max(500).default(3),
        /** share of yes ballots needed to admit, 0..1 */
        threshold: z.number().min(0.5).max(1).default(0.6),
      })
      .prefault({}),
    /** What /verify asks the applicant before the GitHub link. */
    intake: z
      .object({
        askReason: z.boolean().default(false),
        /** modal field label; Discord caps labels at 45 characters */
        prompt: z.string().min(3).max(45).default('Why do you want to join?'),
      })
      .prefault({}),
    /**
     * Lifecycle roles, independent of tier roles. All optional.
     * unverified: given on join (needs the Server Members intent, ENABLE_MEMBER_INTENT=1)
     * verified:   given when GitHub ownership is proven, unverified removed
     * accepted:   given on admission by score, vote, or mod approval (e.g. "Trial Member")
     */
    roles: z
      .object({
        unverifiedRoleId: snowflake.nullable().default(null),
        verifiedRoleId: snowflake.nullable().default(null),
        acceptedRoleId: snowflake.nullable().default(null),
      })
      .prefault({}),
  })
  .refine((r) => r.tiers.some((t) => t.name.toLowerCase() === r.entryTier.toLowerCase()), {
    message: 'entryTier must be one of the tier names',
    path: ['entryTier'],
  });

export type Rubric = z.infer<typeof rubricSchema>;
export type Tier = z.infer<typeof tierSchema>;

export const DEFAULT_TIERS: Tier[] = [
  { name: 'Tourist', min: 0, roleId: null },
  { name: 'Tinkerer', min: 20, roleId: null },
  { name: 'Builder', min: 40, roleId: null },
  { name: 'Shipper', min: 60, roleId: null },
  { name: 'Cracked', min: 80, roleId: null },
];

export const DEFAULT_RUBRIC: Rubric = rubricSchema.parse({
  preset: 'general',
  weights: { consistency: 20, impact: 20, collaboration: 20, craft: 20, community: 10, depth: 10 },
  tiers: DEFAULT_TIERS,
  entryTier: 'Tinkerer',
});

export function parseRubric(input: unknown): { ok: true; rubric: Rubric } | { ok: false; errors: string[] } {
  const parsed = rubricSchema.safeParse(input);
  if (parsed.success) return { ok: true, rubric: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'rubric'}: ${i.message}`),
  };
}

export function loadRubric(json: string): Rubric {
  try {
    const r = parseRubric(JSON.parse(json));
    return r.ok ? r.rubric : DEFAULT_RUBRIC;
  } catch {
    return DEFAULT_RUBRIC;
  }
}

export function tierFor(rubric: Rubric, score: number): Tier {
  let t = rubric.tiers[0]!;
  for (const x of rubric.tiers) if (score >= x.min) t = x;
  return t;
}

export function tierIndex(rubric: Rubric, name: string): number {
  return rubric.tiers.findIndex((t) => t.name.toLowerCase() === name.toLowerCase());
}
