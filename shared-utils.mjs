/**
 * Shared utilities for local-server and daemon
 */

export function stripXml(text) {
  return text
    .replace(/<[^>]+>[^<]*<\/[^>]+>/g, " ")  // paired tags with content
    .replace(/<[^>]+>/g, " ")                 // standalone tags
    .replace(/\s+/g, " ")                     // collapse whitespace
    .trim()
}
