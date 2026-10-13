export const MAX_NAME = 40
export const FALLBACK_NAME = 'Working on it'

const CODE_FILE =
  /[\w.-]*\.(tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|bash|ps1|json|jsonc|ya?ml|toml|ini|cfg|conf|env|lock|css|scss|sass|less|html?|xml|svg|md|mdx|sql|vue|svelte|astro|gradle|dart|lua|pl|r|scala|ex|exs|erl|clj|ipynb|log|txt|csv)\b/gi

/**
 * Turns whatever Claude wrote into a short, plain step name: no code, no
 * paths, no file names, a capital first letter, at most 40 characters.
 */
export function cleanName(raw: unknown): string {
  let text = typeof raw === 'string' ? raw : ''

  text = text.replace(/`[^`]*`/g, ' ').replace(/`/g, ' ')
  text = text.replace(/\S*[/\\]\S*/g, ' ')
  text = text.replace(CODE_FILE, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  text = text.replace(/^[\s,;:.()\-–—]+/, '').replace(/[\s,;:(\-–—]+$/, '').trim()

  if (text === '') {
    return FALLBACK_NAME
  }

  text = text[0]!.toUpperCase() + text.slice(1)

  if (text.length > MAX_NAME) {
    const head = text.slice(0, MAX_NAME - 1)
    const space = head.lastIndexOf(' ')
    const cut = space >= 8 ? head.slice(0, space) : head
    text = cut.replace(/[\s,;:.(\-–—]+$/, '') + '…'
  }

  return text
}

/** Names compared the way a person would: ignoring case and stray spaces. */
export function isSameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** `72000` → `1m 12s`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))

  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)

  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Cuts `text` to `width` cells with `…`, then pads it to exactly `width`. */
export function fit(text: string, width: number): string {
  const chars = Array.from(text)

  if (chars.length > width) {
    return chars.slice(0, Math.max(0, width - 1)).join('') + '…'
  }

  return text + ' '.repeat(width - chars.length)
}
