/* Overview: repo cards with branch rails on the left, the selected session on the right. */

function asksOf(session) {
  const items = []
  for (const item of session.live || []) {
    if (state.done.has(item.id)) continue
    if (item.kind === 'question') items.push({ ...item, session, isAnswerable: true, questions: normalizeQuestions(item.questions) })
    else items.push({ ...item, session, isAnswerable: false })
  }
  if (!items.some(i => i.kind === 'question') && session.question?.length) {
    items.push({ id: `transcript-${session.sessionId}`, kind: 'question', session, isAnswerable: false, questions: normalizeQuestions(session.question), stale: true, at: session.statusUpdatedAt })
  }
  if (!items.length && session.waitingOnPerson) {
    items.push({ id: `wait-${session.sessionId}`, kind: session.pendingTool ? 'permission' : 'waiting', session, isAnswerable: false, tool: session.pendingTool?.name, summary: session.pendingTool?.summary || session.waitingFor, at: session.statusUpdatedAt })
  }
  return items
}

function normalizeQuestions(list) {
  return (Array.isArray(list) ? list : []).map(q => ({
    question: String(q?.question ?? ''),
    header: q?.header ? String(q.header) : '',
    multiSelect: Boolean(q?.multiSelect),
    options: (Array.isArray(q?.options) ? q.options : []).map(o => ({ label: String(o?.label ?? ''), description: o?.description ? String(o.description) : '' })),
  }))
}

function touchedFiles(session) {
  const out = []
  for (const repo of state.repos) for (const file of repo.files) if (file.sessions.some(one => one.sessionId === session.sessionId)) out.push(file.path)
  return out
}

function stateOf(session) {
  if (asksOf(session).length) return 'wait'
  if (session.status === 'busy') return 'run'
  if (session.unread > 0) return 'done'
  return 'idle'
}

function reviewOf(session) {
  if (stateOf(session) !== 'done' || !session.repo) return null
  const files = touchedFiles(session)
  return files.length ? { files } : null
}

function openKind(session) {
  const ask = asksOf(session)[0]
  if (ask) return ask.kind
  return reviewOf(session) ? 'review' : null
}

function lineOf(session) {
  const ask = asksOf(session)[0]
  if (ask?.kind === 'question') return `Question: ${ask.questions[0]?.question || 'waiting for your answer'}`
  if (ask?.kind === 'permission') return `Approval: ${ask.tool ? `${ask.tool} ` : ''}${ask.summary || ''}`
  if (ask?.kind === 'plan') return 'Plan waits for your approval'
  if (ask) return `Waits for you${ask.summary ? `: ${ask.summary}` : ''}`
  if (reviewOf(session)) return `Ready for review: ${touchedFiles(session).length} uncommitted file(s)`
  if (session.status === 'busy' && session.currentTool) return `${session.currentTool.name} ${session.currentTool.summary || ''}`
  if (session.brief?.next) return `Next: ${session.brief.next}`
  return session.lastAssistant || ''
}

/* grouping: repo, then branch, sessions in a stable order */
function groups() {
  const repos = new Map()
  for (const s of state.sessions) {
    const key = s.repo?.root || `dir:${s.cwd}`
    const repo = repos.get(key) || { key, name: s.repo?.name || folderOf(s.cwd), isGit: Boolean(s.repo), root: s.repo?.root, branches: new Map() }
    const branch = s.repo && s.branch && s.branch !== 'HEAD' ? s.branch : s.repo ? 'detached' : 'no git'
    const list = repo.branches.get(branch) || []
    list.push(s)
    repo.branches.set(branch, list)
    repos.set(key, repo)
  }
  const rank = s => ({ wait: 0, done: 1, run: 2, idle: 3 })[stateOf(s)]
  const out = [...repos.values()].map(repo => {
    const branches = [...repo.branches.entries()].map(([name, list]) => [name, list.sort((a, b) => rank(a) - rank(b) || (b.statusUpdatedAt || 0) - (a.statusUpdatedAt || 0))])
    branches.sort((a, b) => Math.min(...a[1].map(rank)) - Math.min(...b[1].map(rank)))
    return { ...repo, branches, best: Math.min(...branches.flatMap(b => b[1].map(rank))) }
  })
  out.sort((a, b) => a.best - b.best || a.name.localeCompare(b.name))
  return out
}

function orderedSessions() {
  return groups().flatMap(repo => repo.branches.flatMap(([, list]) => list))
}

function openSessions() {
  return orderedSessions().filter(s => openKind(s))
}

function lane(session) {
  const bins = session.activity || []
  const max = Math.max(1, ...bins)
  let html = ''
  bins.forEach((v, i) => {
    if (!v) return
    const h = Math.max(3, Math.round((v / max) * 12))
    html += `<i class="sp" style="left:${((i / bins.length) * 100).toFixed(2)}%;height:${h}px"></i>`
  })
  const windowMs = 60 * 60_000
  for (const a of session.agents || []) {
    const end = a.state === 'running' ? state.now : a.updatedAt
    const left = 100 - ((state.now - end) / windowMs) * 100
    if (left < 0) continue
    const width = a.state === 'running' ? 12 : 6
    html += `<i class="ag${a.state === 'done' ? ' done' : ''}" style="--mc:${modelColor(a.model)};left:${Math.max(0, left - width).toFixed(2)}%;width:${width}%" title="${esc(`${a.type || 'agent'} · ${modelKey(a.model) || '?'} · ${a.state}`)}"></i>`
  }
  return `${html}<i class="now"></i>`
}

function leasesOf(session) {
  return state.leases.filter(l => l.sessionId === session.sessionId)
}

function chipsOf(session) {
  const chips = []
  for (const a of (session.agents || []).slice(0, 4)) {
    chips.push(`<span class="chip m${a.state === 'done' ? ' done' : ''}" data-agent-open="${esc(a.id)}" title="Show what this agent does" style="--mc:${modelColor(a.model)}">${esc(modelKey(a.model) || '?')} · ${esc(a.type || 'agent')}${a.state === 'running' ? ' ●' : a.state === 'stalled' ? ' ?' : ''}</span>`)
  }
  for (const f of session.shared || []) chips.push(`<span class="chip x" title="${esc(`Also edited by ${f.others.join(', ')}`)}">shares ${esc(folderOf(f.path))}</span>`)
  for (const l of leasesOf(session)) chips.push(`<span class="chip l">holds ${esc(l.purpose || l.key)} lock</span>`)
  const ctx = contextPercent(session)
  if (ctx !== null) chips.push(`<span class="chip${ctx >= 80 ? ' hi' : ''}" title="context window">ctx ${ctx} %${ctx >= 80 ? ' · compacts soon' : ''}</span>`)
  if (!session.hasHubMod) chips.push('<span class="chip" title="Restart this session to load the lookout mod">no mod</span>')
  return chips
}

function renderOverview(force = false) {
  const list = groups()
  if (!list.length) {
    $('overview').innerHTML = '<div class="rc"><div class="empty-card">No live Claude Code session on this machine.</div></div>'
    return
  }
  const html = list.map((repo, ri) => {
    const rows = []
    repo.branches.forEach(([name, sessions], bi) => {
      rows.push(`<div class="brow" data-b="${bi}"><span class="bl">${repo.isGit ? '⎇ ' : ''}${esc(name)}</span><span class="c">${sessions.length} session${sessions.length > 1 ? 's' : ''}</span></div>`)
      for (const s of sessions) {
        const st = stateOf(s)
        const isSel = state.selected === s.sessionId
        rows.push(`<div class="srow${st === 'wait' ? ' wait' : ''}${isSel ? ' sel' : ''}" data-b="${bi}" data-id="${esc(s.sessionId)}" tabindex="0" role="button" aria-pressed="${isSel}">
          <div class="h"><span class="dot st-${st}"></span><b title="${esc(s.cwd)}">${esc(titleOf(s))}</b>${s.workItem ? `<span class="tag">${esc(itemLabel(s.workItem))}</span>` : ''}${s.unread && !isSel ? `<span class="unread" title="Claude replies since you last looked">${s.unread}</span>` : ''}</div>
          <span class="when">${esc(ago(s.statusUpdatedAt))}</span>
          <div class="line">${esc(lineOf(s))}</div>
          <div class="lane" title="last hour">${lane(s)}</div>
          <div class="chips">${chipsOf(s).join('')}</div>
        </div>`)
      }
    })
    const repoInfo = state.repos.find(r => r.root === repo.root)
    const uncommitted = repoInfo ? `${repoInfo.files.length} uncommitted` : repo.isGit ? '' : 'not a git repository'
    const ids = new Set(repo.branches.flatMap(([, sessions]) => sessions.map(s => s.sessionId)))
    const locks = state.leases.filter(l => ids.has(l.sessionId)).map(l => `<span class="lock held">● ${esc(l.purpose || l.key)} · ${esc(l.name || sessionName(l.sessionId))}<button type="button" data-release="${esc(l.key)}" title="Free a lock a crashed session left behind">×</button></span>`).join('')
    const shared = (repoInfo?.files || []).filter(f => f.sessions.length > 1)
    const clash = shared.length ? `<span class="chip x" title="${esc(shared.map(f => f.path).join('\n'))}">${shared.length} file${shared.length > 1 ? 's' : ''} edited by two sessions: ${esc(shared.slice(0, 2).map(f => folderOf(f.path)).join(', '))}</span>` : ''
    return `<div class="rc" data-repo="${ri}"><div class="rh"><b>${esc(repo.name)}</b><span class="m">${esc(uncommitted)}</span>${locks}${clash}</div><div class="rbody"><div class="rails"><svg aria-hidden="true"></svg></div><div class="rows">${rows.join('')}</div></div></div>`
  }).join('')
  if (!force && $('overview').dataset.sig === html) return
  const focusedId = document.activeElement?.closest?.('.srow')?.dataset.id
  $('overview').innerHTML = html
  $('overview').dataset.sig = html
  if (focusedId) document.querySelector(`.srow[data-id="${CSS.escape(focusedId)}"]`)?.focus()
  requestAnimationFrame(() => drawRails(list))
  document.fonts?.ready.then(() => drawRails(list))
}

function drawRails(list) {
  document.querySelectorAll('#overview .rc').forEach(card => {
    const repo = list[Number(card.dataset.repo)]
    if (!repo) return
    const rails = card.querySelector('.rails')
    const svg = rails.querySelector('svg')
    const top = rails.getBoundingClientRect().top
    const rows = [...card.querySelectorAll('.rows > div')]
    const n = repo.branches.length
    const xFor = bi => (n === 1 ? 15 : 9 + bi * (12 / (n - 1)))
    let out = ''
    repo.branches.forEach((_, bi) => {
      const mine = rows.filter(r => Number(r.dataset.b) === bi)
      const color = `var(--b${(bi % 4) + 1})`
      // Centre each node on the row's own anchor: the status dot of a session, the label of a branch.
      const ys = mine.map(r => {
        const box = (r.querySelector('.h .dot') || r.querySelector('.bl') || r).getBoundingClientRect()
        return Math.round(box.top + box.height / 2 - top)
      })
      if (!ys.length) return
      const x = xFor(bi)
      if (bi > 0) {
        const x0 = xFor(0)
        out += `<path d="M${x0} ${ys[0] - 20} C ${x0} ${ys[0] - 6}, ${x} ${ys[0] - 14}, ${x} ${ys[0]}" fill="none" stroke="${color}" stroke-width="2"/>`
      }
      out += `<line x1="${x}" y1="${ys[0]}" x2="${x}" y2="${ys.at(-1)}" stroke="${color}" stroke-width="2"/>`
      ys.forEach((y, i) => {
        out += i === 0 ? `<circle cx="${x}" cy="${y}" r="4.5" fill="var(--panel)" stroke="${color}" stroke-width="2"/>` : `<circle cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
      })
    })
    svg.innerHTML = out
  })
}

/* focus panel */

function selectedSession() {
  return state.sessions.find(one => one.sessionId === state.selected)
}

function select(id, options = {}) {
  if (!id) return
  const session = state.sessions.find(one => one.sessionId === id)
  if (!session) return
  const isNew = state.selected !== id
  state.selected = id
  storage('lookout-selected', id)
  if (isNew) {
    state.detail = null
    state.detailCount = 8
    if (options.agent === undefined) { state.agent = null; state.agentDetail = null }
    state.catchup = { since: session.lastReadAt, items: session.catchup || [], isRead: false }
    state.focusSig = ''
    buildFocus()
    $('f-body').scrollTop = 0
    loadDetail()
    post('/api/read', { sessionId: id }).catch(() => undefined)
  }
  if (options.agent && state.agent !== options.agent) openAgent(options.agent)
  renderOverview()
  renderFocus()
  if (options.scroll) document.querySelector(`.srow[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
}

function buildFocus() {
  $('focus').innerHTML = `<div class="fh" id="f-head"></div><div class="fbody" id="f-body"><div id="f-catch"></div><div id="f-ask"></div><div id="f-brief"></div><div id="f-ctx"></div><div id="f-agents"></div><div id="f-agentlog"></div><div class="chat" id="f-chat"></div></div>
    <div class="composer"><textarea id="composer" placeholder="Write to this session. It arrives as your own input."></textarea><div class="row" id="composer-row"><span id="composer-hint">Ctrl+Enter sends</span><button type="button" class="btn primary" id="send">Send</button></div></div>`
}

function renderFocus() {
  const s = selectedSession()
  if (!s) {
    state.selected = null
    $('focus').innerHTML = `<div class="nofocus">${state.sessions.length ? 'Pick a session on the left, or press <span class="kbd">n</span> for the next open item.' : 'Nothing to show yet.'}</div>`
    return
  }
  if (!$('f-head')) buildFocus()
  const crumbs = [s.repo?.name || folderOf(s.cwd), s.repo && s.branch && s.branch !== 'HEAD' ? `⎇ ${s.branch}` : null, s.workItem ? itemLabel(s.workItem) : null, prettyModel(s.model) || null].filter(Boolean)
  const head = `<div class="crumbs">${crumbs.map(c => `<span>${esc(c)}</span>`).join('')}<span title="${esc(s.cwd)}">${esc(s.name)}</span></div>
    <div class="tt"><span class="dot st-${stateOf(s)}"></span><h4>${esc(titleOf(s))}</h4></div>
    <div class="acts"><button type="button" class="act" data-act="open">Open in terminal <span class="kbd">o</span></button>${s.kind !== 'interactive' ? '<button type="button" class="act" data-act="attach">Attach</button>' : ''}<button type="button" class="act" data-act="fork">Fork</button><button type="button" class="act" data-act="handoff">Hand off</button><button type="button" class="act" data-act="copy-resume">Copy resume</button></div>`
  if ($('f-head').dataset.sig !== head) { $('f-head').innerHTML = head; $('f-head').dataset.sig = head }
  renderCatchup()
  renderAsk(s)
  renderBrief(s)
  renderAgents(s)
  const hint = $('composer-hint')
  const row = $('composer-row')
  if (!state.messaging.isAvailable) {
    hint.textContent = 'Messaging is offline: no session with the lookout mod is polling right now.'
    row.classList.add('warn')
  } else {
    hint.textContent = 'Ctrl+Enter sends. Arrives in the session as your own input.'
    row.classList.remove('warn')
  }
}

const GLYPH_CLASS = { '?': 'g-q', '!': 'g-x' }

function renderCatchup() {
  const c = state.catchup
  if (!c) return
  const since = c.since ? `${clock(c.since)} (${agoText(c.since)})` : ''
  const html = c.items.length
    ? `<div class="catch${c.isRead ? ' read' : ''}"><div class="hd"><span>Since you were last here${since ? ` · ${esc(since)}` : ''}</span>${c.isRead ? '<small class="muted">read</small>' : '<button type="button" class="act" data-act="read">Read <span class="kbd">e</span></button>'}</div><ul>${c.items.map(i => `<li class="${GLYPH_CLASS[i.g] || ''}"><i>${esc(i.g)}</i><span>${esc(i.text)}</span></li>`).join('')}</ul></div>`
    : `<div class="catch read"><div class="hd"><span>Since you were last here${since ? ` · ${esc(since)}` : ''}</span></div><ul><li><i>·</i><span>Nothing new.</span></li></ul></div>`
  if ($('f-catch').dataset.sig !== html) { $('f-catch').innerHTML = html; $('f-catch').dataset.sig = html }
}

function draftOf(askId) {
  if (!state.drafts.has(askId)) state.drafts.set(askId, { picks: {}, other: {} })
  return state.drafts.get(askId)
}

function askHtml(ask) {
  const since = ask.at ? ` · since ${ago(ask.at)}` : ''
  if (ask.kind === 'question') {
    const draft = draftOf(ask.id)
    let n = 0
    const blocks = ask.questions.map((q, qi) => {
      const picks = draft.picks[qi] || []
      const opts = q.options.map(o => {
        n++
        return `<button type="button" class="choice" data-ask="${esc(ask.id)}" data-q="${qi}" data-label="${esc(o.label)}" aria-pressed="${picks.includes(o.label)}" ${ask.isAnswerable ? '' : 'disabled'}><span class="kbd">${n <= 9 ? n : ''}</span><b>${esc(o.label)}</b><small>${esc(o.description)}</small></button>`
      }).join('')
      const own = ask.isAnswerable ? `<input class="own" data-ask="${esc(ask.id)}" data-q="${qi}" placeholder="Or type your own answer" value="${esc(draft.other[qi] || '')}">` : ''
      return `${q.header ? `<span class="qh">${esc(q.header)}</span>` : ''}<span class="q">${esc(q.question)}</span>${q.multiSelect ? '<span class="hint">Pick one or more</span>' : ''}${opts}${own}`
    }).join('')
    const isQuick = ask.questions.length === 1 && !ask.questions[0].multiSelect
    const foot = ask.isAnswerable
      ? `<div class="btnrow"><button type="button" class="btn primary" data-submit="${esc(ask.id)}" ${state.sending.has(ask.id) ? 'disabled' : ''}>Answer</button><span class="hint">${isQuick ? 'A number key or a click answers at once.' : 'Goes straight into the open dialog of the session.'}</span></div>`
      : `<div class="btnrow"><span class="hint">${ask.stale ? 'This session runs without the lookout mod: answer in the terminal, or restart it with claude --resume to answer here.' : 'Answer in the terminal.'}</span><button type="button" class="btn" data-act="open">Open in terminal <span class="kbd">o</span></button></div>`
    return `<div class="ask"><span class="k">Question${esc(since)}</span>${blocks}${foot}</div>`
  }
  const label = { permission: 'Approval', plan: 'Plan', waiting: 'Waiting' }[ask.kind] || ask.kind
  const what = ask.summary || ''
  const note = ask.kind === 'permission' ? 'Approvals stay in the terminal on purpose. One key takes you there.' : ask.kind === 'plan' ? 'Read and approve the plan in the terminal.' : 'The session waits for input in the terminal.'
  return `<div class="perm"><span class="k">${esc(label)}${esc(since)}</span>${ask.tool ? `<b>${esc(ask.tool)}</b>` : ''}${what ? `<code class="cmd">${esc(what)}</code>` : ''}<span class="hint">${note}</span><div class="btnrow"><button type="button" class="btn primary" data-act="open">Open in terminal <span class="kbd">o</span></button>${what ? `<button type="button" class="btn" data-copy="${esc(what)}">Copy</button>` : ''}</div></div>`
}

function reviewHtml(session, review) {
  return `<div class="review"><span class="k">Ready for review</span><span>${esc(session.lastAssistant || 'The session finished its turn.')}</span><span class="hint">${review.files.length} uncommitted file${review.files.length > 1 ? 's' : ''} this session edited: ${esc(review.files.slice(0, 5).map(folderOf).join(', '))}${review.files.length > 5 ? ', ...' : ''}</span>
    <div class="btnrow"><button type="button" class="btn ok" data-review="commit">Commit <span class="kbd">1</span></button><button type="button" class="btn" data-review="diff">Show diff <span class="kbd">2</span></button><button type="button" class="btn" data-review="change">Ask for changes <span class="kbd">r</span></button></div></div>`
}

function renderAsk(s) {
  const el = $('f-ask')
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return
  const asks = asksOf(s)
  const review = asks.length ? null : reviewOf(s)
  const html = asks.length ? asks.map(askHtml).join('') : review ? reviewHtml(s, review) : ''
  const sig = `${html}|${[...state.sending].join()}`
  if (el.dataset.sig === sig) return
  el.dataset.sig = sig
  el.innerHTML = html
}

function renderBrief(s) {
  const b = s.brief
  const brief = b ? `<dl class="brief">${b.goal ? `<dt>Goal</dt><dd>${esc(b.goal)}</dd>` : ''}${b.decided?.length ? `<dt>Decided</dt><dd><ul>${b.decided.map(d => `<li>${esc(d)}</li>`).join('')}</ul></dd>` : ''}${b.next ? `<dt>Next</dt><dd>${esc(b.next)}</dd>` : ''}${b.blocked ? `<dt>Waits for</dt><dd style="color:var(--attn)">${esc(b.blocked)}</dd>` : ''}</dl>` : '<span class="hint">No brief yet. It appears after the next turn of a session with the lookout mod.</span>'
  if ($('f-brief').dataset.sig !== brief) { $('f-brief').innerHTML = brief; $('f-brief').dataset.sig = brief }
  const ctx = contextPercent(s)
  const ctxHtml = ctx === null ? '' : `<div class="ctxbar"><span>Context</span><i style="--w:${ctx}%${ctx >= 80 ? ';--mc:var(--attn)' : ''}"></i><span class="mono">${ctx} %${s.contextTokens ? ` · ${tokens(s.contextTokens)}` : ''}</span>${ctx >= 80 ? '<span style="color:var(--attn)">Compacts soon, the brief survives it</span>' : ''}</div>`
  if ($('f-ctx').dataset.sig !== ctxHtml) { $('f-ctx').innerHTML = ctxHtml; $('f-ctx').dataset.sig = ctxHtml }
}

function renderAgents(s) {
  const list = s.agents || []
  const html = list.length ? `<h3>Agents</h3><div class="agents">${list.slice(0, 8).map(a => `<button type="button" data-agent="${esc(a.id)}" aria-pressed="${state.agent === a.id}" title="Show what this agent does"><span class="chip m${a.state === 'done' ? ' done' : ''}" style="--mc:${modelColor(a.model)}">${esc(modelKey(a.model) || '?')}</span><b>${esc(a.type || 'agent')}</b><span class="mono">${esc(a.state)} ${esc(ago(a.updatedAt))}</span><span>${esc(a.description || a.lastText || '')}</span></button>`).join('')}</div>` : ''
  if ($('f-agents').dataset.sig !== html) { $('f-agents').innerHTML = html; $('f-agents').dataset.sig = html }
}

function renderChat(force = false) {
  const chat = $('f-chat')
  if (!chat) return
  const detail = state.detail
  if (!detail) { chat.innerHTML = '<span class="hint">Loading the conversation…</span>'; return }
  const sig = `${detail.messages.length}:${detail.messages.at(-1)?.at}:${state.detailCount}`
  if (!force && chat.dataset.sig === sig) return
  const body = $('f-body')
  const wasAtBottom = chat.dataset.sig && body.scrollHeight - body.scrollTop - body.clientHeight < 120
  chat.dataset.sig = sig
  const older = detail.messages.length >= state.detailCount ? '<button type="button" class="older" data-act="older">Show older messages</button>' : ''
  chat.innerHTML = older + (detail.messages.length ? detail.messages.map(m => `<div class="msg ${m.role === 'user' ? 'you' : 'cl'}"><span class="t">${m.role === 'user' ? 'You' : 'Claude'} · ${esc(m.at ? clock(Date.parse(m.at)) : '')}</span>${markdown(m.text)}</div>`).join('') : '<span class="hint">No messages yet.</span>')
  if (wasAtBottom) body.scrollTop = body.scrollHeight
  void force
}

async function loadDetail(force = false) {
  const id = state.selected
  if (!id) return
  try {
    const detail = await api(`/api/detail?id=${encodeURIComponent(id)}&n=${state.detailCount}`)
    if (detail.sessionId !== state.selected) return
    const isFirst = !state.detail
    state.detail = detail
    renderChat(force || isFirst)
  } catch (error) {
    toast(`Could not load the conversation: ${error.message}`, true)
  }
}

/* agent live view */

function openAgent(id) {
  if (state.agent === id) return closeAgent()
  state.agent = id
  state.agentDetail = null
  renderFocus()
  renderAgentLog()
  loadAgent()
}

function closeAgent() {
  state.agent = null
  state.agentDetail = null
  renderFocus()
  renderAgentLog()
}

async function loadAgent() {
  const id = state.selected
  const agent = state.agent
  if (!id || !agent) return
  try {
    const value = await api(`/api/agent?id=${encodeURIComponent(id)}&agent=${encodeURIComponent(agent)}&n=60`)
    if (state.selected !== id || state.agent !== agent) return
    state.agentDetail = value
  } catch (error) {
    state.agentDetail = { error: error.message }
  }
  renderAgentLog()
}

function renderAgentLog() {
  const el = $('f-agentlog')
  if (!el) return
  const a = state.agentDetail
  let html = ''
  if (state.agent && !a) html = '<div class="agentlog"><span class="hint">Loading the agent…</span></div>'
  else if (a?.error) html = `<div class="agentlog"><span class="hint">Agent not readable: ${esc(a.error)}</span></div>`
  else if (a) {
    const steps = a.steps.map(st => st.kind === 'tool'
      ? `<div class="st tool"><b>${esc(st.name)}</b><span class="mono">${esc(st.text)}</span></div>`
      : st.kind === 'result'
        ? `<div class="st res${st.isError ? ' err' : ''}"><span class="mono">${esc(st.text || '(empty)')}</span></div>`
        : `<div class="st txt">${esc(st.text)}</div>`).join('')
    const live = a.state === 'running' ? '<span class="dot st-run"></span>' : ''
    html = `<div class="agentlog"><div class="ah">${live}<span class="chip m${a.state === 'done' ? ' done' : ''}" style="--mc:${modelColor(a.model)}">${esc(prettyModel(a.model) || modelKey(a.model) || '?')}${a.effort ? ` · ${esc(a.effort)}` : ''}</span><b>${esc(a.description || a.type || 'agent')}</b><span class="mono">${esc(a.type || '')} · ${esc(a.state)} ${esc(ago(a.updatedAt))}</span><button type="button" class="btn sm" data-agent-close>Close</button></div>
      ${a.prompt ? `<details><summary>Task</summary><div class="st txt">${esc(a.prompt)}</div></details>` : ''}
      <div class="steps" id="agent-steps">${steps || '<span class="hint">No steps yet.</span>'}</div></div>`
  }
  if (el.dataset.sig === html) return
  const box = $('agent-steps')
  const isAtEnd = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 24
  el.innerHTML = html
  el.dataset.sig = html
  const next = $('agent-steps')
  if (next && isAtEnd) next.scrollTop = next.scrollHeight
}

/* answering */

function findAsk(id) {
  for (const s of state.sessions) for (const ask of asksOf(s)) if (ask.id === id) return ask
  return null
}

function pick(askId, qi, label) {
  const ask = findAsk(askId)
  if (!ask?.isAnswerable) return
  const q = ask.questions[qi]
  const draft = draftOf(askId)
  const picks = draft.picks[qi] || []
  draft.picks[qi] = q.multiSelect ? (picks.includes(label) ? picks.filter(p => p !== label) : [...picks, label]) : [label]
  if (!q.multiSelect) draft.other[qi] = ''
  const isQuick = ask.questions.length === 1 && !q.multiSelect
  if (isQuick) return submitAsk(askId)
  $('f-ask').dataset.sig = ''
  renderAsk(ask.session)
}

async function submitAsk(id) {
  const ask = findAsk(id)
  if (!ask || !ask.isAnswerable || state.sending.has(id)) return
  const draft = draftOf(id)
  const answers = {}
  ask.questions.forEach((q, qi) => {
    const own = String(draft.other[qi] ?? '').trim()
    const picks = draft.picks[qi] || []
    const value = own ? (picks.length && q.multiSelect ? [...picks, own].join(', ') : own) : picks.join(', ')
    if (value) answers[q.question] = value
  })
  if (!Object.keys(answers).length) return toast('Pick an option or type an answer first', true)
  state.sending.add(id)
  renderAsk(ask.session)
  try {
    await post('/api/answer', { sessionId: ask.session.sessionId, questionId: ask.id, answers })
    state.done.set(id, Date.now())
    toast(`Answer sent to ${titleOf(ask.session)}`)
    moveToNext(ask.session.sessionId)
    setTimeout(refresh, 1500)
  } catch (error) {
    toast(`Could not send the answer: ${error.message}`, true)
  } finally {
    state.sending.delete(id)
  }
}

function moveToNext(fromId) {
  const open = openSessions().filter(s => s.sessionId !== fromId)
  if (open.length) select(open[0].sessionId, { scroll: true })
  else { renderOverview(); renderFocus() }
}

function nextOpen() {
  const open = openSessions()
  if (!open.length) return toast('Nothing open. Everything runs.')
  const order = orderedSessions().map(s => s.sessionId)
  const at = order.indexOf(state.selected)
  const after = open.find(s => order.indexOf(s.sessionId) > at) || open[0]
  select(after.sessionId, { scroll: true })
}

function step(delta) {
  const order = orderedSessions()
  if (!order.length) return
  const at = order.findIndex(s => s.sessionId === state.selected)
  const next = order[Math.max(0, Math.min(order.length - 1, at < 0 ? 0 : at + delta))]
  select(next.sessionId, { scroll: true })
}

function answerByKey(n) {
  const s = selectedSession()
  if (!s) return false
  const ask = asksOf(s)[0]
  if (ask?.kind === 'question' && ask.isAnswerable) {
    let count = 0
    for (const [qi, q] of ask.questions.entries()) {
      for (const o of q.options) {
        count++
        if (count === n) { pick(ask.id, qi, o.label); return true }
      }
    }
    return false
  }
  if (!ask && reviewOf(s)) {
    if (n === 1) { reviewAct('commit'); return true }
    if (n === 2) { reviewAct('diff'); return true }
  }
  return false
}

async function reviewAct(kind) {
  const s = selectedSession()
  if (!s) return
  if (kind === 'change') { $('composer').focus(); return }
  if (kind === 'diff') return showDiff(s)
  if (kind === 'commit') return sendText(s, 'Looks good. Commit your changes now: only your own hunks, in the commit style of this repository.', 'Commit request')
}

async function showDiff(s) {
  $('diff-title').textContent = `Diff · ${titleOf(s)}`
  $('diff-sub').textContent = 'Loading…'
  $('diff-body').textContent = ''
  $('diff').classList.add('open')
  try {
    const result = await api(`/api/diff?id=${encodeURIComponent(s.sessionId)}`)
    $('diff-sub').textContent = result.files.length ? `${result.files.length} file(s) this session edited, against HEAD` : 'No edited file of this session in the repository'
    $('diff-body').innerHTML = esc(result.diff || 'No changes.').split('\n').map(line => (/^\+(?!\+\+)/.test(line) ? `<span class="add">${line}</span>` : /^-(?!--)/.test(line) ? `<span class="del">${line}</span>` : /^@@/.test(line) ? `<span class="hunk">${line}</span>` : line)).join('\n')
  } catch (error) {
    $('diff-sub').textContent = `Could not load the diff: ${error.message}`
  }
}

async function sendText(session, text, what = 'Message') {
  try {
    const item = await post('/api/send', { sessionId: session.sessionId, text })
    toast(`${what} queued for ${titleOf(session)}`)
    await waitForDelivery(item.id, what)
  } catch (error) {
    toast(`${what} failed: ${error.message}`, true)
  }
}

async function send() {
  const s = selectedSession()
  const text = $('composer')?.value.trim()
  if (!s || !text) return
  $('send').disabled = true
  $('composer').value = ''
  try {
    await sendText(s, text)
    setTimeout(() => loadDetail(true), 1500)
  } finally {
    if ($('send')) $('send').disabled = false
  }
}

async function focusAct(act) {
  const s = selectedSession()
  if (!s) return
  if (act === 'read') { if (state.catchup) state.catchup.isRead = true; post('/api/read', { sessionId: s.sessionId }).catch(() => undefined); return renderCatchup() }
  if (act === 'older') { state.detailCount += 20; return loadDetail(true) }
  if (act === 'copy-resume') return copy(`claude --resume ${s.sessionId} --fork-session`, 'Resume command')
  if (act === 'handoff') {
    const others = state.sessions.filter(one => one.sessionId !== s.sessionId)
    if (!others.length) return toast('No other live session to hand off to', true)
    $('handoff-target').innerHTML = others.map(one => `<option value="${esc(one.sessionId)}">${esc(titleOf(one))} · ${esc(one.repo?.name || folderOf(one.cwd))}</option>`).join('')
    $('handoff').classList.add('open')
    return
  }
  if (act === 'open') {
    if (s.kind !== 'interactive') return focusAct('attach')
    try {
      const result = await post('/api/focus', { sessionId: s.sessionId })
      if (result.isTab) toast(`Switched to "${titleOf(s)}" in the terminal`)
      else if (result.reason === 'permission') toast('Allow Lookout to control your terminal: System Settings, Privacy & Security, Automation', true)
      else toast(result.ok ? `Terminal in front: switch to the tab "${titleOf(s)}"` : `Switch to the terminal tab "${titleOf(s)}" yourself`)
    } catch {
      toast(`Switch to the terminal tab "${titleOf(s)}" yourself`)
    }
    return
  }
  try {
    await post(`/api/${act}`, { sessionId: s.sessionId })
    toast(act === 'fork' ? 'Fork opened in a new terminal' : 'Attached in a new terminal')
  } catch (error) {
    toast(`${act} failed: ${error.message}`, true)
  }
}

/* digest and top bar */

function renderDigest() {
  const open = openSessions()
  const waits = state.sessions.filter(s => stateOf(s) === 'wait')
  const oldest = Math.min(...waits.map(s => asksOf(s)[0]?.at || s.statusUpdatedAt || state.now))
  $('need-n').textContent = open.length
  $('need-n').classList.toggle('zero', open.length === 0)
  $('need-sub').innerHTML = open.length ? `need${open.length === 1 ? 's' : ''} you${waits.length ? `<br>oldest for ${esc(ago(oldest))}` : ''}` : 'nothing waits<br>for you'
  $('next').disabled = open.length === 0
  const d = state.digest
  if (!d) return
  $('since-h').textContent = `Since your last look at ${clock(d.since)} (${agoText(d.since)})`
  $('since').innerHTML = d.lines.length ? d.lines.map(l => `<li><span class="dot st-${esc(l.tone)}"></span><span>${esc(l.text)}</span></li>`).join('') : '<li><span class="dot st-idle"></span><span>Nothing changed.</span></li>'
}

function renderLimits() {
  const limits = state.budget.limits || []
  const meter = (kind, label) => {
    const l = limits.find(one => one.kind === kind)
    if (!l) return ''
    const p = Math.round(l.percentUsed)
    const cls = p >= 90 ? ' hot' : p >= 80 ? ' warn' : ''
    const color = p >= 90 ? 'var(--err)' : p >= 80 ? 'var(--attn)' : 'var(--ok)'
    return `<span class="meter${cls}" title="${esc(kind)}">${label} <i style="--w:${Math.min(100, p)}%;--mc:${color}"></i> ${p} %<span class="r">${esc(resetLabel(l.resetsAt))}</span></span>`
  }
  const html = `${meter('five_hour', '5 h')}${meter('seven_day', 'Week')}`
  $('limits').innerHTML = html || '<span class="hint" title="Limits show after a turn of a session with the lookout mod">limits: -</span>'
  $('limits').style.display = 'inline-flex'
  $('limits').style.gap = '14px'
  const working = state.sessions.filter(s => s.status === 'busy').length
  $('live-text').textContent = `${state.sessions.length} live · ${working} working · ${clock(state.now)}`
  const waiting = openSessions().length
  document.title = waiting ? `(${waiting}) Lookout` : 'Lookout'
}
