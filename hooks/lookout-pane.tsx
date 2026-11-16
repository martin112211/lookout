import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { On } from './on'

import type { HubDetail, HubLiveItem, HubRecap, HubSession, Snapshot } from '../types'
import { PANE, age, collect, fit, forkName, label, loadDetail, openAskPane, openBrowser, openSettingsPane, openTab, pickAnswer, select } from './hub'
import { loadRecap, recapInput } from './recap'

const sessions = atom({ plugin: 'lookout', key: 'sessions' } as const, [] as HubSession[], { shape: 'sessions-1' })
const refreshedAt = atom({ plugin: 'lookout', key: 'refreshedAt' } as const, 0)
const selected = atom({ plugin: 'lookout', key: 'selected' } as const, null as string | null)
const detail = atom({ plugin: 'lookout', key: 'detail' } as const, null as HubDetail | null, { shape: 'detail-1' })
const notice = atom({ plugin: 'lookout', key: 'notice' } as const, null as string | null)
const selfId = atom({ plugin: 'lookout', key: 'selfId' } as const, null as string | null)
const snapshot = atom({ plugin: 'lookout', key: 'statusSnapshot' } as const, null as Snapshot | null)
const recap = atom({ plugin: 'lookout', key: 'recap' } as const, null as HubRecap | null)
const paneDraft = atom({ plugin: 'lookout', key: 'paneDraft' } as const, {} as Record<string, string>)

const LANE = '▁▂▃▄▅▆▇█'

type State = 'wait' | 'run' | 'done' | 'idle'

function openItem(session: HubSession): HubLiveItem | { kind: 'waiting'; summary?: string } | null {
  const live = session.live ?? []
  const question = live.find(item => item.kind === 'question')
  if (question) return question
  if (live[0]) return live[0]
  if (session.waitingOnPerson) return { kind: 'waiting', summary: session.question?.[0]?.question ?? session.pendingTool?.summary ?? session.waitingFor }
  return null
}

function stateOf(session: HubSession): State {
  if (openItem(session)) return 'wait'
  if (session.status === 'busy') return 'run'
  if ((session.unread ?? 0) > 0) return 'done'
  return 'idle'
}

const GLYPH: Record<State, string> = { wait: '?', run: '●', done: '✓', idle: '○' }
const COLOR: Record<State, 'warning' | 'claude' | 'success' | 'subtle'> = { wait: 'warning', run: 'claude', done: 'success', idle: 'subtle' }

function lineOf(session: HubSession): string {
  const item = openItem(session)
  if (item?.kind === 'question') return `Question: ${('questions' in item ? item.questions?.[0]?.question : undefined) ?? session.question?.[0]?.question ?? 'waiting for your answer'}`
  if (item?.kind === 'permission') return `Approval: ${'tool' in item ? item.tool : ''} ${item.summary ?? ''}`
  if (item?.kind === 'plan') return 'Plan waits for your approval'
  if (item) return `Waits for you${item.summary ? `: ${item.summary}` : ''}`
  if (session.status === 'busy' && session.currentTool) return `${session.currentTool.name} ${session.currentTool.summary ?? ''}`
  if (session.brief?.next) return `Next: ${session.brief.next}`
  return session.lastAssistant ?? ''
}

function laneOf(session: HubSession): string {
  const bins = session.activity ?? []
  if (!bins.length) return ''
  const pairs: number[] = []
  for (let index = 0; index < bins.length; index += 2) pairs.push((bins[index] ?? 0) + (bins[index + 1] ?? 0))
  const max = Math.max(1, ...pairs)
  return pairs.map(v => (v ? (LANE[Math.min(LANE.length - 1, Math.round((v / max) * (LANE.length - 1)))] ?? '▁') : ' ')).join('')
}

function contextPercent(session: HubSession, now: number): number | null {
  if (typeof session.usage?.contextPercent === 'number' && now - session.usage.at < 30 * 60_000) return Math.round(session.usage.contextPercent)
  const n = session.contextTokens
  if (!n) return null
  return Math.min(100, Math.round((n / (n > 200_000 ? 1_000_000 : 200_000)) * 100))
}

type Group = { name: string; isGit: boolean; branches: [string, HubSession[]][] }

function groupsOf(list: HubSession[]): Group[] {
  const rank = (s: HubSession) => ({ wait: 0, done: 1, run: 2, idle: 3 })[stateOf(s)]
  const repos = new Map<string, { name: string; isGit: boolean; branches: Map<string, HubSession[]> }>()
  for (const s of list) {
    const key = s.repo?.root ?? `dir:${s.cwd}`
    const name = s.repo?.name ?? (s.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? s.cwd)
    const repo = repos.get(key) ?? { name, isGit: Boolean(s.repo), branches: new Map() }
    const branch = s.repo && s.branch && s.branch !== 'HEAD' ? s.branch : s.repo ? 'detached' : 'no git'
    repo.branches.set(branch, [...(repo.branches.get(branch) ?? []), s])
    repos.set(key, repo)
  }
  const out = [...repos.values()].map(repo => {
    const branches = [...repo.branches.entries()].map(([name, items]) => [name, items.sort((a, b) => rank(a) - rank(b) || (b.statusUpdatedAt ?? 0) - (a.statusUpdatedAt ?? 0))] as [string, HubSession[]])
    branches.sort((a, b) => Math.min(...a[1].map(rank)) - Math.min(...b[1].map(rank)))
    return { name: repo.name, isGit: repo.isGit, branches, best: Math.min(...branches.flatMap(b => b[1].map(rank))) }
  })
  out.sort((a, b) => a.best - b.best || a.name.localeCompare(b.name))
  return out
}

function ordered(list: HubSession[]): HubSession[] {
  return groupsOf(list).flatMap(group => group.branches.flatMap(([, items]) => items))
}

async function markRead($: EngineInterface, sessionId: string): Promise<void> {
  await $.process.run(['bun', `${$.plugin.root}/scripts/collect.mjs`, '--read', sessionId], { timeoutMs: 10_000 }).catch(() => undefined)
}

async function choose($: EngineInterface, sessionId: string | null): Promise<void> {
  await select($, sessionId)
  if (sessionId) void markRead($, sessionId)
}

async function stepTo($: EngineInterface, delta: number | 'open'): Promise<void> {
  const me = await read($, selfId)
  const list = ordered(await read($, sessions))
  const current = await read($, selected)
  const at = list.findIndex(s => s.sessionId === current)
  if (delta === 'open') {
    const open = list.filter(s => s.sessionId !== me && stateOf(s) === 'wait')
    if (!open.length) {
      await update($, notice, () => 'Nothing open. Everything runs.')
      return
    }
    const next = open.find(s => list.indexOf(s) > at) ?? open[0]
    if (next) await choose($, next.sessionId)
    return
  }
  const next = list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + delta))]
  if (next) await choose($, next.sessionId)
}

async function openInTerminal($: EngineInterface, session: HubSession): Promise<void> {
  if (session.kind !== 'interactive') {
    await openTab($, { title: session.name, command: ['claude', 'attach', session.sessionId] }, 'Attach')
    return
  }
  await update($, notice, () => `Switch to the terminal tab "${session.name}": a running interactive session cannot be opened twice.`)
}

export const registerLookoutPane = (on: On): void => {
  on('prompt.submit', async ($, e, next) => {
    await recapInput($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'lookout' }, async ($, e) => {
    const args = e.args.trim().toLowerCase()
    if (args.startsWith('settings')) {
      await openSettingsPane($)
      return { text: 'Lookout settings opened.' }
    }
    if (args.startsWith('ask')) {
      await openAskPane($)
      return { text: 'Open questions of the other sessions.' }
    }
    if (args.startsWith('recap')) {
      await loadRecap($, true)
      const value = await read($, recap)
      return { text: value?.items.length ? 'Recap above the prompt.' : 'Nothing new since your last input.' }
    }
    await $.ui.open({ id: PANE, title: 'Sessions', focus: true })
    void collect($)
    return { text: 'Lookout opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const value = await read($, recap)
    if (!value || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const shown = value.items.slice(-5)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text dimColor>{`Lookout · since your last input${value.since ? ` ${age(value.since, now)} ago` : ''}${value.unread ? ` · ${value.unread} replies` : ''}`}</Text>
          <Button key="recap-hide" label="Hide" plain onPress={() => void update($, recap, () => null)} />
        </Box>
        {shown.length === 0 && <Text dimColor>Nothing new.</Text>}
        {shown.map((item, index) => (
          <Text key={`recap-${index}`} wrap="truncate-end">
            <Text color={item.g === '!' ? 'warning' : 'subtle'}>{`${item.g} `}</Text>
            {item.text}
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'lookout' }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const list = await read($, sessions)
    const me = await read($, selfId)
    const chosen = await read($, selected)
    const shown = await read($, detail)
    const message = await read($, notice)
    const stamp = await read($, refreshedAt)
    const drafts = await read($, paneDraft)
    const status = await read($, snapshot)
    const now = await $.clock.now()
    const columns = Math.max(24, e.props.bodyColumns)
    const current = list.find(one => one.sessionId === chosen)
    const open = list.filter(s => s.sessionId !== me && stateOf(s) === 'wait').length
    const limits = (status?.limits ?? [])
      .filter(l => l.kind === 'five_hour' || l.kind === 'seven_day')
      .map(l => `${l.kind === 'five_hour' ? '5 h' : 'week'} ${Math.round(l.percent)} %`)
      .join(' · ')
    const item = current ? openItem(current) : null
    const question = item && item.kind === 'question' && 'id' in item && current?.sessionId !== me ? item : null
    const ctx = current ? contextPercent(current, now) : null

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{`${list.length} live`}</Text>
          <Text color={open ? 'warning' : 'subtle'}>{` · ${open} need${open === 1 ? 's' : ''} you`}</Text>
          <Text dimColor>{`${limits ? ` · ${limits}` : ''} · ${age(stamp, now)} ago`}</Text>
        </Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="next-open" label="Next open" hotkey="n" onPress={() => void stepTo($, 'open')} />
          <Button key="down" label="Down" hotkey="j" onPress={() => void stepTo($, 1)} />
          <Button key="up" label="Up" hotkey="k" onPress={() => void stepTo($, -1)} />
          <Button key="browser" label="Browser" hotkey="b" onPress={() => void openBrowser($)} />
          <Button key="refresh" label="Refresh" plain onPress={() => void collect($)} />
        </Box>
        {groupsOf(list).map(group => (
          <Box key={`repo-${group.name}`} flexDirection="column" marginTop={1}>
            <Text bold>{fit(group.name, columns)}</Text>
            {group.branches.map(([branch, items]) => (
              <Box key={`branch-${group.name}-${branch}`} flexDirection="column">
                <Text dimColor>{fit(`${group.isGit ? '⎇ ' : ''}${branch}`, columns)}</Text>
                {items.map(session => {
                  const st = stateOf(session)
                  const isMe = session.sessionId === me
                  const unread = session.unread && session.sessionId !== chosen ? ` (${session.unread})` : ''
                  const tag = session.workItem ? ` #${session.workItem}` : ''
                  const lane = laneOf(session)
                  const head = `${label(session)}${tag}${unread}${isMe ? ' · this session' : ''}`
                  const tail = ` ${age(session.statusUpdatedAt, now)}`
                  return (
                    <Box key={`row-${session.sessionId}`} flexDirection="column">
                      <Button key={`pick-${session.sessionId}`} plain onPress={() => void choose($, chosen === session.sessionId ? null : session.sessionId)}>
                        <Text color={COLOR[st]}>{`  ${GLYPH[st]} `}</Text>
                        <Text bold={chosen === session.sessionId}>{fit(head, Math.max(8, columns - tail.length - 4))}</Text>
                        <Text dimColor>{tail}</Text>
                      </Button>
                      <Text color={st === 'wait' ? 'warning' : undefined} dimColor={st !== 'wait'}>
                        {fit(`    ${lane ? `${lane} ` : ''}${lineOf(session)}`, columns)}
                      </Text>
                    </Box>
                  )
                })}
              </Box>
            ))}
          </Box>
        ))}
        {current && (
          <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
            <Text bold>{fit(label(current), columns - 4)}</Text>
            <Text dimColor>
              {fit([current.repo?.name, current.branch && current.branch !== 'HEAD' ? `⎇ ${current.branch}` : null, ctx !== null ? `ctx ${ctx} %${ctx >= 80 ? ' compacts soon' : ''}` : null, current.name].filter(Boolean).join(' · '), columns - 4)}
            </Text>
            {(current.catchup ?? []).length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor>{`Since you were last here${current.lastReadAt ? ` (${age(current.lastReadAt, now)} ago)` : ''}`}</Text>
                {(current.catchup ?? []).slice(-6).map((one, index) => (
                  <Text key={`c-${index}`} wrap="truncate-end">
                    <Text color={one.g === '?' || one.g === '!' ? 'warning' : 'subtle'}>{`${one.g} `}</Text>
                    {one.text}
                  </Text>
                ))}
              </Box>
            )}
            {question && 'questions' in question && (
              <Box flexDirection="column" marginTop={1}>
                {(question.questions ?? []).map((q, qi) => (
                  <Box key={`q-${question.id}-${qi}`} flexDirection="column">
                    <Text bold color="warning" wrap="wrap">
                      {q.question}
                    </Text>
                    <Box flexDirection="row" flexWrap="wrap" gap={1}>
                      {(q.options ?? []).map((option, oi) => (
                        <Button
                          key={`o-${question.id}-${qi}-${oi}`}
                          label={option.label}
                          hotkey={qi === 0 && oi < 9 ? String(oi + 1) : undefined}
                          onPress={() => void pickAnswer($, current, question, qi, option.label)}
                        />
                      ))}
                    </Box>
                    <Input key={`own-${question.id}-${qi}`} label="Own answer" placeholder="Type your answer" submitLabel="Use" onSubmit={text => void pickAnswer($, current, question, qi, text.trim())} />
                  </Box>
                ))}
              </Box>
            )}
            {item && !question && (
              <Box marginTop={1}>
                <Text color="warning" wrap="wrap">
                  {current.sessionId === me ? 'This session waits for you right here.' : `${lineOf(current)} · answer in its terminal tab "${current.name}".`}
                </Text>
              </Box>
            )}
            {current.brief && (
              <Box flexDirection="column" marginTop={1}>
                {current.brief.goal && <Text wrap="wrap">{`Goal: ${current.brief.goal}`}</Text>}
                {(current.brief.decided ?? []).slice(-3).map((one, index) => (
                  <Text key={`d-${index}`} dimColor wrap="wrap">{`· ${one}`}</Text>
                ))}
                {current.brief.next && <Text wrap="wrap">{`Next: ${current.brief.next}`}</Text>}
                {current.brief.blocked && <Text color="warning" wrap="wrap">{`Waits for: ${current.brief.blocked}`}</Text>}
              </Box>
            )}
            {!shown && <Text dimColor>Loading last messages…</Text>}
            {shown?.messages.slice(-3).map((one, index) => (
              <Box key={`msg-${index}`} flexDirection="column" marginTop={1}>
                <Text color={one.role === 'user' ? 'suggestion' : 'text'} bold>
                  {one.role === 'user' ? 'You' : 'Claude'}
                </Text>
                <Text wrap="wrap">{one.text.length > 600 ? `${one.text.slice(0, 599)}…` : one.text}</Text>
              </Box>
            ))}
            {current.sessionId !== me && (
              <Box marginTop={1}>
                <Input
                  key={`send-${current.sessionId}`}
                  label="Message"
                  placeholder={drafts[current.sessionId] ?? `Write to ${current.name}`}
                  submitLabel="Send"
                  onSubmit={text => {
                    const trimmed = text.trim()
                    if (!trimmed) return
                    void $.session
                      .send({ to: { sessionId: current.sessionId }, text: trimmed })
                      .then(result => update($, notice, () => (result.isDelivered ? `Sent to ${current.name}` : `Not delivered: ${result.reason}`)))
                      .then(() => update($, paneDraft, value => ({ ...value, [current.sessionId]: '' })))
                  }}
                />
              </Box>
            )}
            <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
              <Button key={`open-${current.sessionId}`} label="Open" hotkey="o" onPress={() => void openInTerminal($, current)} />
              <Button
                key={`fork-${current.sessionId}`}
                label="Fork"
                onPress={() =>
                  void openTab($, { cwd: current.cwd, title: forkName(current), command: ['claude', '--resume', current.sessionId, '--fork-session', '--name', forkName(current)] }, 'Fork')
                }
              />
              <Button key={`reload-${current.sessionId}`} label="Reload" plain onPress={() => void loadDetail($, current.sessionId)} />
              <Button key="close-detail" role="dismiss" label="Close" plain onPress={() => void choose($, null)} />
            </Box>
          </Box>
        )}
        {message && (
          <Box marginTop={1}>
            <Text color="warning" wrap="wrap">
              {message}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
