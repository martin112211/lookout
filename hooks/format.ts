import type { GitInfo, Snapshot } from '../types'
import type { Slot } from './palettes'

/** A run of text in one of the skin's slots; the band draws `dim` ones dimmed. */
export type Seg = { text: string; slot: Slot; bold?: boolean; dim?: boolean }

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
const EIGHTHS = ' ▏▎▍▌▋▊▉'

export const levelOf = (pct: number): Slot => (pct < 60 ? 'ok' : pct < 85 ? 'warn' : 'err')

/** Smooth bar using eighth blocks: filled part in its level's slot, track dimmed. */
export const bar = (pct: number, width = 8): Seg[] => {
  const p = Math.max(0, Math.min(100, pct))
  const eighths = Math.round((p / 100) * width * 8)
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  const partial = part ? (EIGHTHS[part] ?? '') : ''
  const rest = width - full - (partial ? 1 : 0)
  return [
    { text: '█'.repeat(full) + partial, slot: levelOf(p) },
    { text: '█'.repeat(rest), slot: 'muted', dim: true },
  ]
}

export const tokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

const pad = (n: number) => String(n).padStart(2, '0')

export const resetLabel = (iso: string | undefined, withDay: boolean, now: Date): string => {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const label = `${pad(t.getHours())}:${pad(t.getMinutes())}`
  return withDay && t.toDateString() !== now.toDateString() ? `${WEEKDAYS[t.getDay()]} ${label}` : label
}

/** "claude-opus-5-5" -> "Opus 5.5"; anything else is shown as given. */
export const prettyModel = (model: string): string => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(model)
  if (!m || !m[1]) return model
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return `${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' 1M' : ''}`
}

export const basename = (path: string): string => {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** Parses `git status --porcelain=v2 --branch` output. */
export const parseGit = (out: string): GitInfo | undefined => {
  let branch: string | undefined
  let oid = ''
  let ahead = 0
  let behind = 0
  let dirty = false
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length)
    else if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length)
    else if (line.startsWith('# branch.ab ')) {
      const [a, b] = line.split(' ').slice(2, 4)
      ahead = Number(a)
      behind = -Number(b)
    } else if (line && !line.startsWith('#')) dirty = true
  }
  if (branch === '(detached)') branch = oid.slice(0, 7)
  return branch ? { branch, dirty, ahead, behind } : undefined
}

const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

/** One status line as segments, grouped; the line separates groups with `│`. */
export const segments = (s: Snapshot, now: Date): Seg[][] => {
  const groups: Seg[][] = []

  if (s.model) groups.push([{ text: `◆ ${prettyModel(s.model)}`, slot: 'write', bold: true }])

  if (s.folder) {
    const g: Seg[] = [{ text: s.folder, slot: 'read' }]
    if (s.git) {
      g.push({ text: ` ⎇ ${s.git.branch}`, slot: 'search' })
      if (s.git.dirty) g.push({ text: ' ●', slot: 'warn' })
      if (s.git.ahead) g.push({ text: ` ↑${s.git.ahead}`, slot: 'ok' })
      if (s.git.behind) g.push({ text: ` ↓${s.git.behind}`, slot: 'err' })
    }
    groups.push(g)
  }

  if (s.hub && s.hub.others > 0) {
    const g: Seg[] = [{ text: 'sessions ', slot: 'muted' }, { text: String(s.hub.others), slot: 'fg' }]
    if (s.hub.waiting) g.push({ text: ` ${s.hub.waiting} waiting`, slot: 'warn', bold: true })
    g.push({ text: ` ${s.hub.working} working`, slot: 'muted' })
    groups.push(g)
  }

  if (s.ctx) {
    const g: Seg[] = [{ text: 'ctx ', slot: 'muted' }, ...bar(s.ctx.percent)]
    if (s.ctx.tokens) g.push({ text: ` ${tokens(s.ctx.tokens)}`, slot: 'fg' })
    groups.push(g)
  }

  for (const l of s.limits) {
    const g: Seg[] = [
      { text: `${LIMIT_NAMES[l.kind] ?? l.kind} `, slot: 'muted' },
      ...bar(l.percent),
      { text: ` ${Math.round(l.percent)}%`, slot: levelOf(l.percent) },
    ]
    const reset = resetLabel(l.resetsAt, l.kind === 'seven_day', now)
    if (reset) g.push({ text: ` ↻ ${reset}`, slot: 'muted' })
    groups.push(g)
  }

  if (s.costUsd !== undefined) groups.push([{ text: `$${s.costUsd.toFixed(2)}`, slot: 'web' }])
  if (s.cacheTax) groups.push([{ text: 'cache ', slot: 'muted' }, { text: s.cacheTax, slot: 'fg' }])
  if (s.update) groups.push([{ text: `↑ Lookout ${s.update}`, slot: 'warn' }])

  return groups
}

const SEPARATOR_WIDTH = 3

export const widthOf = (groups: Seg[][], indexes: number[]): number =>
  indexes.reduce((sum, i) => sum + (groups[i] ?? []).reduce((w, seg) => w + [...seg.text].length, 0), 0) +
  SEPARATOR_WIDTH * Math.max(0, indexes.length - 1)

/**
 * One row when everything fits, else exactly two: who and where (model, folder, git, hub)
 * above, budget (context, limits, cost) below. Never more than two rows.
 */
export const statusRows = (groups: Seg[][], columns: number, tailWidth = 0): number[][] => {
  const all = groups.map((_, i) => i)
  if (widthOf(groups, all) + tailWidth <= columns) return [all]
  let split = groups.findIndex(g => g[0]?.text === 'ctx ')
  if (split <= 0) split = Math.ceil(groups.length / 2)
  return [all.slice(0, split), all.slice(split)]
}
