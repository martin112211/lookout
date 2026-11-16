import { collectSessions, collisions, hubDir, migrateLegacyDir, readBrief, sessionDetail } from './hub-data.mjs'
import { markRead, publicSession, withCatchup } from './catchup.mjs'

const args = process.argv.slice(2)

function briefInput(sessionId) {
  const messages = sessionDetail(sessionId, 16, { full: true }).messages.map(one => ({
    role: one.role,
    text: one.text.length > 1500 ? `${one.text.slice(0, 1499)}…` : one.text,
  }))
  return { messages, previous: readBrief(sessionId) ?? null }
}

function sessionsWithCatchup() {
  const sessions = collectSessions()
  return withCatchup(sessions, collisions(sessions), hubDir).map(publicSession)
}

function recap(sessionId) {
  const session = sessionsWithCatchup().find(one => one.sessionId === sessionId)
  return session ? { sessionId, since: session.lastReadAt, unread: session.unread, items: session.catchup } : { sessionId, since: 0, unread: 0, items: [] }
}

const result =
  args[0] === '--migrate'
    ? { isMigrated: migrateLegacyDir() }
    : args[0] === '--detail'
      ? sessionDetail(args[1], Number(args[2] ?? 10))
      : args[0] === '--brief-input'
        ? briefInput(args[1])
        : args[0] === '--recap'
          ? recap(args[1])
          : args[0] === '--read'
            ? { at: markRead(hubDir, args[1]) }
            : sessionsWithCatchup()
process.stdout.write(JSON.stringify(result))
