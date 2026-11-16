import { expect, mock, test } from 'claude-code/testing'

import { bar, parseGit, prettyModel, segments, statusRows } from '../hooks/format'
import { paletteFor, SKINS } from '../hooks/palettes'

const SNAP = {
  model: 'claude-opus-5-5',
  folder: 'demo-app',
  git: { branch: 'main', dirty: true, ahead: 2, behind: 0 },
  ctx: { percent: 42, tokens: 84_000 },
  limits: [
    { kind: 'five_hour', percent: 63.5, resetsAt: '2026-10-15T14:00:00Z' },
    { kind: 'seven_day', percent: 91, resetsAt: '2026-10-19T08:00:00Z' },
  ],
  costUsd: 1.234,
}

const HINT = { component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as const

test('formats model, git and bars', () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 1M')
  expect(prettyModel('Opus 5.5')).toBe('Opus 5.5')
  expect(parseGit('# branch.oid abc\n# branch.head main\n# branch.ab +2 -1\n1 .M x')).toEqual({
    branch: 'main',
    dirty: true,
    ahead: 2,
    behind: 1,
  })
  expect(bar(50).map(s => s.text).join('')).toBe('████████')
  expect(bar(50)[0]?.text).toBe('████')
})

test('segments carry every figure in skin slots', () => {
  const groups = segments(SNAP, new Date('2026-10-15T10:00:00Z'))
  const text = groups.map(g => g.map(s => s.text).join('')).join(' | ')
  expect(text).toContain('◆ Opus 5.5 | demo-app ⎇ main ● ↑2')
  expect(text).toContain('84k')
  expect(text).toContain('64%')
  expect(text).toContain('91%')
  expect(text).toContain('$1.23')
  expect(groups[0]?.[0]?.slot).toBe('write')
  expect(groups.flat().find(s => s.text === ' 91%')?.slot).toBe('err')
})

test('palette follows the skin, made skins and light terminals', () => {
  expect(paletteFor('nord', {}, false)).toEqual(SKINS.nord!.dark)
  expect(paletteFor('gone', {}, false)).toEqual(SKINS.gruvbox!.dark)
  expect(paletteFor('mine', { mine: { base: 'dracula', palette: { write: '#123456' } } }, false)).toEqual({
    ...SKINS.dracula!.dark,
    write: '#123456',
  })
  expect(paletteFor('gruvbox', {}, true).fg).toBe(SKINS.gruvbox!.light?.fg ?? '#1f1f1f')
})

test('the hint line under the prompt draws the status, the hint after it', async ($, on) => {
  mock.clock(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: 'C:\\code\\demo-app' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, tokens: 84_000, percent: 42 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 63.5, resetsAt: '2026-10-15T14:00:00Z' }],
      cost: { usd: 1.234 },
    },
  }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: '# branch.oid abc\n# branch.head main\n# branch.ab +2 -0\n1 .M x\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('ui.status', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'C:\\code\\demo-app', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'lookout', surface, ...HINT })
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⎇ main/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$1\.23/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /for shortcuts/ })).toBeDefined()
    expect(await ui.keepsBeneath()).toBe(false)
    await ui.unmount()
  }
})

test('a narrow line splits into exactly two rows before the budget', () => {
  const groups = segments(SNAP as never, new Date('2026-10-15T10:00:00Z'))
  expect(statusRows(groups, 400)).toEqual([groups.map((_, i) => i)])
  const rows = statusRows(groups, 60)
  expect(rows.length).toBe(2)
  expect(groups[rows[1]![0]!]![0]!.text).toBe('ctx ')
  expect(statusRows(groups, 10).length).toBe(2)
})
