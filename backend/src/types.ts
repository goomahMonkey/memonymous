export interface Env {
  DB: D1Database;
  MEMOIR_STATS: DurableObjectNamespace;
  MOD_QUEUE: DurableObjectNamespace;
  MOD_API_KEY: string;
  GLOBAL_PEPPER: string; // mixed into report IP hashing only
  MOD_PAGE_SIZE: string;
}

export interface MemoirRow {
  id: string;
  title: string;
  body: string;
  content_hash: string;
  status: "pending" | "approved" | "rejected" | "removed";
  reject_reason: string | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
}
