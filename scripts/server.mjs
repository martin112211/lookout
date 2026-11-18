import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { agentDetail, collectSessions, collisions, findRegistration, forkName, hubDir, ledger, readBrief, runGit, sessionDetail, sessionTitle } from './hub-data.mjs'
import { dayKey, scanFile, sessionIdOf, titleOf, transcriptsSince } from './scan.mjs'
import { DEFAULT_CONFIG, FEATURE_LABELS, MODEL_CHOICES, PRESETS, draftRoute, routeAgent, sanitizeConfig } from '../hooks/settings.ts'
import { focusArgv, focusSessionArgv, parseProcessInfo, processInfoArgv, tabArgv } from '../hooks/terminal.ts'
import { digest, loadReads, markRead, publicSession, withCatchup } from './catchup.mjs'
import { spawnSync } from 'node:child_process'

const settingsPath = join(hubDir, 'config.json')
const routingPath = join(hubDir, 'routing.jsonl')

function readSettings() {
  try {
    return sanitizeConfig(JSON.parse(readFileSync(settingsPath, 'utf8')))
  } catch {
    return DEFAULT_CONFIG
  }
}

function routingLog() {
  try {
    return readFileSync(routingPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function recentRoutes() {
  return routingLog().filter(one => one.kind !== 'outcome').slice(-30).reverse()
}

function outcomeStats() {
  const byModel = new Map()
  for (const one of routingLog()) {
    if (one.kind !== 'outcome') continue
    const key = one.ran ?? one.model ?? 'unknown'
    const row = byModel.get(key) ?? { model: key, count: 0, tokens: 0, durationMs: 0, toolUses: 0, errors: 0, routed: 0 }
    row.count++
    row.tokens += one.tokens ?? 0
    row.durationMs += one.durationMs ?? 0
    row.toolUses += one.toolUses ?? 0
    if (one.isError || (one.status && one.status !== 'completed' && one.status !== 'async_launched')) row.errors++
    if (one.model) row.routed++
    byModel.set(key, row)
  }
  return [...byModel.values()].map(row => ({ ...row, avgTokens: Math.round(row.tokens / row.count), avgSeconds: Math.round(row.durationMs / row.count / 1000), avgToolUses: Math.round(row.toolUses / row.count) })).sort((a, b) => b.count - a.count)
}

function taskWords(text) {
  return new Set(String(text).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(word => word.length > 2))
}

function isSameTask(a, b) {
  const x = taskWords(a)
  const y = taskWords(b)
  if (!x.size || !y.size) return false
  let shared = 0
  for (const word of x) if (y.has(word)) shared++
  return shared / Math.max(x.size, y.size) >= 0.6
}

const PORT = Number(process.env.LOOKOUT_PORT ?? process.env.DOCKET_PORT ?? process.env.SESSION_HUB_PORT ?? 47821)
const HOST = '127.0.0.1'
const configPath = join(hubDir, 'server.json')
const pagePath = join(import.meta.dir, 'web', 'index.html')
const assetsDir = join(import.meta.dir, 'web', 'assets')
const ASSET_TYPES = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', webmanifest: 'application/manifest+json' }
const VERSION = readJsonFile(join(import.meta.dir, '..', '.claude-plugin', 'plugin.json'), {}).version ?? '0.0.0'
const startedAt = Date.now()
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const QUEUE_TTL_MS = 10 * 60_000

mkdirSync(hubDir, { recursive: true })

function loadToken() {
  try {
    const saved = JSON.parse(readFileSync(configPath, 'utf8'))
    if (typeof saved.token === 'string' && saved.token.length >= 32) return saved.token
  } catch {}
  return randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
}

const token = loadToken()
const queue = new Map()
const answers = new Map()
const ANSWER_TTL_MS = 30 * 60_000
const leasesPath = join(hubDir, 'leases.json')
const leases = new Map(Object.entries(readJsonFile(leasesPath, {})))
const costSamples = new Map()

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function saveLeases() {
  try {
    writeFileSync(leasesPath, JSON.stringify(Object.fromEntries(leases)))
  } catch {}
}

function liveLeases() {
  const now = Date.now()
  let changed = false
  for (const [key, lease] of leases) {
    if (lease.expiresAt < now) {
      leases.delete(key)
      changed = true
    }
  }
  if (changed) saveLeases()
  return [...leases.entries()].map(([key, lease]) => ({ key, ...lease }))
}

function budget(sessions) {
  let newest
  for (const session of sessions) {
    if (session.usage?.rateLimits?.length && (!newest || session.usage.at > newest.at)) newest = session.usage
  }
  const now = Date.now()
  const burn = []
  for (const session of sessions) {
    const cost = session.usage?.costUsd
    if (typeof cost !== 'number') continue
    const samples = costSamples.get(session.sessionId) ?? []
    if (!samples.length || now - samples.at(-1).at > 60_000) samples.push({ at: now, cost })
    while (samples.length && now - samples[0].at > 2 * 60 * 60_000) samples.shift()
    costSamples.set(session.sessionId, samples)
    const hourAgo = samples.find(one => now - one.at <= 60 * 60_000) ?? samples[0]
    burn.push({ sessionId: session.sessionId, costUsd: cost, lastHourUsd: Math.max(0, cost - hourAgo.cost) })
  }
  return { limits: newest?.rateLimits ?? [], at: newest?.at, burn }
}

function timeReport(days) {
  const since = new Date()
  since.setHours(0, 0, 0, 0)
  since.setDate(since.getDate() - (days - 1))
  const dayKeys = []
  for (let i = 0; i < days; i++) {
    const d = new Date(since)
    d.setDate(since.getDate() + i)
    dayKeys.push(dayKey(d.getTime()))
  }
  const items = new Map()
  for (const file of transcriptsSince(since.getTime())) {
    const state = scanFile(file)
    if (!state) continue
    for (const day of dayKeys) {
      const perItem = state.days.get(day)
      if (!perItem) continue
      for (const [item, ms] of perItem) {
        const row = items.get(item) ?? { item, total: 0, perDay: {}, sessions: new Map() }
        row.total += ms
        row.perDay[day] = (row.perDay[day] ?? 0) + ms
        const id = sessionIdOf(file)
        const session = row.sessions.get(id) ?? { sessionId: id, title: titleOf(state), cwd: state.cwd, ms: 0 }
        session.ms += ms
        row.sessions.set(id, session)
        items.set(item, row)
      }
    }
  }
  const rows = [...items.values()].map(row => ({ ...row, sessions: [...row.sessions.values()].sort((a, b) => b.ms - a.ms) }))
  rows.sort((a, b) => (a.item === '-') - (b.item === '-') || b.total - a.total)
  return { days: dayKeys, items: rows }
}

function recorder(day, liveIds) {
  const start = new Date(day + 'T00:00:00').getTime()
  const end = start + 24 * 60 * 60_000
  const lanes = []
  for (const file of transcriptsSince(start)) {
    const state = scanFile(file)
    if (!state) continue
    const spans = state.spans.filter(([a, b]) => b >= start && a < end).map(([a, b]) => [Math.max(a, start), Math.min(b, end)])
    if (!spans.length) continue
    const id = sessionIdOf(file)
    lanes.push({
      sessionId: id,
      title: titleOf(state) ?? id.slice(0, 8),
      cwd: state.cwd,
      branch: state.branch,
      item: state.item,
      isLive: liveIds.has(id),
      spans,
      events: state.events.filter(one => one.t >= start && one.t < end),
    })
  }
  lanes.sort((a, b) => a.spans[0][0] - b.spans[0][0])
  return { day, start, end, lanes }
}

/** A path as the page shows it: the home folder as ~, so a screenshot names no user. */
function shownPath(path) {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function shortModel(model) {
  return model ? (/(haiku|sonnet|opus|fable)/i.exec(model)?.[1]?.toLowerCase() ?? model) : null
}

const AGENT_CALL = /"name":\s*"(?:Agent|Task)"/

function routingReplay(days) {
  const settings = readSettings()
  const config = { ...settings, orchestrator: { ...settings.orchestrator, on: true } }
  const rows = []
  for (const file of transcriptsSince(Date.now() - days * 24 * 60 * 60_000)) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!AGENT_CALL.test(text)) continue
    const subDir = join(file.replace(/\.jsonl$/, ''), 'subagents')
    const metas = []
    try {
      for (const name of readdirSync(subDir)) if (name.endsWith('.meta.json')) metas.push(readJsonFile(join(subDir, name), {}))
    } catch {}
    for (const line of text.split('\n')) {
      if (!line.includes('"tool_use"') || !AGENT_CALL.test(line)) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      for (const block of entry.message?.content ?? []) {
        if (block?.type !== 'tool_use' || (block.name !== 'Agent' && block.name !== 'Task')) continue
        const input = block.input ?? {}
        const type = input.subagent_type ?? 'general-purpose'
        const description = String(input.description ?? '')
        const meta = metas.find(one => one.description === description && one.agentType === type) ?? metas.find(one => one.description === description)
        const routeInput = { subagentType: type, description, prompt: String(input.prompt ?? ''), model: input.model }
        const draft = draftRoute(config, routeInput)
        const route = routeAgent(config, routeInput)
        rows.push({ at: Date.parse(entry.timestamp ?? '') || 0, sessionId: sessionIdOf(file), type, description: description.slice(0, 120), asked: input.model ?? null, ran: shortModel(meta?.pickedEffortModel ?? meta?.model ?? entry.message?.model), rule: draft?.rule?.id ?? (draft?.tier ? `tier ${draft.tier}` : null), tier: draft?.tier ?? null, source: draft?.source ?? null, isSure: draft?.isSure ?? null, reasons: route?.reasons ?? draft?.reasons ?? [], routed: route?.model ?? null, routedEffort: route?.effort ?? null })
      }
    }
  }
  rows.sort((a, b) => a.at - b.at)
  rows.forEach((row, index) => {
    row.isRedone = rows.slice(index + 1).some(later => later.sessionId === row.sessionId && later.at - row.at < 2 * 60 * 60_000 && later.type === row.type && isSameTask(later.description, row.description))
  })
  rows.reverse()
  const redoByModel = Object.entries(rows.reduce((acc, row) => {
    const key = row.ran ?? 'unknown'
    acc[key] ??= { total: 0, redone: 0 }
    acc[key].total++
    if (row.isRedone) acc[key].redone++
    return acc
  }, {})).map(([model, value]) => ({ model, ...value })).sort((a, b) => b.total - a.total)
  const tally = pick => Object.entries(rows.reduce((acc, row) => ((acc[pick(row)] = (acc[pick(row)] ?? 0) + 1), acc), {})).sort((a, b) => b[1] - a[1])
  return {
    days,
    total: rows.length,
    byType: tally(row => row.type),
    byRule: tally(row => row.rule ?? (row.asked ? 'model set in the call' : 'no rule matched')),
    ran: tally(row => row.ran ?? 'unknown'),
    routed: tally(row => row.routed ?? (row.asked ? `kept ${row.asked}` : 'unchanged')),
    efforts: tally(row => row.routedEffort ?? 'unchanged'),
    changes: tally(row => `${row.ran ?? '?'} -> ${row.routed ?? row.asked ?? row.ran ?? '?'}`),
    unsure: rows.filter(row => row.source === 'tier' && row.isSure === false).length,
    byTier: tally(row => row.tier ?? (row.source === 'type' ? 'pinned by type' : 'not routed')),
    redoByModel,
    outcomes: outcomeStats(),
    rows: rows.slice(0, 60),
  }
}

function handoffText(from, note) {
  const source = findRegistration(from)
  const brief = readBrief(from)
  const last = sessionDetail(from, 4, { full: true }).messages.filter(one => one.role === 'assistant').at(-1)
  const title = sessionTitle(from) ?? source?.name ?? from
  const parts = ['Hand-off from the session "' + title + '" (' + (source?.cwd ?? 'ended session') + ', id ' + from + '). Take this as context for your work here.']
  if (typeof note === 'string' && note.trim()) parts.push('My note: ' + note.trim().slice(0, 4000))
  if (brief) {
    parts.push(['Its brief:', '- Goal: ' + (brief.goal ?? '-'), '- Decided: ' + ((brief.decided ?? []).join('; ') || '-'), '- Next: ' + (brief.next ?? '-'), '- Blocked: ' + (brief.blocked ?? '-')].join('\n'))
  }
  if (last) parts.push('Its latest answer:\n' + last.text.slice(0, 6000))
  return parts.join('\n\n')
}

setTimeout(() => {
  try {
    timeReport(7)
  } catch {}
}, 500)
let lastSessions = null
let lastClaimAt = 0
let lastClaimBy = null

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function prune() {
  const now = Date.now()
  for (const [id, item] of queue) {
    if (now - item.createdAt > QUEUE_TTL_MS) queue.delete(id)
  }
}

async function body(request) {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

const OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'

function openTab(request) {
  const child = Bun.spawn(tabArgv(OS, process.env.TERM_PROGRAM, request), { stdout: 'ignore', stderr: 'ignore' })
  child.unref()
}

async function handleApi(request, url) {
  const path = url.pathname
  if (path === '/api/ping') return json({ ok: true, pid: process.pid, version: VERSION, startedAt })
  if (path === '/api/shutdown' && request.method === 'POST') {
    process.stdout.write(`shutting down ${VERSION} on request\n`)
    setTimeout(() => process.exit(0), 100)
    return json({ ok: true, pid: process.pid })
  }
  if (path === '/api/sessions' && request.method === 'GET') {
    const all = collectSessions()
    const repos = collisions(all)
    withCatchup(all, repos, hubDir)
    lastSessions = all
    const sessions = all.map(publicSession)
    return json({
      sessions,
      repos,
      leases: liveLeases(),
      budget: budget(sessions),
      now: Date.now(),
      messaging: { isAvailable: Date.now() - lastClaimAt < 15_000, via: lastClaimBy },
    })
  }
  if (path === '/api/detail' && request.method === 'GET') {
    const id = url.searchParams.get('id') ?? ''
    const count = Math.min(80, Number(url.searchParams.get('n') ?? 30))
    return json(sessionDetail(id, count, { full: true }))
  }
  if (path === '/api/send' && request.method === 'POST') {
    const { sessionId, text } = await body(request)
    if (typeof sessionId !== 'string' || typeof text !== 'string' || !text.trim()) return json({ error: 'sessionId and text required' }, 400)
    prune()
    const item = { id: randomUUID(), sessionId, name: findRegistration(sessionId)?.name, text: text.trim().slice(0, 20_000), createdAt: Date.now(), state: 'queued' }
    queue.set(item.id, item)
    markRead(hubDir, sessionId)
    return json(item)
  }
  if (path === '/api/read' && request.method === 'POST') {
    const { sessionId } = await body(request)
    if (typeof sessionId !== 'string' || !sessionId || sessionId.startsWith('_')) return json({ error: 'sessionId required' }, 400)
    return json({ at: markRead(hubDir, sessionId) })
  }
  if (path === '/api/look' && request.method === 'POST') {
    const previous = loadReads(hubDir)._page ?? Date.now() - 2 * 60 * 60_000
    let sessions = lastSessions
    if (!sessions) {
      sessions = collectSessions()
      withCatchup(sessions, collisions(sessions), hubDir)
    }
    const lines = digest(sessions, previous, budget(sessions).limits)
    markRead(hubDir, '_page')
    return json({ since: previous, lines })
  }
  if (path === '/api/diff' && request.method === 'GET') {
    const id = url.searchParams.get('id') ?? ''
    const session = (lastSessions ?? []).find(one => one.sessionId === id)
    if (!session?.repo) return json({ error: 'session not in a git repository' }, 404)
    const root = session.repo.root.replace(/\\/g, '/').toLowerCase()
    const files = (session.events ?? []).filter(e => e.kind === 'edit' && String(e.label).replace(/\\/g, '/').toLowerCase().startsWith(`${root}/`)).map(e => e.label)
    if (!files.length) return json({ diff: '', files: [] })
    const result = runGit(['-C', session.repo.root, '--no-optional-locks', '-c', 'core.quotePath=false', 'diff', '--stat', '--patch', 'HEAD', '--', ...new Set(files)], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
    return json({ diff: (result.stdout || '').slice(0, 200_000), files: [...new Set(files)] })
  }
  if (path === '/api/focus' && request.method === 'POST') {
    const { sessionId } = await body(request)
    const reg = typeof sessionId === 'string' ? findRegistration(sessionId) : undefined
    if (reg && OS === 'windows') {
      const argv = focusSessionArgv(OS, undefined, { titles: [sessionTitle(reg.sessionId), reg.name] })
      if (argv) {
        const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 15000, windowsHide: true })
        if ((result.stdout || '').trim() === 'ok') return json({ ok: true, isTab: true })
      }
      return json({ ok: false, reason: 'tab not found' })
    }
    if (reg?.pid && OS === 'mac') {
      const ps = spawnSync(processInfoArgv(reg.pid)[0], processInfoArgv(reg.pid).slice(1), { encoding: 'utf8', timeout: 3000 })
      const info = parseProcessInfo(ps.stdout || '')
      const others = (lastSessions ?? []).filter(one => one.sessionId !== reg.sessionId && one.cwd === reg.cwd).map(one => one.title ?? one.name)
      const argv = focusSessionArgv(OS, info.terminal ?? process.env.TERM_PROGRAM, { titles: [sessionTitle(reg.sessionId), reg.name], others, cwd: reg.cwd, tty: info.tty })
      if (argv) {
        const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 8000 })
        if ((result.stdout || '').trim() === 'ok') return json({ ok: true, isTab: true })
        if (/-1743|not allowed|Not authorized/i.test(result.stderr || '')) return json({ ok: false, reason: 'permission' })
      }
    }
    const argv = focusArgv(OS, process.env.TERM_PROGRAM)
    if (!argv) return json({ ok: false, reason: 'no known terminal to bring forward' })
    const child = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' })
    child.unref()
    return json({ ok: true, isTab: false })
  }
  if (path === '/api/agent' && request.method === 'GET') {
    const value = agentDetail(url.searchParams.get('id') ?? '', url.searchParams.get('agent') ?? '', Math.min(120, Number(url.searchParams.get('n') ?? 40)))
    return value ? json(value) : json({ error: 'agent not found' }, 404)
  }
  if (path.startsWith('/api/send/') && request.method === 'GET') {
    const item = queue.get(path.slice('/api/send/'.length))
    return item ? json(item) : json({ error: 'unknown' }, 404)
  }
  if (path === '/api/outbox/claim' && request.method === 'POST') {
    const { by } = await body(request)
    lastClaimAt = Date.now()
    lastClaimBy = typeof by === 'string' ? by : null
    const claimed = [...queue.values()].filter(item => item.state === 'queued')
    for (const item of claimed) item.state = 'claimed'
    return json(claimed.map(({ id, sessionId, name, text }) => ({ id, sessionId, name, text })))
  }
  if (path === '/api/outbox/result' && request.method === 'POST') {
    const { id, isDelivered, reason } = await body(request)
    const item = queue.get(id)
    if (!item) return json({ error: 'unknown' }, 404)
    item.state = isDelivered ? 'delivered' : 'failed'
    item.reason = typeof reason === 'string' ? reason : undefined
    return json(item)
  }
  if (path === '/api/answer' && request.method === 'POST') {
    const { sessionId, questionId, answers: given, response } = await body(request)
    if (typeof sessionId !== 'string' || typeof questionId !== 'string' || !given || typeof given !== 'object') {
      return json({ error: 'sessionId, questionId and answers required' }, 400)
    }
    const clean = {}
    for (const [question, answer] of Object.entries(given).slice(0, 8)) {
      if (typeof answer === 'string' && answer.trim()) clean[String(question).slice(0, 2000)] = answer.trim().slice(0, 4000)
    }
    if (Object.keys(clean).length === 0) return json({ error: 'no answer given' }, 400)
    const now = Date.now()
    for (const [key, item] of answers) if (now - item.at > ANSWER_TTL_MS) answers.delete(key)
    markRead(hubDir, sessionId)
    answers.set(`${sessionId}:${questionId}`, { answers: clean, response: typeof response === 'string' && response.trim() ? response.trim().slice(0, 4000) : undefined, at: now })
    return json({ ok: true })
  }
  if (path === '/api/answer/claim' && request.method === 'POST') {
    const { sessionId, questionId } = await body(request)
    const key = `${sessionId}:${questionId}`
    const item = answers.get(key)
    if (!item) return json({ answer: null })
    answers.delete(key)
    return json({ answer: { answers: item.answers, response: item.response } })
  }
  if (path === '/api/time' && request.method === 'GET') {
    return json(timeReport(Math.min(31, Math.max(1, Number(url.searchParams.get('days') ?? 7)))))
  }
  if (path === '/api/recorder' && request.method === 'GET') {
    const asked = url.searchParams.get('day') ?? ''
    const day = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(asked) ? asked : dayKey(Date.now())
    return json(recorder(day, new Set(collectSessions().map(one => one.sessionId))))
  }
  if (path === '/api/ledger' && request.method === 'GET') return json({ entries: ledger() })
  if (path === '/api/routing/replay' && request.method === 'GET') return json(routingReplay(Math.min(60, Math.max(1, Number(url.searchParams.get('days') ?? 14)))))
  if (path === '/api/config' && request.method === 'GET') {
    return json({ config: readSettings(), defaults: DEFAULT_CONFIG, models: MODEL_CHOICES, labels: FEATURE_LABELS, routes: recentRoutes(), outcomes: outcomeStats(), presets: PRESETS, path: shownPath(settingsPath) })
  }
  if (path === '/api/config' && request.method === 'POST') {
    const { config, reset } = await body(request)
    const next = reset ? DEFAULT_CONFIG : sanitizeConfig(config)
    mkdirSync(hubDir, { recursive: true })
    writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`)
    return json({ config: next })
  }
  if (path === '/api/lease/acquire' && request.method === 'POST') {
    const { key, sessionId, name, ttlMs, purpose } = await body(request)
    if (typeof key !== 'string' || typeof sessionId !== 'string') return json({ error: 'key and sessionId required' }, 400)
    liveLeases()
    const held = leases.get(key)
    if (held && held.sessionId !== sessionId) return json({ granted: false, holder: held })
    const lease = {
      sessionId,
      name: typeof name === 'string' ? name : undefined,
      purpose: typeof purpose === 'string' ? purpose.slice(0, 200) : undefined,
      since: held?.since ?? Date.now(),
      expiresAt: Date.now() + Math.min(Number(ttlMs) || 15 * 60_000, 2 * 60 * 60_000),
    }
    leases.set(key, lease)
    saveLeases()
    return json({ granted: true, holder: lease })
  }
  if (path === '/api/lease/release' && request.method === 'POST') {
    const { key, sessionId } = await body(request)
    const held = leases.get(key)
    if (held && (held.sessionId === sessionId || sessionId === '*')) {
      leases.delete(key)
      saveLeases()
    }
    return json({ ok: true })
  }
  if (path === '/api/handoff' && request.method === 'POST') {
    const { from, to, note } = await body(request)
    const target = typeof to === 'string' ? findRegistration(to) : undefined
    if (typeof from !== 'string' || !target) return json({ error: 'from and a live target required' }, 400)
    prune()
    const item = { id: randomUUID(), sessionId: target.sessionId, name: target.name, text: handoffText(from, note), createdAt: Date.now(), state: 'queued' }
    queue.set(item.id, item)
    return json(item)
  }
  if ((path === '/api/fork' || path === '/api/attach') && request.method === 'POST') {
    const { sessionId } = await body(request)
    const reg = typeof sessionId === 'string' ? findRegistration(sessionId) : undefined
    if (!reg) return json({ error: 'session not found' }, 404)
    try {
      if (path === '/api/fork') {
        const name = forkName(sessionTitle(reg.sessionId), reg.name)
        openTab({ cwd: reg.cwd, title: name, command: ['claude', '--resume', reg.sessionId, '--fork-session', '--name', name] })
      } else {
        openTab({ title: reg.name, command: ['claude', 'attach', reg.sessionId] })
      }
    } catch (error) {
      return json({ error: String(error.message ?? error) }, 400)
    }
    return json({ ok: true })
  }
  return json({ error: 'not found' }, 404)
}

let server
try {
  server = Bun.serve({
    hostname: HOST,
    port: PORT,
    async fetch(request) {
      const url = new URL(request.url)
      if (!ALLOWED_HOSTS.has(request.headers.get('host') ?? '')) return new Response('forbidden host', { status: 403 })
      if (url.pathname === '/favicon.ico' && request.method === 'GET') return Response.redirect('/assets/icon.svg', 301)
      const asset = /^\/assets\/([a-z0-9-]+)\.(js|css|svg|png|webmanifest)$/.exec(url.pathname)
      if (asset && request.method === 'GET') {
        const file = join(assetsDir, `${asset[1]}.${asset[2]}`)
        if (!existsSync(file)) return new Response('not found', { status: 404 })
        const isText = asset[2] !== 'png'
        return new Response(isText ? readFileSync(file, 'utf8') : readFileSync(file), { headers: { 'content-type': ASSET_TYPES[asset[2]], 'cache-control': isText ? 'no-store' : 'max-age=86400' } })
      }
      const given = url.searchParams.get('token') ?? request.headers.get('x-lookout-token')
      if (given !== token) return new Response('missing or wrong token', { status: 401 })
      if (url.pathname === '/' && request.method === 'GET') {
        return new Response(readFileSync(pagePath, 'utf8'), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
            'referrer-policy': 'no-referrer',
          },
        })
      }
      if (url.pathname.startsWith('/api/')) return handleApi(request, url)
      return new Response('not found', { status: 404 })
    },
  })
} catch (error) {
  if (existsSync(configPath)) {
    process.stdout.write(`already running ${readFileSync(configPath, 'utf8')}\n`)
    process.exit(0)
  }
  throw error
}

writeFileSync(configPath, JSON.stringify({ port: PORT, token, pid: process.pid, version: VERSION, url: `http://${HOST}:${PORT}/?token=${token}` }))
process.stdout.write(`listening http://${HOST}:${PORT} (lookout ${VERSION})\n`)
