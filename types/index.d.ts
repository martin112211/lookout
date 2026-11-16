export type HubSession = {
  sessionId: string
  pid: number
  name: string
  cwd: string
  kind: string
  entrypoint?: string
  status?: string
  statusUpdatedAt?: number
  startedAt?: number
  title?: string
  lastUser?: string
  lastAssistant?: string
  lastAt?: string
  waitingOnPerson: boolean
  waitingFor?: string
  live?: HubLiveItem[]
  brief?: HubBrief
  question?: HubQuestion[]
  pendingTool?: { name: string; summary?: string }
  currentTool?: { name: string; summary?: string }
  hasHubMod?: boolean
  model?: string
  contextTokens?: number
  activity?: number[]
  agents?: HubAgent[]
  branch?: string
  workItem?: string
  usage?: { at: number; contextPercent?: number }
  repo?: { root: string; name: string }
  shared?: { path: string; at: number; others: string[] }[]
  lastReadAt?: number
  unread?: number
  catchup?: HubCatchupItem[]
}

export type HubAgent = { id: string; type?: string; description?: string; model?: string; state: 'running' | 'stalled' | 'done'; updatedAt: number }

export type HubCatchupItem = { g: string; t?: number; text: string }

export type HubRecap = { since: number; unread: number; items: HubCatchupItem[]; isAsked: boolean }

export type HubLiveItem = {
  id: string
  kind: 'question' | 'permission' | 'plan'
  tool: string
  at: number
  questions?: HubQuestion[]
  summary?: string
}

export type HubQuestion = {
  question: string
  header?: string
  multiSelect?: boolean
  options?: { label: string; description?: string }[]
}

export type HubBrief = {
  at: number
  goal?: string
  decided?: string[]
  next?: string
  blocked?: string
}

export type HubLedgerEntry = {
  at: number
  sessionId: string
  title?: string
  cwd?: string
  kind: 'answer' | 'decision'
  question?: string
  text: string
}

export type HubMessage = { role: 'user' | 'assistant'; at?: string; text: string }

export type HubDetail = { sessionId: string; messages: HubMessage[] }

export type HubAgentStep = { kind: 'tool' | 'result' | 'text'; at?: string; name?: string; text: string; isError?: boolean }

export type HubAgentDetail = {
  sessionId: string
  agentId: string
  type?: string
  description?: string
  model?: string
  effort?: string
  isBackground?: boolean
  state: HubAgent['state']
  updatedAt: number
  prompt?: string
  steps: HubAgentStep[]
}

export type GitInfo = { branch: string; dirty: boolean; ahead: number; behind: number }

export type Limit = { kind: string; percent: number; resetsAt?: string }

export type Snapshot = {
  model?: string
  folder?: string
  git?: GitInfo
  ctx?: { percent: number; tokens?: number }
  limits: Limit[]
  costUsd?: number
  hub?: HubCounts
  cacheTax?: string
}

export type HubCounts = { others: number; waiting: number; working: number }


export type FileChange = { path: string; status: string; added: number; removed: number }
export type Commit = { hash: string; refs: string[]; subject: string; time: number; isAhead: boolean }
export type GitSnapshot = {
  branch: string
  ahead: number | null
  behind: number | null
  base: string | null
  files: FileChange[]
  commits: Commit[]
}


declare module 'claude-code' {
  interface PluginState {
    lookout: {
      sessions: Shaped<HubSession[]>
      refreshedAt: number
      selected: string | null
      detail: Shaped<HubDetail | null>
      agentView: Shaped<HubAgentDetail | null>
      notice: string | null
      selfId: string | null
      askDraft: Record<string, Record<string, string>>
      settingsTick: number
      statusSnapshot: Snapshot | null
      gitSnapshot: GitSnapshot | null
      cacheTaxText: string | null
      recap: HubRecap | null
      paneDraft: Record<string, string>
    }
  }
}
