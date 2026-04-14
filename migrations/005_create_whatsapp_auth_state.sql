-- Migration: Create whatsapp_auth_state table
-- Purpose: Store Baileys WhatsApp session credentials in the database
-- Enables reliable session persistence across restarts (Railway ephemeral storage)

CREATE TABLE IF NOT EXISTS whatsapp_auth_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
