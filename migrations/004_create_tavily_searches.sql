-- Migration: Create tavily_searches table
-- Purpose: Cache and log Tavily web search queries

CREATE TABLE IF NOT EXISTS tavily_searches (
  id                     SERIAL PRIMARY KEY,
  chat_id                TEXT NOT NULL,
  sender_number          TEXT NOT NULL,
  sender_name            TEXT NOT NULL,
  original_query         TEXT NOT NULL,
  search_query           TEXT NOT NULL,
  search_query_normalized TEXT,
  answer                 TEXT,
  results                JSONB,
  results_count          INTEGER,
  response_time          INTEGER,
  from_cache             BOOLEAN DEFAULT FALSE,
  timestamp              BIGINT NOT NULL
);

-- Index for cache lookups (normalized query + recency)
CREATE INDEX IF NOT EXISTS idx_tavily_searches_normalized_ts
  ON tavily_searches(search_query_normalized, timestamp);

CREATE INDEX IF NOT EXISTS idx_tavily_searches_timestamp
  ON tavily_searches(timestamp);
