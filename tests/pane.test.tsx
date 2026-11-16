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
