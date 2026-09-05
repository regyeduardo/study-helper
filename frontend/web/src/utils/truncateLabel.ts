/**
 * Truncates a text string.
 *
 * - If `text` length ≤ 25, returns the text unchanged.
 * - Otherwise, drops the last whitespace-separated word and appends '…'.
 * - A single word longer than 25 chars returns '…'.
 *
 * @param text  The input string to truncate.
 * @returns The original or truncated string.
 */
export function truncateLabel(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= 25) return trimmed
  const words = trimmed.split(/\s+/)
  return words.slice(0, -1).join(' ') + '…'
}
