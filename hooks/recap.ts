import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { HubRecap } from '../types'

export const recap = atom({ plugin: 'lookout', key: 'recap' } as const, null as HubRecap | null)

const AWAY_MS = 10 * 60_000

let lastInputAt = 0
let isChecked = false

export async function loadRecap($: EngineInterface, isAsked: boolean): Promise<void> {
  try {
    const me = await $.session.id()
    const run = await $.process.run(['bun', `${$.plugin.root}/scripts/collect.mjs`, '--recap', me], { timeoutMs: 20_000 })
    if (run.exitCode !== 0) return
    const value = JSON.parse(run.stdout) as Omit<HubRecap, 'isAsked'>
    const items = value.items.filter(item => item.g !== '?' && (item.g !== 'E' || isAsked))
    if (!items.length && !isAsked) return
    await update($, recap, () => ({ ...value, items, isAsked }))
  } catch {}
}

export async function recapStart($: EngineInterface): Promise<void> {
  lastInputAt = await $.clock.now()
  isChecked = false
  await update($, recap, () => null)
  $.clock.every(60_000, () => {
    void (async () => {
      if (isChecked || (await $.clock.now()) - lastInputAt < AWAY_MS) return
      isChecked = true
      await loadRecap($, false)
    })()
  })
}

export async function recapInput($: EngineInterface): Promise<void> {
  lastInputAt = await $.clock.now()
  isChecked = false
  if (await read($, recap)) await update($, recap, () => null)
}
