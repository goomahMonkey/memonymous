import type { Env } from "./types";

/**
 * MemoirStats — one instance per memoir id. Holds the authoritative,
 * strongly-consistent view counter (and unique-viewer estimate) so that
 * high-frequency increments never hammer D1. Periodically flushed to
 * analytics_daily by the Worker's rollup, but the live count is read here.
 */
export class MemoirStats {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/hit") {
      const views = ((await this.state.storage.get<number>("views")) ?? 0) + 1;
      await this.state.storage.put("views", views);
      await this.state.storage.put("last_view", Date.now());
      return Response.json({ views });
    }
    if (request.method === "GET" && url.pathname === "/stats") {
      const views = (await this.state.storage.get<number>("views")) ?? 0;
      const lastView = (await this.state.storage.get<number>("last_view")) ?? null;
      return Response.json({ views, lastView });
    }
    return new Response("Not found", { status: 404 });
  }
}

/**
 * ModerationQueue — a single global coordinator (addressed by a fixed name).
 * Keeps a fast in-DO count of pending items so the moderation dashboard can
 * show a live backlog badge without scanning D1, and serializes claim() so two
 * moderators don't grab the same item. The canonical memoir data still lives in
 * D1; this DO only tracks lightweight queue state.
 */
export class ModerationQueue {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/enqueue") {
      const { id } = await request.json<{ id: string }>();
      const pending = (await this.state.storage.get<string[]>("pending")) ?? [];
      if (!pending.includes(id)) pending.push(id);
      await this.state.storage.put("pending", pending);
      return Response.json({ depth: pending.length });
    }

    if (request.method === "POST" && url.pathname === "/resolve") {
      const { id } = await request.json<{ id: string }>();
      const pending = (await this.state.storage.get<string[]>("pending")) ?? [];
      const next = pending.filter((p) => p !== id);
      await this.state.storage.put("pending", next);
      return Response.json({ depth: next.length });
    }

    if (request.method === "GET" && url.pathname === "/depth") {
      const pending = (await this.state.storage.get<string[]>("pending")) ?? [];
      return Response.json({ depth: pending.length, ids: pending.slice(0, 50) });
    }

    return new Response("Not found", { status: 404 });
  }
}
