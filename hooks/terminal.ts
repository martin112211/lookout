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
