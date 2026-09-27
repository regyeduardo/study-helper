const FENCE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/
const MARKDOWN_LINK = /\[([^\]\n]*)\]\(\s*([^)\s]+)[^)]*\)/g
const ANGLE_URL = /<\s*(https?:\/\/[^>\s]+)\s*>/g
const BARE_URL = /(?<![\w(])((?:https?:\/\/|www\.)[^\s<>)\]]+)/g
const EXTERNAL = /^(https?:\/\/|www\.|\/\/)/i

function clean(text: string): string {
  return text
    .replace(MARKDOWN_LINK, (whole, label: string, target: string) => (EXTERNAL.test(target) ? label : whole))
    .replace(ANGLE_URL, '')
    .replace(BARE_URL, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
}

export function stripExternalLinks(markdown: string): string {
  return markdown
    .split(FENCE)
    .map((part, index) => (index % 2 === 1 ? part : clean(part)))
    .join('')
}
