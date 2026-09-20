import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { scores } from '../db/schema.js';
import { authorizeUrl, exchangeCode, fetchViewer } from '../github/oauth.js';
import { log } from '../lib/logger.js';
import { DEFAULT_RUBRIC, tierFor } from '../scoring/index.js';
import { completeVerification } from '../services/verification.js';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string, repo: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e8eb;font:16px/1.5 system-ui,sans-serif}main{max-width:460px;padding:2rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:.5rem 0;color:#aab1ba}a{color:#7aa2ff}.k{display:inline-block;margin-top:1rem;padding:.4rem .8rem;border:1px solid #2a2f37;border-radius:8px;color:#e6e8eb;text-decoration:none}</style></head>
<body><main>${body}<p><a class="k" href="${esc(repo)}">crackedbot on GitHub</a></p></main></body></html>`;
}

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();
  const repo = ctx.cfg.REPO_URL;
  const redirectUri = `${ctx.cfg.PUBLIC_URL}/auth/callback`;

  app.get('/', (c) =>
    c.html(
      page(
        'crackedbot',
        '<h1>crackedbot</h1><p>A Discord bot that vets engineering communities by GitHub, with an explainable Cracked Score.</p>',
        repo,
      ),
    ),
  );

  app.get('/health', (c) => {
    const ready = ctx.client.isReady();
    return c.json(
      {
        ok: ready,
        discord: ready ? 'ready' : 'connecting',
        guilds: ready ? ctx.client.guilds.cache.size : 0,
        uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
        lastAnalysisAt: ctx.lastAnalysisAt ? new Date(ctx.lastAnalysisAt).toISOString() : null,
      },
      ready ? 200 : 503,
    );
  });

  app.get('/auth/start', (c) => {
    const s = c.req.query('s');
    if (!s)
      return c.html(
        page(
          'Missing link',
          '<h1>Missing link</h1><p>Run <code>/verify</code> in Discord and use the button.</p>',
          repo,
        ),
        400,
      );
    // Do not consume the nonce here; the callback consumes it. Only check the signature and expiry.
    const probe = ctx.verifier.peek(s);
    if (!probe.ok) {
      const msg =
        probe.error === 'expired' ? 'That link expired. Run /verify again.' : 'That link is not valid.';
      return c.html(page('Link invalid', `<h1>Link invalid</h1><p>${msg}</p>`, repo), 400);
    }
    return c.redirect(authorizeUrl(ctx.cfg.GITHUB_CLIENT_ID, redirectUri, s));
  });

  app.get('/auth/callback', async (c) => {
    const code = c.req.query('code');
    const s = c.req.query('state');
    if (!code || !s)
      return c.html(
        page(
          'Missing code',
          '<h1>Missing code</h1><p>GitHub did not send a code. Run /verify again.</p>',
          repo,
        ),
        400,
      );
    const v = ctx.verifier.verify(s);
    if (!v.ok) {
      const msg =
        v.error === 'expired'
          ? 'That link expired. Run /verify again.'
          : v.error === 'replayed'
            ? 'That link was already used. Run /verify again if you need a fresh one.'
            : 'That link is not valid.';
      return c.html(page('Link invalid', `<h1>Link invalid</h1><p>${msg}</p>`, repo), 400);
    }
    let token: string;
    let viewer: Awaited<ReturnType<typeof fetchViewer>>;
    try {
      token = await exchangeCode(ctx.cfg.GITHUB_CLIENT_ID, ctx.cfg.GITHUB_CLIENT_SECRET, code, redirectUri);
      viewer = await fetchViewer(token);
    } catch (err) {
      log.warn({ err: String(err) }, 'oauth exchange failed');
      return c.html(
        page(
          'GitHub sign-in failed',
          '<h1>GitHub sign-in failed</h1><p>Go back to Discord and run /verify again.</p>',
          repo,
        ),
        502,
      );
    }
    const held = ctx.verifier.take(v.state.n);
    const out = await completeVerification(
      ctx,
      v.state,
      held?.token ?? null,
      token,
      viewer.login,
      String(viewer.databaseId),
      held?.statement ?? null,
    );
    if (!out.ok)
      return c.html(
        page('Something went wrong', `<h1>Something went wrong</h1><p>${esc(out.message)}</p>`, repo),
        500,
      );
    const line = {
      admitted: `You're in as <strong>${esc(out.tier)}</strong>.`,
      review: 'Sent to manual review. A mod will take a look.',
      rejected: "Didn't clear this server's bar. The receipt in Discord explains why.",
      blocked: 'Blocked. The receipt in Discord explains why.',
      vote: 'Your application is now up for a community vote. You will get a DM with the result.',
    }[out.route];
    return c.html(
      page(
        'Done',
        `<h1>Done, go back to Discord</h1><p><strong>${esc(out.login)}</strong> scored <strong>${out.total}/100</strong>.</p><p>${line}</p>`,
        repo,
      ),
    );
  });

  app.get('/badge/:login', (c) => {
    const login = c.req.param('login').replace(/\.svg$/i, '');
    if (!/^[a-zA-Z0-9-]{1,39}$/.test(login)) return c.text('bad login', 400);
    const row = ctx.db
      .select({ total: scores.total, login: scores.githubLogin })
      .from(scores)
      .where(eq(scores.githubLogin, login))
      .orderBy(desc(scores.id))
      .get();
    const label = 'cracked score';
    const value = row ? `${row.total} · ${tierFor(DEFAULT_RUBRIC, row.total).name}` : 'unscored';
    const color = !row
      ? '#9f9f9f'
      : row.total >= 80
        ? '#e5534b'
        : row.total >= 60
          ? '#7c3aed'
          : row.total >= 40
            ? '#2563eb'
            : row.total >= 20
              ? '#16a34a'
              : '#6b7280';
    const lw = 7 * label.length + 12;
    const vw = 7 * value.length + 12;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><a href="${esc(repo)}"><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><rect rx="3" width="${lw + vw}" height="20" fill="#555"/><rect rx="3" x="${lw}" width="${vw}" height="20" fill="${color}"/><rect rx="3" width="${lw + vw}" height="20" fill="url(#s)"/><g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></a></svg>`;
    c.header('Content-Type', 'image/svg+xml; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(svg);
  });

  return app;
}
