export type Platform = 'windows' | 'mac' | 'linux'

export type TabRequest = { cwd?: string; title: string; command: string[] }

const CMD_UNSAFE = /[&|<>^"%!;\r\n]/

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function appleString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function shellLine(request: TabRequest): string {
  const run = request.command.map(shellQuote).join(' ')
  return request.cwd ? `cd ${shellQuote(request.cwd)} && ${run}` : run
}

export function tabArgv(os: Platform, terminal: string | undefined, request: TabRequest): string[] {
  if (os === 'windows') {
    const argv = [...(request.cwd ? ['-d', request.cwd] : []), '--title', request.title, ...request.command]
    const unsafe = argv.find(arg => CMD_UNSAFE.test(arg))
    if (unsafe) throw new Error(`refusing argument with shell metacharacters: ${unsafe}`)
    return ['cmd.exe', '/d', '/c', 'wt', '-w', '0', 'new-tab', ...argv]
  }
  if (os === 'mac' && terminal === 'ghostty') {
    return ['open', '-na', 'Ghostty.app', '--args', ...(request.cwd ? [`--working-directory=${request.cwd}`] : []), `--title=${request.title}`, '-e', ...request.command]
  }
  if (os === 'mac') {
    return ['osascript', '-e', `tell application "Terminal" to do script ${appleString(shellLine(request))}`, '-e', 'tell application "Terminal" to activate']
  }
  return ['x-terminal-emulator', '-e', 'sh', '-c', shellLine(request)]
}

export function tabName(os: Platform, terminal: string | undefined): string {
  if (os === 'windows') return 'Windows Terminal tab'
  if (terminal === 'ghostty') return 'Ghostty window'
  return os === 'mac' ? 'Terminal window' : 'terminal window'
}

export function browserArgv(os: Platform, url: string): string[] {
  if (os === 'windows') return ['rundll32', 'url.dll,FileProtocolHandler', url]
  if (os === 'mac') return ['open', url]
  return ['xdg-open', url]
}

const MAC_APPS: Record<string, string> = { ghostty: 'Ghostty', Apple_Terminal: 'Terminal', 'iTerm.app': 'iTerm', WezTerm: 'WezTerm', vscode: 'Visual Studio Code' }

export function focusArgv(os: Platform, terminal: string | undefined): string[] | null {
  if (os !== 'mac') return null
  const app = MAC_APPS[terminal ?? ''] ?? 'Terminal'
  return ['osascript', '-e', `tell application ${appleString(app)} to activate`]
}

export type FocusTarget = {
  /** Titles the session's tab may carry (Claude Code puts the session title in the tab, after a status glyph). */
  titles: (string | undefined)[]
  /** Titles of the other live sessions in the same folder, so a folder match never picks one of theirs. */
  others?: (string | undefined)[]
  cwd?: string
  /** The session's terminal device, e.g. ttys003. */
  tty?: string
}

/** `ps` line for a session process: its terminal device, then its command line with the environment (macOS `-E`). */
export function processInfoArgv(pid: number): string[] {
  return ['ps', '-E', '-ww', '-o', 'tty=,command=', '-p', String(pid)]
}

export function parseProcessInfo(output: string): { tty?: string; terminal?: string } {
  const line = output.trim()
  const tty = /^(\S+)/.exec(line)?.[1]
  const terminal = /(?:^|\s)TERM_PROGRAM=(\S+)/.exec(line)?.[1]
  return { tty: tty && tty !== '??' ? tty : undefined, terminal }
}

function appleList(values: string[]): string {
  return `{${values.map(appleString).join(', ')}}`
}

function usableTitles(values: (string | undefined)[]): string[] {
  return [...new Set(values.map(one => (one ?? '').replace(/[\r\n]+/g, ' ').trim()).filter(one => one.length >= 4 && one !== 'Claude Code'))]
}

/**
 * Brings the tab of a running interactive session to the front, macOS only. The script prints "ok" when it found the tab.
 * Ghostty is matched by tab title, then by folder when exactly one tab there belongs to no other session;
 * Terminal.app and iTerm by the session's terminal device. With `isDryRun` the script only prints what it would focus.
 */
export function focusSessionArgv(os: Platform, terminal: string | undefined, target: FocusTarget, isDryRun = false): string[] | null {
  if (os !== 'mac') return null
  const hit = (what: string, steps: string) => (isDryRun ? `return "ok " & ${what}` : `${steps}\nreturn "ok"`)
  if (terminal === 'ghostty') {
    const titles = usableTitles(target.titles)
    const others = usableTitles(target.others ?? [])
    const script = `tell application "Ghostty"
  set wanted to ${appleList(titles)}
  set others to ${appleList(others)}
  repeat with t in terminals
    set n to name of t
    repeat with w in wanted
      if n contains w then
        ${hit('n', 'focus t\nactivate')}
      end if
    end repeat
  end repeat
  set hits to {}
  ${target.cwd ? `repeat with t in (every terminal whose working directory is ${appleString(target.cwd)})
    set n to name of t
    set isOther to false
    repeat with o in others
      if n contains o then set isOther to true
    end repeat
    if not isOther then set end of hits to t
  end repeat` : ''}
  if (count of hits) is 1 then
    set t to item 1 of hits
    set n to name of t
    ${hit('n', 'focus t\nactivate')}
  end if
  return "none"
end tell`
    return ['osascript', '-e', script]
  }
  if (!target.tty) return null
  const device = appleString(`/dev/${target.tty}`)
  if (terminal === 'Apple_Terminal') {
    const script = `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is ${device} then
        ${hit('(name of w)', 'set selected of t to true\nset index of w to 1\nactivate')}
      end if
    end repeat
  end repeat
  return "none"
end tell`
    return ['osascript', '-e', script]
  }
  if (terminal === 'iTerm.app') {
    const script = `tell application "iTerm"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is ${device} then
          ${hit('(name of s)', 'select w\nselect t\nselect s\nactivate')}
        end if
      end repeat
    end repeat
  end repeat
  return "none"
end tell`
    return ['osascript', '-e', script]
  }
  return null
}
