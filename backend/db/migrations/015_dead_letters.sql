-- Poison-message parking: stream entries that have exceeded MAX_DELIVERY_ATTEMPTS
-- are moved here and XACK'd so they no longer block the consumer group.
-- Operators inspect / replay / discard from this table.
CREATE TABLE IF NOT EXISTS dead_letters (
  id            BIGSERIAL    PRIMARY KEY,
  stream        TEXT         NOT NULL,
  consumer_group TEXT        NOT NULL,
  entry_id      TEXT         NOT NULL,
  payload       TEXT         NOT NULL,
  delivery_count INTEGER     NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (consumer_group, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_stream
  ON dead_letters (stream, consumer_group);

CREATE INDEX IF NOT EXISTS idx_dead_letters_created
  ON dead_letters (created_at DESC);
