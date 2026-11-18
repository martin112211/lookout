import { describe, expect, test } from 'claude-code/testing'

import { isSameDecision } from '../hooks/decisions'
import { browserArgv, focusSessionArgv, parseProcessInfo, tabArgv } from '../hooks/terminal'
import { isOlderVersion, latestTag } from '../hooks/update'

const FORK = { cwd: '/Users/me/repo it', title: 'Fork: x', command: ['claude', '--resume', 'abc', '--fork-session'] }

describe('platform', () => {
  test('Windows opens a Windows Terminal tab and refuses cmd metacharacters', async () => {
    expect(tabArgv('windows', undefined, FORK)).toEqual(['cmd.exe', '/d', '/c', 'wt', '-w', '0', 'new-tab', '-d', '/Users/me/repo it', '--title', 'Fork: x', 'claude', '--resume', 'abc', '--fork-session'])
    expect(() => tabArgv('windows', undefined, { title: 'a & b', command: ['claude'] })).toThrow()
  })

  test('macOS opens Ghostty when it runs there, else Terminal with a quoted command', async () => {
    expect(tabArgv('mac', 'ghostty', FORK).slice(0, 6)).toEqual(['open', '-na', 'Ghostty.app', '--args', '--working-directory=/Users/me/repo it', '--title=Fork: x'])
    const script = tabArgv('mac', 'Apple_Terminal', { cwd: "/tmp/it's", title: 't', command: ['claude', 'attach', 'abc'] })
    expect(script[0]).toBe('osascript')
    expect(script[2]).toBe(`tell application "Terminal" to do script "cd '/tmp/it'\\\\''s' && 'claude' 'attach' 'abc'"`)
  })

  test('a session process gives its terminal device and terminal app', async () => {
    expect(parseProcessInfo('ttys003  claude --resume x TERM=xterm TERM_PROGRAM=ghostty HOME=/Users/me\n')).toEqual({ tty: 'ttys003', terminal: 'ghostty' })
    expect(parseProcessInfo('??       claude')).toEqual({ tty: undefined, terminal: undefined })
  })

  test('Open finds the session tab: Ghostty by title and folder, Terminal by device, nothing off macOS', async () => {
    const target = { titles: ['Fix "the" login', undefined, 'ab'], others: ['Other work'], cwd: '/Users/me/repo', tty: 'ttys004' }
    const ghostty = focusSessionArgv('mac', 'ghostty', target)?.[2] ?? ''
    expect(ghostty).toContain('set wanted to {"Fix \\"the\\" login"}')
    expect(ghostty).toContain('set others to {"Other work"}')
    expect(ghostty).toContain('every terminal whose working directory is "/Users/me/repo"')
    expect(focusSessionArgv('mac', 'Apple_Terminal', target)?.[2]).toContain('if tty of t is "/dev/ttys004"')
    expect(focusSessionArgv('mac', 'Apple_Terminal', { ...target, tty: undefined })).toBeNull()
    expect(focusSessionArgv('mac', 'WezTerm', target)).toBeNull()
  })

  test('Open on Windows selects the Windows Terminal tab by title through UI Automation', async () => {
    const argv = focusSessionArgv('windows', undefined, { titles: ["Fix Ana's login", undefined, 'Claude Code', 'ab'] }) ?? []
    expect(argv.slice(0, 6)).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    const bytes = atob(argv[6] ?? '')
    let script = ''
    for (let index = 0; index < bytes.length; index += 2) script += String.fromCharCode(bytes.charCodeAt(index) | (bytes.charCodeAt(index + 1) << 8))
    expect(script).toContain("$wanted = @('Fix Ana''s login')")
    expect(script).toContain('CASCADIA_HOSTING_WINDOW_CLASS')
    expect(script).toContain('SelectionItemPattern]::Pattern).Select()')
    expect(script.split('{').length).toBe(script.split('}').length)
    expect(focusSessionArgv('windows', undefined, { titles: ['Claude Code'] })).toBeNull()
  })

  test('the browser opener follows the platform', async () => {
    expect(browserArgv('mac', 'http://x')).toEqual(['open', 'http://x'])
    expect(browserArgv('windows', 'http://x')[0]).toBe('rundll32')
    expect(browserArgv('linux', 'http://x')).toEqual(['xdg-open', 'http://x'])
  })
})

describe('ledger', () => {
  test('a reworded decision counts as the same one', async () => {
    expect(isSameDecision('Three-step controls approved: answer with 1-3, write with r, open the terminal tab with o.', 'Three-step controls: answer with 1-3, write with r, open the terminal tab with o.')).toBe(true)
    expect(isSameDecision("The top bar shows the 5-hour and weekly limit; each session shows its context, with a 'compacts soon' hint from 80 %.", "Top bar shows 5-hour and weekly limit; each session shows context, 'compacts soon' hint from 80 %.")).toBe(true)
  })

  test('different decisions stay apart', async () => {
    expect(isSameDecision('The agent view and the grouping by repo and branch are approved.', 'The owner picks directions B and C combined; the agent view and the grouping by repo and branch are approved.')).toBe(false)
    expect(isSameDecision('The name Lookout is confirmed.', 'All three looks stay; Calm is the default.')).toBe(false)
  })
})

describe('server version', () => {
  test('a server older than the installed mod, or without a version, is replaced', async () => {
    expect(isOlderVersion(undefined, '0.5.6')).toBe(true)
    expect(isOlderVersion('0.5.4', '0.5.6')).toBe(true)
    expect(isOlderVersion('0.5.10', '0.5.9')).toBe(false)
    expect(isOlderVersion('0.6.0', '0.5.9')).toBe(false)
    expect(isOlderVersion('0.5.6', '0.5.6')).toBe(false)
  })
  test('the newest release tag wins, other tags are ignored', async () => {
    const out = ['a\trefs/tags/v0.5.9', 'b\trefs/tags/v0.5.10', 'c\trefs/tags/lookout--v0.6.0', 'd\trefs/tags/v0.7.0-beta', 'e\trefs/tags/other--v9.0.0'].join('\n')
    expect(latestTag(out)).toBe('0.6.0')
    expect(latestTag('')).toBe(undefined)
  })
})
