/* Lookout page: shared state and helpers. Loaded first; overview.js, tabs.js and main.js build on it. */
const token = new URLSearchParams(location.search).get('token') || ''
const state = {
  tab: 'overview',
  sessions: [], repos: [], leases: [], budget: { limits: [], burn: [] }, messaging: { isAvailable: false },
  now: Date.now(), selected: null, detail: null, detailCount: 8, agent: null, agentDetail: null,
  drafts: new Map(), sending: new Set(), done: new Map(),
  look: null, digest: null,
  ledger: null, ledgerQuery: '', time: null, timeDays: 7, openItems: new Set(), settings: null,
  previous: new Map(), firstLoad: true,
}
const $ = id => document.getElementById(id)

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key)
    localStorage.setItem(key, value)
  } catch {}
  return null
}

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { 'x-lookout-token': token, 'content-type': 'application/json', ...(init.headers || {}) } })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return response.json()
}

function post(path, payload) {
  return api(path, { method: 'POST', body: JSON.stringify(payload ?? {}) })
}

/* Radar mark for the tab and the top bar: the beam is lit while a session works, the badge counts sessions that need you. */
function lookoutIcon({ waiting = 0, working = true, offline = false, square = false } = {}) {
  const beam = offline ? '#5f6773' : working ? '#6aa6f8' : '#8b95a7'
  const ring = offline ? '#3a404b' : working ? '#3d5a86' : '#434b5a'
  const blip = offline ? '#5f6773' : '#f2a33a'
  const label = waiting > 9 ? '9+' : String(waiting)
  const badge = waiting ? `<circle cx="49" cy="15" r="13" fill="#f2a33a" stroke="#161a22" stroke-width="4"/><text x="49" y="15" dy=".36em" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-weight="800" font-size="${waiting > 9 ? 13 : 18}" fill="#161a22">${label}</text>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="${square ? 0 : 15}" fill="#161a22"/><circle cx="32" cy="32" r="22.5" fill="none" stroke="${ring}" stroke-width="4"/><circle cx="32" cy="32" r="11" fill="none" stroke="${ring}" stroke-width="3"/><g class="sweep"><path d="M32 32V9.5A22.5 22.5 0 0 1 51.5 20.75Z" fill="${beam}" fill-opacity=".3"/><path d="M32 32L51.5 20.75" stroke="${beam}" stroke-width="4.5" stroke-linecap="round"/></g><circle cx="32" cy="32" r="4.5" fill="${beam}"/><circle class="spot" cx="40.5" cy="16.5" r="6" fill="${blip}"/>${badge}</svg>`
}

let tabIconSig = ''
function setTabIcon(look) {
  const sig = JSON.stringify(look)
  if (sig === tabIconSig) return
  tabIconSig = sig
  const link = document.querySelector('link[rel="icon"]')
  if (link) link.href = `data:image/svg+xml,${encodeURIComponent(lookoutIcon(look))}`
  const mark = $('mark')
  if (!mark) return
  mark.innerHTML = lookoutIcon({ ...look, waiting: 0 })
  mark.classList.toggle('working', Boolean(look.working) && !look.offline)
  mark.classList.toggle('waiting', Boolean(look.waiting) && !look.offline)
}

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function ago(ms) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((state.now - ms) / 1000))
  if (s < 45) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

function agoText(ms) {
  const value = ago(ms)
  return value === 'now' ? 'just now' : `${value} ago`
}

function clock(ms) {
  return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
}

function resetLabel(iso) {
  if (!iso) return ''
  const at = new Date(iso)
  const sameDay = at.toDateString() === new Date().toDateString()
  return sameDay ? clock(at.getTime()) : at.toLocaleDateString([], { weekday: 'short' }) + ' ' + clock(at.getTime())
}

function tokens(n) {
  if (!n) return '-'
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}k`
}

function modelKey(model) {
  const m = /(haiku|sonnet|opus|fable)/i.exec(model || '')
  return m ? m[1].toLowerCase() : null
}

function modelColor(model) {
  const key = modelKey(model)
  return key ? `var(--${key})` : 'var(--muted)'
}

function prettyModel(model) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?/.exec(model || '')
  if (!m) return model || ''
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

function titleOf(session) {
  return session.title || session.name
}

function folderOf(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).at(-1) || path || '?'
}

function itemLabel(id) {
  return /^[0-9]+$/.test(id) ? `#${id}` : id
}

function sessionName(id) {
  const s = state.sessions.find(one => one.sessionId === id)
  return s ? titleOf(s) : `ended ${String(id).slice(0, 8)}`
}

function contextPercent(session) {
  if (typeof session.usage?.contextPercent === 'number' && state.now - (session.usage.at || 0) < 30 * 60_000) return Math.round(session.usage.contextPercent)
  const n = session.contextTokens
  if (!n) return null
  const limit = n > 200_000 ? 1_000_000 : 200_000
  return Math.min(100, Math.round((n / limit) * 100))
}

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
}

function markdown(source) {
  const parts = String(source).split(/```[^\n]*\n?/)
  let html = ''
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      html += `<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`
      return
    }
    const lines = esc(part).split('\n')
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (!line.trim()) { i++; continue }
      if (/^\s*\|/.test(line)) {
        const rows = []
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++])
        const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()))
        const body = rows.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r))
        const [head, ...rest] = body
        if (!head) continue
        html += `<table><thead><tr>${cells(head).map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rest.map(r => `<tr>${cells(r).map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
        continue
      }
      const heading = line.match(/^#{1,6}\s+(.*)$/)
      if (heading) { html += `<h4>${inline(heading[1])}</h4>`; i++; continue }
      if (/^\s*[-*]\s+/.test(line)) {
        const items = []
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''))
        html += `<ul>${items.map(t => `<li>${inline(t)}</li>`).join('')}</ul>`
        continue
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = []
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))
        html += `<ol>${items.map(t => `<li>${inline(t)}</li>`).join('')}</ol>`
        continue
      }
      const para = []
      while (i < lines.length && lines[i].trim() && !/^\s*(\||[-*]\s|\d+[.)]\s|#{1,6}\s)/.test(lines[i])) para.push(lines[i++])
      if (para.length === 0) { html += `<p>${inline(lines[i++])}</p>`; continue }
      html += `<p>${inline(para.join('<br>'))}</p>`
    }
  })
  return html
}

function toast(text, isError = false) {
  const el = document.createElement('div')
  el.className = `toast${isError ? ' err' : ''}`
  el.textContent = text
  $('toasts').append(el)
  setTimeout(() => el.remove(), 4200)
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${what} copied`)
  } catch {
    toast('Clipboard not available', true)
  }
}

async function waitForDelivery(id, what) {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const now = await api(`/api/send/${id}`)
    if (now.state === 'delivered') return toast(`${what} delivered`)
    if (now.state === 'failed') return toast(`${what} not delivered: ${now.reason || 'unknown reason'}`, true)
  }
  toast(`${what} still queued: is a session with the lookout mod open?`, true)
}

/* Looks: appearance.look and appearance.mode from the settings file; the page only switches token sets. */
const LOOKS = [
  ['calm', 'Calm', 'Graphite, amber only for what needs you'],
  ['warm', 'Warm', 'Gruvbox, all monospace, square'],
  ['editorial', 'Editorial', 'Rules instead of boxes, serif headlines'],
]
const darkQuery = matchMedia('(prefers-color-scheme: dark)')

function applyLook(appearance) {
  if (appearance) state.look = appearance
  const look = state.look?.look || storage('lookout-look') || 'calm'
  const wanted = state.look?.mode || 'system'
  const mode = wanted === 'system' ? (darkQuery.matches ? 'dark' : 'light') : wanted
  document.documentElement.dataset.look = look
  document.documentElement.dataset.mode = mode
  storage('lookout-look', look)
}
darkQuery.addEventListener('change', () => applyLook())
applyLook()
