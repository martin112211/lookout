import { describe, expect, test } from 'claude-code/testing'

import { isSameDecision } from '../hooks/decisions'
import { browserArgv, tabArgv } from '../hooks/terminal'

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
