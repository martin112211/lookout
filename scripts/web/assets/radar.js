/* Radar: every live session as a blip. Angle = repo, distance from the centre = time since it last moved. */

const SWEEP_MS = 6000
const RADAR_RINGS = [{ ms: 60_000, label: '1m' }, { ms: 10 * 60_000, label: '10m' }, { ms: 60 * 60_000, label: '1h' }, { ms: 6 * 60 * 60_000, label: '6h' }]
const radarBlips = new Map()
let radarSig = ''
let radarHot = null

function lastMoveOf(session) {
  if (session.status === 'busy') return state.now
  const at = Math.max(session.statusUpdatedAt || 0, Date.parse(session.lastAt || '') || 0, asksOf(session)[0]?.at || 0)
  return at || session.startedAt || state.now
}

function radiusOf(ageMs) {
  const f = Math.log10(Math.max(ageMs, 10_000) / 10_000) / Math.log10(RADAR_RINGS.at(-1).ms / 10_000)
  return 0.1 + 0.84 * Math.min(1, Math.max(0, f))
}

function radarRepos() {
  const repos = new Map()
  for (const s of state.sessions) {
    const key = s.repo?.root || `dir:${s.cwd}`
    const repo = repos.get(key) || { key, name: s.repo?.name || folderOf(s.cwd), sessions: [] }
    repo.sessions.push(s)
    repos.set(key, repo)
  }
  return [...repos.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
}

function radarLayout() {
  const repos = radarRepos()
  const span = 360 / Math.max(1, repos.length)
  const blips = []
  repos.forEach((repo, i) => {
    repo.from = i * span
    repo.mid = repo.from + span / 2
    const pad = repos.length > 1 ? Math.min(14, span * 0.18) : 0
    const list = repo.sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    list.forEach((s, j) => {
      const angle = repos.length === 1 && list.length === 1 ? 45 : repo.from + pad + ((j + 0.5) / list.length) * (span - 2 * pad)
      const age = Math.max(0, state.now - lastMoveOf(s))
      blips.push({ s, repo, angle, age, r: radiusOf(age), kind: stateOf(s) })
    })
  })
  return { repos, blips }
}

/* x, y in percent of the scope, angle clockwise from the top */
function polar(angle, r) {
  const a = (angle * Math.PI) / 180
  return { x: 50 + 50 * r * Math.sin(a), y: 50 - 50 * r * Math.cos(a) }
}

/* negative delay that puts keyframe 0 % of a SWEEP_MS cycle where the beam crosses `angle` */
function sweepDelay(angle) {
  const now = document.timeline?.currentTime ?? performance.now()
  return -((((now - (angle / 360) * SWEEP_MS) % SWEEP_MS) + SWEEP_MS) % SWEEP_MS)
}

const STATE_WORDS = { wait: 'needs you', run: 'working', done: 'finished, unread', idle: 'idle' }

function scopeSvg(repos) {
  const rings = RADAR_RINGS.map(ring => {
    const r = radiusOf(ring.ms) * 50
    return `<circle cx="50" cy="50" r="${r.toFixed(2)}"/><text x="${(50 + r * 0.72).toFixed(2)}" y="${(50 - r * 0.72 - 0.8).toFixed(2)}">${ring.label}</text>`
  }).join('')
  const spokes = repos.length > 1 ? repos.map(repo => { const p = polar(repo.from, 1); return `<line x1="50" y1="50" x2="${p.x.toFixed(2)}" y2="${p.y.toFixed(2)}"/>` }).join('') : ''
  return `<svg class="scope-grid" viewBox="0 0 100 100" aria-hidden="true"><circle class="rim" cx="50" cy="50" r="49.6"/>${rings}<g class="spokes">${spokes}</g><line class="cross" x1="50" y1="2" x2="50" y2="98"/><line class="cross" x1="2" y1="50" x2="98" y2="50"/></svg>`
}

function renderRadar() {
  const el = $('tab-radar')
  const { repos, blips } = radarLayout()
  const sig = repos.map(r => r.key).join('|')
  if (!$('scope') || sig !== radarSig) {
    radarSig = sig
    radarBlips.clear()
    const labels = repos.map(repo => {
      const p = polar(repo.mid, 1.09)
      return `<span class="sector" style="left:${p.x.toFixed(2)}%;top:${p.y.toFixed(2)}%">${esc(repo.name)}</span>`
    }).join('')
    el.innerHTML = `<div class="radar-wrap">
      <div class="panel scope-panel">
        <div class="panel-head"><h3>Radar</h3><span class="muted" id="radar-sum"></span></div>
        <div class="scope-frame"><div class="scope" id="scope">${scopeSvg(repos)}<div class="beam-clip"><div class="beam" style="animation-delay:${sweepDelay(0).toFixed(0)}ms"></div></div>${labels}<span class="me" title="Now"></span><div class="radar-tip" id="radar-tip" hidden></div></div></div>
        <div class="radar-legend"><span><i class="dot st-wait"></i>needs you</span><span><i class="dot st-run"></i>working</span><span><i class="dot st-done"></i>finished, unread</span><span><i class="dot st-idle"></i>idle</span><span class="hint">Angle: repo · Distance: time since the session last moved</span></div>
      </div>
      <div class="panel contacts"><div class="panel-head"><h3>Contacts</h3></div><div id="radar-list"></div></div>
    </div>`
  }
  const scope = $('scope')
  const seen = new Set()
  for (const b of blips) {
    const id = b.s.sessionId
    seen.add(id)
    let node = radarBlips.get(id)
    if (!node) {
      node = document.createElement('button')
      node.type = 'button'
      node.className = 'blip'
      node.dataset.id = id
      node.innerHTML = '<i class="core"></i><i class="ping"></i><span class="orbits"></span>'
      scope.appendChild(node)
      radarBlips.set(id, node)
    }
    const p = polar(b.angle, b.r)
    node.style.left = `${p.x.toFixed(2)}%`
    node.style.top = `${p.y.toFixed(2)}%`
    if (node.dataset.angle !== b.angle.toFixed(1)) {
      node.dataset.angle = b.angle.toFixed(1)
      node.querySelector('.core').style.animationDelay = `${sweepDelay(b.angle).toFixed(0)}ms`
    }
    node.className = `blip k-${b.kind}${radarHot === id ? ' hot' : ''}${state.selected === id ? ' sel' : ''}`
    node.setAttribute('aria-label', `${titleOf(b.s)}, ${b.repo.name}, ${STATE_WORDS[b.kind]}, last moved ${b.kind === 'run' ? 'now' : ago(state.now - b.age)}`)
    const running = (b.s.agents || []).filter(a => a.state === 'running').slice(0, 4)
    const orbitSig = running.map(a => `${a.id}:${modelKey(a.model)}`).join(',')
    if (node.dataset.orbits !== orbitSig) {
      node.dataset.orbits = orbitSig
      node.querySelector('.orbits').innerHTML = running.map((a, i) => `<i class="orbit" style="animation-delay:${(-i * 2400) / Math.max(1, running.length)}ms"><b style="background:${modelColor(a.model)}"></b></i>`).join('')
    }
  }
  for (const [id, node] of radarBlips) {
    if (seen.has(id)) continue
    node.remove()
    radarBlips.delete(id)
  }
  const counts = { wait: 0, run: 0 }
  for (const b of blips) if (counts[b.kind] !== undefined) counts[b.kind]++
  $('radar-sum').textContent = `${blips.length} contact${blips.length === 1 ? '' : 's'} · ${counts.wait} need${counts.wait === 1 ? 's' : ''} you · ${counts.run} working`
  renderContacts(blips)
  if (radarHot) showRadarTip(radarHot)
}

function bandOf(age) {
  if (age < 60_000) return 'Now'
  if (age < 10 * 60_000) return 'Last 10 minutes'
  if (age < 60 * 60_000) return 'Last hour'
  return 'Older'
}

function renderContacts(blips) {
  const order = { wait: 0, run: 1, done: 2, idle: 3 }
  const sorted = [...blips].sort((a, b) => order[a.kind] - order[b.kind] || a.age - b.age)
  let band = ''
  const rows = sorted.map(b => {
    const label = b.kind === 'wait' ? 'Needs you' : b.kind === 'run' ? 'Working' : bandOf(b.age)
    const head = label !== band ? `<div class="band">${esc((band = label))}</div>` : ''
    const branch = b.s.repo && b.s.branch && b.s.branch !== 'HEAD' ? ` ⎇ ${b.s.branch}` : ''
    return `${head}<button type="button" class="contact${radarHot === b.s.sessionId ? ' hot' : ''}" data-id="${esc(b.s.sessionId)}"><span class="dot st-${b.kind}"></span><span class="ct"><b>${esc(titleOf(b.s))}</b><span class="hint">${esc(b.repo.name + branch)}</span></span><span class="mono hint">${b.kind === 'run' ? 'now' : esc(ago(state.now - b.age))}</span></button>`
  }).join('')
  const html = rows || '<span class="hint">No live sessions in range.</span>'
  if ($('radar-list').dataset.sig !== html) {
    $('radar-list').dataset.sig = html
    $('radar-list').innerHTML = html
  }
}

function showRadarTip(id) {
  const tip = $('radar-tip')
  const node = radarBlips.get(id)
  const s = state.sessions.find(one => one.sessionId === id)
  if (!tip || !node || !s) { if (tip) tip.hidden = true; return }
  const kind = stateOf(s)
  const branch = s.repo && s.branch && s.branch !== 'HEAD' ? ` ⎇ ${s.branch}` : ''
  const line = lineOf(s)
  tip.innerHTML = `<b>${esc(titleOf(s))}</b><span class="hint">${esc((s.repo?.name || folderOf(s.cwd)) + branch)}</span><span><span class="dot st-${kind}"></span> ${esc(STATE_WORDS[kind])}</span>${line ? `<span class="line">${esc(line.slice(0, 140))}</span>` : ''}`
  tip.hidden = false
  const left = parseFloat(node.style.left)
  const top = parseFloat(node.style.top)
  tip.style.left = `${left}%`
  tip.style.top = `${top}%`
  tip.classList.toggle('flip-x', left > 58)
  tip.classList.toggle('flip-y', top > 62)
}

function setRadarHot(id) {
  if (radarHot === id) return
  radarHot = id
  for (const [key, node] of radarBlips) node.classList.toggle('hot', key === id)
  document.querySelectorAll('#radar-list .contact').forEach(row => row.classList.toggle('hot', row.dataset.id === id))
  if (id) showRadarTip(id)
  else if ($('radar-tip')) $('radar-tip').hidden = true
}

function openFromRadar(id) {
  setRadarHot(null)
  setTab('overview')
  select(id, { scroll: true })
}

$('tab-radar').addEventListener('click', event => {
  const hit = event.target.closest('.blip, .contact')
  if (hit) openFromRadar(hit.dataset.id)
})
$('tab-radar').addEventListener('mouseover', event => {
  const hit = event.target.closest('.blip, .contact')
  setRadarHot(hit ? hit.dataset.id : null)
})
$('tab-radar').addEventListener('mouseleave', () => setRadarHot(null))
$('tab-radar').addEventListener('focusin', event => {
  const hit = event.target.closest('.blip, .contact')
  setRadarHot(hit ? hit.dataset.id : null)
})
