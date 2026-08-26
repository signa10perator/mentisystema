// MentiSystema: Signal — event ingest + nightly rollup Worker.
//
// Routes:
//   GET  /nonce   — issue a short-lived, single-use anti-replay token (rate-limited)
//   POST /ingest  — write one raw event (origin-checked, rate-limited, token-checked)
//   GET  /rollup  — public aggregate JSON (the only world-readable data)
//
// Raw events (D1 "events" table) are never exposed by any route. Only the
// nightly-computed "rollups" rows — aggregate counts and a narration string —
// are served publicly.

import Anthropic from '@anthropic-ai/sdk';

const VALID_EVENTS = new Set(['SESSION_STARTED', 'BUTTON_CLICKED', 'SESSION_ENDED']);
const VALID_VARIANTS = ['control', 'prohibition', 'polite_prohibition'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NONCE_TTL_SECONDS = 120;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_PER_IP = 30;
const RATE_LIMIT_MAX_PER_SESSION = 20;
const MAX_BODY_BYTES = 2048;

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders)
  });
}

function restrictedCorsHeaders(origin, allowedOrigin) {
  const headers = { Vary: 'Origin' };
  if (origin === allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Signal-Token';
  }
  return headers;
}

function publicCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
}

// Lightweight, not atomic — acceptable slop for a soft per-IP/session cap on a personal site.
async function underRateLimit(kv, key, limit) {
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= limit) return false;
  await kv.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return true;
}

async function handleNonce(request, env) {
  const origin = request.headers.get('Origin');
  const headers = restrictedCorsHeaders(origin, env.ALLOWED_ORIGIN);
  if (origin !== env.ALLOWED_ORIGIN) return json({ error: 'forbidden' }, 403, headers);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await underRateLimit(env.SIGNAL_KV, `rl:nonce:${ip}`, RATE_LIMIT_MAX_PER_IP))) {
    return json({ error: 'rate_limited' }, 429, headers);
  }

  const token = crypto.randomUUID();
  await env.SIGNAL_KV.put(`nonce:${token}`, '1', { expirationTtl: NONCE_TTL_SECONDS });
  return json({ token }, 200, headers);
}

async function handleIngest(request, env) {
  const origin = request.headers.get('Origin');
  const headers = restrictedCorsHeaders(origin, env.ALLOWED_ORIGIN);
  if (origin !== env.ALLOWED_ORIGIN) return json({ error: 'forbidden' }, 403, headers);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await underRateLimit(env.SIGNAL_KV, `rl:ingest_ip:${ip}`, RATE_LIMIT_MAX_PER_IP))) {
    return json({ error: 'rate_limited' }, 429, headers);
  }

  const token = request.headers.get('X-Signal-Token');
  if (!token) return json({ error: 'missing_token' }, 403, headers);
  const nonceKey = `nonce:${token}`;
  if (!(await env.SIGNAL_KV.get(nonceKey))) return json({ error: 'invalid_token' }, 403, headers);
  await env.SIGNAL_KV.delete(nonceKey); // single-use — blocks replay

  const contentLength = request.headers.get('Content-Length');
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, 413, headers);
  }

  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413, headers);
    body = JSON.parse(text);
  } catch {
    return json({ error: 'invalid_json' }, 400, headers);
  }

  const { session_id, event, timestamp_iso, variant, time_since_session_start_ms } = body;
  const valid =
    typeof session_id === 'string' && UUID_RE.test(session_id) &&
    typeof event === 'string' && VALID_EVENTS.has(event) &&
    typeof variant === 'string' && VALID_VARIANTS.includes(variant) &&
    typeof timestamp_iso === 'string' && !Number.isNaN(Date.parse(timestamp_iso)) &&
    (time_since_session_start_ms === undefined || typeof time_since_session_start_ms === 'number');
  if (!valid) return json({ error: 'invalid_payload' }, 400, headers);

  if (!(await underRateLimit(env.SIGNAL_KV, `rl:ingest_session:${session_id}`, RATE_LIMIT_MAX_PER_SESSION))) {
    return json({ error: 'rate_limited' }, 429, headers);
  }

  const humanPlausible = typeof body.human_plausible === 'boolean' ? (body.human_plausible ? 1 : 0) : null;

  await env.SIGNAL_DB.prepare(
    `INSERT INTO events (session_id, event, timestamp_iso, variant, time_since_session_start_ms, human_plausible)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(session_id, event, timestamp_iso, variant, time_since_session_start_ms ?? null, humanPlausible).run();

  return new Response(null, { status: 204, headers });
}

async function handleRollup(env) {
  const headers = publicCorsHeaders();
  const row = await env.SIGNAL_DB.prepare(
    'SELECT data FROM rollups ORDER BY computed_at DESC LIMIT 1'
  ).first();
  if (!row) return json({ error: 'no_rollup_yet' }, 404, headers);
  return new Response(row.data, { status: 200, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) });
}

// Two-proportion pooled z-test — appropriate for comparing two click-through
// rates (binomial proportions), not a naive time-series z-score.
function binomialZScore(clicksA, visitorsA, clicksB, visitorsB) {
  if (!visitorsA || !visitorsB) return null;
  const pA = clicksA / visitorsA;
  const pB = clicksB / visitorsB;
  const pPool = (clicksA + clicksB) / (visitorsA + visitorsB);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / visitorsA + 1 / visitorsB));
  if (se === 0) return null;
  return (pA - pB) / se;
}

async function countDistinctSessions(db, variant, eventName, sinceIso, untilIso) {
  const row = await db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS n FROM events
     WHERE variant = ? AND event = ? AND received_at >= ? AND received_at < ?`
  ).bind(variant, eventName, sinceIso, untilIso).first();
  return row.n;
}

async function computeVariantStats(db, variant, sinceIso, untilIso) {
  const visitors = await countDistinctSessions(db, variant, 'SESSION_STARTED', sinceIso, untilIso);
  const clicks = await countDistinctSessions(db, variant, 'BUTTON_CLICKED', sinceIso, untilIso);
  return { visitors, clicks };
}

async function narrate(rollup, env) {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 512,
      output_config: { effort: 'low' },
      system:
        'You describe behavioral A/B test telemetry plainly and cautiously for a public status page. ' +
        'You are given aggregate rollup statistics only (no individual user data) comparing button-copy ' +
        'variants of a novelty button on a personal research site. In 2-4 short sentences, describe what ' +
        'the numbers show. Do not claim statistical significance below roughly |z| > 2. Do not assert a ' +
        'psychological mechanism as fact. Explicitly note when current evidence does not establish whether ' +
        'a difference reflects the variant, traffic composition, or random variation. Plain language.',
      messages: [{ role: 'user', content: JSON.stringify(rollup) }]
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    return textBlock ? textBlock.text : null;
  } catch (err) {
    return `Narration unavailable (${err instanceof Error ? err.message : 'unknown error'}).`;
  }
}

async function runNightlyRollup(env) {
  const now = new Date();
  const currentStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const baselineStart = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
  const baselineEnd = currentStart;

  const variants = {};
  for (const variant of VALID_VARIANTS) {
    const current = await computeVariantStats(env.SIGNAL_DB, variant, currentStart.toISOString(), now.toISOString());
    const baseline = await computeVariantStats(env.SIGNAL_DB, variant, baselineStart.toISOString(), baselineEnd.toISOString());

    const baselineDailyVisitors = baseline.visitors / 7;
    variants[variant] = {
      visitors: current.visitors,
      clicks: current.clicks,
      click_rate: current.visitors ? current.clicks / current.visitors : null,
      baseline_click_rate: baseline.visitors ? baseline.clicks / baseline.visitors : null,
      z_score: binomialZScore(current.clicks, current.visitors, baseline.clicks, baseline.visitors),
      traffic_change: baselineDailyVisitors > 0
        ? (current.visitors - baselineDailyVisitors) / baselineDailyVisitors
        : null
    };
  }

  const rollup = {
    computed_at: now.toISOString(),
    window: { current: '24h', baseline: '7d_trailing_prior_to_current' },
    variants
  };
  rollup.narration = await narrate(rollup, env);

  await env.SIGNAL_DB.prepare('INSERT INTO rollups (computed_at, data) VALUES (?, ?)')
    .bind(rollup.computed_at, JSON.stringify(rollup)).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      if (url.pathname === '/rollup') return new Response(null, { status: 204, headers: publicCorsHeaders() });
      return new Response(null, { status: 204, headers: restrictedCorsHeaders(request.headers.get('Origin'), env.ALLOWED_ORIGIN) });
    }
    if (url.pathname === '/nonce' && request.method === 'GET') return handleNonce(request, env);
    if (url.pathname === '/ingest' && request.method === 'POST') return handleIngest(request, env);
    if (url.pathname === '/ingest') return json({ error: 'method_not_allowed' }, 405, {});
    if (url.pathname === '/rollup' && request.method === 'GET') return handleRollup(env);
    return json({ error: 'not_found' }, 404, {});
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNightlyRollup(env));
  }
};
