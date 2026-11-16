/* Lookout page: data loop, events and keys. */

const TABS = ['overview', 'decisions', 'time', 'settings']

function setTab(tab) {
  if (!TABS.includes(tab)) return
  state.tab = tab
  storage('lookout-tab', tab)
  for (const t of TABS) $(`tab-${t}`).hidden = t !== tab
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-pressed', b.dataset.tab === tab))
  if (tab === 'decisions') { renderDecisions(); loadLedger() }
  if (tab === 'time') { renderTime(); loadTime() }
  if (tab === 'settings') { renderSettings(); loadSettings() }
  if (tab === 'overview') { renderOverview(); renderFocus() }
}

function notifyChanges() {
  if (state.firstLoad || storage('lookout-notify') !== 'on' || !('Notification' in window) || Notification.permission !== 'granted') return
  for (const s of state.sessions) {
    const before = state.previous.get(s.sessionId)
    if (!before) continue
    const now = stateOf(s)
    if (before !== 'wait' && now === 'wait') new Notification('Needs you', { body: titleOf(s), tag: s.sessionId })
    else if (before === 'run' && now === 'done') new Notification('Finished', { body: `${titleOf(s)}\n${s.lastAssistant || ''}`.slice(0, 180), tag: s.sessionId })
  }
}

function isTyping() {
  const el = document.activeElement
  return el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}

async function refresh() {
  try {
    const data = await api('/api/sessions')
    state.sessions = data.sessions
    state.now = data.now
    state.messaging = data.messaging
    state.repos = data.repos || []
    state.leases = data.leases || []
    state.budget = data.budget || { limits: [], burn: [] }
    for (const [id, at] of state.done) if (Date.now() - at > 20_000) state.done.delete(id)
    notifyChanges()
    state.previous = new Map(state.sessions.map(s => [s.sessionId, stateOf(s)]))
    $('offline').classList.remove('show')
    $('live').classList.remove('off')
    if (state.firstLoad) {
      state.firstLoad = false
      const saved = storage('lookout-selected')
      const first = openSessions()[0] || orderedSessions()[0]
      const pickId = state.sessions.some(s => s.sessionId === saved) ? saved : first?.sessionId
      if (pickId) select(pickId)
    }
    renderLimits()
    renderDigest()
    if (state.tab === 'overview') {
      renderOverview()
      renderFocus()
    }
  } catch {
    $('offline').classList.add('show')
    $('live').classList.add('off')
  }
}

async function look() {
  try {
    state.digest = await post('/api/look', {})
    renderDigest()
  } catch {}
}

let hiddenAt = 0
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return }
  if (hiddenAt && Date.now() - hiddenAt > 5 * 60_000) look()
  refresh()
})

$('tabs').addEventListener('click', event => {
  const el = event.target.closest('[data-tab]')
  if (el) setTab(el.dataset.tab)
})
$('next').addEventListener('click', nextOpen)

$('overview').addEventListener('click', event => {
  const release = event.target.closest('[data-release]')
  if (release) {
    post('/api/lease/release', { key: release.dataset.release, sessionId: '*' }).then(() => { toast('Lock released'); refresh() }, error => toast(`Release failed: ${error.message}`, true))
    return
  }
  const row = event.target.closest('.srow')
  if (row) select(row.dataset.id)
})
$('overview').addEventListener('keydown', event => {
  const row = event.target.closest('.srow')
  if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(row.dataset.id) }
})

$('focus').addEventListener('click', event => {
  const t = event.target
  const choice = t.closest('.choice')
  if (choice && !choice.disabled) return pick(choice.dataset.ask, Number(choice.dataset.q), choice.dataset.label)
  const submit = t.closest('[data-submit]')
  if (submit) return submitAsk(submit.dataset.submit)
  const review = t.closest('[data-review]')
  if (review) return reviewAct(review.dataset.review)
  const copyBtn = t.closest('[data-copy]')
  if (copyBtn) return copy(copyBtn.dataset.copy, 'Command')
  const act = t.closest('[data-act]')
  if (act) return focusAct(act.dataset.act)
  if (t.closest('#send')) return send()
})
$('focus').addEventListener('input', event => {
  const own = event.target.closest('input.own')
  if (own) draftOf(own.dataset.ask).other[Number(own.dataset.q)] = own.value
})
$('focus').addEventListener('keydown', event => {
  if (event.target.matches('input.own') && event.key === 'Enter') { event.preventDefault(); submitAsk(event.target.dataset.ask) }
  if (event.target.id === 'composer' && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send() }
  if (event.key === 'Escape' && isTyping()) document.activeElement.blur()
})

$('tab-decisions').addEventListener('input', event => {
  if (event.target.id === 'ledger-filter') { state.ledgerQuery = event.target.value; renderDecisions() }
})
$('tab-decisions').addEventListener('click', event => {
  const btn = event.target.closest('button')
  if (btn?.dataset.lCopy) { const e = state.ledgerShown?.[Number(btn.dataset.lCopy)]; if (e) copy(`${e.question ? `${e.question} -> ` : ''}${e.text}`, 'Decision') }
  if (btn?.dataset.lMem) { const e = state.ledgerShown?.[Number(btn.dataset.lMem)]; if (e) ledgerToMemory(e) }
})
$('tab-time').addEventListener('click', event => {
  const btn = event.target.closest('button')
  if (btn?.dataset.days) { state.timeDays = Number(btn.dataset.days); state.time = null; renderTime(); return loadTime() }
  if (btn?.dataset.copyTime) return copyTime(btn.dataset.copyTime)
  const row = event.target.closest('[data-item]')
  if (row) { const key = row.dataset.item; state.openItems.has(key) ? state.openItems.delete(key) : state.openItems.add(key); renderTime() }
})
$('tab-settings').addEventListener('change', onSettingsChange)
$('tab-settings').addEventListener('click', event => {
  if (event.target.closest('[data-cfg-reset]')) return resetSettings()
  const profileBtn = event.target.closest('[data-profile]')
  if (profileBtn) return setProfile(profileBtn.dataset.profile)
  const replay = event.target.closest('[data-replay]')
  if (replay) return loadReplay(Number(replay.dataset.replay))
  const lookBtn = event.target.closest('[data-look]')
  if (lookBtn) return setLook({ look: lookBtn.dataset.look })
  const modeBtn = event.target.closest('[data-mode]')
  if (modeBtn) return setLook({ mode: modeBtn.dataset.mode })
})

$('handoff-cancel').addEventListener('click', () => $('handoff').classList.remove('open'))
$('handoff-send').addEventListener('click', async () => {
  const to = $('handoff-target').value
  if (!state.selected || !to) return
  $('handoff-send').disabled = true
  try {
    const item = await post('/api/handoff', { from: state.selected, to, note: $('handoff-note').value })
    $('handoff').classList.remove('open')
    $('handoff-note').value = ''
    toast(`Handing off to ${sessionName(to)}…`)
    await waitForDelivery(item.id, 'Hand-off')
  } catch (error) {
    toast(`Hand-off failed: ${error.message}`, true)
  } finally {
    $('handoff-send').disabled = false
  }
})
$('diff-close').addEventListener('click', () => $('diff').classList.remove('open'))
for (const id of ['handoff', 'diff']) $(id).addEventListener('click', event => { if (event.target === $(id)) $(id).classList.remove('open') })

$('notify').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('Notifications are not supported here', true)
  if (storage('lookout-notify') === 'on') storage('lookout-notify', 'off')
  else {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return toast('Notifications are blocked by the browser', true)
    storage('lookout-notify', 'on')
  }
  $('notify').setAttribute('aria-pressed', storage('lookout-notify') === 'on')
})

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    for (const id of ['handoff', 'diff']) $(id).classList.remove('open')
    return
  }
  if (isTyping() || event.ctrlKey || event.metaKey || event.altKey) return
  if (state.tab !== 'overview') return
  const k = event.key
  if (k === 'j' || k === 'ArrowDown') { event.preventDefault(); return step(1) }
  if (k === 'k' || k === 'ArrowUp') { event.preventDefault(); return step(-1) }
  if (k === 'n') return nextOpen()
  if (k === 'r') { event.preventDefault(); return $('composer')?.focus() }
  if (k === 'o') return focusAct('open')
  if (k === 'e') return focusAct('read')
  if (k === '?') { const s = selectedSession(); if (s) showDiff(s); return }
  if (/^[1-9]$/.test(k) && answerByKey(Number(k))) event.preventDefault()
})

let resizeTimer
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => renderOverview(true), 120) })

$('notify').setAttribute('aria-pressed', storage('lookout-notify') === 'on')
setTab(TABS.includes(storage('lookout-tab')) ? storage('lookout-tab') : 'overview')
loadSettings()
refresh().then(look)
setInterval(refresh, 3000)
setInterval(() => { if (state.selected && state.tab === 'overview') loadDetail() }, 5000)
setInterval(() => { if (state.tab === 'decisions') loadLedger() }, 60_000)
