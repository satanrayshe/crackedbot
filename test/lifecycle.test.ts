import { describe, expect, it } from 'vitest';
import { newNonce, StateVerifier } from '../src/lib/state.js';
import { DEFAULT_RUBRIC, parseRubric } from '../src/scoring/index.js';
import { quoteStatement, stageRoles } from '../src/services/members.js';

const U = '111111111111111111';
const V = '222222222222222222';
const A = '333333333333333333';
const all = { unverifiedRoleId: U, verifiedRoleId: V, acceptedRoleId: A };
const none = { unverifiedRoleId: null, verifiedRoleId: null, acceptedRoleId: null };

describe('lifecycle roles', () => {
  it('are unset by default and old rubrics still load', () => {
    expect(DEFAULT_RUBRIC.roles).toEqual(none);
    expect(DEFAULT_RUBRIC.intake.askReason).toBe(false);
    const { roles: _r, intake: _i, ...legacy } = DEFAULT_RUBRIC;
    const r = parseRubric(legacy);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rubric.roles).toEqual(none);
  });

  it('joined gives unverified only', () => {
    expect(stageRoles(all, 'joined')).toEqual({ add: [U], remove: [] });
  });

  it('verified swaps unverified for verified', () => {
    expect(stageRoles(all, 'verified')).toEqual({ add: [V], remove: [U] });
  });

  it('accepted adds the trial role and keeps verified, even if the verified step was skipped', () => {
    expect(stageRoles(all, 'accepted')).toEqual({ add: [V, A], remove: [U] });
  });

  it('reset undoes everything and puts unverified back', () => {
    expect(stageRoles(all, 'reset')).toEqual({ add: [U], remove: [V, A] });
  });

  it('does nothing when no roles are configured', () => {
    for (const s of ['joined', 'verified', 'accepted', 'reset'] as const) {
      expect(stageRoles(none, s)).toEqual({ add: [], remove: [] });
    }
  });

  it('rejects role ids that are not snowflakes', () => {
    expect(parseRubric({ ...DEFAULT_RUBRIC, roles: { verifiedRoleId: 'verified' } }).ok).toBe(false);
  });
});

describe('intake', () => {
  it('caps the prompt at the 45 characters Discord allows for a modal label', () => {
    expect(parseRubric({ ...DEFAULT_RUBRIC, intake: { prompt: 'x'.repeat(46) } }).ok).toBe(false);
    expect(parseRubric({ ...DEFAULT_RUBRIC, intake: { askReason: true, prompt: 'Why us?' } }).ok).toBe(true);
  });

  it('carries the answer server-side with the interaction token, once', () => {
    const v = new StateVerifier('s'.repeat(64));
    const n = newNonce();
    v.remember(n, 'tok', Date.now(), 'I want to build things with people who ship.');
    expect(v.take(n)).toEqual({ token: 'tok', statement: 'I want to build things with people who ship.' });
    expect(v.take(n)).toBeNull();
    const m = newNonce();
    v.remember(m, 'tok2');
    expect(v.take(m)).toEqual({ token: 'tok2', statement: null });
  });
});

describe('quoteStatement', () => {
  it('renders nothing for an empty answer', () => {
    expect(quoteStatement(null)).toBe('');
    expect(quoteStatement('   ')).toBe('');
  });

  it('block-quotes every line and defuses mentions', () => {
    const out = quoteStatement('hi @everyone\nsecond line');
    expect(out).toContain('> hi @​everyone\n> second line');
    expect(out).not.toContain('@everyone');
  });

  it('clips long answers', () => {
    const out = quoteStatement('a'.repeat(900), 100);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThan(160);
  });
});
