import { CATCH_ALL_TYPES } from './routing'
export { PROTECTED_RULES } from './routing'

export const MODEL_CHOICES = ['inherit', 'haiku', 'sonnet', 'opus', 'fable'] as const
export type ModelChoice = (typeof MODEL_CHOICES)[number]

export const EFFORT_CHOICES = ['inherit', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortChoice = (typeof EFFORT_CHOICES)[number]

export type RouteRule = {
  id: string
  label: string
  types: string[]
  model: ModelChoice
  effort: EffortChoice
}

export const TIERS = ['light', 'standard', 'deep'] as const
export type Tier = (typeof TIERS)[number]
export const CLASSIFIER_MODES = ['off', 'unsure', 'always'] as const
export type ClassifierMode = (typeof CLASSIFIER_MODES)[number]
export type TierSetting = { model: ModelChoice; effort: EffortChoice; words: string[] }
export const PROFILES = ['quality', 'balanced', 'economy', 'custom'] as const
export type Profile = (typeof PROFILES)[number]
type Pick2 = { model: ModelChoice; effort: EffortChoice }
type Preset = { tiers: Record<Tier, Pick2>; rules: Record<string, Pick2> }


export const PRESETS: Record<Exclude<Profile, 'custom'>, Preset> = {
  quality: {
    tiers: { light: { model: 'inherit', effort: 'inherit' }, standard: { model: 'inherit', effort: 'inherit' }, deep: { model: 'inherit', effort: 'high' } },
    rules: { explore: { model: 'inherit', effort: 'inherit' }, review: { model: 'inherit', effort: 'high' }, plan: { model: 'inherit', effort: 'high' }, docs: { model: 'inherit', effort: 'inherit' }, implement: { model: 'inherit', effort: 'inherit' } },
  },
  balanced: {
    tiers: { light: { model: 'haiku', effort: 'low' }, standard: { model: 'inherit', effort: 'medium' }, deep: { model: 'inherit', effort: 'high' } },
    rules: { explore: { model: 'haiku', effort: 'low' }, review: { model: 'inherit', effort: 'high' }, plan: { model: 'inherit', effort: 'high' }, docs: { model: 'inherit', effort: 'medium' }, implement: { model: 'inherit', effort: 'medium' } },
  },
  economy: {
    tiers: { light: { model: 'haiku', effort: 'low' }, standard: { model: 'sonnet', effort: 'high' }, deep: { model: 'opus', effort: 'high' } },
    rules: { explore: { model: 'haiku', effort: 'low' }, review: { model: 'opus', effort: 'high' }, plan: { model: 'opus', effort: 'high' }, docs: { model: 'sonnet', effort: 'medium' }, implement: { model: 'sonnet', effort: 'high' } },
  },
}

export const LOOKS = ['calm', 'warm', 'editorial'] as const
export const MODES = ['system', 'dark', 'light'] as const
export type Look = (typeof LOOKS)[number]
export type Mode = (typeof MODES)[number]

export type HubConfig = {
  appearance: { look: Look; mode: Mode }
  features: {
    brief: { on: boolean; model: ModelChoice; everySec: number }
    ledger: { on: boolean }
    radar: { on: boolean; windowHours: number }
    leases: { on: boolean; waitMin: number; commit: boolean; integration: boolean }
    budgetGuard: { on: boolean; percent: number }
    hubAnswers: { on: boolean }
    relay: { on: boolean }
    statusLine: { on: boolean }
    gitPane: { on: boolean }
    skinsColors: { on: boolean }
    cacheTax: { on: boolean }
  }
  orchestrator: {
    on: boolean
    onlyWhenUnset: boolean
    downgrade: { on: boolean; percent: number }
    profile: Profile
    protectJudgment: boolean
    routeModel: boolean
    routeEffort: boolean
    classifier: ClassifierMode
    escalate: boolean
    tiers: Record<Tier, TierSetting>
    rules: RouteRule[]
  }
}

export const FEATURE_LABELS: Record<keyof HubConfig['features'], string> = {
  brief: 'Session brief',
  ledger: 'Decision ledger',
  radar: 'Collision radar',
  leases: 'Leases (commit, integration tests)',
  budgetGuard: 'Budget guard',
  hubAnswers: 'Answer from Lookout',
  relay: 'Lookout messages as own input',
  statusLine: 'Status line under the prompt',
  gitPane: 'Git pane (/git)',
  skinsColors: 'Integration: skins colours',
  cacheTax: 'Integration: cache-tax in the status line',
}

export const DEFAULT_CONFIG: HubConfig = {
  appearance: { look: 'calm', mode: 'system' },
  features: {
    brief: { on: true, model: 'haiku', everySec: 60 },
    ledger: { on: true },
    radar: { on: true, windowHours: 6 },
    leases: { on: true, waitMin: 15, commit: true, integration: true },
    budgetGuard: { on: true, percent: 90 },
    hubAnswers: { on: true },
    relay: { on: true },
    statusLine: { on: true },
    gitPane: { on: true },
    skinsColors: { on: true },
    cacheTax: { on: true },
  },
  orchestrator: {
    on: false,
    onlyWhenUnset: true,
    downgrade: { on: false, percent: 75 },
    profile: 'quality',
    protectJudgment: true,
    routeModel: true,
    routeEffort: true,
    classifier: 'unsure',
    escalate: true,
    tiers: {
      light: { model: 'inherit', effort: 'inherit', words: ['search', 'find', 'locate', 'look up', 'grep', 'list', 'scan', 'inventory', 'which files', 'where is', 'where are'] },
      standard: { model: 'inherit', effort: 'inherit', words: ['implement', 'build', 'fix', 'add', 'write', 'test', 'update', 'rename', 'refactor', 'docs', 'readme', 'changelog'] },
      deep: { model: 'inherit', effort: 'high', words: ['architecture', 'design', 'plan', 'security', 'audit', 'review', 'root cause', 'debug', 'investigate', 'migration', 'race condition', 'concurrency', 'performance', 'trade-off', 'tradeoff'] },
    },
    rules: [
      { id: 'explore', label: 'Explore and search', types: ['Explore', 'claude-code-guide'], model: 'inherit', effort: 'inherit' },
      { id: 'review', label: 'Review and verification', types: ['*review*', '*verifier*', '*auditor*', '*checker*'], model: 'inherit', effort: 'high' },
      { id: 'plan', label: 'Planning and architecture', types: ['Plan', '*planner*', '*architect*'], model: 'inherit', effort: 'high' },
      { id: 'docs', label: 'Docs and writing', types: ['*doc*'], model: 'inherit', effort: 'inherit' },
      { id: 'implement', label: 'Implementation', types: ['*executor*', '*fixer*'], model: 'inherit', effort: 'inherit' },
    ],
  },
}

type Loose = Record<string, unknown>

function isObject(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback
}

function effort(value: unknown, fallback: EffortChoice): EffortChoice {
  return (EFFORT_CHOICES as readonly string[]).includes(String(value)) ? (value as EffortChoice) : fallback
}

function model(value: unknown, fallback: ModelChoice): ModelChoice {
  return (MODEL_CHOICES as readonly string[]).includes(String(value)) ? (value as ModelChoice) : fallback
}

function words(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  return value
    .map(one => String(one).trim())
    .filter(Boolean)
    .slice(0, 24)
    .map(one => one.slice(0, 60))
}

function pick(source: unknown, key: string): Loose {
  return isObject(source) && isObject(source[key]) ? (source[key] as Loose) : {}
}

export function sanitizeConfig(raw: unknown): HubConfig {
  const d = DEFAULT_CONFIG
  const f = pick(raw, 'features')
  const brief = pick(f, 'brief')
  const radar = pick(f, 'radar')
  const leases = pick(f, 'leases')
  const guard = pick(f, 'budgetGuard')
  const o = pick(raw, 'orchestrator')
  const down = pick(o, 'downgrade')
  const givenRules = Array.isArray(o.rules) ? (o.rules as unknown[]).filter(isObject) : undefined
  const rules = (givenRules ?? d.orchestrator.rules).slice(0, 20).map((rule, index) => {
    const base = d.orchestrator.rules.find(one => one.id === rule.id) ?? d.orchestrator.rules[index] ?? d.orchestrator.rules[0]!
    return {
      id: String(rule.id ?? base.id).slice(0, 40),
      label: String(rule.label ?? base.label).slice(0, 80),
      types: words(rule.types, base.types).filter(type => !CATCH_ALL_TYPES.includes(type)),
      model: model(rule.model, base.model),
      effort: effort(rule.effort, base.effort ?? 'inherit'),
    }
  })
  const look = pick(raw, 'appearance')
  return {
    appearance: {
      look: (LOOKS as readonly string[]).includes(String(look.look)) ? (look.look as Look) : d.appearance.look,
      mode: (MODES as readonly string[]).includes(String(look.mode)) ? (look.mode as Mode) : d.appearance.mode,
    },
    features: {
      brief: { on: bool(brief.on, d.features.brief.on), model: model(brief.model, d.features.brief.model), everySec: num(brief.everySec, d.features.brief.everySec, 15, 3600) },
      ledger: { on: bool(pick(f, 'ledger').on, d.features.ledger.on) },
      radar: { on: bool(radar.on, d.features.radar.on), windowHours: num(radar.windowHours, d.features.radar.windowHours, 1, 72) },
      leases: {
        on: bool(leases.on, d.features.leases.on),
        waitMin: num(leases.waitMin, d.features.leases.waitMin, 1, 120),
        commit: bool(leases.commit, d.features.leases.commit),
        integration: bool(leases.integration, d.features.leases.integration),
      },
      budgetGuard: { on: bool(guard.on, d.features.budgetGuard.on), percent: num(guard.percent, d.features.budgetGuard.percent, 10, 100) },
      hubAnswers: { on: bool(pick(f, 'hubAnswers').on, d.features.hubAnswers.on) },
      relay: { on: bool(pick(f, 'relay').on, d.features.relay.on) },
      statusLine: { on: bool(pick(f, 'statusLine').on, d.features.statusLine.on) },
      gitPane: { on: bool(pick(f, 'gitPane').on, d.features.gitPane.on) },
      skinsColors: { on: bool(pick(f, 'skinsColors').on, d.features.skinsColors.on) },
      cacheTax: { on: bool(pick(f, 'cacheTax').on, d.features.cacheTax.on) },
    },
    orchestrator: {
      on: bool(o.on, d.orchestrator.on),
      onlyWhenUnset: bool(o.onlyWhenUnset, d.orchestrator.onlyWhenUnset),
      downgrade: { on: bool(down.on, d.orchestrator.downgrade.on), percent: num(down.percent, d.orchestrator.downgrade.percent, 10, 100) },
      profile: (PROFILES as readonly string[]).includes(String(o.profile)) ? (o.profile as Profile) : o.profile === undefined && !isObject(o.tiers) && !Array.isArray(o.rules) ? d.orchestrator.profile : 'custom',
      protectJudgment: bool(o.protectJudgment, d.orchestrator.protectJudgment),
      routeModel: bool(o.routeModel, d.orchestrator.routeModel),
      routeEffort: bool(o.routeEffort, d.orchestrator.routeEffort),
      classifier: (CLASSIFIER_MODES as readonly string[]).includes(String(o.classifier)) ? (o.classifier as ClassifierMode) : d.orchestrator.classifier,
      escalate: bool(o.escalate, d.orchestrator.escalate),
      tiers: Object.fromEntries(
        TIERS.map(tier => {
          const given = pick(pick(o, 'tiers'), tier)
          const base = d.orchestrator.tiers[tier]
          return [tier, { model: model(given.model, base.model), effort: effort(given.effort, base.effort), words: words(given.words, base.words) }]
        }),
      ) as Record<Tier, TierSetting>,
      rules,
    },
  }
}

export { draftRoute, routeAgent, routeTier, estimateTier } from './routing'
export type { RouteDecision, RouteInput, TierGuess } from './routing'

/** The config with a preset's models and efforts written into its tiers and rules; keywords and agent types stay. */
export function applyProfile(config: HubConfig, profile: Profile): HubConfig {
  const o = config.orchestrator
  if (profile === 'custom') return { ...config, orchestrator: { ...o, profile } }
  const preset = PRESETS[profile]
  const tiers = Object.fromEntries(TIERS.map(tier => [tier, { ...o.tiers[tier], ...preset.tiers[tier] }])) as Record<Tier, TierSetting>
  const rules = o.rules.map(rule => ({ ...rule, ...(preset.rules[rule.id] ?? {}) }))
  return { ...config, orchestrator: { ...o, profile, tiers, rules } }
}
