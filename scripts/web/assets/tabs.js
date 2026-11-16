/* Tabs next to the overview: Decisions, Time, Settings. */

async function loadLedger() {
  try {
    state.ledger = (await api('/api/ledger')).entries
    if (state.tab === 'decisions') renderDecisions()
  } catch (error) {
    toast(`Could not load decisions: ${error.message}`, true)
  }
}

function renderDecisions() {
  const el = $('tab-decisions')
  if (el.contains(document.activeElement) && document.activeElement.id !== 'ledger-filter' && document.activeElement.tagName === 'INPUT') return
  const head = `<div class="panel-head"><h3>Decisions</h3><span class="muted">Your answers and the decisions the session briefs picked up.</span><input class="field" id="ledger-filter" placeholder="Search decisions" value="${esc(state.ledgerQuery)}"></div>`
  let body
  if (!state.ledger) body = '<span class="hint">Loading…</span>'
  else {
    const q = state.ledgerQuery.trim().toLowerCase()
    const list = state.ledger.filter(e => !q || [e.text, e.question, e.title, e.cwd].some(v => String(v || '').toLowerCase().includes(q)))
    state.ledgerShown = list
    if (!list.length) body = `<span class="hint">${state.ledger.length ? 'No match.' : 'No decisions yet. They appear once sessions with the lookout mod get answers or write briefs.'}</span>`
    else {
      let day = ''
      body = list.map((e, i) => {
        const d = new Date(e.at).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: '2-digit' })
        const label = d !== day ? `<div class="ledger-day">${esc(d)}</div>` : ''
        day = d
        const live = state.sessions.some(s => s.sessionId === e.sessionId)
        return `${label}<div class="lentry"><time>${esc(clock(e.at))}</time><div>${e.question ? `<div class="q">${esc(e.question)}</div>` : ''}<div>${esc(e.text)}</div><div class="src">${esc(e.kind)} · ${esc(e.title || String(e.sessionId).slice(0, 8))}${e.cwd ? ` · ${esc(folderOf(e.cwd))}` : ''}</div></div><div class="acts"><button type="button" class="btn sm" data-l-copy="${i}">Copy</button>${live ? `<button type="button" class="btn sm" data-l-mem="${i}" title="Ask that session to write it to memory">Save as memory</button>` : ''}</div></div>`
      }).join('')
    }
  }
  const focused = document.activeElement?.id === 'ledger-filter'
  el.innerHTML = `<div class="panel">${head}${body}</div>`
  if (focused) { const f = $('ledger-filter'); f.focus(); f.setSelectionRange(f.value.length, f.value.length) }
}

async function ledgerToMemory(entry) {
  const text = `Please save this owner decision as a memory note, following the memory rules (check for an existing note first): ${entry.question ? `Question: "${entry.question}". Answer: ` : ''}"${entry.text}" (decided ${new Date(entry.at).toLocaleString()}).`
  const session = state.sessions.find(s => s.sessionId === entry.sessionId)
  if (session) await sendText(session, text, 'Memory request')
}

async function loadTime() {
  try {
    state.time = await api(`/api/time?days=${state.timeDays}`)
    if (state.tab === 'time') renderTime()
  } catch (error) {
    toast(`Could not load time: ${error.message}`, true)
  }
}

function hours(ms) {
  return ms ? (ms / 3600_000).toFixed(1) : ''
}

function renderTime() {
  const head = `<div class="panel-head"><h3>Time per work item</h3><span class="muted">Active session time: gaps over five minutes do not count. A session counts toward the item it mentioned last.</span><span class="seg"><button type="button" data-days="7" aria-pressed="${state.timeDays === 7}">7 days</button><button type="button" data-days="14" aria-pressed="${state.timeDays === 14}">14 days</button></span></div>`
  if (!state.time) { $('tab-time').innerHTML = `<div class="panel">${head}<span class="hint">Reading transcripts…</span></div>`; return }
  const { days, items } = state.time
  const max = Math.max(1, ...items.flatMap(r => Object.values(r.perDay)))
  const cell = ms => (ms ? `<span class="heatcell" style="background:color-mix(in srgb, var(--run) ${Math.round(12 + (ms / max) * 55)}%, transparent)">${hours(ms)}</span>` : '')
  const rows = items.map(r => {
    const open = state.openItems.has(r.item)
    const label = r.item === '-' ? 'No work item' : itemLabel(r.item)
    const sub = open ? r.sessions.map(s => `<tr class="sub"><td style="padding-left:24px">${esc(s.title || s.sessionId.slice(0, 8))}</td>${days.map(() => '<td></td>').join('')}<td class="num">${hours(s.ms)}</td><td></td></tr>`).join('') : ''
    return `<tr class="click" data-item="${esc(r.item)}"><td><b class="mono">${open ? '▾' : '▸'} ${esc(label)}</b> <span class="hint">${r.sessions.length} session${r.sessions.length > 1 ? 's' : ''}</span></td>${days.map(d => `<td class="num">${cell(r.perDay[d])}</td>`).join('')}<td class="num"><b>${hours(r.total)}</b></td><td><button type="button" class="btn sm" data-copy-time="${esc(r.item)}">Copy</button></td></tr>${sub}`
  }).join('')
  const totals = days.map(d => items.reduce((sum, r) => sum + (r.perDay[d] || 0), 0))
  $('tab-time').innerHTML = `<div class="panel">${head}<div class="scroll-x"><table class="grid"><thead><tr><th>Work item</th>${days.map(d => `<th class="num">${esc(new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: '2-digit' }))}</th>`).join('')}<th class="num">Hours</th><th></th></tr></thead><tbody>${rows}<tr><td><b>All</b></td>${totals.map(t => `<td class="num"><b>${hours(t)}</b></td>`).join('')}<td class="num"><b>${hours(totals.reduce((a, b) => a + b, 0))}</b></td><td></td></tr></tbody></table></div></div>`
}

function copyTime(item) {
  const row = state.time?.items.find(r => r.item === item)
  if (!row) return
  const label = row.item === '-' ? 'No work item' : /^[0-9]+$/.test(row.item) ? `AB#${row.item}` : row.item
  copy(`${label}: ${hours(row.total)} h (${state.time.days[0]} to ${state.time.days.at(-1)})\n${state.time.days.filter(d => row.perDay[d]).map(d => `${d}: ${hours(row.perDay[d])} h`).join('\n')}`, 'Hours')
}

/* settings */

const FEATURE_HELP = {
  brief: 'A small model writes Goal, Decided, Next, Blocked after each turn and gives it back after compaction.',
  ledger: 'Keeps every answered question and new brief decision.',
  radar: 'Warns a session when another live session edited the same file.',
  leases: 'git commit and integration tests wait while another session holds them.',
  budgetGuard: 'No new subagents above the weekly threshold.',
  hubAnswers: 'Questions can be answered from this page and from /lookout ask.',
  relay: 'Messages from this page arrive in the target session as your own input.',
  statusLine: 'Model, folder, git, session counts, context, limits and cost under the prompt.',
  gitPane: 'Changed files and recent commits in a pane, opened with /git.',
  skinsColors: 'Uses the colours of the skins mod when it is installed, else the built-in palette.',
  cacheTax: 'Moves the cache-tax status line into the status line when cache-tax is installed.',
}

async function loadSettings() {
  try {
    state.settings = await api('/api/config')
    applyLook(state.settings.config.appearance)
    if (state.tab === 'settings') renderSettings()
  } catch (error) {
    toast(`Could not load settings: ${error.message}`, true)
  }
}

function setPath(object, path, value) {
  const keys = path.split('.')
  const last = keys.pop()
  keys.reduce((v, k) => v[k], object)[last] = value
}

let settingsTimer = null
function saveSettings(immediate) {
  clearTimeout(settingsTimer)
  settingsTimer = setTimeout(async () => {
    try {
      const saved = await post('/api/config', { config: state.settings.config })
      state.settings.config = saved.config
      applyLook(saved.config.appearance)
      toast('Saved. Sessions pick it up within 10 s.')
    } catch (error) {
      toast(`Save failed: ${error.message}`, true)
    }
  }, immediate ? 0 : 500)
}

const EFFORTS = ['inherit', 'low', 'medium', 'high', 'xhigh', 'max']

function effortSelect(path, value) {
  return `<select class="field" data-cfg="${path}" data-kind="model">${EFFORTS.map(m => `<option value="${m}"${m === value ? ' selected' : ''}>${m}</option>`).join('')}</select>`
}

function modelSelect(path, value) {
  return `<select class="field" data-cfg="${path}" data-kind="model">${state.settings.models.map(m => `<option value="${m}"${m === value ? ' selected' : ''}>${m}</option>`).join('')}</select>`
}

function numberInput(path, value, min, max, unit) {
  return `<label class="knob"><input class="field num" type="number" min="${min}" max="${max}" data-cfg="${path}" data-kind="number" value="${esc(value)}"> ${esc(unit)}</label>`
}

function checkbox(path, value, label) {
  return `<label class="knob"><input type="checkbox" data-cfg="${path}" data-kind="bool"${value ? ' checked' : ''}> ${esc(label)}</label>`
}

function routingSummary(routes) {
  const byModel = new Map()
  const byRule = new Map()
  for (const r of routes) {
    byModel.set(r.model, (byModel.get(r.model) || 0) + 1)
    byRule.set(r.rule, (byRule.get(r.rule) || 0) + 1)
  }
  const total = routes.length || 1
  const bars = [...byModel.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `<div class="knob"><span class="bar" style="--mc:${modelColor(m)};width:${Math.max(6, Math.round((n / total) * 160))}px"></span> ${esc(m)} ${n}</div>`).join('')
  const overridden = routes.filter(r => r.asked && r.asked !== r.model).length
  const unset = routes.filter(r => !r.asked).length
  return `<div>${bars}</div><span class="hint">${routes.length} routed · ${unset} had no model set · ${overridden} overrode an explicit model · ${routes.filter(r => r.isDowngraded).length} downgraded for budget</span>`
}

function renderSettings() {
  const el = $('tab-settings')
  if (el.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName) && document.activeElement.type !== 'checkbox') return
  if (!state.settings) { el.innerHTML = '<div class="panel"><span class="hint">Loading…</span></div>'; return }
  const c = state.settings.config
  const f = c.features
  const look = c.appearance
  const looks = `<div class="panel"><div class="panel-head"><h3>Look</h3><span class="muted">For this page. The terminal keeps its own colours (skins or the built-in palette).</span></div>
    <div class="looks">${LOOKS.map(([id, name, sub]) => `<button type="button" data-look="${id}" aria-pressed="${look.look === id}"><b>${esc(name)}</b><small>${esc(sub)}</small></button>`).join('')}</div>
    <span class="seg">${['system', 'dark', 'light'].map(m => `<button type="button" data-mode="${m}" aria-pressed="${look.mode === m}">${m[0].toUpperCase()}${m.slice(1)}</button>`).join('')}</span></div>`
  const knobs = {
    brief: `${modelSelect('features.brief.model', f.brief.model)} ${numberInput('features.brief.everySec', f.brief.everySec, 15, 3600, 's min. gap')}`,
    radar: numberInput('features.radar.windowHours', f.radar.windowHours, 1, 72, 'h window'),
    leases: `${numberInput('features.leases.waitMin', f.leases.waitMin, 1, 120, 'min max. wait')} ${checkbox('features.leases.commit', f.leases.commit, 'git commit')} ${checkbox('features.leases.integration', f.leases.integration, 'integration tests')}`,
    budgetGuard: numberInput('features.budgetGuard.percent', f.budgetGuard.percent, 10, 100, '% weekly'),
  }
  const features = Object.entries(state.settings.labels).map(([key, label]) => `<tr><td><label class="toggle"><input type="checkbox" data-cfg="features.${key}.on" data-kind="bool"${f[key].on ? ' checked' : ''}><span></span></label></td><td><b>${esc(label)}</b><div class="hint">${esc(FEATURE_HELP[key] || '')}</div></td><td>${knobs[key] || ''}</td></tr>`).join('')
  const o = c.orchestrator
  const rules = o.rules.map((r, i) => `<tr><td><b>${esc(r.label)}</b></td><td>${modelSelect(`orchestrator.rules.${i}.model`, r.model)}</td><td>${effortSelect(`orchestrator.rules.${i}.effort`, r.effort)}</td><td><input class="field wide" data-cfg="orchestrator.rules.${i}.types" data-kind="list" value="${esc(r.types.join(', '))}"></td></tr>`).join('')
  const TIER_HELP = { light: 'Read-only lookup and search. Never for tasks that edit or have a long brief.', standard: 'Normal implementation, tests, docs in one or two files.', deep: 'Architecture, security, debugging across files, migrations, reviews. Also three or more files named.' }
  const tiers = ['light', 'standard', 'deep'].map(t => `<tr><td><b>${t[0].toUpperCase()}${t.slice(1)}</b><div class="hint">${esc(TIER_HELP[t])}</div></td><td>${modelSelect(`orchestrator.tiers.${t}.model`, o.tiers[t].model)}</td><td>${effortSelect(`orchestrator.tiers.${t}.effort`, o.tiers[t].effort)}</td><td><input class="field wide" data-cfg="orchestrator.tiers.${t}.words" data-kind="list" value="${esc(o.tiers[t].words.join(', '))}"></td></tr>`).join('')
  const PROFILE_TEXT = { quality: ['Quality', 'Never weaker than your session. More effort only for hard work, reviews and plans.'], balanced: ['Balanced', 'Session model, effort by task. Haiku only for pure lookups.'], economy: ['Economy', 'Sonnet for implementation, Haiku for lookups, Opus for hard work.'], custom: ['Custom', 'Your own values in the tables below.'] }
  const profiles = `<div class="looks">${Object.entries(PROFILE_TEXT).map(([id, [name, sub]]) => `<button type="button" data-profile="${id}" aria-pressed="${o.profile === id}"><b>${esc(name)}</b><small>${esc(sub)}</small></button>`).join('')}</div>`
  const classifier = `<label class="knob">Classifier <select class="field" data-cfg="orchestrator.classifier" data-kind="model">${[['off', 'off: keywords only'], ['unsure', 'when unsure (haiku)'], ['always', 'always (haiku)']].map(([v, l]) => `<option value="${v}"${o.classifier === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`
  const routes = state.settings.routes || []
  const routeRows = routes.slice(0, 15).map(r => `<tr><td class="mono">${esc(clock(r.at))}</td><td>${esc(sessionName(r.sessionId).slice(0, 28))}</td><td>${esc(r.subagentType)}</td><td>${esc(r.description || '')}</td><td>${esc(r.tier ? `${r.tier}${r.source === 'classifier' ? ' (classifier)' : ''}` : r.rule || '-')}<div class="hint">${esc((r.reasons || []).join(' · '))}</div></td><td class="model">${esc(r.asked || 'unset')} → <b style="color:${modelColor(r.model)}">${esc(r.model || 'kept')}</b>${r.effort ? ` · ${esc(r.effort)}` : ''}${r.isDowngraded ? ' <span class="hint">budget</span>' : ''}</td></tr>`).join('')
  const outcomes = state.settings.outcomes || []
  const outcomeHtml = outcomes.length ? `<div class="scroll-x"><table class="grid"><thead><tr><th>Model that ran</th><th class="num">Agents</th><th class="num">Routed</th><th class="num">Avg tokens</th><th class="num">Avg time</th><th class="num">Avg tool calls</th><th class="num">Errors</th></tr></thead><tbody>${outcomes.map(x => `<tr><td class="model" style="color:${modelColor(x.model)}"><b>${esc(x.model)}</b></td><td class="num">${x.count}</td><td class="num">${x.routed}</td><td class="num">${esc(tokens(x.avgTokens))}</td><td class="num">${x.avgSeconds} s</td><td class="num">${x.avgToolUses}</td><td class="num">${x.errors}</td></tr>`).join('')}</tbody></table></div>` : ''
  el.innerHTML = `${looks}
  <div class="panel"><div class="panel-head"><h3>Features</h3><span class="muted">Same switches as /lookout settings in the terminal and in Claude Desktop.</span><button type="button" class="btn sm" data-cfg-reset>Reset to defaults</button></div><div class="scroll-x"><table class="grid"><tbody>${features}</tbody></table></div></div>
  <div class="panel"><div class="panel-head"><h3>Orchestrator</h3><span class="muted">Which model and effort a subagent runs on; each can be switched off on its own. Specialised agent types stay pinned; general-purpose agents get a tier from their task: keywords in the description and the head of the prompt, whether it edits, how many files it names and how long its brief is.</span></div>
    ${profiles}
    <div>${checkbox('orchestrator.protectJudgment', o.protectJudgment, 'Reviews, plans and deep tasks never below the session model and effort')}</div>
    <div>${checkbox('orchestrator.on', o.on, 'Route subagents')} ${checkbox('orchestrator.routeModel', o.routeModel, 'set the model')} ${checkbox('orchestrator.routeEffort', o.routeEffort, 'set the effort')} ${checkbox('orchestrator.onlyWhenUnset', o.onlyWhenUnset, 'Keep what the Agent call names itself')} ${classifier} ${checkbox('orchestrator.escalate', o.escalate, 'Allow one re-run, at high effort or one model up')} ${checkbox('orchestrator.downgrade.on', o.downgrade.on, 'One model cheaper from')} ${numberInput('orchestrator.downgrade.percent', o.downgrade.percent, 10, 100, '% weekly usage')}</div>
    <h3>General-purpose agents by difficulty</h3>
    <div class="scroll-x"><table class="grid"><thead><tr><th>Tier</th><th>Model</th><th>Effort</th><th>Keywords</th></tr></thead><tbody>${tiers}</tbody></table></div>
    <h3>Pinned by agent type</h3>
    <div class="scroll-x"><table class="grid"><thead><tr><th>Task type</th><th>Model</th><th>Effort</th><th>Agent types (* = wildcard)</th></tr></thead><tbody>${rules}</tbody></table></div>
    <span class="hint">inherit = leave it as the session decides. Quality never lowers anything; Balanced lowers effort for routine work and uses Haiku only for pure lookups; Economy also moves implementation to Sonnet (Anthropic measured Sonnet at high effort on par with Opus at low effort). With the re-run on, a session whose agent ran below high effort (or on a cheaper model) gets a note: if the result falls short, run it once more at high effort, no further. Briefs use their own model above.</span></div>
  <div class="panel routes"><div class="panel-head"><h3>Recent routing</h3><span class="muted">The orchestrator's last decisions and how the agents did, across all sessions.</span></div>${routes.length ? `${routingSummary(routes)}${outcomeHtml}<div class="scroll-x"><table class="grid"><thead><tr><th>Time</th><th>Session</th><th>Agent</th><th>Task</th><th>Why</th><th>Model</th></tr></thead><tbody>${routeRows}</tbody></table></div>` : `${outcomeHtml}<span class="hint">Nothing routed yet. Switch the orchestrator on to see its decisions here.</span>`}</div>
  ${replayPanel()}
  <span class="hint">Stored in ${esc(state.settings.path)}</span>`
}

function tallyHtml(title, list) {
  const total = list.reduce((sum, [, n]) => sum + n, 0) || 1
  return `<div><h3>${esc(title)}</h3>${list.slice(0, 8).map(([name, n]) => `<div class="knob"><span class="bar" style="--mc:${modelColor(name)};width:${Math.max(4, Math.round((n / total) * 140))}px"></span> ${esc(name)} <b>${n}</b></div>`).join('<br>')}</div>`
}

function replayPanel() {
  const r = state.replay
  const head = `<div class="panel-head"><h3>Replay</h3><span class="muted">What the rules above would have done with the agent calls of your recent sessions, compared with the model that actually ran. Nothing is changed; this only reads transcripts.</span><span class="seg">${[7, 14, 30].map(d => `<button type="button" data-replay="${d}" aria-pressed="${r?.days === d}">${d} days</button>`).join('')}</span></div>`
  if (!r) return `<div class="panel">${head}<span class="hint">Pick a range to replay.</span></div>`
  if (r.isLoading) return `<div class="panel">${head}<span class="hint">Reading transcripts…</span></div>`
  if (!r.total) return `<div class="panel">${head}<span class="hint">No agent calls in the last ${r.days} days on this machine.</span></div>`
  const unsure = r.unsure ? `<span class="hint">${r.unsure} of them were unclear by keywords; with the classifier on, a haiku call decides those.</span>` : ''
  const redo = (r.redoByModel || []).map(x => `<div class="knob"><b style="color:${modelColor(x.model)}">${esc(x.model)}</b> ${x.redone} of ${x.total} redone (${Math.round((x.redone / Math.max(1, x.total)) * 100)} %)</div>`).join('<br>')
  const rows = r.rows.slice(0, 30).map(x => `<tr><td class="mono">${esc(new Date(x.at).toLocaleDateString([], { day: '2-digit', month: '2-digit' }))} ${esc(clock(x.at))}</td><td>${esc(x.type)}</td><td>${esc(x.description)}${x.isRedone ? ' <span class="chip hi">redone</span>' : ''}</td><td class="model">${esc(x.asked || '-')}</td><td class="model" style="color:${modelColor(x.ran)}">${esc(x.ran || '?')}</td><td>${esc(x.rule || '-')}${x.source === 'tier' && x.isSure === false ? ' <span class="hint">unsure</span>' : ''}<div class="hint">${esc((x.reasons || []).join(' · '))}</div></td><td class="model" style="color:${modelColor(x.routed)}"><b>${esc(x.routed || (x.asked ? `kept ${x.asked}` : 'unchanged'))}</b>${x.routedEffort ? ` · ${esc(x.routedEffort)}` : ''}</td></tr>`).join('')
  return `<div class="panel">${head}<span class="hint">${r.total} agent calls in ${r.days} days. "Redone" means the same session started a near-identical task of the same agent type within two hours, a hint that the first result fell short.</span>${unsure}
    <div style="display:flex;gap:28px;flex-wrap:wrap">${tallyHtml('Actually ran', r.ran)}${tallyHtml('Rules would pick', r.routed)}${tallyHtml('Effort', r.efforts || [])}${tallyHtml('Tier', r.byTier || [])}${tallyHtml('Agent type', r.byType)}${redo ? `<div><h3>Redone by model</h3>${redo}</div>` : ''}</div>
    <div class="scroll-x"><table class="grid"><thead><tr><th>When</th><th>Agent</th><th>Task</th><th>Asked</th><th>Ran</th><th>Why</th><th>Would run</th></tr></thead><tbody>${rows}</tbody></table></div></div>`
}

async function loadReplay(days) {
  state.replay = { days, isLoading: true }
  renderSettings()
  try {
    state.replay = await api(`/api/routing/replay?days=${days}`)
  } catch (error) {
    state.replay = null
    toast(`Replay failed: ${error.message}`, true)
  }
  if (state.tab === 'settings') renderSettings()
}

function onSettingsChange(event) {
  const el = event.target.closest('[data-cfg]')
  if (!el || !state.settings) return
  const kind = el.dataset.kind
  const value = kind === 'bool' ? el.checked : kind === 'number' ? Number(el.value) : kind === 'list' ? el.value.split(',').map(s => s.trim()).filter(Boolean) : el.value
  setPath(state.settings.config, el.dataset.cfg, value)
  if (/^orchestrator\.(tiers|rules)\.[^.]+\.(model|effort)$/.test(el.dataset.cfg)) { state.settings.config.orchestrator.profile = 'custom'; renderSettings() }
  saveSettings(kind === 'bool' || kind === 'model')
}

async function resetSettings() {
  try {
    const saved = await post('/api/config', { reset: true })
    state.settings.config = saved.config
    applyLook(saved.config.appearance)
    renderSettings()
    toast('Settings reset to defaults')
  } catch (error) {
    toast(`Reset failed: ${error.message}`, true)
  }
}

function setLook(patch) {
  if (!state.settings) return
  state.settings.config.appearance = { ...state.settings.config.appearance, ...patch }
  applyLook(state.settings.config.appearance)
  renderSettings()
  saveSettings(true)
}

function setProfile(profile) {
  if (!state.settings) return
  const o = state.settings.config.orchestrator
  const preset = state.settings.presets?.[profile]
  o.profile = profile
  if (preset) {
    for (const tier of Object.keys(o.tiers)) Object.assign(o.tiers[tier], preset.tiers[tier] || {})
    for (const rule of o.rules) Object.assign(rule, preset.rules[rule.id] || {})
  }
  renderSettings()
  saveSettings(true)
}
