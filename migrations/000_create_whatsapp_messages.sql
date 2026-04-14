-- Migration: Create whatsapp_messages table
-- Purpose: Core table for storing all WhatsApp messages
-- Run this FIRST before all other migrations

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id               TEXT PRIMARY KEY,
  chat_id          TEXT NOT NULL,
  chat_name        TEXT NOT NULL,
  sender_name      TEXT,
  sender_number    TEXT,
  message_type     TEXT NOT NULL,
  body             TEXT,
  timestamp        BIGINT NOT NULL,
  from_me          BOOLEAN NOT NULL DEFAULT FALSE,
  is_group         BOOLEAN NOT NULL DEFAULT FALSE,
  is_content       BOOLEAN NOT NULL DEFAULT FALSE,
  message_key_json TEXT,
  reacted_to_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_chat_id
  ON whatsapp_messages(chat_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_timestamp
  ON whatsapp_messages(timestamp);

-- Composite index for common query pattern: messages by group filtered by content and ordered by time
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_chat_content_ts
  ON whatsapp_messages(chat_id, is_content, timestamp);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_message_type
  ON whatsapp_messages(message_type);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_sender_number
  ON whatsapp_messages(sender_number);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_reacted_to
  ON whatsapp_messages(reacted_to_id);
