-- MentiSystema: Signal — D1 schema
-- events: raw per-session telemetry, write-only from the public ingest endpoint.
-- rollups: nightly-computed aggregate snapshots — the only table ever read publicly.

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('SESSION_STARTED', 'BUTTON_CLICKED', 'SESSION_ENDED')),
  timestamp_iso TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('control', 'prohibition', 'polite_prohibition')),
  time_since_session_start_ms INTEGER,
  human_plausible INTEGER,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_variant_event ON events(variant, event);
CREATE INDEX IF NOT EXISTS idx_events_received_at ON events(received_at);

CREATE TABLE IF NOT EXISTS rollups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  computed_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rollups_computed_at ON rollups(computed_at);
