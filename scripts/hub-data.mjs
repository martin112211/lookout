import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync, openSync, readSync, closeSync, renameSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { eventsOf, itemsIn } from './scan.mjs'

const home = process.env.USERPROFILE || process.env.HOME
const claudeDir = join(home, '.claude')
const sessionsDir = join(claudeDir, 'sessions')
const projectsDir = join(claudeDir, 'projects')
export const hubDir = join(claudeDir, 'lookout')
const legacyDirs = [join(claudeDir, 'hub'), join(claudeDir, 'docket')]

function moveMissing(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) moveMissing(source, target)
    else if (!existsSync(target)) renameSync(source, target)
  }
  try {
    rmdirSync(from)
  } catch {}
}

export function migrateLegacyDir() {
  let isMoved = false
  for (const dir of legacyDirs) {
    if (!existsSync(dir)) continue
    isMoved = true
    try {
      moveMissing(dir, hubDir)
    } catch {}
  }
  return isMoved
}

migrateLegacyDir()
const titleCachePath = join(hubDir, 'titles.json')
const TAIL_BYTES = 1_500_000
const AGENT_TAIL_BYTES = 200_000
const SNIPPET = 600
const FULL = 8000
const ACTIVITY_BINS = 30
const ACTIVITY_BIN_MS = 2 * 60_000
const AGENT_RECENT_MS = 3 * 60 * 60_000
const AGENT_STALE_MS = 10 * 60_000
const pendingDir = join(hubDir, 'pending')
const briefsDir = join(hubDir, 'briefs')
const usageDir = join(hubDir, 'usage')
const touchesDir = join(hubDir, 'touches')
const ledgerDir = join(hubDir, 'ledger')
const ITEM_PATTERNS = [/\bAB#(\d{4,6})\b/g, /(?:^|[\s(\[])#(\d{5})\b/g]
const BRANCH_ITEM = /(?:^|\/)(?:[a-z]+\/)?(\d{5})(?:-|$)/


function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function sanitizeCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

let projectDirNames
function findTranscript(cwd, sessionId) {
  const file = `${sessionId}.jsonl`
  const direct = join(projectsDir, sanitizeCwd(cwd), file)
  if (existsSync(direct)) return direct
  projectDirNames ??= readdirSync(projectsDir)
  for (const dir of projectDirNames) {
    const candidate = join(projectsDir, dir, file)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function readTail(path, bytes) {
  const size = statSync(path).size
  const start = Math.max(0, size - bytes)
  const length = size - start
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, length, start)
  } finally {
    closeSync(fd)
  }
  const lines = buffer.toString('utf8').split('\n')
  if (start > 0) lines.shift()
  return { lines, size }
}

function textOfUser(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return undefined
  const content = entry.message?.content
  let text
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    if (content.some(block => block?.type === 'tool_result')) return undefined
    text = content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
  }
  if (!text) return undefined
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('[SYSTEM NOTIFICATION')) return undefined
  if (trimmed.startsWith('This session is being continued')) return undefined
  return trimmed
}

function textOfAssistant(entry) {
  if (entry.type !== 'assistant' || entry.isSidechain) return undefined
  const content = entry.message?.content
  if (!Array.isArray(content)) return undefined
  const text = content.filter(block => block?.type === 'text').map(block => block.text).join('\n').trim()
  return text || undefined
}

function cut(text, max = SNIPPET) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function parseLines(lines) {
  const out = []
  for (const line of lines) {
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}

function findTitleFull(path) {
  const text = readFileSync(path, 'utf8')
  const custom = [...text.matchAll(/"customTitle":"((?:[^"\\]|\\.)*)"/g)]
  const matches = custom.length > 0 ? custom : [...text.matchAll(/"aiTitle":"((?:[^"\\]|\\.)*)"/g)]
  if (matches.length === 0) return undefined
  return JSON.parse(`"${matches.at(-1)[1]}"`)
}

function summarize(path, cached) {
  const { lines, size } = readTail(path, TAIL_BYTES)
  const entries = parseLines(lines)
  let aiTitle
  let customTitle
  let lastUser
  let lastAssistant
  let lastAt
  let model
  let contextTokens
  let branch
  let workItem
  let assistantItem
  const pending = new Map()
  const now = Date.now()
  const activity = new Array(ACTIVITY_BINS).fill(0)
  const events = []
  for (const entry of entries) {
    for (const event of eventsOf(entry)) events.push(event)
    const stamp = entry.timestamp ? Date.parse(entry.timestamp) : NaN
    if (!Number.isNaN(stamp) && (entry.type === 'assistant' || entry.type === 'user')) {
      const bin = ACTIVITY_BINS - 1 - Math.floor((now - stamp) / ACTIVITY_BIN_MS)
      if (bin >= 0 && bin < ACTIVITY_BINS) activity[bin]++
    }
    if (entry.type === 'assistant' && !entry.isSidechain && entry.message?.usage) {
      const usage = entry.message.usage
      const total = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
      if (total > 0) contextTokens = total
      if (entry.message.model && entry.message.model !== '<synthetic>') model = entry.message.model
    }
    if (entry.type === 'ai-title' && entry.aiTitle) aiTitle = entry.aiTitle
    if (entry.type === 'custom-title' && entry.customTitle) customTitle = entry.customTitle
    if (entry.gitBranch) branch = entry.gitBranch
    const user = textOfUser(entry)
    if (user) {
      const mentioned = itemsIn(user)
      if (mentioned.length) workItem = mentioned.at(-1)
      lastUser = user
      lastAt = entry.timestamp ?? lastAt
    }
    const assistant = textOfAssistant(entry)
    if (assistant) {
      const said = itemsIn(assistant)
      if (said.length) assistantItem = said.at(-1)
      lastAssistant = assistant
      lastAt = entry.timestamp ?? lastAt
    }
    if (entry.isSidechain) continue
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : []
    if (entry.type === 'assistant') {
      for (const block of blocks) {
        if (block?.type === 'tool_use' && block.id) pending.set(block.id, { name: block.name, input: block.input ?? {}, at: entry.timestamp })
      }
    }
    if (entry.type === 'user') {
      for (const block of blocks) {
        if (block?.type === 'tool_result' && block.tool_use_id) pending.delete(block.tool_use_id)
      }
    }
  }
  const open = [...pending.values()]
  const asking = open.findLast(call => call.name === 'AskUserQuestion')
  const question = asking ? questionsOf(asking.input) : undefined
  const pendingTool = open.findLast(call => call.name !== 'AskUserQuestion')
  const waitingOnPerson = Boolean(question)
  let title = customTitle
  if (!title && cached?.isCustom) title = cached.title
  if (!title) title = aiTitle
  if (!title && cached?.size === size) title = cached.title
  if (!title) title = findTitleFull(path)
  const isCustom = Boolean(customTitle) || Boolean(cached?.isCustom && title === cached.title)
  return {
    title,
    isCustom,
    lastUser,
    lastAssistant,
    lastAt,
    size,
    waitingOnPerson,
    question,
    pendingTool: pendingTool ? { name: pendingTool.name, summary: toolSummary(pendingTool), at: pendingTool.at } : undefined,
    events: events.slice(-400),
    model,
    contextTokens,
    activity,
    branch,
    workItem: workItem ?? assistantItem ?? (branch ? BRANCH_ITEM.exec(branch)?.[1] : undefined) ?? (title ? itemsIn(title)[0] : undefined),
  }
}

function readDirJson(dir, sessionId) {
  return readJson(join(dir, `${sessionId}.json`), undefined)
}

function normalizePath(path) {
  return String(path).replace(/\\/g, '/').replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`).toLowerCase()
}

const repoCache = new Map()
function gitRoot(cwd) {
  const key = normalizePath(cwd)
  if (repoCache.has(key)) return repoCache.get(key)
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 3000 })
  if (result.status !== 0) return result.stderr && /not a git repository/i.test(result.stderr) ? (repoCache.set(key, null), null) : null
  const root = result.stdout.trim()
  repoCache.set(key, root)
  return root
}

let collisionCache = { at: 0, value: [] }
export function collisions(sessions) {
  if (Date.now() - collisionCache.at < 10_000) return collisionCache.value
  const byRepo = new Map()
  for (const session of sessions) {
    const root = session.cwd ? gitRoot(session.cwd) : null
    if (!root) continue
    const list = byRepo.get(root) ?? []
    list.push(session)
    byRepo.set(root, list)
  }
  const repos = []
  for (const [root, members] of byRepo) {
    const status = spawnSync('git', ['-C', root, '--no-optional-locks', '-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8', timeout: 4000 })
    if (status.status !== 0) {
      const previous = collisionCache.value.find(one => one.root === root)
      if (previous) repos.push(previous)
      continue
    }
    const touchedBy = new Map()
    for (const session of members) {
      const touches = readDirJson(touchesDir, session.sessionId)?.files ?? {}
      for (const [file, at] of Object.entries(touches)) {
        const key = normalizePath(file)
        const list = touchedBy.get(key) ?? []
        list.push({ sessionId: session.sessionId, at })
        touchedBy.set(key, list)
      }
    }
    const files = []
    for (const line of status.stdout.split(/\r?\n/)) {
      if (line.length < 4) continue
      const code = line.slice(0, 2).trim()
      const rel = line.slice(3).replace(/^"|"$/g, '').split(' -> ').at(-1)
      const by = touchedBy.get(normalizePath(`${root}/${rel}`)) ?? []
      files.push({ path: rel, code, sessions: by.sort((a, b) => b.at - a.at) })
    }
    files.sort((a, b) => b.sessions.length - a.sessions.length || a.path.localeCompare(b.path))
    repos.push({ root, name: root.split('/').at(-1), sessions: members.map(one => one.sessionId), files })
  }
  collisionCache = { at: Date.now(), value: repos }
  return repos
}

export function ledger(limit = 400) {
  if (!existsSync(ledgerDir)) return []
  const entries = []
  for (const name of readdirSync(ledgerDir)) {
    if (!name.endsWith('.jsonl')) continue
    try {
      for (const line of readFileSync(join(ledgerDir, name), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          entries.push(JSON.parse(line))
        } catch {}
      }
    } catch {}
  }
  entries.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return entries.slice(0, limit)
}

export function readBrief(sessionId) {
  return readDirJson(briefsDir, sessionId)
}

function readPending(sessionId) {
  const saved = readJson(join(pendingDir, `${sessionId}.json`), undefined)
  return Array.isArray(saved?.items) ? saved.items : []
}

const agentCache = new Map()

function agentActivity(path, size) {
  const cached = agentCache.get(path)
  if (cached?.size === size) return cached.value
  const value = scanAgent(path)
  agentCache.set(path, { size, value })
  return value
}

function scanAgent(path) {
  const { lines } = readTail(path, AGENT_TAIL_BYTES)
  let lastTool
  let lastText
  let toolCount = 0
  let model
  for (const entry of parseLines(lines)) {
    if (entry.type !== 'assistant') continue
    if (entry.message?.model) model = entry.message.model
    for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (block?.type === 'tool_use') {
        toolCount++
        lastTool = { name: block.name, summary: toolSummary({ input: block.input }), at: entry.timestamp }
      }
      if (block?.type === 'text' && block.text?.trim()) lastText = cut(block.text, 240)
    }
  }
  return { lastTool, lastText, toolCount, model }
}

/** The model an agent ran on: from its own replies; the meta file's `pickedEffortModel` is the parent's, used only to pick effort. */
function agentModel(ranOn, meta) {
  return ranOn ?? meta.model ?? meta.pickedEffortModel
}

export function sessionAgents(transcript) {
  if (!transcript) return []
  const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents')
  if (!existsSync(dir)) return []
  const now = Date.now()
  const agents = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.meta.json')) continue
    const log = join(dir, name.replace(/\.meta\.json$/, '.jsonl'))
    let mtime = 0
    let size = 0
    try {
      const info = statSync(log)
      mtime = info.mtimeMs
      size = info.size
    } catch {
      continue
    }
    const meta = readJson(join(dir, name), {})
    if (meta.finished && now - mtime > AGENT_RECENT_MS) continue
    const state = agentState(meta, mtime, now)
    const activity = agentActivity(log, size)
    agents.push({
      id: name.replace(/^agent-|\.meta\.json$/g, ''),
      type: meta.agentType,
      description: meta.description,
      isBackground: meta.requestShape === 'background',
      state,
      updatedAt: mtime,
      size,
      ...activity,
      model: agentModel(activity.model, meta),
    })
  }
  agents.sort((a, b) => (a.state === 'done') - (b.state === 'done') || b.updatedAt - a.updatedAt)
  return agents.slice(0, 16)
}

function agentState(meta, mtime, now) {
  return meta.finished ? 'done' : now - mtime > AGENT_STALE_MS ? 'stalled' : 'running'
}

function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

/** One subagent's run as steps (its prompt, what it said, which tools it called and what came back), for the live view. */
export function agentDetail(sessionId, agentId, count = 40) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(agentId))) return undefined
  const reg = findRegistration(sessionId)
  const transcript = findTranscript(reg?.cwd ?? '', sessionId)
  if (!transcript) return undefined
  const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents')
  const log = join(dir, `agent-${agentId}.jsonl`)
  if (!existsSync(log)) return undefined
  const meta = readJson(join(dir, `agent-${agentId}.meta.json`), {})
  const { mtimeMs } = statSync(log)
  const { lines } = readTail(log, AGENT_TAIL_BYTES)
  const steps = []
  let prompt
  let ranOn
  for (const entry of parseLines(lines)) {
    const content = entry.message?.content
    if (entry.type === 'assistant' && entry.message?.model) ranOn = entry.message.model
    if (entry.type === 'user') {
      if (typeof content === 'string') {
        prompt ??= cut(content, 1200)
        continue
      }
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'tool_result') steps.push({ kind: 'result', at: entry.timestamp, text: cut(resultText(block.content), 300), isError: Boolean(block.is_error) })
        else if (block?.type === 'text' && block.text?.trim()) prompt ??= cut(block.text, 1200)
      }
      continue
    }
    if (entry.type !== 'assistant') continue
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === 'tool_use') steps.push({ kind: 'tool', at: entry.timestamp, name: block.name, text: toolSummary({ input: block.input }) })
      else if (block?.type === 'text' && block.text?.trim()) steps.push({ kind: 'text', at: entry.timestamp, text: cut(block.text, 2000) })
    }
  }
  return {
    sessionId,
    agentId,
    type: meta.agentType,
    description: meta.description,
    model: agentModel(ranOn, meta),
    effort: meta.effort,
    isBackground: meta.requestShape === 'background',
    state: agentState(meta, mtimeMs, Date.now()),
    updatedAt: mtimeMs,
    prompt,
    steps: steps.slice(-count),
  }
}

function questionsOf(input) {
  const list = Array.isArray(input?.questions) ? input.questions : []
  return list.map(one => ({
    question: String(one?.question ?? ''),
    header: one?.header ? String(one.header) : undefined,
    multiSelect: Boolean(one?.multiSelect),
    options: (Array.isArray(one?.options) ? one.options : []).map(option => ({
      label: String(option?.label ?? ''),
      description: option?.description ? String(option.description) : undefined,
    })),
  }))
}

function toolSummary(call) {
  const input = call.input ?? {}
  const text = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.description ?? input.prompt ?? ''
  return cut(String(text), 300)
}

export function collectSessions() {
  const titleCache = readJson(titleCachePath, {})
  const sessions = []
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith('.json')) continue
    const reg = readJson(join(sessionsDir, name), undefined)
    if (!reg?.sessionId || !isAlive(reg.pid)) continue
    const transcript = findTranscript(reg.cwd, reg.sessionId)
    const live = readPending(reg.sessionId).filter(item => item.kind !== 'permission' || reg.status === 'waiting')
    let info = {}
    if (transcript) {
      try {
        info = summarize(transcript, titleCache[reg.sessionId])
        if (info.title) titleCache[reg.sessionId] = { title: info.title, size: info.size, isCustom: info.isCustom }
      } catch {}
    }
    sessions.push({
      sessionId: reg.sessionId,
      pid: reg.pid,
      name: reg.name,
      nameSource: reg.nameSource,
      cwd: reg.cwd,
      kind: reg.kind,
      entrypoint: reg.entrypoint,
      status: reg.status,
      statusUpdatedAt: reg.statusUpdatedAt,
      startedAt: reg.startedAt,
      transcript,
      title: info.title,
      lastUser: info.lastUser ? cut(info.lastUser, 240) : undefined,
      lastAssistant: info.lastAssistant ? cut(info.lastAssistant, 240) : undefined,
      lastAt: info.lastAt,
      waitingOnPerson: Boolean(info.waitingOnPerson) || reg.status === 'waiting' || live.some(item => item.kind === 'question'),
      waitingFor: reg.waitingFor,
      question: info.question,
      pendingTool: reg.status === 'waiting' && !info.question ? info.pendingTool : undefined,
      currentTool: reg.status === 'busy' ? info.pendingTool : undefined,
      live,
      hasHubMod: existsSync(join(pendingDir, `${reg.sessionId}.json`)),
      model: info.model,
      contextTokens: info.contextTokens,
      activity: info.activity,
      agents: sessionAgents(transcript),
      branch: info.branch,
      workItem: info.workItem,
      brief: readDirJson(briefsDir, reg.sessionId),
      usage: readDirJson(usageDir, reg.sessionId),
      events: info.events ?? [],
    })
  }
  mkdirSync(hubDir, { recursive: true })
  writeFileSync(titleCachePath, JSON.stringify(titleCache))
  sessions.sort((a, b) => (b.statusUpdatedAt ?? 0) - (a.statusUpdatedAt ?? 0))
  const summary = sessions.map(one => ({ sessionId: one.sessionId, status: one.status, waitingOnPerson: one.waitingOnPerson }))
  writeFileSync(join(hubDir, 'summary.json'), JSON.stringify({ at: Date.now(), sessions: summary }))
  return sessions
}

export function sessionTitle(sessionId) {
  return readJson(titleCachePath, {})[sessionId]?.title
}

export function forkName(title, fallback) {
  const clean = String(title || fallback || 'session').replace(/[&|<>^"%!;\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim()
  const name = `Fork: ${clean}`
  return name.length > 80 ? `${name.slice(0, 79)}…` : name
}

export function findRegistration(sessionId) {
  return readdirSync(sessionsDir)
    .filter(name => name.endsWith('.json'))
    .map(name => readJson(join(sessionsDir, name), undefined))
    .find(one => one?.sessionId === sessionId)
}

export function sessionDetail(sessionId, count, options = {}) {
  const reg = findRegistration(sessionId)
  const transcript = findTranscript(reg?.cwd ?? '', sessionId)
  if (!transcript) return { sessionId, messages: [] }
  const { lines } = readTail(transcript, TAIL_BYTES)
  const shape = options.full ? text => (text.length > FULL ? `${text.slice(0, FULL - 1)}…` : text) : text => cut(text)
  const messages = []
  for (const entry of parseLines(lines)) {
    const user = textOfUser(entry)
    if (user) messages.push({ role: 'user', at: entry.timestamp, text: shape(user) })
    const assistant = textOfAssistant(entry)
    if (assistant) messages.push({ role: 'assistant', at: entry.timestamp, text: shape(assistant) })
  }
  return { sessionId, cwd: reg?.cwd, kind: reg?.kind, messages: messages.slice(-count) }
}

