import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.USERPROFILE || process.env.HOME
const projectsDir = join(home, '.claude', 'projects')
const GAP_MS = 5 * 60_000
const SOLO_MS = 60_000
const KEEP_MS = 9 * 24 * 60 * 60_000
const CHUNK = 8 * 1024 * 1024
const cache = new Map()

const ITEM_PATTERNS = [/\bAB#(\d{4,6})\b/g, /(?:^|[\s(\[])#(\d{5})\b/g]
const BRANCH_ITEM = /(?:^|\/)(?:[a-z]+\/)?(\d{5})(?:-|$)/

export function dayKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const PHASE_PATTERNS = [/\b[Pp]hase[\s-]+0?(\d{1,2}(?:\.\d{1,2})?)\b/g, /\b0?(\d{1,2}\.\d{1,2})-\d{2}\b/g, /\bphases[\\/]0?(\d{1,2}(?:\.\d{1,2})?)-/g]

export function itemsIn(text) {
  const found = []
  for (const pattern of ITEM_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) found.push(match[1])
  }
  if (found.length) return found
  for (const pattern of PHASE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) found.push(`Phase ${match[1]}`)
  }
  return found
}

function userText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return undefined
  const content = entry.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.some(block => block?.type === 'tool_result')) return undefined
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

function fresh(path) {
  return {
    path,
    offset: 0,
    lastTs: 0,
    title: undefined,
    customTitle: undefined,
    branch: undefined,
    cwd: undefined,
    item: undefined,
    items: new Map(),
    days: new Map(),
    events: [],
    spans: [],
  }
}

function addTime(state, ts) {
  const gap = state.lastTs ? ts - state.lastTs : Infinity
  const add = gap >= 0 && gap <= GAP_MS ? gap : SOLO_MS
  const day = dayKey(ts)
  const item = state.item ?? '-'
  const perItem = state.days.get(day) ?? new Map()
  perItem.set(item, (perItem.get(item) ?? 0) + add)
  state.days.set(day, perItem)
  const span = state.spans.at(-1)
  if (span && ts - span[1] <= GAP_MS && ts >= span[1]) span[1] = ts
  else if (!span || ts > span[1]) state.spans.push([ts, ts])
  state.lastTs = Math.max(state.lastTs, ts)
}

function addEvent(state, ts, kind, label) {
  state.events.push({ t: ts, kind, label: String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) })
}

function consume(state, entry) {
  if (entry.type === 'custom-title' && entry.customTitle) state.customTitle = entry.customTitle
  if (entry.type === 'ai-title' && entry.aiTitle) state.title = entry.aiTitle
  if (entry.gitBranch) {
    state.branch = entry.gitBranch
    const fromBranch = BRANCH_ITEM.exec(entry.gitBranch)?.[1]
    if (fromBranch && !state.item) state.item = fromBranch
  }
  if (entry.cwd) state.cwd = entry.cwd
  const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN
  if (Number.isNaN(ts) || entry.isSidechain) return
  if (entry.type === 'system' && entry.subtype === 'compact_boundary') addEvent(state, ts, 'compact', 'Compaction')
  const text = userText(entry)
  if (text !== undefined) {
    const found = itemsIn(text)
    if (found.length) {
      state.item = found.at(-1)
      for (const id of found) state.items.set(id, (state.items.get(id) ?? 0) + 1)
    }
    const trimmed = text.trim()
    if (trimmed && !trimmed.startsWith('<') && !trimmed.startsWith('[SYSTEM') && !trimmed.startsWith('This session is being continued')) {
      addEvent(state, ts, 'prompt', trimmed)
    }
  }
  if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
    for (const block of entry.message.content) {
      if (block?.type === 'text' && !state.item && typeof block.text === 'string') {
        const said = itemsIn(block.text)
        if (said.length) state.item = said.at(-1)
      }
      if (block?.type !== 'tool_use') continue
      const input = block.input ?? {}
      if (block.name === 'AskUserQuestion') addEvent(state, ts, 'question', input.questions?.[0]?.question ?? 'Question')
      else if (block.name === 'Agent' || block.name === 'Task') addEvent(state, ts, 'agent', input.description ?? input.subagent_type ?? 'Agent')
      else if ((block.name === 'Bash' || block.name === 'PowerShell') && typeof input.command === 'string') {
        if (/\bgit\b[^\n|;&]*\bcommit\b/.test(input.command)) addEvent(state, ts, 'commit', input.command)
        else if (/\bgit\b[^\n|;&]*\bpush\b/.test(input.command)) addEvent(state, ts, 'push', input.command)
      }
    }
  }
  if (entry.type === 'user' || entry.type === 'assistant') addTime(state, ts)
}

function prune(state) {
  const cutoff = Date.now() - KEEP_MS
  if (state.events.length && state.events[0].t < cutoff) state.events = state.events.filter(one => one.t >= cutoff)
  if (state.spans.length && state.spans[0][1] < cutoff) state.spans = state.spans.filter(one => one[1] >= cutoff)
  for (const day of state.days.keys()) if (Date.parse(`${day}T23:59:59`) < cutoff) state.days.delete(day)
}

export function scanFile(path) {
  let size
  try {
    size = statSync(path).size
  } catch {
    return undefined
  }
  let state = cache.get(path)
  if (!state || size < state.offset) state = fresh(path)
  if (size > state.offset) {
    const fd = openSync(path, 'r')
    try {
      let position = state.offset
      let carry = ''
      while (position < size) {
        const length = Math.min(CHUNK, size - position)
        const buffer = Buffer.alloc(length)
        readSync(fd, buffer, 0, length, position)
        position += length
        const text = carry + buffer.toString('utf8')
        const lines = text.split('\n')
        carry = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue
          try {
            consume(state, JSON.parse(line))
          } catch {}
        }
      }
      state.offset = size - Buffer.byteLength(carry, 'utf8')
    } finally {
      closeSync(fd)
    }
    prune(state)
  }
  cache.set(path, state)
  return state
}

export function transcriptsSince(sinceMs) {
  const out = []
  if (!existsSync(projectsDir)) return out
  for (const dir of readdirSync(projectsDir)) {
    const full = join(projectsDir, dir)
    let names
    try {
      names = readdirSync(full)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(full, name)
      try {
        if (statSync(path).mtimeMs >= sinceMs) out.push(path)
      } catch {}
    }
  }
  return out
}

export function sessionIdOf(path) {
  return path.split(/[\\/]/).at(-1).replace(/\.jsonl$/, '')
}

export function titleOf(state) {
  return state.customTitle || state.title
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function commitMessage(command) {
  const heredoc = /<<\s*'?(\w+)'?\s*\n([\s\S]*?)\n\s*\1\b/.exec(command)
  if (heredoc) return heredoc[2].split('\n').find(line => line.trim())?.trim() ?? 'commit'
  const flag = /-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(command)
  if (flag) return (flag[1] ?? flag[2]).split('\n')[0].trim()
  return 'commit'
}

export function eventsOf(entry) {
  const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN
  if (Number.isNaN(ts) || entry.isSidechain) return []
  if (entry.type === 'system' && entry.subtype === 'compact_boundary') return [{ t: ts, kind: 'compact' }]
  const text = userText(entry)
  if (text !== undefined) {
    const trimmed = text.trim()
    const isOwner = trimmed && !trimmed.startsWith('<') && !trimmed.startsWith('[SYSTEM') && !trimmed.startsWith('This session is being continued')
    return isOwner ? [{ t: ts, kind: 'prompt' }] : []
  }
  if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) return []
  const out = []
  for (const block of entry.message.content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) out.push({ t: ts, kind: 'reply' })
    if (block?.type !== 'tool_use') continue
    const input = block.input ?? {}
    if (block.name === 'AskUserQuestion') out.push({ t: ts, kind: 'question', label: input.questions?.[0]?.question })
    else if (EDIT_TOOLS.has(block.name) && typeof (input.file_path ?? input.notebook_path) === 'string') out.push({ t: ts, kind: 'edit', label: input.file_path ?? input.notebook_path })
    else if ((block.name === 'Bash' || block.name === 'PowerShell') && typeof input.command === 'string') {
      if (/\bgit\b[^\n|;&]*\bcommit\b/.test(input.command)) out.push({ t: ts, kind: 'commit', label: commitMessage(input.command) })
      else if (/\bgit\b[^\n|;&]*\bpush\b/.test(input.command)) out.push({ t: ts, kind: 'push' })
    }
  }
  return out
}
