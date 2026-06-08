-- Anonymous memoirs backend schema

-- Memoirs. Submissions are fully anonymous; no author credential is stored.
CREATE TABLE IF NOT EXISTS memoirs (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,              -- sha-256 of body, dedupe/integrity
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','removed')),
  reject_reason TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  published_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memoirs_status      ON memoirs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_memoirs_published   ON memoirs(published_at);
CREATE INDEX IF NOT EXISTS idx_memoirs_contenthash ON memoirs(content_hash);

-- Moderation audit log.
CREATE TABLE IF NOT EXISTS moderation_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memoir_id   TEXT NOT NULL,
  action      TEXT NOT NULL,                -- approve | reject | remove
  reason      TEXT,
  moderator   TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (memoir_id) REFERENCES memoirs(id)
);
CREATE INDEX IF NOT EXISTS idx_modlog_memoir ON moderation_log(memoir_id);

-- User-submitted reports against published memoirs.
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memoir_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  reporter_ip_hash TEXT,                     -- hashed, never raw IP
  created_at  INTEGER NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (memoir_id) REFERENCES memoirs(id)
);
CREATE INDEX IF NOT EXISTS idx_reports_open ON reports(resolved, created_at);

-- Aggregated analytics events (raw counters live in Durable Objects).
CREATE TABLE IF NOT EXISTS analytics_daily (
  day        TEXT NOT NULL,
  metric     TEXT NOT NULL,                 -- views | submissions | approvals | rejections
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);
