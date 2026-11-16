import type { Commit, FileChange } from '../types'

export const parseAheadBehind = (out: string): { ahead: number; behind: number } | null => {
  const [behind, ahead] = out.trim().split(/\s+/).map(Number)
  if (behind === undefined || ahead === undefined || isNaN(behind) || isNaN(ahead)) return null
  return { ahead, behind }
}

// porcelain quotes paths with spaces or special chars: "my file.txt"
const unquote = (p: string) => (p.length >= 2 && p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p)

export const parseStatus = (porcelain: string, numstat: string): FileChange[] => {
  const counts = new Map<string, { added: number; removed: number }>()
  for (const line of numstat.split(/\r?\n/)) {
    const [a, r, path] = line.split('\t')
    if (!path) continue
    counts.set(unquote(path), { added: Number(a) || 0, removed: Number(r) || 0 })
  }
  const files: FileChange[] = []
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.length < 4) continue
    const status = line.slice(0, 2).trim() || '?'
    const raw = line.slice(3)
    const path = unquote(raw.includes(' -> ') ? raw.split(' -> ')[1] ?? raw : raw)
    const c = counts.get(path) ?? { added: 0, removed: 0 }
    files.push({ path, status, ...c })
  }
  return files
}

// `HEAD -> feature/x, origin/feature/x, main` -> ['feature/x', 'main']
export const parseRefs = (decoration: string): string[] => {
  const names = decoration
    .split(',')
    .map(r => r.trim().replace(/^HEAD -> /, '').replace(/^tag: /, '#'))
    .filter(r => r && r !== 'HEAD' && !r.endsWith('/HEAD'))
  const local = new Set(names.filter(n => !n.startsWith('origin/')))
  return names.filter(n => !(n.startsWith('origin/') && local.has(n.slice(7))))
}

// lines of `log --format=%h%x09%D%x09%s%x09%ct`
export const parseCommits = (out: string, aheadHashes: Set<string>): Commit[] =>
  out
    .split(/\r?\n/)
    .map(line => line.split('\t'))
    .filter(parts => parts.length >= 4 && parts[0])
    .map(([hash = '', refs = '', subject = '', time = '0']) => ({
      hash,
      refs: parseRefs(refs),
      subject,
      time: Number(time) * 1000,
      isAhead: aheadHashes.has(hash),
    }))

// `origin/main` (from symbolic-ref of origin/HEAD) -> 'main' when a local branch exists, else 'origin/main'
export const pickBase = (originHead: string | null, localBranches: string[]): string | null => {
  const local = new Set(localBranches)
  const remote = originHead?.trim().replace(/^refs\/remotes\//, '')
  if (remote) {
    const short = remote.replace(/^origin\//, '')
    return local.has(short) ? short : remote
  }
  for (const name of ['main', 'master', 'develop']) if (local.has(name)) return name
  return null
}

export const shortAge = (ms: number) => {
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 60) return `${min}m`
  const h = Math.round(min / 60)
  if (h < 48) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 60) return `${d}d`
  return `${Math.round(d / 30)}mo`
}

export const splitPath = (path: string) => {
  const at = path.lastIndexOf('/')
  return at < 0 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
}

// fixed-width bar, e.g. ■■■■·· for the share of added (green) vs removed (red)
export const bar = (added: number, removed: number, max: number, width = 8) => {
  const total = added + removed
  if (total === 0 || max === 0) return { plus: '', minus: '', rest: '·'.repeat(width) }
  const filled = Math.min(width, Math.max(1, Math.round((total / max) * width)))
  const plus = Math.round((added / total) * filled)
  const minus = filled - plus
  return { plus: '■'.repeat(plus), minus: '■'.repeat(minus), rest: '·'.repeat(width - filled) }
}
