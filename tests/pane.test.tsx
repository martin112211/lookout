import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'lookout',
  component: 'Pane',
  requestId: 'lookout',
  props: { title: 'Sessions', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('the sessions pane draws on the terminal and on desktop', async ($, on) => {
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /0 live/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /0 need/ })).toBeDefined()
    await ui.unmount()
  }
})

test('without a recap the band above the prompt is left to the others', async ($, on) => {
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'lookout', component: 'AbovePrompt', surface, props: { hasSurvey: false } as never })
    expect(await ui.find({ type: 'Text', text: /Lookout/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the session box sets brief, agents and conversation apart', async ($, on) => {
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  const session = {
    sessionId: 's1', pid: 1, name: 'demo', cwd: '/w/demo', kind: 'interactive', waitingOnPerson: false,
    brief: { goal: 'Ship it' },
    agents: [{ id: 'a1', type: 'Explore', description: 'Find the files', model: 'claude-haiku-5-5', state: 'running', updatedAt: 1_799_999_990_000 }],
  }
  const detail = { sessionId: 's1', messages: [{ role: 'user', at: '2027-01-15T07:59:00.000Z', text: 'hello' }] }
  on('process.run', ($, e) => {
    const out = (value: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(value), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv.includes('--detail')) return out(detail)
    if (e.argv.includes('--read')) return out({ at: 0 })
    return out([session])
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /demo · 1 agent running/ })).toBeDefined()
  await ui.press({ key: 'pick-s1' })
  expect(await ui.find({ type: 'Text', text: /^── Brief ─+$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^── Agents · a: next/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^── Conversation · last messages ─+$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^You · / })).toBeDefined()
  await ui.unmount()
})
