import { describe, expect, test } from 'claude-code/testing'

import { bar, parseAheadBehind, parseCommits, parseRefs, parseStatus, pickBase, shortAge, splitPath } from '../hooks/git'

describe('git parsers', () => {
  test('ahead/behind from rev-list --left-right', async () => {
    expect(parseAheadBehind('3\t5\n')).toEqual({ ahead: 5, behind: 3 })
    expect(parseAheadBehind('')).toBe(null)
  })

  test('status joined with numstat, CRLF and quoted paths', async () => {
    const files = parseStatus(
      ' M src/a.java\r\n?? new.txt\r\nR  old.js -> moved.js\r\n M "my file.txt"\r\n',
      '10\t2\tsrc/a.java\r\n4\t0\tmoved.js\r\n1\t1\t"my file.txt"\r\n',
    )
    expect(files).toEqual([
      { path: 'src/a.java', status: 'M', added: 10, removed: 2 },
      { path: 'new.txt', status: '??', added: 0, removed: 0 },
      { path: 'moved.js', status: 'R', added: 4, removed: 0 },
      { path: 'my file.txt', status: 'M', added: 1, removed: 1 },
    ])
  })

  test('refs drop HEAD and remotes that mirror a local branch', async () => {
    expect(parseRefs('HEAD -> feature/x, origin/feature/x, origin/main, tag: v1')).toEqual([
      'feature/x',
      'origin/main',
      '#v1',
    ])
    expect(parseRefs('')).toEqual([])
  })

  test('commits carry refs, time and whether they are ahead of base', async () => {
    const [c] = parseCommits('52a5d99\tHEAD -> main\tfix: x\t1700000000\n', new Set(['52a5d99']))
    expect(c).toEqual({ hash: '52a5d99', refs: ['main'], subject: 'fix: x', time: 1700000000000, isAhead: true })
  })

  test('base comes from origin/HEAD, else main/master/develop', async () => {
    expect(pickBase('refs/remotes/origin/master\n', ['master', 'feature/x'])).toBe('master')
    expect(pickBase('refs/remotes/origin/main\n', ['feature/x'])).toBe('origin/main')
    expect(pickBase(null, ['develop', 'master'])).toBe('master')
    expect(pickBase(null, ['feature/x'])).toBe(null)
  })

  test('short ages and paths', async () => {
    expect(shortAge(5 * 60_000)).toBe('5m')
    expect(shortAge(3 * 3600_000)).toBe('3h')
    expect(shortAge(5 * 86400_000)).toBe('5d')
    expect(splitPath('src/a/B.java')).toEqual({ dir: 'src/a/', name: 'B.java' })
  })

  test('bar is always the same width', async () => {
    const b = bar(30, 10, 40, 8)
    expect(b.plus.length + b.minus.length + b.rest.length).toBe(8)
    expect(bar(0, 0, 10).rest).toBe('········')
  })
})

test('the git pane draws on the terminal and on desktop, also outside a repository', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'lookout', component: 'Pane', requestId: 'lookout-git', surface, props: { title: 'Git', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
    expect(await ui.find({ type: 'Text', text: /Not a git repository/ })).toBeDefined()
    await ui.unmount()
  }
})
