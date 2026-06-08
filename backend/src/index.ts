import type { Env, MemoirRow } from "./types";
import { sha256Hex, randomHex } from "./crypto";

export { MemoirStats, ModerationQueue } from "./durable";

const MOD_QUEUE_NAME = "global";

// ---------- small helpers ----------

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });

const err = (message: string, status = 400) => json({ error: message }, status);

const dayUTC = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

function publicView(m: MemoirRow, views?: number) {
  return {
    id: m.id,
    title: m.title,
    body: m.body,
    status: m.status,
    createdAt: m.created_at,
    publishedAt: m.published_at,
    ...(views !== undefined ? { views } : {}),
  };
}

async function bumpMetric(env: Env, metric: string, by = 1) {
  await env.DB.prepare(
    `INSERT INTO analytics_daily (day, metric, count) VALUES (?1, ?2, ?3)
     ON CONFLICT(day, metric) DO UPDATE SET count = count + ?3`,
  )
    .bind(dayUTC(), metric, by)
    .run();
}

function modQueue(env: Env) {
  return env.MOD_QUEUE.get(env.MOD_QUEUE.idFromName(MOD_QUEUE_NAME));
}

function statsStub(env: Env, memoirId: string) {
  return env.MEMOIR_STATS.get(env.MEMOIR_STATS.idFromName(memoirId));
}

function requireMod(request: Request, env: Env): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (token.length !== env.MOD_API_KEY.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++)
    mismatch |= token.charCodeAt(i) ^ env.MOD_API_KEY.charCodeAt(i);
  return mismatch === 0;
}

// ---------- handlers ----------

// POST /memoirs  -> submit a memoir (lands in pending queue). Fully anonymous:
// no author credential is stored, so memoirs cannot be edited or deleted later.
async function submitMemoir(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ title?: string; body?: string }>().catch(() => null);
  if (!body) return err("invalid JSON");
  const title = (body.title ?? "").trim();
  const text = (body.body ?? "").trim();
  if (title.length < 1 || title.length > 200) return err("title must be 1-200 chars");
  if (text.length < 1 || text.length > 100_000) return err("body must be 1-100000 chars");

  const contentHash = await sha256Hex(text);
  const dup = await env.DB.prepare(
    `SELECT id FROM memoirs WHERE content_hash = ?1 AND status IN ('pending','approved') LIMIT 1`,
  )
    .bind(contentHash)
    .first<{ id: string }>();
  if (dup) return err("an identical memoir already exists", 409);

  const id = randomHex(12);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO memoirs (id,title,body,content_hash,status,created_at,updated_at)
     VALUES (?1,?2,?3,?4,'pending',?5,?5)`,
  )
    .bind(id, title, text, contentHash, now)
    .run();

  await modQueue(env).fetch("https://do/enqueue", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  await bumpMetric(env, "submissions");

  return json({ id, status: "pending", message: "Submitted for moderation." }, 201);
}

// GET /memoirs  -> list published memoirs (paginated)
async function listMemoirs(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 100);
  const before = Number(url.searchParams.get("before") ?? Date.now());
  const rows = await env.DB.prepare(
    `SELECT * FROM memoirs WHERE status='approved' AND published_at < ?1
     ORDER BY published_at DESC LIMIT ?2`,
  )
    .bind(before, limit)
    .all<MemoirRow>();
  const items = (rows.results ?? []).map((m) => publicView(m));
  const nextCursor = items.length === limit ? rows.results![items.length - 1].published_at : null;
  return json({ items, nextCursor });
}

// GET /memoirs/:id  -> read one (only approved to the public) + record a view
async function getMemoir(id: string, env: Env): Promise<Response> {
  const m = await env.DB.prepare(`SELECT * FROM memoirs WHERE id=?1`).bind(id).first<MemoirRow>();
  if (!m || m.status !== "approved") return err("not found", 404);

  let views: number | undefined;
  try {
    const r = await statsStub(env, id).fetch("https://do/hit", { method: "POST" });
    views = (await r.json<{ views: number }>()).views;
    await bumpMetric(env, "views");
  } catch {
    /* view counting is best-effort */
  }
  return json(publicView(m, views));
}

// POST /memoirs/:id/report  -> public flag of an approved memoir
async function reportMemoir(id: string, request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ reason?: string }>().catch(() => null);
  const reason = (body?.reason ?? "").trim();
  if (reason.length < 1 || reason.length > 500) return err("reason must be 1-500 chars");
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const ipHash = ip ? await sha256Hex(ip + env.GLOBAL_PEPPER) : null;
  await env.DB.prepare(
    `INSERT INTO reports (memoir_id, reason, reporter_ip_hash, created_at) VALUES (?1,?2,?3,?4)`,
  )
    .bind(id, reason, ipHash, Date.now())
    .run();
  return json({ ok: true });
}

// ----- moderator endpoints (require MOD_API_KEY) -----

async function modPending(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const size = Math.min(Number(env.MOD_PAGE_SIZE || 25), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
  const rows = await env.DB.prepare(
    `SELECT * FROM memoirs WHERE status='pending' ORDER BY created_at ASC LIMIT ?1 OFFSET ?2`,
  )
    .bind(size, offset)
    .all<MemoirRow>();
  const depthRes = await modQueue(env).fetch("https://do/depth");
  const { depth } = await depthRes.json<{ depth: number }>();
  return json({
    backlog: depth,
    items: (rows.results ?? []).map((m) => ({
      id: m.id,
      title: m.title,
      body: m.body,
      createdAt: m.created_at,
    })),
  });
}

async function modDecide(
  id: string,
  action: "approve" | "reject" | "remove",
  request: Request,
  env: Env,
): Promise<Response> {
  const body: { reason?: string; moderator?: string } =
    (await request.json<{ reason?: string; moderator?: string }>().catch(() => null)) ?? {};
  const m = await env.DB.prepare(`SELECT * FROM memoirs WHERE id=?1`).bind(id).first<MemoirRow>();
  if (!m) return err("not found", 404);
  const now = Date.now();

  if (action === "approve") {
    await env.DB.prepare(
      `UPDATE memoirs SET status='approved', published_at=?2, updated_at=?2 WHERE id=?1`,
    )
      .bind(id, now)
      .run();
    await bumpMetric(env, "approvals");
  } else if (action === "reject") {
    await env.DB.prepare(
      `UPDATE memoirs SET status='rejected', reject_reason=?2, updated_at=?3 WHERE id=?1`,
    )
      .bind(id, body.reason ?? null, now)
      .run();
    await bumpMetric(env, "rejections");
  } else {
    await env.DB.prepare(
      `UPDATE memoirs SET status='removed', reject_reason=?2, updated_at=?3 WHERE id=?1`,
    )
      .bind(id, body.reason ?? null, now)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO moderation_log (memoir_id, action, reason, moderator, created_at)
     VALUES (?1,?2,?3,?4,?5)`,
  )
    .bind(id, action, body.reason ?? null, body.moderator ?? null, now)
    .run();
  await modQueue(env).fetch("https://do/resolve", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  return json({
    id,
    status: action === "approve" ? "approved" : action === "reject" ? "rejected" : "removed",
  });
}

// GET /analytics  -> aggregate dashboard numbers (moderator only)
async function analytics(env: Env): Promise<Response> {
  const totals = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
       SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
       SUM(CASE WHEN status='removed'  THEN 1 ELSE 0 END) AS removed,
       COUNT(*) AS total
     FROM memoirs`,
  ).first<Record<string, number>>();

  const daily = await env.DB.prepare(
    `SELECT day, metric, count FROM analytics_daily WHERE day >= ?1 ORDER BY day DESC`,
  )
    .bind(dayUTC(Date.now() - 30 * 86_400_000))
    .all<{ day: string; metric: string; count: number }>();

  const openReports = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM reports WHERE resolved=0`,
  ).first<{ n: number }>();

  return json({
    memoirs: totals,
    openReports: openReports?.n ?? 0,
    last30Days: daily.results ?? [],
  });
}

// ---------- router ----------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (parts[0] === "health") return json({ ok: true });

      if (parts[0] === "memoirs") {
        if (parts.length === 1) {
          if (request.method === "POST") return await submitMemoir(request, env);
          if (request.method === "GET") return await listMemoirs(request, env);
        }
        if (parts.length === 2 && request.method === "GET") {
          return await getMemoir(parts[1], env);
        }
        if (parts.length === 3 && parts[2] === "report" && request.method === "POST") {
          return await reportMemoir(parts[1], request, env);
        }
      }

      if (parts[0] === "moderation") {
        if (!requireMod(request, env)) return err("unauthorized", 401);
        if (parts[1] === "pending" && request.method === "GET")
          return await modPending(request, env);
        if (parts.length === 3 && request.method === "POST") {
          const action = parts[2];
          if (action === "approve" || action === "reject" || action === "remove")
            return await modDecide(parts[1], action, request, env);
        }
      }

      if (parts[0] === "analytics" && request.method === "GET") {
        if (!requireMod(request, env)) return err("unauthorized", 401);
        return await analytics(env);
      }

      return err("not found", 404);
    } catch (e) {
      return err((e as Error).message ?? "internal error", 500);
    }
  },
};
