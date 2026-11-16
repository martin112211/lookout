import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { On } from './on'

import type { HubAgentDetail, HubBrief, HubDetail, HubLedgerEntry, HubLiveItem, HubSession } from '../types'
import { CLASSIFIER_MODES, EFFORT_CHOICES, FEATURE_LABELS, applyProfile, MODEL_CHOICES, TIERS, draftRoute, routeAgent, routeTier } from './settings'
import { classifiedTier, modelRank, nextEffortUp, nextModelUp } from './routing'
import type { RouteDecision, RouteInput } from './routing'
import { isSameDecision } from './decisions'
import { LEGACY_DATA_DIRS, homeDir, hubFile, loadConfig, platform, saveConfig } from './config'
import { browserArgv, tabArgv, tabName } from './terminal'
import type { TabRequest } from './terminal'
import { gitAfterTool, gitStart, gitTurn } from './git-pane'
import { recapStart } from './recap'
import { statusAfterTool, statusStart, statusTurn } from './status'
import type { ClassifierMode, EffortChoice, HubConfig, Profile, ModelChoice, Tier } from './settings'

export const PANE = 'lookout'
const REFRESH_MS = 30_000
const RELAY_MAX_AGE_MS = 5 * 60_000
const RELAY_HEADER = /\[(?:lookout relay: typed by the owner on the Lookout page|docket relay: typed by the owner on the Docket page|session-hub relay: typed by the user on the hub page); ts=(\d+) sig=([0-9a-f]{64})\]\n/
const DETAIL_COUNT = 8

export const sessions = atom({ plugin: 'lookout', key: 'sessions' } as const, [], { shape: 'sessions-1' })
export const refreshedAt = atom({ plugin: 'lookout', key: 'refreshedAt' } as const, 0)
export const selected = atom({ plugin: 'lookout', key: 'selected' } as const, null)
export const detail = atom({ plugin: 'lookout', key: 'detail' } as const, null, { shape: 'detail-1' })
export const ownBrief = atom({ plugin: 'lookout', key: 'ownBrief' } as const, null as HubBrief | null)
export const agentView = atom({ plugin: 'lookout', key: 'agentView' } as const, null as HubAgentDetail | null, { shape: 'agent-1' })
export const notice = atom({ plugin: 'lookout', key: 'notice' } as const, null)
export const selfId = atom({ plugin: 'lookout', key: 'selfId' } as const, null)


export function age(fromMs: number | undefined, nowMs: number): string {
  if (!fromMs) return ''
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? cwd
}

export function label(session: HubSession): string {
  return session.title || session.name
}

export function forkName(session: HubSession): string {
  const clean = label(session).replace(/[&|<>^"%!;\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim()
  const name = `Fork: ${clean}`
  return name.length > 80 ? `${name.slice(0, 79)}…` : name
}

export function fit(text: string, columns: number): string {
  if (columns <= 1) return ''
  return text.length > columns ? `${text.slice(0, columns - 1)}…` : text
}

let collecting = false

let lastCollectAt = 0

export async function collect($: EngineInterface): Promise<void> {
  if (collecting) return
  const startedAt = await $.clock.now()
  if (startedAt - lastCollectAt < 5_000) return
  lastCollectAt = startedAt
  collecting = true
  try {
    const result = await $.process.run(['bun', '--no-install', `${$.plugin.root}/scripts/collect.mjs`], { timeoutMs: 20_000 })
    if (result.exitCode !== 0) {
      await update($, notice, () => `Collector failed: ${result.stderr.slice(0, 200)}`)
      return
    }
    const list = JSON.parse(result.stdout) as HubSession[]
    await update($, sessions, () => list)
    const open = await read($, agentView)
    if (open && open.state !== 'done') await loadAgent($, open.sessionId, open.agentId)
    const now = await $.clock.now()
    await update($, refreshedAt, () => now)
  } catch (error) {
    await update($, notice, () => `Collector error: ${String(error).slice(0, 200)}`)
  } finally {
    collecting = false
  }
}

async function migrateLegacyData($: EngineInterface): Promise<void> {
  try {
    const home = await homeDir($)
    if (!home) return
    let isFound = false
    for (const dir of LEGACY_DATA_DIRS) if (await $.fs.exists(`${home}/.claude/${dir}`)) isFound = true
    if (!isFound) return
    await $.process.run(['bun', '--no-install', `${$.plugin.root}/scripts/collect.mjs`, '--migrate'], { timeoutMs: 20_000 })
  } catch {}
}

/** One subagent's live steps for the pane; null closes the view. */
export async function loadAgent($: EngineInterface, sessionId: string, agentId: string | null): Promise<void> {
  if (!agentId) {
    await update($, agentView, () => null)
    return
  }
  const result = await $.process.run(['bun', '--no-install', `${$.plugin.root}/scripts/collect.mjs`, '--agent', sessionId, agentId, '12'], { timeoutMs: 20_000 })
  if (result.exitCode !== 0) {
    await update($, notice, () => `Agent failed: ${result.stderr.slice(0, 200)}`)
    return
  }
  const value = JSON.parse(result.stdout) as HubAgentDetail | null
  await update($, agentView, () => value)
}

export async function loadDetail($: EngineInterface, sessionId: string): Promise<void> {
  const result = await $.process.run(
    ['bun', '--no-install', `${$.plugin.root}/scripts/collect.mjs`, '--detail', sessionId, String(DETAIL_COUNT)],
    { timeoutMs: 20_000 },
  )
  if (result.exitCode !== 0) {
    await update($, notice, () => `Detail failed: ${result.stderr.slice(0, 200)}`)
    return
  }
  const value = JSON.parse(result.stdout) as HubDetail
  await update($, detail, () => value)
}

export async function select($: EngineInterface, sessionId: string | null): Promise<void> {
  await update($, selected, () => sessionId)
  await update($, detail, () => null)
  await update($, agentView, () => null)
  await update($, notice, () => null)
  if (sessionId) await loadDetail($, sessionId)
}

export async function openTab($: EngineInterface, request: TabRequest, what: string): Promise<void> {
  try {
    const os = await platform($)
    const terminal = await $.env.get('TERM_PROGRAM')
    const result = await $.process.run(tabArgv(os, terminal, request), { timeoutMs: 10_000 })
    await update($, notice, () => (result.exitCode === 0 ? `${what}: new ${tabName(os, terminal)} opened` : `${what} failed: ${result.stderr.slice(0, 200)}`))
  } catch (error) {
    await update($, notice, () => `${what} failed: ${String(error).slice(0, 200)}`)
  }
}

type ServerInfo = { port: number; token: string; url: string }

let server: ServerInfo | null = null
let serverChild = false
let polling = false
let nextServerCheckAt = 0
let relayKey: string | null = null
const relayedSignatures = new Set<string>()

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function loadRelayKey($: EngineInterface): Promise<string | null> {
  if (relayKey) return relayKey
  const path = await hubFile($, 'relay.key')
  if (!path) return null
  try {
    const saved = (await $.fs.read(path)).trim()
    if (/^[0-9a-f]{64}$/.test(saved)) {
      relayKey = saved
      return saved
    }
  } catch {}
  const fresh = toHex(crypto.getRandomValues(new Uint8Array(32)).buffer)
  await $.fs.write(path, fresh)
  relayKey = fresh
  return fresh
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<ArrayBuffer> {
  const block = new Uint8Array(64)
  block.set(key.length > 64 ? new Uint8Array(await crypto.subtle.digest('SHA-256', key)) : key)
  const inner = block.map(byte => byte ^ 0x36)
  const outer = block.map(byte => byte ^ 0x5c)
  const innerHash = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(inner, message)))
  return crypto.subtle.digest('SHA-256', concat(outer, innerHash))
}

async function sign(key: string, ts: string, body: string): Promise<string> {
  const raw = new Uint8Array((key.match(/../g) ?? []).map(pair => parseInt(pair, 16)))
  return toHex(await hmacSha256(raw, new TextEncoder().encode(`${ts}\n${body}`)))
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

async function relayText($: EngineInterface, body: string): Promise<string> {
  const key = await loadRelayKey($)
  if (!key) return body
  const ts = String(await $.clock.now())
  const sig = await sign(key, ts, body)
  return `[lookout relay: typed by the owner on the Lookout page; ts=${ts} sig=${sig}]\n${body}`
}

async function verifiedRelayBody($: EngineInterface, text: string): Promise<string | null> {
  const match = RELAY_HEADER.exec(text)
  if (!match) return null
  const [header, ts, sig] = match
  if (!ts || !sig || relayedSignatures.has(sig)) return null
  const now = await $.clock.now()
  if (Math.abs(now - Number(ts)) > RELAY_MAX_AGE_MS) return null
  const key = await loadRelayKey($)
  if (!key) return null
  const rest = text.slice(match.index + header.length)
  const candidates = [rest, rest.replace(/\s*<\/[A-Za-z][\w-]*>\s*$/, '')]
  for (const body of candidates) {
    if (sameHex(await sign(key, ts, body), sig)) {
      relayedSignatures.add(sig)
      return body
    }
  }
  return null
}

async function readServerInfo($: EngineInterface): Promise<ServerInfo | null> {
  const path = await hubFile($, 'server.json')
  if (!path) return null
  try {
    const saved = JSON.parse(await $.fs.read(path)) as ServerInfo
    return saved.token && saved.url ? saved : null
  } catch {
    return null
  }
}

async function isServerUp($: EngineInterface, info: ServerInfo | null): Promise<boolean> {
  if (!info) return false
  try {
    const response = await $.http.fetch(`http://127.0.0.1:${info.port}/api/ping`, { headers: { 'x-lookout-token': info.token } })
    return response.ok
  } catch {
    return false
  }
}

async function ensureServer($: EngineInterface): Promise<ServerInfo | null> {
  const known = await readServerInfo($)
  if (await isServerUp($, known)) {
    server = known
    return known
  }
  if (!serverChild) {
    serverChild = true
    const child = $.process.spawn({ argv: ['bun', '--no-install', `${$.plugin.root}/scripts/server.mjs`] })
    void (async () => {
      try {
        for await (const piece of child) void piece
      } catch {}
      serverChild = false
    })()
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    await $.clock.sleep(250)
    const info = await readServerInfo($)
    if (await isServerUp($, info)) {
      server = info
      return info
    }
  }
  return null
}

export async function openBrowser($: EngineInterface): Promise<void> {
  const info = await ensureServer($)
  if (!info) {
    await update($, notice, () => 'Lookout server did not start')
    return
  }
  await $.process.run(browserArgv(await platform($), info.url), { timeoutMs: 10_000 })
  await update($, notice, () => `Lookout opened in the browser: http://127.0.0.1:${info.port}`)
}

async function deliver(
  $: EngineInterface,
  me: string | null,
  item: { sessionId: string; name?: string; text: string },
): Promise<{ isDelivered: boolean; reason?: string }> {
  if (item.sessionId === me) {
    await $.prompt.submit({ text: `Message from the Lookout page:

${item.text}` })
    return { isDelivered: true }
  }
  const text = await relayText($, item.text)
  const byId = await $.session.send({ to: { sessionId: item.sessionId }, text })
  if (byId.isDelivered || !item.name) return byId
  const byName = await $.session.send({ to: item.name, text })
  return byName.isDelivered ? byName : { isDelivered: false, reason: `${byId.reason} / by name: ${byName.reason}` }
}

async function pollOutbox($: EngineInterface): Promise<void> {
  if (polling) return
  if (!server) {
    const now = await $.clock.now()
    if (now < nextServerCheckAt) return
    nextServerCheckAt = now + 30_000
    const info = await readServerInfo($)
    if (!(await isServerUp($, info))) return
    server = info
  }
  if (!server) return
  polling = true
  try {
    const me = await read($, selfId)
    const base = `http://127.0.0.1:${server.port}`
    const headers = { 'x-lookout-token': server.token, 'content-type': 'application/json' }
    const response = await $.http.fetch(`${base}/api/outbox/claim`, { method: 'POST', headers, body: JSON.stringify({ by: me }) })
    if (!response.ok) return
    const items = JSON.parse(response.text) as { id: string; sessionId: string; name?: string; text: string }[]
    for (const item of items) {
      const result = await deliver($, me, item)
      await $.http.fetch(`${base}/api/outbox/result`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: item.id, isDelivered: result.isDelivered, reason: result.reason }),
      })
    }
  } catch {
    server = null
  } finally {
    polling = false
  }
}

type PendingItem = {
  id: string
  kind: 'question' | 'permission' | 'plan'
  tool: string
  at: number
  questions?: unknown[]
  summary?: string
  agentId?: string
}

type HubAnswer = { answers: Record<string, string>; response?: string }

const pendingItems = new Map<string, PendingItem>()

function inputSummary(input: unknown): string {
  const value = (input ?? {}) as Record<string, unknown>
  const text = value.command ?? value.file_path ?? value.url ?? value.pattern ?? value.description ?? value.prompt ?? value.plan ?? ''
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > 400 ? `${flat.slice(0, 399)}…` : flat
}

async function writePending($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  const path = await hubFile($, 'pending', `${id}.json`)
  if (!path) return
  const at = await $.clock.now()
  await $.fs.write(path, JSON.stringify({ sessionId: id, at, items: [...pendingItems.values()] }))
}

async function setPending($: EngineInterface, item: PendingItem | null, removeId?: string): Promise<void> {
  if (item) pendingItems.set(item.id, item)
  if (removeId) pendingItems.delete(removeId)
  await writePending($).catch(() => undefined)
}

async function clearPermissions($: EngineInterface, tool?: string): Promise<void> {
  let changed = false
  for (const [id, item] of pendingItems) {
    if (item.kind === 'permission' && (!tool || item.tool === tool)) {
      pendingItems.delete(id)
      changed = true
    }
  }
  if (changed) await writePending($).catch(() => undefined)
}

async function claimAnswer($: EngineInterface, sessionId: string, questionId: string): Promise<HubAnswer | null> {
  const info = server ?? (await readServerInfo($))
  if (!info) return null
  try {
    const response = await $.http.fetch(`http://127.0.0.1:${info.port}/api/answer/claim`, {
      method: 'POST',
      headers: { 'x-lookout-token': info.token, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, questionId }),
    })
    if (!response.ok) return null
    const value = JSON.parse(response.text) as { answer?: HubAnswer | null }
    return value.answer ?? null
  } catch {
    return null
  }
}

async function waitForHubAnswer($: EngineInterface, questionId: string, isDone: () => boolean): Promise<HubAnswer | null> {
  const me = await $.session.id()
  while (!isDone()) {
    const answer = await claimAnswer($, me, questionId)
    if (answer && !isDone()) return answer
    await $.clock.sleep(1500)
  }
  return null
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const TOUCH_KEEP_MS = 24 * 60 * 60_000
const ASK_PANE = 'lookout-ask'
const BRIEF_SYSTEM = `You keep a short brief of one Claude Code working session for its owner, who runs many sessions in parallel and loses track when a conversation is compacted.
Read the previous brief and the recent conversation. Answer with ONE JSON object and nothing else:
{"goal": "...", "decided": ["..."], "next": "...", "blocked": "..."}
- goal: what this session is for, one sentence, at most 140 characters.
- decided: decisions the owner made or confirmed (answers, approvals, rules, scope calls), oldest first, at most 8 items of at most 140 characters. Keep items of the previous brief unless the owner reversed them. Never list work Claude merely did.
- next: the concrete next step, one sentence.
- blocked: what the session waits for from the owner, or "" when nothing.
Write in the language the owner writes in. No markdown.`

const askDraft = atom({ plugin: 'lookout', key: 'askDraft' } as const, {})
const settingsTick = atom({ plugin: 'lookout', key: 'settingsTick' } as const, 0)
const SETTINGS_PANE = 'lookout-settings'

const PROFILE_HELP: Record<Profile, string> = {
  quality: 'never weaker than the session; more effort only for hard work',
  balanced: 'session model, effort by task; haiku only for pure lookups',
  economy: 'sonnet for implementation, haiku for lookups, opus for hard work',
  custom: 'your own values below',
}

function nextProfile(current: Profile): Profile {
  const order: Profile[] = ['quality', 'balanced', 'economy']
  return order[(order.indexOf(current) + 1) % order.length] ?? 'quality'
}

function nextEffort(current: EffortChoice): EffortChoice {
  const index = EFFORT_CHOICES.indexOf(current)
  return EFFORT_CHOICES[(index + 1) % EFFORT_CHOICES.length] ?? 'inherit'
}

function nextClassifier(current: ClassifierMode): ClassifierMode {
  const index = CLASSIFIER_MODES.indexOf(current)
  return CLASSIFIER_MODES[(index + 1) % CLASSIFIER_MODES.length] ?? 'unsure'
}

function nextModel(current: ModelChoice): ModelChoice {
  const index = MODEL_CHOICES.indexOf(current)
  return MODEL_CHOICES[(index + 1) % MODEL_CHOICES.length] ?? 'inherit'
}

async function changeSettings($: EngineInterface, change: (config: HubConfig) => HubConfig): Promise<void> {
  await saveConfig($, change)
  await update($, settingsTick, tick => tick + 1)
}

type FeatureKey = keyof HubConfig['features']

function featureDetail(config: HubConfig, key: FeatureKey): string {
  const f = config.features
  if (key === 'brief') return `${f.brief.model}, every ${f.brief.everySec} s`
  if (key === 'radar') return `${f.radar.windowHours} h window`
  if (key === 'leases') return `wait ${f.leases.waitMin} min${f.leases.commit ? ', commit' : ''}${f.leases.integration ? ', integration' : ''}`
  if (key === 'budgetGuard') return `at ${f.budgetGuard.percent} % weekly`
  return ''
}

let askPaneUntil = 0
let briefRunning = false
let lastBriefAt = 0
let ledgerEntries: HubLedgerEntry[] | null = null
let touchesLoaded = false
const touches = new Map<string, number>()
const warnedClashes = new Set<string>()

const CLASSIFY_LABELS: Record<string, Tier> = {
  'light: read-only search, lookup or summary': 'light',
  'standard: normal implementation, tests or docs in one or two files': 'standard',
  'deep: architecture, security, debugging across files, migrations or reviewing complex changes': 'deep',
}

function shortModel(model: string | undefined): string | null {
  return /(haiku|sonnet|opus|fable)/i.exec(model ?? '')?.[1]?.toLowerCase() ?? model ?? null
}

let sessionEffort: string | undefined

async function currentEffort($: EngineInterface): Promise<string | undefined> {
  const fromEnv = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')
  if (fromEnv) return fromEnv
  if (sessionEffort) return sessionEffort
  try {
    const saved = await $.settings.read({ key: 'effortLevel' })
    return typeof saved === 'string' ? saved : undefined
  } catch {
    return undefined
  }
}

async function classifyTier($: EngineInterface, description: string, prompt: string): Promise<Tier | undefined> {
  const text = `Task given to a coding subagent.\nDescription: ${description}\n\n${prompt.slice(0, 2500)}`
  const answer = await Promise.race([
    $.model.classify(text, Object.keys(CLASSIFY_LABELS), { model: 'haiku' }).catch(() => undefined),
    $.clock.sleep(5000).then(() => undefined),
  ])
  const tier = answer ? CLASSIFY_LABELS[answer] : undefined
  return tier && (TIERS as readonly string[]).includes(tier) ? tier : undefined
}

/** Background agents' route, kept until their run ends: their outcome is logged then. */
const pendingOutcomes = new Map<string, Record<string, unknown>>()

async function logRoute($: EngineInterface, entry: Record<string, unknown>): Promise<void> {
  const path = await hubFile($, 'routing.jsonl')
  if (!path) return
  let lines: string[] = []
  try {
    lines = (await $.fs.read(path)).split('\n').filter(Boolean)
  } catch {}
  lines.push(JSON.stringify(entry))
  await $.fs.write(path, `${lines.slice(-400).join('\n')}\n`)
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function normalizeFile(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

async function addLedger($: EngineInterface,entry: { kind: HubLedgerEntry['kind']; text: string; question?: string }): Promise<void> {
  if (!(await loadConfig($)).features.ledger.on) return
  const me = await $.session.id()
  const path = await hubFile($, 'ledger', `${me}.jsonl`)
  if (!path) return
  if (ledgerEntries === null) {
    try {
      ledgerEntries = (await $.fs.read(path))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as HubLedgerEntry)
    } catch {
      ledgerEntries = []
    }
  }
  if (entry.kind === 'decision' && ledgerEntries.some(one => one.kind === 'decision' && isSameDecision(one.text, entry.text))) return
  const list = await read($, sessions)
  const title = list.find(one => one.sessionId === me)?.title
  const cwd = await $.session.cwd().catch(() => undefined)
  ledgerEntries.push({ at: await $.clock.now(), sessionId: me, title, cwd, ...entry })
  if (ledgerEntries.length > 300) ledgerEntries = ledgerEntries.slice(-300)
  await $.fs.write(path, `${ledgerEntries.map(one => JSON.stringify(one)).join('\n')}\n`)
}

async function recordAnswers($: EngineInterface, answers: Record<string, unknown>): Promise<void> {
  try {
    for (const [question, answer] of Object.entries(answers)) {
      const text = clip(String(answer ?? ''), 600)
      if (text) await addLedger($, { kind: 'answer', question: clip(question, 400), text })
    }
  } catch {}
}

async function updateBrief($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const settings = (await loadConfig($)).features.brief
  if (!settings.on || briefRunning || now - lastBriefAt < settings.everySec * 1000) return
  briefRunning = true
  lastBriefAt = now
  try {
    const me = await $.session.id()
    const run = await $.process.run(['bun', '--no-install', `${$.plugin.root}/scripts/collect.mjs`, '--brief-input', me], { timeoutMs: 20_000 })
    if (run.exitCode !== 0) return
    const input = JSON.parse(run.stdout) as { messages: { role: string; text: string }[]; previous: HubBrief | null }
    if (input.messages.length === 0) return
    const transcript = input.messages.map(one => `${one.role === 'user' ? 'OWNER' : 'CLAUDE'}: ${one.text}`).join('\n\n')
    const reply = await $.model.complete({
      model: settings.model === 'inherit' ? 'haiku' : settings.model,
      system: BRIEF_SYSTEM,
      prompt: `Previous brief:\n${JSON.stringify(input.previous ?? {})}\n\nRecent conversation, oldest first:\n${transcript}`,
      maxTokens: 700,
    })
    if (!reply.isAnswered) return
    const match = /\{[\s\S]*\}/.exec(reply.text)
    if (!match) return
    const raw = JSON.parse(match[0]) as Record<string, unknown>
    const decided = (Array.isArray(raw.decided) ? raw.decided : []).map(one => clip(one, 160)).filter((one): one is string => Boolean(one)).slice(-8)
    const brief: HubBrief = { at: await $.clock.now(), goal: clip(raw.goal, 200), decided, next: clip(raw.next, 260), blocked: clip(raw.blocked, 260) }
    const path = await hubFile($, 'briefs', `${me}.json`)
    if (!path) return
    await $.fs.write(path, JSON.stringify(brief))
    await update($, ownBrief, () => brief)
    const before = new Set(input.previous?.decided ?? [])
    for (const text of decided.filter(one => !before.has(one))) await addLedger($, { kind: 'decision', text })
  } catch {
  } finally {
    briefRunning = false
  }
}

/** This session's brief from its file, for the line pinned above the prompt after a restart or resume. */
async function loadOwnBrief($: EngineInterface): Promise<void> {
  try {
    const me = await $.session.id()
    const path = await hubFile($, 'briefs', `${me}.json`)
    if (!path || !(await $.fs.exists(path))) return
    const brief = JSON.parse(await $.fs.read(path)) as HubBrief
    await update($, ownBrief, () => brief)
  } catch {}
}

async function briefContext($: EngineInterface): Promise<string | undefined> {
  try {
    if (!(await loadConfig($)).features.brief.on) return undefined
    const me = await $.session.id()
    const path = await hubFile($, 'briefs', `${me}.json`)
    if (!path) return undefined
    const brief = JSON.parse(await $.fs.read(path)) as HubBrief
    const lines = [
      'Session brief kept by Lookout, written before this compaction. Treat the decisions as the owner\'s and do not ask them again:',
      `- Goal: ${brief.goal ?? '-'}`,
      `- Decided: ${(brief.decided ?? []).join('; ') || '-'}`,
      `- Next: ${brief.next ?? '-'}`,
      `- Waiting for the owner: ${brief.blocked || '-'}`,
    ]
    return lines.join('\n')
  } catch {
    return undefined
  }
}

async function writeUsage($: EngineInterface): Promise<void> {
  const me = await $.session.id()
  const path = await hubFile($, 'usage', `${me}.json`)
  if (!path) return
  const usage = await $.session.usage()
  await $.fs.write(
    path,
    JSON.stringify({
      at: await $.clock.now(),
      rateLimits: (usage.rateLimits ?? []).map(one => ({ kind: one.kind, percentUsed: one.percentUsed, resetsAt: one.resetsAt })),
      contextTokens: usage.context?.tokens,
      contextPercent: usage.context?.percent,
      costUsd: usage.cost?.usd,
    }),
  )
}

async function weeklyPercent($: EngineInterface): Promise<number | undefined> {
  try {
    const dir = await hubFile($, 'usage')
    if (!dir) return undefined
    let newest: { at: number; rateLimits?: { kind: string; percentUsed: number }[] } | undefined
    for (const entry of await $.fs.list(dir)) {
      if (!entry.name.endsWith('.json')) continue
      try {
        const data = JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as typeof newest
        if (data?.rateLimits?.length && (!newest || data.at > newest.at)) newest = data
      } catch {}
    }
    if (!newest || (await $.clock.now()) - newest.at > 60 * 60_000) return undefined
    return newest.rateLimits?.find(one => one.kind === 'seven_day')?.percentUsed
  } catch {
    return undefined
  }
}

async function recordTouch($: EngineInterface, file: string): Promise<string | undefined> {
  const me = await $.session.id()
  const path = await hubFile($, 'touches', `${me}.json`)
  if (!path) return undefined
  if (!touchesLoaded) {
    touchesLoaded = true
    try {
      const saved = JSON.parse(await $.fs.read(path)) as { files?: Record<string, number> }
      for (const [name, at] of Object.entries(saved.files ?? {})) touches.set(name, at)
    } catch {}
  }
  const now = await $.clock.now()
  const windowMs = (await loadConfig($)).features.radar.windowHours * 60 * 60_000
  touches.set(file, now)
  for (const [name, at] of touches) if (now - at > TOUCH_KEEP_MS) touches.delete(name)
  const cwd = await $.session.cwd().catch(() => undefined)
  await $.fs.write(path, JSON.stringify({ sessionId: me, cwd, at: now, files: Object.fromEntries(touches) }))
  const key = normalizeFile(file)
  for (const other of await read($, sessions)) {
    if (other.sessionId === me) continue
    const otherPath = await hubFile($, 'touches', `${other.sessionId}.json`)
    if (!otherPath) continue
    let files: Record<string, number> = {}
    try {
      files = (JSON.parse(await $.fs.read(otherPath)) as { files?: Record<string, number> }).files ?? {}
    } catch {
      continue
    }
    for (const [name, at] of Object.entries(files)) {
      const marker = `${other.sessionId}:${key}`
      if (normalizeFile(name) !== key || now - at > windowMs || warnedClashes.has(marker)) continue
      warnedClashes.add(marker)
      const minutes = Math.max(1, Math.round((now - at) / 60_000))
      return `Lookout: the parallel session "${label(other)}" also edited ${file} ${minutes} min ago, possibly uncommitted. Check its hunks before you commit or overwrite them, and commit only your own hunks.`
    }
  }
  return undefined
}

type LeaseWant = { key: string; purpose: string; ttlMs: number }

async function leaseFor($: EngineInterface, command: string): Promise<LeaseWant | null> {
  const settings = (await loadConfig($)).features.leases
  if (!settings.on) return null
  if (settings.commit && /\bgit\b[^\n|;&]*\bcommit\b/.test(command)) {
    const cwd = await $.session.cwd().catch(() => 'repo')
    return { key: `commit:${normalizeFile(cwd)}`, purpose: 'git commit', ttlMs: 10 * 60_000 }
  }
  if (settings.integration && /tests[\\/]integration|test:integration|integration[\s\S]*vitest|vitest[\s\S]*integration/.test(command)) {
    return { key: 'integration-tests', purpose: 'integration tests', ttlMs: 60 * 60_000 }
  }
  return null
}

async function acquireLease($: EngineInterface, want: LeaseWant): Promise<{ isGranted: boolean; note?: string }> {
  const info = await ensureServer($).catch(() => null)
  if (!info) return { isGranted: false }
  const me = await $.session.id()
  const mine = (await read($, sessions)).find(one => one.sessionId === me)
  const startedAt = await $.clock.now()
  let isAnnounced = false
  let holderName = ''
  const waitMin = (await loadConfig($)).features.leases.waitMin
  while ((await $.clock.now()) - startedAt < waitMin * 60_000) {
    try {
      const response = await $.http.fetch(`http://127.0.0.1:${info.port}/api/lease/acquire`, {
        method: 'POST',
        headers: { 'x-lookout-token': info.token, 'content-type': 'application/json' },
        body: JSON.stringify({ key: want.key, sessionId: me, name: mine ? label(mine) : me, ttlMs: want.ttlMs, purpose: want.purpose }),
      })
      if (!response.ok) return { isGranted: false }
      const answer = JSON.parse(response.text) as { granted: boolean; holder?: { name?: string } }
      if (answer.granted) {
        const waited = Math.round(((await $.clock.now()) - startedAt) / 1000)
        return { isGranted: true, note: isAnnounced ? `Lookout: waited ${waited} s for the ${want.purpose} lock held by "${holderName}".` : undefined }
      }
      holderName = answer.holder?.name ?? 'another session'
      if (!isAnnounced) {
        isAnnounced = true
        $.ui.toast(`Waiting: ${want.purpose} lock held by ${holderName}`)
      }
    } catch {
      return { isGranted: false }
    }
    await $.clock.sleep(3000)
  }
  return { isGranted: false, note: `Lookout: waited ${waitMin} min for the ${want.purpose} lock held by "${holderName}" and ran anyway. Check that the other session is not committing or testing right now.` }
}

async function withLease<R>($: EngineInterface, command: string, run: () => Promise<R>): Promise<R> {
  const want = await leaseFor($, command)
  if (!want) return run()
  const lease = await acquireLease($, want)
  try {
    const result = await run()
    const shaped = result as { result?: unknown; deny?: string; context?: readonly string[] }
    if (!lease.note || !('result' in shaped) || shaped.deny) return result
    return { ...shaped, context: [...(shaped.context ?? []), lease.note] } as R
  } finally {
    if (lease.isGranted) await releaseLease($, want.key)
  }
}

async function releaseLease($: EngineInterface, key: string): Promise<void> {
  const info = server ?? (await readServerInfo($))
  if (!info) return
  const me = await $.session.id()
  await $.http
    .fetch(`http://127.0.0.1:${info.port}/api/lease/release`, {
      method: 'POST',
      headers: { 'x-lookout-token': info.token, 'content-type': 'application/json' },
      body: JSON.stringify({ key, sessionId: me }),
    })
    .catch(() => undefined)
}

async function sendHubAnswer($: EngineInterface, session: HubSession, item: HubLiveItem, answers: Record<string, string>): Promise<void> {
  const info = await ensureServer($)
  if (!info) {
    await update($, notice, () => 'Lookout server did not start')
    return
  }
  const response = await $.http.fetch(`http://127.0.0.1:${info.port}/api/answer`, {
    method: 'POST',
    headers: { 'x-lookout-token': info.token, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session.sessionId, questionId: item.id, answers }),
  })
  await update($, notice, () => (response.ok ? `Answer sent to ${label(session)}` : `Answer failed: ${response.text.slice(0, 200)}`))
  await update($, askDraft, current => {
    const next = { ...current }
    delete next[item.id]
    return next
  })
}

export async function pickAnswer($: EngineInterface, session: HubSession, item: HubLiveItem, index: number, text: string): Promise<void> {
  if (!text) return
  const draft = { ...((await read($, askDraft))[item.id] ?? {}), [String(index)]: text }
  await update($, askDraft, current => ({ ...current, [item.id]: draft }))
  const questions = item.questions ?? []
  if (questions.every((_, qi) => draft[String(qi)])) {
    const answers: Record<string, string> = {}
    questions.forEach((q, qi) => {
      answers[q.question] = draft[String(qi)] ?? ''
    })
    await sendHubAnswer($, session, item, answers)
  }
}

export async function openSettingsPane($: EngineInterface): Promise<void> {
  await update($, settingsTick, tick => tick + 1)
  await $.ui.open({ id: SETTINGS_PANE, title: 'Lookout settings', focus: true })
}

export async function openAskPane($: EngineInterface): Promise<void> {
  askPaneUntil = (await $.clock.now()) + 15 * 60_000
  await update($, notice, () => null)
  await $.ui.open({ id: ASK_PANE, title: 'Open questions', focus: true })
  void collect($)
}

export const registerHub = (on: On): void => {
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const now = await $.clock.now()
    const id = e.tool_use_id ?? `q-${now}`
    const questions = (e as unknown as { questions?: unknown[] }).questions ?? []
    await setPending($, { id, kind: 'question', tool: e.tool, at: now, questions, agentId: e.agentId })
    let isSettled = false
    if (!(await loadConfig($)).features.hubAnswers.on) {
      try {
        const result = await next(e)
        void recordAnswers($, (result as { result?: { answers?: Record<string, unknown> } }).result?.answers ?? {})
        return result
      } finally {
        await setPending($, null, id)
      }
    }
    try {
      const local = next(e).then(result => ({ from: 'local' as const, result }))
      const remote = waitForHubAnswer($, id, () => isSettled).then(answer =>
        answer ? { from: 'hub' as const, answer } : new Promise<never>(() => undefined),
      )
      const winner = await Promise.race([local, remote])
      if (winner.from === 'local') {
        const given = (winner.result as { result?: { answers?: Record<string, unknown> } }).result?.answers ?? {}
        void recordAnswers($, given)
        return winner.result
      }
      $.ui.toast('Answered on the Lookout page')
      void recordAnswers($, winner.answer.answers)
      const result = { questions, answers: winner.answer.answers, ...(winner.answer.response ? { response: winner.answer.response } : {}) }
      return { result } as unknown as Awaited<ReturnType<typeof next>>
    } finally {
      isSettled = true
      await setPending($, null, id)
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const now = await $.clock.now()
    const id = e.tool_use_id ?? `p-${now}`
    await setPending($, { id, kind: 'plan', tool: e.tool, at: now, summary: inputSummary(e), agentId: e.agentId })
    try {
      return await next(e)
    } finally {
      await setPending($, null, id)
    }
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    const now = await $.clock.now()
    const id = `perm-${e.tool_name}-${now}`
    await setPending($, { id, kind: 'permission', tool: e.tool_name, at: now, summary: inputSummary(e.tool_input) })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
    } finally {
      if (pendingItems.size > 0) await clearPermissions($, e.tool)
      statusAfterTool($)
      gitAfterTool($, e.tool)
    }
    if (!EDIT_TOOLS.has(e.tool) || !('result' in result) || result.isError || result.deny) return result
    const args = e as unknown as { file_path?: string; notebook_path?: string }
    const file = args.file_path ?? args.notebook_path
    if (!file || !(await loadConfig($)).features.radar.on) return result
    const note = await recordTouch($, file).catch(() => undefined)
    return note ? ({ ...result, context: [...(result.context ?? []), note] } as typeof result) : result
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => withLease($, e.command, () => next(e))).catch(($, e, next) => next(e))
  on('tool.call', { tool: /^PowerShell$/ }, async ($, e, next) =>
    withLease($, String((e as unknown as { command?: unknown }).command ?? ''), () => next(e)),
  ).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const config = await loadConfig($)
    const percent = await weeklyPercent($)
    const guard = config.features.budgetGuard
    if (guard.on && percent !== undefined && percent >= guard.percent) {
      $.ui.toast(`Agent held: weekly usage at ${Math.round(percent)} %`)
      return {
        deny: `Weekly usage is at ${Math.round(percent)} %. The owner's rule: at ${guard.percent} % pause long agent loops and report instead of starting new agents. Finish the current step yourself and tell the user where things stand.`,
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PreToolUse', async ($, e, next) => {
    const input = e as unknown as { agent_id?: string; effort?: { level?: string } }
    if (!input.agent_id && input.effort?.level) sessionEffort = input.effort.level
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const args = e as unknown as { description?: string; subagent_type?: string; model?: string; effort?: string; prompt?: string }
    const config = await loadConfig($)
    let route: RouteDecision | undefined
    let parent: string | null = null
    let call = e
    if (config.orchestrator.on && args.subagent_type !== 'fork') {
      try {
        parent = shortModel(await $.session.model().catch(() => undefined))
        const input: RouteInput = {
          subagentType: args.subagent_type ?? 'general-purpose',
          description: args.description ?? '',
          prompt: args.prompt ?? '',
          model: args.model,
          effort: args.effort,
          weeklyPercent: await weeklyPercent($),
          sessionModel: parent ?? undefined,
          sessionEffort: await currentEffort($),
        }
        const draft = draftRoute(config, input)
        route = routeAgent(config, input)
        let tier = draft?.tier
        let source = draft?.source
        const reasons = [...(draft?.reasons ?? [])]
        const classifier = config.orchestrator.classifier
        if (draft?.source === 'tier' && (classifier === 'always' || (classifier === 'unsure' && !draft.isSure))) {
          const answer = await classifyTier($, input.description, input.prompt ?? '')
          const picked = answer && draft.tier ? classifiedTier({ tier: draft.tier, canBeLight: draft.canBeLight ?? false }, answer) : answer
          if (picked) {
            reasons.push(picked === answer ? `classifier: ${picked}` : `classifier: ${answer}, kept ${picked}`)
            tier = picked
            source = 'classifier'
            route = routeTier(config, picked, input, reasons)
          }
        }
        if (route) call = { ...e, ...(route.model ? { model: route.model } : {}), ...(route.effort ? { effort: route.effort } : {}) } as typeof e
        if (draft) {
          void logRoute($, {
            kind: 'route',
            at: await $.clock.now(),
            sessionId: await $.session.id(),
            subagentType: input.subagentType,
            description: clip(input.description, 120),
            asked: args.model ?? null,
            askedEffort: args.effort ?? null,
            parent,
            sessionEffort: input.sessionEffort ?? null,
            profile: config.orchestrator.profile,
            rule: draft.rule?.id ?? null,
            tier: tier ?? null,
            source: source ?? null,
            isSure: draft.isSure,
            reasons: route?.reasons ?? reasons,
            changed: Boolean(route),
            model: route?.model ?? null,
            effort: route?.effort ?? null,
            isDowngraded: route?.isDowngraded ?? false,
          }).catch(() => undefined)
        }
      } catch {
        route = undefined
        call = e
      }
    }
    const result = await next(call)
    try {
      if (!config.orchestrator.on || !('result' in result)) return result
      const out = result.result as { status?: string; agentId?: string; resolvedModel?: string; totalTokens?: number; totalDurationMs?: number; totalToolUseCount?: number; toolStats?: { editFileCount?: number; linesAdded?: number; linesRemoved?: number } }
      const outcome = {
        kind: 'outcome',
        sessionId: await $.session.id(),
        subagentType: args.subagent_type ?? 'general-purpose',
        description: clip(args.description, 120),
        asked: args.model ?? null,
        model: route?.model ?? null,
        effort: route?.effort ?? null,
        tier: route?.tier ?? null,
        source: route?.source ?? null,
      }
      if (out.status === 'async_launched' && out.agentId) {
        pendingOutcomes.set(out.agentId, { ...outcome, ran: shortModel(out.resolvedModel) })
      } else {
        void logRoute($, {
          ...outcome,
          at: await $.clock.now(),
          ran: shortModel(out.resolvedModel),
          status: out.status ?? null,
          isError: Boolean(result.isError),
          tokens: out.totalTokens ?? null,
          durationMs: out.totalDurationMs ?? null,
          toolUses: out.totalToolUseCount ?? null,
          edits: out.toolStats?.editFileCount ?? null,
          lines: (out.toolStats?.linesAdded ?? 0) + (out.toolStats?.linesRemoved ?? 0),
        }).catch(() => undefined)
      }
      if (!route || !config.orchestrator.escalate || (out.status !== 'completed' && out.status !== 'async_launched')) return result
      const effortUp = nextEffortUp(route.effort)
      const modelUp = route.model && modelRank(route.model) < modelRank(parent ?? undefined) ? nextModelUp(route.model) : undefined
      const retry = effortUp ? `effort: "${effortUp}"` : modelUp ? `model: "${modelUp}"` : null
      if (!retry) return result
      const ran = [route.model, route.effort ? `${route.effort} effort` : null].filter(Boolean).join(' at ')
      const why = route.tier ? `as a ${route.tier} task` : 'by its agent type'
      const note = `Lookout ran this agent${ran ? ` on ${ran}` : ''} ${why}. If its result is incomplete or wrong, run it once more with ${retry} rather than redoing the work yourself; do not escalate further.`
      return { ...result, context: [...(result.context ?? []), note] } as typeof result
    } catch {
      return result
    }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (pendingItems.size > 0) await clearPermissions($)
    await statusTurn($)
    gitTurn($)
    const pending = e.agentId ? pendingOutcomes.get(e.agentId) : undefined
    if (e.agentId && pending) {
      pendingOutcomes.delete(e.agentId)
      const usage = e.usage
      void logRoute($, {
        ...pending,
        at: await $.clock.now(),
        ran: shortModel(usage?.model) ?? pending.ran ?? null,
        status: e.reason === 'answer' ? 'completed' : e.reason,
        isError: e.reason === 'error',
        tokens: usage ? usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : null,
        durationMs: e.durationMs,
      }).catch(() => undefined)
    }
    if (!e.agentId) {
      void writeUsage($).catch(() => undefined)
      void updateBrief($)
    }
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source !== 'compact') return result
    const brief = await briefContext($)
    if (!brief) return result
    return { ...result, additionalContext: [...(result.additionalContext ?? []), brief] }
  }).catch(($, e, next) => next(e))

  on('session.receive', async ($, e, next) => {
    if (e.agentId || (e.origin.kind !== 'peer' && e.origin.kind !== 'peer-send-message')) return next(e)
    if (!(await loadConfig($)).features.relay.on) return next(e)
    const body = await verifiedRelayBody($, e.text)
    if (body === null) return next(e)
    void $.prompt.submit({ text: body, asUser: true })
    return { consumed: 'lookout relayed a signed Lookout message as the owner prompt' }
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    $.ui.status(undefined)
    await migrateLegacyData($)
    const id = await $.session.id()
    await update($, selfId, () => id)
    pendingItems.clear()
    void writePending($).catch(() => undefined)
    await $.command.register({ name: 'lookout', description: 'Open Lookout: all live sessions (/lookout ask, /lookout settings)' })
    await $.command.register({ name: 'lookout-web', description: 'Open Lookout in the browser' })
    void collect($)
    void loadRelayKey($)
    $.clock.every(REFRESH_MS, () => {
      void collect($)
    })
    $.clock.every(2_000, () => {
      void pollOutbox($)
    })
    $.clock.every(5_000, () => {
      void (async () => {
        if ((await $.clock.now()) < askPaneUntil) await collect($)
      })()
    })
    $.clock.every(60_000, () => {
      void writeUsage($).catch(() => undefined)
    })
    void writeUsage($).catch(() => undefined)
    await statusStart($)
    await gitStart($)
    await recapStart($)
    void loadOwnBrief($)
    return started
  })

  on('ui.render', { component: 'Pane', requestId: ASK_PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const list = await read($, sessions)
    const me = await read($, selfId)
    const draft = await read($, askDraft)
    const message = await read($, notice)
    const columns = Math.max(20, e.props.bodyColumns)
    const asks = list
      .filter(one => one.sessionId !== me)
      .flatMap(one => (one.live ?? []).filter(item => item.kind === 'question').map(item => ({ session: one, item })))
    return (
      <Box flexDirection="column">
        {asks.length === 0 && <Text dimColor>No other session is waiting for an answer right now.</Text>}
        {asks.map(({ session, item }) => (
          <Box key={`ask-${item.id}`} flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
            <Text bold color="warning">
              {fit(`? ${label(session)}`, columns - 4)}
            </Text>
            {(item.questions ?? []).map((question, qi) => (
              <Box key={`q-${item.id}-${qi}`} flexDirection="column" marginTop={1}>
                <Text bold wrap="wrap">
                  {question.question}
                </Text>
                <Box flexDirection="row" flexWrap="wrap" gap={1}>
                  {(question.options ?? []).map(option => (
                    <Button
                      key={`o-${item.id}-${qi}-${option.label}`}
                      label={`${draft[item.id]?.[String(qi)] === option.label ? '● ' : ''}${option.label}`}
                      onPress={() => void pickAnswer($, session, item, qi, option.label)}
                    />
                  ))}
                </Box>
                <Input
                  key={`i-${item.id}-${qi}`}
                  label="Own answer"
                  placeholder="Type your answer"
                  submitLabel="Use"
                  onSubmit={text => void pickAnswer($, session, item, qi, text.trim())}
                />
              </Box>
            ))}
          </Box>
        ))}
        {message && (
          <Box marginTop={1}>
            <Text color="warning">{message}</Text>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, settingsTick)
    const config = await loadConfig($)
    const columns = Math.max(20, e.props.bodyColumns)
    const features = Object.keys(FEATURE_LABELS) as FeatureKey[]
    const o = config.orchestrator
    const toggle = (key: FeatureKey) =>
      changeSettings($, current => ({ ...current, features: { ...current.features, [key]: { ...current.features[key], on: !current.features[key].on } } }))
    return (
      <Box flexDirection="column">
        <Text bold>Features</Text>
        {features.map(key => {
          const isOn = config.features[key].on
          const detailText = featureDetail(config, key)
          return (
            <Box key={`f-${key}`} flexDirection="row" gap={1}>
              <Button label={isOn ? 'on ' : 'off'} onPress={() => void toggle(key)} />
              <Text color={isOn ? undefined : 'inactive'}>{fit(`${FEATURE_LABELS[key]}${detailText ? `  ${detailText}` : ''}`, columns - 8)}</Text>
            </Box>
          )
        })}
        <Box flexDirection="row" gap={1}>
          <Button
            label="brief model"
            onPress={() => void changeSettings($, c => ({ ...c, features: { ...c.features, brief: { ...c.features.brief, model: nextModel(c.features.brief.model) } } }))}
          />
          <Text dimColor>{config.features.brief.model}</Text>
        </Box>
        <Box marginTop={1}>
          <Text bold>Orchestrator: model per task type</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button label={o.on ? 'on ' : 'off'} onPress={() => void changeSettings($, c => ({ ...c, orchestrator: { ...c.orchestrator, on: !c.orchestrator.on } }))} />
          <Text>{o.on ? 'Subagents are routed by the rules below' : 'Off: subagents keep the model they ask for'}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button
            label={o.onlyWhenUnset ? 'only unset' : 'always   '}
            onPress={() => void changeSettings($, c => ({ ...c, orchestrator: { ...c.orchestrator, onlyWhenUnset: !c.orchestrator.onlyWhenUnset } }))}
          />
          <Text dimColor>{o.onlyWhenUnset ? 'An explicit model in the Agent call wins' : 'Rules override an explicit model'}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button
            label={o.downgrade.on ? 'downgrade on ' : 'downgrade off'}
            onPress={() => void changeSettings($, c => ({ ...c, orchestrator: { ...c.orchestrator, downgrade: { ...c.orchestrator.downgrade, on: !c.orchestrator.downgrade.on } } }))}
          />
          <Text dimColor>{`one model cheaper from ${o.downgrade.percent} % weekly usage`}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button label={`profile ${o.profile}`.padEnd(16)} onPress={() => void changeSettings($, c => applyProfile(c, nextProfile(c.orchestrator.profile)))} />
          <Text dimColor>{PROFILE_HELP[o.profile]}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button
            label={o.protectJudgment ? 'protect on ' : 'protect off'}
            onPress={() => void changeSettings($, c => ({ ...c, orchestrator: { ...c.orchestrator, protectJudgment: !c.orchestrator.protectJudgment } }))}
          />
          <Text dimColor>{'reviews, plans and deep tasks never below the session model and effort'}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button
            label={o.routeModel ? 'model on ' : 'model off'}
            onPress={() => void changeSettings($, c => ({ ...c, orchestrator: { ...c.orchestrator, routeModel: !c.orchestrator.routeModel } }))}
          />
          <Button
            label={o.routeEffort ? 'effort on ' : 'effort off'}
            onPress={() => void changeSettings($, c => ({ ...c, orchestrator: { ...c.orchestrator, routeEffort: !c.orchestrator.routeEffort } }))}
          />
          <Text dimColor>{'what the routing may set'}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button
            label={`classifier ${o.classifier}`.padEnd(17)}
            onPress={() => void changeSettings($, c => ({ ...c, orchestrator: { ...c.orchestrator, classifier: nextClassifier(c.orchestrator.classifier) } }))}
          />
          <Text dimColor>{o.classifier === 'off' ? 'tiers from keywords and the brief only' : o.classifier === 'always' ? 'a haiku call picks every tier' : 'a haiku call decides unclear tasks'}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button
            label={o.escalate ? 'escalate on ' : 'escalate off'}
            onPress={() => void changeSettings($, c => ({ ...c, orchestrator: { ...c.orchestrator, escalate: !c.orchestrator.escalate } }))}
          />
          <Text dimColor>{'a short agent may be re-run once at high effort or one model up'}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{'General-purpose agents, by difficulty:'}</Text>
        </Box>
        {TIERS.map(tier => (
          <Box key={`t-${tier}`} flexDirection="row" gap={1}>
            <Button
              label={o.tiers[tier].model.padEnd(7)}
              onPress={() => void changeSettings($, c => ({ ...c, orchestrator: { ...c.orchestrator, profile: 'custom', tiers: { ...c.orchestrator.tiers, [tier]: { ...c.orchestrator.tiers[tier], model: nextModel(c.orchestrator.tiers[tier].model) } } } }))}
            />
            <Button
              label={o.tiers[tier].effort.padEnd(7)}
              onPress={() => void changeSettings($, c => ({ ...c, orchestrator: { ...c.orchestrator, profile: 'custom', tiers: { ...c.orchestrator.tiers, [tier]: { ...c.orchestrator.tiers[tier], effort: nextEffort(c.orchestrator.tiers[tier].effort) } } } }))}
            />
            <Text>{fit(`${tier}  ${o.tiers[tier].words.slice(0, 6).join(', ')}`, columns - 20)}</Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor>{'Pinned by agent type:'}</Text>
        </Box>
        {o.rules.map(rule => (
          <Box key={`r-${rule.id}`} flexDirection="row" gap={1}>
            <Button
              label={rule.model.padEnd(7)}
              onPress={() =>
                void changeSettings($, c => ({
                  ...c,
                  orchestrator: { ...c.orchestrator, profile: 'custom', rules: c.orchestrator.rules.map(one => (one.id === rule.id ? { ...one, model: nextModel(one.model) } : one)) },
                }))
              }
            />
            <Button
              label={rule.effort.padEnd(7)}
              onPress={() =>
                void changeSettings($, c => ({
                  ...c,
                  orchestrator: { ...c.orchestrator, profile: 'custom', rules: c.orchestrator.rules.map(one => (one.id === rule.id ? { ...one, effort: nextEffort(one.effort) } : one)) },
                }))
              }
            />
            <Text>{fit(`${rule.label}  ${rule.types.join(', ')}`, columns - 20)}</Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            Numbers, agent types, keywords and the Replay are on the web page (/lookout-web, Settings). Saved in ~/.claude/lookout/config.json, read by every session within 10 s.
          </Text>
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'lookout-web' }, async $ => {
    await openBrowser($)
    return { text: 'Lookout opening in the browser.' }
  })

}
