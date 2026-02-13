export interface WhatsAppMessage {
  id: string;
  chat_id: string;
  chat_name: string;
  sender_name: string | null;
  sender_number: string | null;
  message_type: string;
  body: string | null;
  timestamp: number;
  from_me: boolean;
  is_group: boolean;
  is_content: boolean;
  message_key_json?: string | null;  // Full message key for reacting
  reacted_to_id?: string | null;     // For reactions: the target message ID
}

export interface AllowedGroup {
  id: string;
  name: string;
}
