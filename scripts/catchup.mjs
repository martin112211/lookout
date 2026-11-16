import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ITEMS = 8

function readsPath(dir) {
  return join(dir, 'reads.json')
}

export function loadReads(dir) {
  try {
    return existsSync(readsPath(dir)) ? JSON.parse(readFileSync(readsPath(dir), 'utf8')) : {}
  } catch {
    return {}
  }
}

export function markRead(dir, key, at = Date.now()) {
  const reads = loadReads(dir)
  reads[key] = Math.max(reads[key] ?? 0, at)
  for (const [id, value] of Object.entries(reads)) if (Date.now() - value > 14 * 24 * 60 * 60_000) delete reads[id]
  writeFileSync(readsPath(dir), JSON.stringify(reads))
  return reads[key]
}

function baseName(path) {
  return String(path).split(/[\\/]/).filter(Boolean).at(-1) ?? String(path)
}

function shortModel(model) {
  const m = /(haiku|sonnet|opus|fable)/i.exec(model ?? '')
  return m ? m[1].toLowerCase() : undefined
}

export function lastReadOf(session, reads) {
  const lastPrompt = (session.events ?? []).findLast(one => one.kind === 'prompt')?.t ?? 0
  const marked = reads[session.sessionId] ?? 0
  return Math.max(marked, lastPrompt) || session.startedAt || 0
}

function openItems(session) {
  const items = []
  for (const item of session.live ?? []) {
    if (item.kind === 'question') items.push({ g: '?', t: item.at, text: `Waits for your answer: ${item.questions?.[0]?.question ?? 'question'}` })
    else if (item.kind === 'permission') items.push({ g: '?', t: item.at, text: `Waits for an approval: ${item.tool}${item.summary ? ` ${item.summary}` : ''}` })
    else if (item.kind === 'plan') items.push({ g: '?', t: item.at, text: 'Waits for you to approve a plan' })
  }
  if (!items.length && session.waitingOnPerson) {
    const q = session.question?.[0]?.question
    items.push({ g: '?', t: session.statusUpdatedAt, text: q ? `Waits for your answer: ${q}` : `Waits for you${session.waitingFor ? `: ${session.waitingFor}` : ''}` })
  }
  return items
}

export function catchupFor(session, since, sharedFiles = []) {
  const after = (session.events ?? []).filter(one => one.t > since)
  const items = []
  for (const e of after) {
    if (e.kind === 'commit') items.push({ g: 'C', t: e.t, text: `Committed: ${e.label}` })
    else if (e.kind === 'push') items.push({ g: 'P', t: e.t, text: 'Pushed' })
    else if (e.kind === 'compact') items.push({ g: 'K', t: e.t, text: session.brief ? 'Compacted, the brief was given back' : 'Compacted' })
  }
  const edited = [...new Set(after.filter(e => e.kind === 'edit').map(e => baseName(e.label)))]
  if (edited.length) {
    const t = after.findLast(e => e.kind === 'edit').t
    items.push({ g: 'E', t, text: `Edited ${edited.length} file${edited.length > 1 ? 's' : ''}: ${edited.slice(0, 4).join(', ')}${edited.length > 4 ? ', ...' : ''}` })
  }
  for (const agent of session.agents ?? []) {
    const model = shortModel(agent.model)
    const name = `${agent.type ?? 'agent'}${model ? ` (${model})` : ''}`
    if (agent.state === 'done' && agent.updatedAt > since) items.push({ g: 'A', t: agent.updatedAt, text: `${name} finished: ${agent.description ?? ''}`.trim() })
    if (agent.state === 'stalled') items.push({ g: '!', t: agent.updatedAt, text: `${name} has written nothing for a while: ${agent.description ?? ''}`.trim() })
  }
  for (const file of sharedFiles) items.push({ g: '!', t: file.at, text: `Shares ${baseName(file.path)} with ${file.others.join(', ')}` })
  items.sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
  const open = openItems(session)
  return {
    since,
    unread: after.filter(e => e.kind === 'reply').length,
    items: [...items.slice(-MAX_ITEMS), ...open],
  }
}

function titleOf(session) {
  return session.title || session.name
}

function sharedFor(session, repos, sessions) {
  const out = []
  for (const repo of repos) {
    if (!repo.sessions.includes(session.sessionId)) continue
    for (const file of repo.files) {
      const mine = file.sessions.find(one => one.sessionId === session.sessionId)
      const others = file.sessions.filter(one => one.sessionId !== session.sessionId)
      if (!mine || !others.length) continue
      const names = others.map(one => {
        const other = sessions.find(s => s.sessionId === one.sessionId)
        return other ? titleOf(other) : 'an ended session'
      })
      out.push({ path: file.path, at: Math.max(mine.at, ...others.map(one => one.at)), others: [...new Set(names)] })
    }
  }
  return out
}

export function withCatchup(sessions, repos, dir) {
  const reads = loadReads(dir)
  for (const session of sessions) {
    const repo = repos.find(one => one.sessions.includes(session.sessionId))
    session.repo = repo ? { root: repo.root, name: repo.name } : undefined
    session.shared = sharedFor(session, repos, sessions)
    session.lastReadAt = lastReadOf(session, reads)
    const catchup = catchupFor(session, session.lastReadAt, session.shared)
    session.unread = catchup.unread
    session.catchup = catchup.items
  }
  return sessions
}

export function digest(sessions, since, limits = []) {
  const lines = []
  for (const session of sessions) {
    const after = (session.events ?? []).filter(one => one.t > since)
    const parts = []
    const commits = after.filter(e => e.kind === 'commit').length
    const agents = (session.agents ?? []).filter(a => a.state === 'done' && a.updatedAt > since).length
    const compactions = after.filter(e => e.kind === 'compact').length
    if (commits) parts.push(`${commits} commit${commits > 1 ? 's' : ''}`)
    if (agents) parts.push(`${agents} agent${agents > 1 ? 's' : ''} finished`)
    if (compactions) parts.push('compacted')
    if (session.shared?.some(file => file.at > since)) parts.push('shares a file with another session')
    const isWaiting = session.waitingOnPerson || (session.live ?? []).length > 0
    const replied = after.some(e => e.kind === 'reply')
    if (isWaiting) {
      lines.push({ tone: 'wait', text: `${titleOf(session)} waits for you${parts.length ? ` (${parts.join(', ')})` : ''}` })
    } else if (parts.length || replied) {
      const done = session.status !== 'busy'
      lines.push({ tone: done ? 'done' : 'run', text: `${titleOf(session)}: ${parts.length ? parts.join(', ') : 'new replies'}${done ? ', idle now' : ', still working'}` })
    }
  }
  const order = { wait: 0, done: 1, run: 2 }
  lines.sort((a, b) => order[a.tone] - order[b.tone])
  const five = limits.find(one => one.kind === 'five_hour')
  if (five && five.percentUsed >= 80) {
    const at = five.resetsAt ? new Date(five.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
    lines.push({ tone: 'wait', text: `5-hour limit at ${Math.round(five.percentUsed)} %${at ? `, frees up at ${at}` : ''}. Hold long agent runs until then.` })
  }
  return lines
}

export function publicSession(session) {
  const { events, ...rest } = session
  void events
  return rest
}
