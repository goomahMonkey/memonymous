# Anonymous Memoirs — Backend

A Cloudflare Workers backend for publishing memoirs anonymously. Stack: **Workers + D1** (queryable storage) **+ Durable Objects** (live view counts and a moderation-queue coordinator). Submissions are fully anonymous — no author credential is stored. All submissions go through a **pre-publish moderation queue**.

## How it works

**Fully anonymous submissions.** A memoir is just a title and body. No passphrase, account, or author hash is stored, so a memoir can't be edited or deleted by its author after submission — moderators are the only ones who can change its state. Body text is SHA-256 hashed only for duplicate detection.

**Storage (D1 + Durable Objects).** D1 holds the canonical, queryable data (memoirs, moderation log, reports, daily analytics rollups). Two Durable Objects hold fast, strongly-consistent state: `MemoirStats` (one per memoir — live view counter) and `ModerationQueue` (one global coordinator — live backlog depth, serialized claims).

**Moderation (pre-publish queue).** New and edited memoirs land in `pending`. They are not publicly readable until a moderator approves them. Moderator endpoints require the `MOD_API_KEY` bearer token.

**Analytics.** Per-day counters (`submissions`, `views`, `approvals`, `rejections`) are rolled up in `analytics_daily`; live view counts come from the `MemoirStats` DO. `GET /analytics` returns totals by status, open report count, and the last 30 days.

## API

Public:
- `POST /memoirs` — submit `{ title, body }`. Returns `{ id, status: "pending" }`.
- `GET /memoirs?limit=&before=` — list approved memoirs (cursor paginated).
- `GET /memoirs/:id` — read one approved memoir (records a view).
- `POST /memoirs/:id/report` — flag `{ reason }`.

Moderator (header `Authorization: Bearer <MOD_API_KEY>`):
- `GET /moderation/pending?offset=` — queue with live backlog depth.
- `POST /moderation/:id/approve` — publish.
- `POST /moderation/:id/reject` — `{ reason?, moderator? }`.
- `POST /moderation/:id/remove` — take down a published memoir.
- `GET /analytics` — dashboard aggregates.

## Setup

```bash
npm install
npx wrangler d1 create memoirs_db          # paste the database_id into wrangler.toml
npm run db:migrate:remote                   # or :local for dev
npx wrangler secret put MOD_API_KEY
npx wrangler secret put GLOBAL_PEPPER        # used only to hash reporter IPs
npm run deploy
```

Local dev: `npm run db:migrate:local && npm run dev`.

## Project layout

```
wrangler.toml            bindings: D1, MemoirStats DO, ModerationQueue DO
migrations/0001_init.sql  schema
src/index.ts             router + all endpoints
src/crypto.ts            content hashing + id generation
src/durable.ts           MemoirStats + ModerationQueue Durable Objects
src/types.ts             Env + row types
```
