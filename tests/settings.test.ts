import { describe, expect, test } from 'claude-code/testing'

import { classifiedTier } from '../hooks/routing'
import { DEFAULT_CONFIG, applyProfile, estimateTier, routeAgent, sanitizeConfig } from '../hooks/settings'

const ON = sanitizeConfig({ ...DEFAULT_CONFIG, orchestrator: { ...DEFAULT_CONFIG.orchestrator, on: true, downgrade: { on: true, percent: 75 } } })

describe('settings', () => {
  test('invalid values fall back or are clamped', async () => {
    const config = sanitizeConfig({ features: { brief: { everySec: 2, model: 'gpt' }, cacheTax: { on: 'yes' } }, orchestrator: { on: 1, classifier: 'sometimes' } })
    expect(config.features.brief.everySec).toBe(15)
    expect(config.features.brief.model).toBe('haiku')
    expect(config.features.cacheTax.on).toBe(true)
    expect(config.orchestrator.on).toBe(false)
    expect(config.orchestrator.classifier).toBe('unsure')
    expect(config.orchestrator.rules.length).toBe(DEFAULT_CONFIG.orchestrator.rules.length)
  })

  test('the pinned brief ships on, an old config without it gets it, and it can be switched off', async () => {
    expect(DEFAULT_CONFIG.features.pinBrief.on).toBe(true)
    expect(sanitizeConfig({ features: { brief: { on: true } } }).features.pinBrief.on).toBe(true)
    expect(sanitizeConfig({ features: { pinBrief: { on: false } } }).features.pinBrief.on).toBe(false)
  })

  test('appearance accepts the three looks and falls back to calm', async () => {
    expect(sanitizeConfig({ appearance: { look: 'warm', mode: 'dark' } }).appearance).toEqual({ look: 'warm', mode: 'dark' })
    expect(sanitizeConfig({ appearance: { look: 'neon', mode: 'dim' } }).appearance).toEqual({ look: 'calm', mode: 'system' })
  })

  test('an old config that pinned general-purpose to a rule now lets the tiers decide', async () => {
    const old = sanitizeConfig({ orchestrator: { on: true, rules: [{ id: 'implement', label: 'Implementation', types: ['general-purpose', 'claude', '*executor*'], words: ['build'], model: 'sonnet' }] } })
    expect(old.orchestrator.rules[0]?.types).toEqual(['*executor*'])
    expect(routeAgent(applyProfile(old, 'balanced'), { subagentType: 'general-purpose', description: 'Find where the session id is read' })?.source).toBe('tier')
  })
})

describe('routing', () => {
  const BALANCED = applyProfile(ON, 'balanced')
  const ECONOMY = applyProfile(ON, 'economy')
  const IMPLEMENT = { subagentType: 'general-purpose', description: 'Implement the login form', prompt: 'Add the form to src/login.tsx and write a test.' }
  const LOOKUP = { subagentType: 'general-purpose', description: 'Find where the relay key is read', prompt: 'Search the repo and report back. Do not edit anything.' }
  const DEEP = { subagentType: 'general-purpose', description: 'Debug the race condition in the lease server', prompt: 'Look at scripts/server.mjs, hooks/hub.tsx, hooks/config.ts and scripts/hub-data.mjs.' }

  test('the orchestrator is off by default', async () => {
    expect(routeAgent(DEFAULT_CONFIG, { subagentType: 'Explore', description: 'find it' })).toBe(undefined)
  })

  test('quality, the default profile, never makes an agent weaker: it only adds effort to hard work', async () => {
    expect(ON.orchestrator.profile).toBe('quality')
    expect(routeAgent(ON, IMPLEMENT)).toBe(undefined)
    expect(routeAgent(ON, LOOKUP)).toBe(undefined)
    const deep = routeAgent(ON, { ...DEEP, sessionModel: 'opus', sessionEffort: 'medium' })
    expect(deep?.model).toBe(undefined)
    expect(deep?.effort).toBe('high')
    expect(routeAgent(ON, { subagentType: 'gsd-code-reviewer', description: 'x', sessionEffort: 'medium' })?.effort).toBe('high')
  })

  test('balanced keeps the session model and sends only pure lookups to haiku', async () => {
    const find = routeAgent(BALANCED, LOOKUP)
    expect(find?.tier).toBe('light')
    expect(find?.model).toBe('haiku')
    expect(find?.effort).toBe('low')
    const build = routeAgent(BALANCED, IMPLEMENT)
    expect(build?.model).toBe(undefined)
    expect(build?.effort).toBe('medium')
    expect(estimateTier(BALANCED, 'Find and summarize how the cache works', 'Search the code and report back.').tier).not.toBe('light')
  })

  test('economy uses sonnet for implementation', async () => {
    expect(routeAgent(ECONOMY, IMPLEMENT)?.model).toBe('sonnet')
    expect(routeAgent(ECONOMY, IMPLEMENT)?.effort).toBe('high')
  })

  test('protected work never runs below the session model or effort, in any profile', async () => {
    const onFable = routeAgent(ECONOMY, { ...DEEP, sessionModel: 'fable', sessionEffort: 'xhigh' })
    expect(onFable).toBe(undefined)
    const unprotected = sanitizeConfig({ ...ECONOMY, orchestrator: { ...ECONOMY.orchestrator, protectJudgment: false } })
    expect(routeAgent(unprotected, { ...DEEP, sessionModel: 'fable', sessionEffort: 'xhigh' })?.model).toBe('opus')
    const budget = sanitizeConfig({ ...ECONOMY, orchestrator: { ...ECONOMY.orchestrator, downgrade: { on: true, percent: 75 } } })
    expect(routeAgent(budget, { ...DEEP, weeklyPercent: 90, sessionModel: 'opus' })?.model).toBe('opus')
    expect(routeAgent(budget, { ...IMPLEMENT, weeklyPercent: 90 })?.model).toBe('haiku')
    expect(routeAgent(ECONOMY, DEEP)?.model).toBe(undefined)
  })

  test('catch-all agents get a tier from the task', async () => {
    expect(routeAgent(BALANCED, DEEP)?.tier).toBe('deep')
    expect(routeAgent(BALANCED, IMPLEMENT)?.tier).toBe('standard')
    expect(routeAgent(BALANCED, { subagentType: 'custom-agent', description: 'Review the diff for security issues' })?.tier).toBe('deep')
    expect(routeAgent(BALANCED, { subagentType: 'Explore', description: 'implement' })?.model).toBe('haiku')
  })

  test('a task that edits never goes to the light tier, nor does a long brief', async () => {
    expect(estimateTier(ON, 'Find and fix the broken import', 'Search for the import and fix it.').tier).toBe('standard')
    expect(estimateTier(ON, 'Search the docs', `Search and list. ${'context '.repeat(800)}`).tier).toBe('standard')
  })

  test('judgment and hard-to-see bugs count as deep, but a read-only lookup stays out', async () => {
    expect(estimateTier(ON, 'Verify the fix is correct', 'Check whether the fix in commit abc123 actually solves the deadlock.').tier).toBe('deep')
    expect(estimateTier(ON, 'Find why tests are flaky', 'Tests fail one in five runs. Find the root cause.').tier).toBe('deep')
    expect(estimateTier(ON, 'Compare three state libraries', 'Research zustand, jotai and redux toolkit and recommend one.').tier).toBe('deep')
    expect(estimateTier(ON, 'Find files that compare dates', 'Search for functions that compare dates and list them. Do not edit.').tier).not.toBe('deep')
    expect(estimateTier(ON, 'Add a regression test', 'Add a regression test for the date bug in tests/date.test.ts.').tier).toBe('standard')
  })

  test('the classifier cannot send excluded work to the light tier, nor lower a deep task', async () => {
    const recap = estimateTier(ON, 'Look into how the recap timer works', 'Read hooks/recap.ts and explain in three sentences when the band appears.')
    expect(recap.canBeLight).toBe(false)
    expect(classifiedTier(recap, 'light')).toBe('standard')
    expect(classifiedTier({ tier: 'deep', canBeLight: true }, 'standard')).toBe('deep')
    expect(classifiedTier({ tier: 'standard', canBeLight: true }, 'light')).toBe('light')
    expect(estimateTier(ON, 'Review the protection floor', 'Review finish() for logic bugs. Do not edit anything. Report at most three findings.').tier).toBe('deep')
  })

  test('an unclear task is marked unsure, so the classifier can decide', async () => {
    expect(estimateTier(ON, 'Look into the cache tax numbers', '').isSure).toBe(false)
  })

  test('model and effort have their own switches, and an explicit choice wins', async () => {
    const effortOnly = sanitizeConfig({ ...BALANCED, orchestrator: { ...BALANCED.orchestrator, routeModel: false } })
    const modelOnly = sanitizeConfig({ ...ECONOMY, orchestrator: { ...ECONOMY.orchestrator, routeEffort: false } })
    expect(routeAgent(effortOnly, LOOKUP)?.model).toBe(undefined)
    expect(routeAgent(effortOnly, LOOKUP)?.effort).toBe('low')
    expect(routeAgent(modelOnly, IMPLEMENT)?.model).toBe('sonnet')
    expect(routeAgent(modelOnly, IMPLEMENT)?.effort).toBe(undefined)
    expect(routeAgent(ECONOMY, { ...IMPLEMENT, model: 'opus', effort: 'high' })).toBe(undefined)
    expect(routeAgent(ECONOMY, { ...IMPLEMENT, model: 'opus' })?.model).toBe(undefined)
    expect(routeAgent(ECONOMY, { ...IMPLEMENT, model: 'opus' })?.effort).toBe('high')
  })

  test('forks are never routed, and a hand-edited value turns the profile to custom', async () => {
    expect(routeAgent(BALANCED, { subagentType: 'fork', description: 'plan' })).toBe(undefined)
    expect(sanitizeConfig({ orchestrator: { tiers: { light: { model: 'sonnet' } } } }).orchestrator.profile).toBe('custom')
  })
})
