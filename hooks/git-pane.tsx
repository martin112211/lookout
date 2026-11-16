import { atom, read, update } from 'claude-code'
import type { EngineInterface, Timer } from 'claude-code'
import type { On } from './on'

import type { GitSnapshot } from '../types'
import { loadConfig } from './config'
import { bar, parseAheadBehind, parseCommits, parseStatus, pickBase, shortAge, splitPath } from './git'

const PANE = 'lookout-git'
const REFRESH_MS = 20_000

const snapshot = atom({ plugin: 'lookout', key: 'gitSnapshot' } as const, null as GitSnapshot | null)

const STATUS: Record<string, { label: string; color: string }> = {
  M: { label: 'M', color: 'warning' },
  MM: { label: 'M', color: 'warning' },
  A: { label: 'A', color: 'success' },
  AM: { label: 'A', color: 'success' },
  D: { label: 'D', color: 'error' },
  R: { label: 'R', color: 'suggestion' },
  '??': { label: 'U', color: 'subtle' },
}

// Module variables reset on reload; the snapshot in $.state survives.
let timer: Timer | undefined
let isRefreshing = false
let isPending = false
const baseByCwd = new Map<string, string | null>()

async function git($: EngineInterface, args: string[]) {
  try {
    const res = await $.process.run(['git', '--no-optional-locks', '-c', 'core.quotePath=false', ...args], {
      timeoutMs: 10_000,
    })
    return res.exitCode === 0 ? res.stdout : null
  } catch {
    return null
  }
}

async function detectBase($: EngineInterface, cwd: string) {
  if (baseByCwd.has(cwd)) return baseByCwd.get(cwd) ?? null
  const [originHead, locals] = await Promise.all([
    git($, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']),
    git($, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
  ])
  const base = pickBase(originHead, (locals ?? '').split(/\r?\n/).filter(Boolean))
  baseByCwd.set(cwd, base)
  return base
}

async function refreshOnce($: EngineInterface) {
  const branch = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
  if (!branch) {
    await update($, snapshot, () => null)
    return
  }
  const cwd = await $.session.cwd().catch(() => '')
  const base = await detectBase($, cwd)
  const hasBase = base !== null && branch !== base
  const [counts, porcelain, numstat, log, aheadList] = await Promise.all([
    hasBase ? git($, ['rev-list', '--left-right', '--count', `${base}...HEAD`]) : null,
    git($, ['status', '--porcelain', '--untracked-files=normal']),
    git($, ['diff', '--numstat', '--no-renames', 'HEAD']),
    git($, ['log', '--format=%h%x09%D%x09%s%x09%ct', '-n', '15', 'HEAD']),
    hasBase ? git($, ['rev-list', '--abbrev-commit', `${base}..HEAD`]) : null,
  ])
  const ab = counts ? parseAheadBehind(counts) : null
  const aheadHashes = new Set((aheadList ?? '').split(/\r?\n/).filter(Boolean))
  const next: GitSnapshot = {
    branch: branch === 'HEAD' ? '(detached)' : branch,
    ahead: ab?.ahead ?? null,
    behind: ab?.behind ?? null,
    base,
    files: parseStatus(porcelain ?? '', numstat ?? ''),
    commits: parseCommits(log ?? '', aheadHashes),
  }
  await update($, snapshot, () => next)
}

// Coalesces bursts (many tool calls in a row) into at most one extra run.
async function refresh($: EngineInterface) {
  if (!(await loadConfig($)).features.gitPane.on) return
  if (isRefreshing) {
    isPending = true
    return
  }
  isRefreshing = true
  try {
    do {
      isPending = false
      await refreshOnce($).catch(() => undefined)
    } while (isPending)
  } finally {
    isRefreshing = false
  }
}

const totals = (snap: GitSnapshot) => ({
  added: snap.files.reduce((sum, f) => sum + f.added, 0),
  removed: snap.files.reduce((sum, f) => sum + f.removed, 0),
})

export async function gitStart($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'git',
    description: 'Show branch, changed files and recent commits in a pane',
  })
  timer?.cancel()
  timer = $.clock.every(REFRESH_MS, () => void refresh($))
  void refresh($)
}

export function gitAfterTool($: EngineInterface, tool: string): void {
  if (['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit'].includes(tool)) void refresh($)
}

export function gitTurn($: EngineInterface): void {
  void refresh($)
}

export const registerGitPane = (on: On): void => {

  on('command.run', { command: 'git' }, async $ => {
    if (!(await loadConfig($)).features.gitPane.on) return { text: 'The git pane is switched off in /lookout settings.' }
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Git' })
    return { text: 'Git pane opened.' }
  })


  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    if (snap === null) return <Text dimColor>Not a git repository.</Text>

    const now = await $.clock.now()
    const rows = Math.max(12, (e.viewport?.rows ?? 30) - 8)
    const fileRows = Math.min(snap.files.length, Math.max(3, Math.floor(rows / 2)))
    const commitRows = Math.max(3, Math.floor((rows - fileRows) / 2))
    const { added, removed } = totals(snap)
    const maxLines = Math.max(1, ...snap.files.map(f => f.added + f.removed))
    const shownCommits = snap.commits.slice(0, commitRows)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text backgroundColor="claude" color="inverseText" bold wrap="truncate-end">
            {' ⎇ '}
            {snap.branch}{' '}
          </Text>
          {snap.ahead !== null && (
            <Text dimColor>
              <Text color={snap.ahead ? 'success' : 'subtle'}>{snap.ahead} vor</Text>
              {' · '}
              <Text color={snap.behind ? 'warning' : 'subtle'}>{snap.behind} hinter</Text> {snap.base}
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold>Changes</Text>
            {snap.files.length > 0 && (
              <Text>
                <Text color="diffAdded">+{added}</Text> <Text color="diffRemoved">−{removed}</Text>
              </Text>
            )}
          </Box>
          {snap.files.length === 0 && <Text color="success">✓ Working tree clean</Text>}
          {snap.files.slice(0, fileRows).map(f => {
            const status = STATUS[f.status] ?? { label: f.status.slice(0, 1), color: 'text' }
            const { dir, name } = splitPath(f.path)
            const b = bar(f.added, f.removed, maxLines)
            return (
              <Box key={f.path}>
                <Box width={2} flexShrink={0}>
                  <Text color={status.color} bold>
                    {status.label}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text wrap="truncate-end">
                    {name}
                    <Text dimColor> {dir}</Text>
                  </Text>
                </Box>
                <Box flexShrink={0} marginLeft={1}>
                  <Text>
                    <Text color="diffAdded">{b.plus}</Text>
                    <Text color="diffRemoved">{b.minus}</Text>
                    <Text dimColor>{b.rest}</Text>
                  </Text>
                </Box>
              </Box>
            )
          })}
          {snap.files.length > fileRows && <Text dimColor>  … {snap.files.length - fileRows} weitere</Text>}
        </Box>

        <Box flexDirection="column">
          <Text bold>Commits</Text>
          {shownCommits.map((c, i) => {
            const isLast = i === shownCommits.length - 1
            return (
              <Box key={c.hash} flexDirection="column">
                <Box>
                  <Box width={2} flexShrink={0}>
                    <Text color={c.isAhead ? 'claude' : 'subtle'}>{c.isAhead ? '●' : '○'}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Text wrap="truncate-end" dimColor={!c.isAhead}>
                      {c.subject}
                    </Text>
                  </Box>
                  <Box flexShrink={0} marginLeft={1}>
                    <Text dimColor>{shortAge(now - c.time).padStart(3)}</Text>
                  </Box>
                </Box>
                <Box>
                  <Box width={2} flexShrink={0}>
                    <Text color="subtle">{isLast ? ' ' : '│'}</Text>
                  </Box>
                  <Text wrap="truncate-end">
                    <Text color="warning" dimColor>
                      {c.hash.slice(0, 7)}
                    </Text>
                    {c.refs.map(r => (
                      <Text key={r} color="suggestion">
                        {' '}
                        {r}
                      </Text>
                    ))}
                  </Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}
