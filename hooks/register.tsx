import type { Register } from 'claude-code'

import { registerLookoutPane } from './lookout-pane'
import { registerGitPane } from './git-pane'
import { registerHub } from './hub'
import { registerStatus } from './status'

export const register: Register = on => {
  registerHub(on)
  registerLookoutPane(on)
  registerStatus(on)
  registerGitPane(on)
}
