/**
 * dsh-companion — host half.
 *
 * What this file owns
 * -------------------
 *   1. THE STATE. One small JSON file under `$DSH_HOME/companion/state.json` holding
 *      where the companion sits, whether it is shown, which character it wears.
 *      Writes are atomic (temp file + rename *in the same directory*, because a temp
 *      file in the OS temp dir can sit on another filesystem where rename() is a
 *      copy). Reads self-heal: a missing, hand-edited, oversized or malformed file
 *      never throws and never propagates junk — every field goes through the same
 *      sanitizer the HTTP layer uses.
 *   2. THE PRESENCE SIGNAL. `session/event` fires for every agent event. We do not
 *      interpret it: the mere fact that it fired means work is happening, so we
 *      stamp `activityAt`. The client turns that stamp into a mood. That is the
 *      whole of the "state awareness" the old plugins each reimplemented.
 *   3. TWO ROUTES. `/dsh-companion/status.json` (what this build is) and
 *      `/dsh-companion/state.json` (read + write). No asset route: every character
 *      is inline SVG in the client half, so there is no file a URL could name.
 *
 * Deliberately dependency-free and SDK-free: no build step, no imports beyond node:.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-companion'

/** `webServer` is the only host service this plugin needs. */
export const inject = ['webServer']

const BASE_ROUTE = '/dsh-companion'
const STATUS_ROUTE = `${BASE_ROUTE}/status.json`
const STATE_ROUTE = `${BASE_ROUTE}/state.json`
/**
 * The write path hangs UNDER the read path on purpose: the webserver matches a
 * registered prefix with `pathname === prefix || pathname.startsWith(prefix + '/')`,
 * so one registration can answer both and the suffix is derived, never typed twice.
 */
const WRITE_SUFFIX = '/state'
const WRITE_ROUTE = `${STATE_ROUTE}${WRITE_SUFFIX}`

/** Everything the companion remembers lives under these two names. */
const STATE_DIR = 'companion'
const STATE_FILE = 'state.json'

/** Refuse to read a state file, or accept a body, bigger than this. */
const MAX_BYTES = 8192

/** The label under the character. A name, not a document. */
const MAX_NAME = 24

/** Fractional window coordinates are pointless and invite float drift. */
const COORD_MIN = 0
const COORD_MAX = 100000

/** How long after the last session event the client still calls it "working". */
const ACTIVE_WINDOW_MS = 6000

/**
 * The characters this build ships artwork for.
 *
 * An ALLOW-LIST, and that is the entire validation: an id is only ever compared
 * against these strings, never turned into a path or a lookup key.
 */
const CHARACTER_IDS = Object.freeze(['fish', 'whale', 'pixel'])
const DEFAULT_CHARACTER = 'fish'

const DEFAULT_NAME = '小蓝'

/** Epoch ms may not sit more than a day in the future (clock skew) or the past century. */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000

/** The complete, honest default state. Every field the file may carry. */
const DEFAULT_STATE = Object.freeze({
  version: 1,
  visible: true,
  x: null,
  y: null,
  character: DEFAULT_CHARACTER,
  name: DEFAULT_NAME,
  clicks: 0,
})

const FIELD_NAMES = Object.freeze(Object.keys(DEFAULT_STATE))

/** `$DSH_HOME` when the host sets it, `~/.dsh` otherwise. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function statePath() {
  return join(dshHome(), STATE_DIR, STATE_FILE)
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Fold any input into a valid state.
 *
 * `strict` decides what an unacceptable value means:
 *   - strict (HTTP body): a field present with the wrong shape is a REJECTION, and
 *     the caller gets the issue list. Silently accepting `{"visible":"false"}` would
 *     teach a buggy client that its bug works.
 *   - lenient (disk): the same value falls back to the default instead, because a
 *     hand-edited file must not brick the pet either.
 */
function sanitizeState(raw, { strict = false } = {}) {
  const issues = []
  const out = { ...DEFAULT_STATE }
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) {
    issues.push('state: must be a JSON object')
    if (strict) return { state: out, issues, ok: false }
  }

  if (Object.prototype.hasOwnProperty.call(source, 'version')) {
    const v = source.version
    if (typeof v !== 'number' || !Number.isFinite(v) || v !== 1) {
      issues.push(`version: must be 1 (got ${JSON.stringify(v)})`)
      if (strict) return { state: out, issues, ok: false }
    }
  }

  if (Object.prototype.hasOwnProperty.call(source, 'visible')) {
    if (typeof source.visible === 'boolean') out.visible = source.visible
    else {
      issues.push('visible: must be a boolean')
      if (strict) return { state: out, issues, ok: false }
    }
  }

  for (const axis of ['x', 'y']) {
    if (!Object.prototype.hasOwnProperty.call(source, axis)) continue
    const value = source[axis]
    if (value === null) {
      out[axis] = null
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push(`${axis}: must be a finite number or null`)
      if (strict) return { state: out, issues, ok: false }
      continue
    }
    out[axis] = clampInt(value, COORD_MIN, COORD_MAX)
  }

  // x and y are a pair: a position with one axis missing would place the pet at
  // 0 on the other, which reads as "she teleported to the corner". Drop both.
  if ((out.x === null) !== (out.y === null)) {
    issues.push('x/y: must be supplied together')
    out.x = null
    out.y = null
  }

  if (Object.prototype.hasOwnProperty.call(source, 'character')) {
    const value = source.character
    if (typeof value === 'string' && CHARACTER_IDS.includes(value)) out.character = value
    else {
      issues.push(`character: must be one of ${CHARACTER_IDS.join(', ')}`)
      if (strict) return { state: out, issues, ok: false }
    }
  }

  if (Object.prototype.hasOwnProperty.call(source, 'name')) {
    const value = source.name
    if (typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_NAME) {
      out.name = value.trim()
    } else {
      issues.push(`name: must be a non-empty string of at most ${MAX_NAME} characters`)
      if (strict) return { state: out, issues, ok: false }
    }
  }

  if (Object.prototype.hasOwnProperty.call(source, 'clicks')) {
    const value = source.clicks
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      out.clicks = clampInt(value, 0, Number.MAX_SAFE_INTEGER)
    } else {
      issues.push('clicks: must be a non-negative finite number')
      if (strict) return { state: out, issues, ok: false }
    }
  }

  return { state: out, issues, ok: true }
}

/** Write the state atomically: temp sibling, then rename over the real file. */
async function writeState(state) {
  const file = statePath()
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, file)
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => {})
    throw cause
  }
  return file
}

/**
 * Read the state, healing anything unreadable.
 *
 * Returns `{ exists, state, issues, healed }`. `healed` means the file existed but
 * could not be used as-is and the defaults were substituted; the caller may want to
 * persist that decision, and the status route reports it.
 */
async function readState() {
  const file = statePath()
  let text
  try {
    const info = await stat(file)
    if (!info.isFile()) return { exists: false, state: { ...DEFAULT_STATE }, issues: ['state file is not a regular file'], healed: true }
    if (info.size > MAX_BYTES) return { exists: true, state: { ...DEFAULT_STATE }, issues: [`state file exceeds ${MAX_BYTES} bytes`], healed: true }
    text = await readFile(file, 'utf8')
  } catch (cause) {
    if (cause && cause.code === 'ENOENT') return { exists: false, state: { ...DEFAULT_STATE }, issues: [], healed: false }
    return { exists: false, state: { ...DEFAULT_STATE }, issues: [`state read failed (${String(cause?.message ?? cause)})`], healed: true }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { exists: true, state: { ...DEFAULT_STATE }, issues: ['state file is not valid JSON'], healed: true }
  }
  const { state, issues } = sanitizeState(parsed, { strict: false })
  return { exists: true, state, issues, healed: issues.length > 0 }
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(`${JSON.stringify(payload, null, 2)}\n`)
}

function sendText(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Read a request body with a hard cap, so a stuck client cannot pin memory. */
async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BYTES) {
      const error = new Error(`request body exceeds ${MAX_BYTES} bytes`)
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Apply: wire the presence signal, then register the two routes.
 *
 * A failure while REGISTERING is the plugin boundary: report it and stop, never let
 * it escape into the host boot.
 */
export function apply(ctx) {
  /** Epoch ms of the last agent event, or 0 for "nothing has happened yet". */
  let activityAt = 0
  /** Epoch ms when the companion was last served a state read. Diagnostic only. */
  let servedAt = 0

  /**
   * Every agent event moves the pet. We do not inspect the event: its SHAPE is the
   * agent's business and has changed before, while "something happened" has not.
   */
  const onSessionEvent = () => {
    activityAt = Date.now()
  }
  if (typeof ctx.on === 'function') {
    ctx.effect(() => {
      const off = ctx.on('session/event', onSessionEvent)
      return () => {
        if (typeof off === 'function') off()
      }
    }, 'dsh-companion: presence signal')
  }

  const moodNow = () => (activityAt > 0 && Date.now() - activityAt < ACTIVE_WINDOW_MS ? 'working' : 'idle')

  const status = async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')
    if (pathname !== STATUS_ROUTE) return sendText(res, 404, 'dsh-companion: unknown status path\n')
    const read = await readState().catch((cause) => ({ exists: false, state: { ...DEFAULT_STATE }, issues: [String(cause?.message ?? cause)], healed: true }))
    return sendJson(res, {
      plugin: name,
      version: '1.0.0',
      characters: CHARACTER_IDS,
      defaultCharacter: DEFAULT_CHARACTER,
      moods: ['idle', 'working'],
      activeWindowMs: ACTIVE_WINDOW_MS,
      services: ['webServer'],
      routes: [STATUS_ROUTE, STATE_ROUTE, WRITE_ROUTE],
      stateFile: statePath(),
      stateExists: read.exists,
      stateIssues: read.issues,
      activityAt,
      mood: moodNow(),
    })
  }

  const state = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const { pathname } = url
    if (pathname !== STATE_ROUTE && pathname !== WRITE_ROUTE) {
      return sendText(res, 404, 'dsh-companion: unknown state path\n')
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const read = await readState()
      servedAt = Date.now()
      if (read.healed) {
        // Persist the healed state so the next read does not have to re-heal, and so
        // the user's bad edit is replaced by something the UI can render.
        await writeState(read.state).catch(() => {})
      }
      return sendJson(res, {
        ...read.state,
        exists: read.exists,
        healed: read.healed,
        issues: read.issues,
        activityAt,
        mood: moodNow(),
        activeWindowMs: ACTIVE_WINDOW_MS,
        servedAt,
      })
    }

    if (pathname === STATE_ROUTE) {
      // Writing to the read path is the mistake the pair of routes exists to avoid.
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
      return res.end('dsh-companion: use POST /state.json/state to change the state\n')
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
      return res.end('dsh-companion: state writes are POST only\n')
    }

    let text
    try {
      text = await readBody(req)
    } catch (cause) {
      const tooBig = cause && cause.code === 'BODY_TOO_LARGE'
      return sendJson(res, { ok: false, error: tooBig ? 'body-too-large' : 'body-read-failed', issues: [String(cause?.message ?? cause)] }, tooBig ? 413 : 400)
    }

    let parsed
    try {
      parsed = text.trim().length === 0 ? {} : JSON.parse(text)
    } catch {
      return sendJson(res, { ok: false, error: 'invalid-json', issues: ['body: must be JSON'] }, 400)
    }

    const previous = await readState()
    const merged = { ...previous.state, ...(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) }
    const { state: next, issues, ok } = sanitizeState(merged, { strict: true })
    if (!ok) return sendJson(res, { ok: false, error: 'invalid-state', issues }, 400)

    try {
      await writeState(next)
    } catch (cause) {
      return sendJson(res, { ok: false, error: 'write-failed', issues: [String(cause?.message ?? cause)] }, 500)
    }
    return sendJson(res, { ok: true, state: next, issues })
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: STATUS_ROUTE, handler: status }),
    'dsh-companion: status route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: STATE_ROUTE, handler: state }),
    'dsh-companion: state route',
  )
}

/** Exported for tests and for anyone scripting the state file by hand. */
export const limits = Object.freeze({
  MAX_BYTES,
  MAX_NAME,
  MAX_CLOCK_SKEW_MS,
  ACTIVE_WINDOW_MS,
  STATE_DIR,
  STATE_FILE,
  DEFAULT_STATE,
  DEFAULT_NAME,
  CHARACTER_IDS,
  DEFAULT_CHARACTER,
  FIELD_NAMES,
  baseRoute: BASE_ROUTE,
  routes: { STATUS_ROUTE, STATE_ROUTE, WRITE_ROUTE },
  sanitizeState,
  dshHome,
  statePath,
})
