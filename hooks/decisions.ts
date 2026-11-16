function decisionWords(text: string): Set<string> {
  const flat = text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ')
  return new Set(flat.split(/\s+/).filter(word => word.length > 2))
}

export function isSameDecision(a: string, b: string): boolean {
  const x = decisionWords(a)
  const y = decisionWords(b)
  if (x.size === 0 || y.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase()
  let shared = 0
  for (const word of x) if (y.has(word)) shared++
  return shared / Math.max(x.size, y.size) >= 0.75
}
