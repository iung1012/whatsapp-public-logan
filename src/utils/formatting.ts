/**
 * Text Formatting Utilities
 * Converts markdown formatting to WhatsApp-compatible formatting
 */

/**
 * Convert markdown formatting to WhatsApp formatting
 *
 * Markdown → WhatsApp conversions:
 * - **bold** → *bold* (double asterisk to single)
 * - __bold__ → *bold* (double underscore to single asterisk)
 * - ~~strikethrough~~ → ~strikethrough~ (double tilde to single)
 * - # Heading → *Heading* (markdown headings to bold)
 * - `code` stays as is (WhatsApp uses triple backticks, but single works inline)
 */
export function markdownToWhatsApp(text: string): string {
  if (!text) return text;

  let result = text;

  // Convert **bold** to *bold* (double asterisk to single)
  // Use negative lookbehind/lookahead to avoid matching already-single asterisks
  result = result.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  // Convert __bold__ to *bold* (double underscore to bold)
  result = result.replace(/__([^_]+)__/g, '*$1*');

  // Convert ~~strikethrough~~ to ~strikethrough~ (double tilde to single)
  result = result.replace(/~~([^~]+)~~/g, '~$1~');

  // Convert markdown headings (# ## ###) to bold
  // Match lines starting with 1-6 # followed by space and text
  result = result.replace(/^(#{1,6})\s+(.+)$/gm, '*$2*');

  return result;
}

/**
 * Check if text contains markdown formatting that needs conversion
 */
export function hasMarkdownFormatting(text: string): boolean {
  if (!text) return false;

  // Check for double asterisks, double underscores, double tildes, or headings
  return /\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|^#{1,6}\s+/m.test(text);
}
