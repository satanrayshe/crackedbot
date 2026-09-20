import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed, expiring, single-use OAuth state.
 *
 * Only short ids travel in the URL: Discord caps link-button URLs at 512 characters, so the
 * interaction token (which alone is ~200 characters) stays in memory on the bot, keyed by nonce.
 * If the bot restarts mid-flow the token is gone and the callback falls back to a DM.
 */
export interface VerifyState {
  /** guild id */
  g: string;
  /** discord user id */
  u: string;
  /** channel the /verify was run in */
  c: string;
  /** nonce, replay protection and key for the pending interaction token */
  n: string;
  /** expiry, epoch ms */
  e: number;
}

export const STATE_TTL_MS = 10 * 60 * 1000;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function hmac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function newNonce(): string {
  return randomBytes(12).toString('hex');
}

export function signState(secret: string, data: Omit<VerifyState, 'e'>, now = Date.now()): string {
  const full: VerifyState = { ...data, e: now + STATE_TTL_MS };
  const payload = b64url(Buffer.from(JSON.stringify(full)));
  const sig = b64url(hmac(secret, payload));
  return `${payload}.${sig}`;
}

export type VerifyStateError = 'malformed' | 'bad-signature' | 'expired' | 'replayed';
type Outcome = { ok: true; state: VerifyState } | { ok: false; error: VerifyStateError };

export class StateVerifier {
  private used = new Map<string, number>();
  private pending = new Map<string, { token: string; statement: string | null; exp: number }>();

  constructor(private readonly secret: string) {}

  /**
   * Hold the interaction token, and the applicant's intake answer if one was asked,
   * for a nonce until the callback needs them. Neither travels in the URL.
   */
  remember(nonce: string, interactionToken: string, now = Date.now(), statement: string | null = null): void {
    this.sweep(now);
    this.pending.set(nonce, { token: interactionToken, statement, exp: now + STATE_TTL_MS });
  }

  /** Retrieve and forget what was remembered for a nonce. Null if unknown, expired, or restarted. */
  take(nonce: string, now = Date.now()): { token: string; statement: string | null } | null {
    const p = this.pending.get(nonce);
    this.pending.delete(nonce);
    if (!p || p.exp < now) return null;
    return { token: p.token, statement: p.statement };
  }

  /** Token-only form of take(). */
  takeToken(nonce: string, now = Date.now()): string | null {
    return this.take(nonce, now)?.token ?? null;
  }

  /** Check signature and expiry without consuming the nonce. */
  peek(token: string, now = Date.now()): Outcome {
    const r = this.decode(token, now);
    if (!r.ok) return r;
    if (this.used.has(r.state.n)) return { ok: false, error: 'replayed' };
    return r;
  }

  /** Check and consume. A second call with the same token fails with 'replayed'. */
  verify(token: string, now = Date.now()): Outcome {
    const r = this.decode(token, now);
    if (!r.ok) return r;
    this.sweep(now);
    if (this.used.has(r.state.n)) return { ok: false, error: 'replayed' };
    this.used.set(r.state.n, r.state.e);
    return r;
  }

  private decode(token: string, now: number): Outcome {
    const dot = token.indexOf('.');
    if (dot <= 0) return { ok: false, error: 'malformed' };
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = hmac(this.secret, payload);
    let given: Buffer;
    try {
      given = Buffer.from(sig, 'base64url');
    } catch {
      return { ok: false, error: 'malformed' };
    }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, error: 'bad-signature' };
    }
    let state: VerifyState;
    try {
      state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as VerifyState;
    } catch {
      return { ok: false, error: 'malformed' };
    }
    if (typeof state.e !== 'number' || state.e < now) return { ok: false, error: 'expired' };
    if (!state.n || !state.g || !state.u || !state.c) return { ok: false, error: 'malformed' };
    return { ok: true, state };
  }

  private sweep(now: number): void {
    if (this.used.size >= 1000) for (const [n, exp] of this.used) if (exp < now) this.used.delete(n);
    if (this.pending.size >= 1000) for (const [n, p] of this.pending) if (p.exp < now) this.pending.delete(n);
  }
}
