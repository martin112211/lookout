import type { EffortChoice, HubConfig, ModelChoice, RouteRule, Tier } from './settings'

export type RouteInput = {
  subagentType: string
  description: string
  prompt?: string
  model?: string
  effort?: string
  weeklyPercent?: number
  /** The session's model and effort: protected work never runs below them. */
  sessionModel?: string
  sessionEffort?: string
}
/** canBeLight: no edits, no analysis and a short brief, the only work a classifier may send to the light tier. */
export type TierGuess = { tier: Tier; isSure: boolean; canBeLight: boolean; reasons: string[] }
export type RouteDecision = {
  source: 'type' | 'tier' | 'classifier'
  rule?: RouteRule
  tier?: Tier
  model?: string
  effort?: string
  isDowngraded: boolean
  isSure: boolean
  canBeLight?: boolean
  reasons: string[]
}

export const CATCH_ALL_TYPES = ['general-purpose', 'claude']

/** Rules whose work is judgment: never weaker than the session while protectJudgment is on. */
export const PROTECTED_RULES = ['review', 'plan']

const CHEAPER: Record<string, string> = { opus: 'sonnet', fable: 'opus', sonnet: 'haiku' }
const RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 }
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']

function effortRank(effort: string | undefined): number {
  return EFFORT_ORDER.indexOf(effort ?? '')
}

export function nextEffortUp(effort: string | undefined): string | undefined {
  const index = EFFORT_ORDER.indexOf(effort ?? '')
  return index >= 0 && index < 2 ? EFFORT_ORDER[2] : undefined
}
const PATH = /(?:^|[\s`'"(])((?:[\w.-]+[\\/])*[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|sql|md|json|ya?ml|toml|css|scss|html|vue|svelte|sh|ps1))\b/g
const EDIT = /\b(implement|edit|change|modify|write|fix|add|create|update|refactor|rename|delete|remove|commit|migrate)\b/
const ANALYSIS = /\b(analy[sz]e|assess|evaluate|compare|explain|why|understand|summari[sz]e|research|investigate|review|judge|decide|recommend)\b/
/** Judgment and hard-to-see bugs: count toward deep whatever words a config keeps. */
const JUDGMENT = /\b(verify|check whether|whether (?:it|this|the \w+) (?:is|actually)|correctness|compare|recommend|weigh|pros and cons|flaky|intermittent(?:ly)?|deadlock|memory leak|leaks?|why (?:does|do|is|are|did))\b/g
const READ_ONLY = /\b(do not (?:edit|change|modify|write)|don't (?:edit|change|modify|write)|read[- ]only|report back|only report|no changes|without changing)\b/
const TASK_HEAD = 1500
const LONG_BRIEF = 4000

export function modelRank(model: string | undefined): number {
  const key = /(haiku|sonnet|opus|fable)/i.exec(model ?? '')?.[1]?.toLowerCase()
  return key ? (RANK[key] ?? 0) : 0
}

export function nextModelUp(model: string): string | undefined {
  return Object.entries(CHEAPER).find(([, cheaper]) => cheaper === model)?.[0]
}

export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value.toLowerCase())
}

/** Deep words match as stems (debug, debugging); light words as whole words, so "findings" is no "find". */
function hits(words: string[], text: string, isWhole = false): string[] {
  const end = isWhole ? '(?:s|es|ed|ing)?\\b' : ''
  return words.filter(word => new RegExp(`\\b${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${end}`).test(text))
}

/** Difficulty of a catch-all agent's task, from the description and the head of its prompt. */
export function estimateTier(config: HubConfig, description: string, prompt = ''): TierGuess {
  const tiers = config.orchestrator.tiers
  const d = description.toLowerCase()
  const p = prompt.slice(0, TASK_HEAD).toLowerCase()
  const reasons: string[] = []
  const deepWords = [...new Set([...hits(tiers.deep.words, d), ...hits(tiers.deep.words, p)])]
  const lightWords = [...new Set([...hits(tiers.light.words, d, true), ...hits(tiers.light.words, p, true)])]
  const standardWords = hits(tiers.standard.words, d)
  const files = new Set([...prompt.matchAll(PATH)].map(match => match[1])).size
  const isReadOnly = READ_ONLY.test(`${d}\n${p}`)
  const isEditing = !isReadOnly && (EDIT.test(d) || EDIT.test(p))
  const judgment = (text: string) => new Set(text.match(JUDGMENT) ?? []).size
  const judgmentWords = [...new Set([...(d.match(JUDGMENT) ?? []), ...(p.match(JUDGMENT) ?? [])])]
  const deep = hits(tiers.deep.words, d).length * 2 + hits(tiers.deep.words, p).length + judgment(d) * 2 + judgment(p) + (files >= 3 ? 2 : 0) + (files >= 3 && isEditing ? 1 : 0) + (prompt.length > 6000 ? 1 : 0)
  const light = hits(tiers.light.words, d, true).length * 2 + hits(tiers.light.words, p, true).length + (isReadOnly ? 2 : 0) - (isEditing ? 3 : 0)
  if (deepWords.length) reasons.push(`deep: ${deepWords.slice(0, 3).join(', ')}`)
  if (judgmentWords.length) reasons.push(`judgment: ${judgmentWords.slice(0, 3).join(', ')}`)
  if (lightWords.length) reasons.push(`light: ${lightWords.slice(0, 3).join(', ')}`)
  if (files) reasons.push(`${files} file${files > 1 ? 's' : ''} named`)
  if (isReadOnly) reasons.push('read-only')
  if (isEditing) reasons.push('edits')
  if (prompt.length > LONG_BRIEF) reasons.push(`${Math.round(prompt.length / 1000)}k brief`)
  const isAnalysis = ANALYSIS.test(d) || ANALYSIS.test(p)
  const canBeLight = !isEditing && !isAnalysis && judgmentWords.length === 0 && prompt.length <= LONG_BRIEF
  if (deep >= 3 && (deep > light || (judgmentWords.length > 0 && !isReadOnly))) return { tier: 'deep', isSure: deep >= 4, canBeLight, reasons }
  if (isAnalysis && light >= 3) reasons.push('analysis: not light')
  if (light >= 3 && canBeLight) return { tier: 'light', isSure: light >= 4, canBeLight, reasons }
  const isSure = (isEditing || standardWords.length > 0) && deep < 2 && light < 2
  return { tier: 'standard', isSure, canBeLight, reasons }
}

/**
 * The tier a classifier's pick may set: it never sends work to the light tier
 * that the light rules exclude, and never lowers a task the words found deep.
 */
export function classifiedTier(guess: Pick<TierGuess, 'tier' | 'canBeLight'>, picked: Tier): Tier {
  if (guess.tier === 'deep') return 'deep'
  if (picked === 'light' && !guess.canBeLight) return 'standard'
  return picked
}

export type Draft = Omit<RouteDecision, 'isDowngraded' | 'model' | 'effort'> & { model: ModelChoice; effort: EffortChoice }

function finish(config: HubConfig, draft: Draft, input: RouteInput): RouteDecision | undefined {
  const o = config.orchestrator
  const isModelFree = !(o.onlyWhenUnset && input.model && input.model !== 'inherit')
  const isEffortFree = !(o.onlyWhenUnset && input.effort)
  let model: string | undefined = o.routeModel && isModelFree && draft.model !== 'inherit' ? draft.model : undefined
  let effort: string | undefined = o.routeEffort && isEffortFree && draft.effort !== 'inherit' ? draft.effort : undefined
  const reasons = [...draft.reasons]
  const isProtected = o.protectJudgment && (draft.tier === 'deep' || (draft.source === 'type' && PROTECTED_RULES.includes(draft.rule?.id ?? '')))
  const isOver = o.downgrade.on && input.weeklyPercent !== undefined && input.weeklyPercent >= o.downgrade.percent
  const cheaper = isOver && model && !isProtected ? CHEAPER[model] : undefined
  if (cheaper) {
    model = cheaper
    reasons.push(`budget at ${Math.round(input.weeklyPercent ?? 0)} %`)
  }
  if (isProtected && model && (!modelRank(input.sessionModel) || modelRank(model) < modelRank(input.sessionModel))) {
    model = undefined
    reasons.push(modelRank(input.sessionModel) ? 'protected: session model' : 'protected: session model unknown')
  }
  if (isProtected && effort && effortRank(effort) < effortRank(input.sessionEffort)) {
    effort = undefined
    reasons.push('protected: session effort')
  }
  if (!model && !effort) return undefined
  return { ...draft, model, effort, isDowngraded: Boolean(cheaper), reasons }
}

/** The tier a classifier picked, turned into a decision. */
export function routeTier(config: HubConfig, tier: Tier, input: RouteInput, reasons: string[]): RouteDecision | undefined {
  const setting = config.orchestrator.tiers[tier]
  return finish(config, { source: 'classifier', tier, model: setting.model, effort: setting.effort, isSure: true, reasons }, input)
}

/** What the orchestrator recognizes for a call, before any switch or protection: also logged when nothing changes. */
export function draftRoute(config: HubConfig, input: RouteInput): Draft | undefined {
  const o = config.orchestrator
  if (input.subagentType === 'fork') return undefined
  const rule = CATCH_ALL_TYPES.includes(input.subagentType) ? undefined : o.rules.find(one => one.types.some(type => globMatch(type, input.subagentType)))
  if (rule) return { source: 'type', rule, model: rule.model, effort: rule.effort, isSure: true, reasons: [`agent type ${input.subagentType}`] }
  const guess = estimateTier(config, input.description, input.prompt)
  const setting = o.tiers[guess.tier]
  return { source: 'tier', tier: guess.tier, model: setting.model, effort: setting.effort, isSure: guess.isSure, canBeLight: guess.canBeLight, reasons: guess.reasons }
}

export function routeAgent(config: HubConfig, input: RouteInput): RouteDecision | undefined {
  if (!config.orchestrator.on) return undefined
  const draft = draftRoute(config, input)
  return draft ? finish(config, draft, input) : undefined
}
