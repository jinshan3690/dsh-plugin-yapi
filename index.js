/**
 * dsh-plugin-yapi — host half.
 *
 * Owns the YAPI account. The browser never sees the password: the host logs in
 * lazily, keeps the `_yapi_token` / `_yapi_uid` cookie in memory, refreshes it
 * on expiry, and exposes two exact `/api/yapi/*` routes to the panel:
 *
 *   POST /api/yapi/interface  { id }  -> normalized interface document
 *   POST /api/yapi/search     { projectId, keyword } -> fuzzy interface matches
 *   GET  /api/yapi/health             -> login / configuration status
 *   GET  /api/yapi/settings           -> current account (no password)
 *   POST /api/yapi/settings           -> verify, then persist a new account
 *
 * Both routes sit on DSH's authenticated `/api` channel, so the panel talks to
 * origin-relative URLs and the YAPI origin is never fetched from the browser.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  normalizeBaseUrl,
  normalizeInterface,
  parseDocId,
  rankInterfaces,
} from './lib/core.js'

export const name = 'yapi'
export const inject = ['connection', 'skills']

/** Directory of this host module; the packaged skill and CLI live below it. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** A failure with a stable machine-readable code for the panel's error box. */
class YapiError extends Error {
  /**
   * @param {string} message - user-facing correction.
   * @param {string} code - stable failure category.
   */
  constructor(message, code) {
    super(message)
    this.name = 'YapiError'
    this.code = code
  }
}

/** @param {unknown} error @returns {string} */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error ?? '未知错误')
}

/**
 * An abort signal bounded by the configured timeout, when the runtime has one.
 * @param {number} milliseconds - request budget.
 * @returns {AbortSignal | undefined} timeout signal or undefined.
 */
function timeoutSignal(milliseconds) {
  try {
    return AbortSignal.timeout(milliseconds)
  } catch {
    return undefined
  }
}

/**
 * JSON response with no caching and an explicit UTF-8 charset.
 * @param {unknown} value - serializable body.
 * @param {number} [status] - HTTP status.
 * @returns {Response} the response the connection bridge forwards.
 */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Absolute path of the harness home used for the plugin's own config file. */
function harnessHome() {
  const configured = typeof process !== 'undefined' ? process.env?.DSH_HOME : undefined
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/** Location of the optional credential file written by the installer. */
export const CONFIG_FILE = join(harnessHome(), 'dsh-plugin-yapi.json')

const BUNDLED_SKILL_PROVIDER = 'yapi-doc-plugin'
const BUNDLED_SKILLS = [
  {
    name: 'yapi-doc',
    dir: 'yapi-doc',
    description:
      'Read a YAPI interface document by ID, full URL, or path keyword. Use when a task needs an API method, path, headers, parameters, request body, response fields, or response example. The bundled CLI reads the local YAPI account and prints Markdown in one command.',
    whenToUse:
      'The user mentions YAPI, an interface document ID (for example 10001), an API path, or asks for the request or response fields of an API.',
  },
  {
    name: 'yapi-sync',
    dir: 'yapi-sync',
    description:
      'Sync the yapi-doc and yapi-sync skills into every detected AI tool (Trae, WorkBuddy, Qoder CN, GitHub Copilot, CodeBuddy, Codex/Agent Skills, DSH, Claude Code, Cursor, Gemini CLI, Amp, OpenCode and more). Use when the user asks to install, update, or sync the YAPI skill across tools.',
    whenToUse:
      'The user asks to install, update, or sync the YAPI skill or CLI across local AI tools.',
  },
]

/** Packaged skills whose user-level copy is absent. */
function bundledSkillDefs() {
  return BUNDLED_SKILLS.map(function (skill) {
    return Object.assign({}, skill, {
      skillDir: join(HERE, 'skills', skill.dir),
      skillPath: join(HERE, 'skills', skill.dir, 'SKILL.md'),
    })
  }).filter(function (skill) {
    return (
      existsSync(skill.skillPath) &&
      !existsSync(join(harnessHome(), 'skills', skill.name, 'SKILL.md'))
    )
  })
}

/**
 * Register packaged `yapi-doc` / `yapi-sync` skills when the plugin was
 * installed by `dsh plugin add` (no `~/.dsh/skills` copy present). The user
 * skill root still wins because it ranks above this bundled provider.
 * @param {any} ctx - DSH host context (must carry the `skills` service).
 */
function registerBundledSkill(ctx) {
  const defs = bundledSkillDefs()
  if (defs.length === 0) return

  ctx.skills.registerProvider(function () {
    return {
      name: BUNDLED_SKILL_PROVIDER,
      async list() {
        return defs.map(function (skill) {
          return {
            name: skill.name,
            description: skill.description,
            whenToUse: skill.whenToUse,
            source: 'bundled',
            provider: BUNDLED_SKILL_PROVIDER,
            rank: 1000,
            path: skill.skillPath,
          }
        })
      },
      async get(candidate) {
        const skill = defs.find(function (item) {
          return item.name === (candidate && candidate.name)
        })
        if (skill === undefined) return undefined
        const raw = await readFile(skill.skillPath, 'utf8')
        const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, '').trim()
        const content = body.split('$HOME/.dsh/skills/yapi-doc').join(join(HERE, 'skills', 'yapi-doc'))
        return {
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'bundled',
          provider: BUNDLED_SKILL_PROVIDER,
          resourceBase: { kind: 'directory', path: skill.skillDir },
          path: skill.skillPath,
          content,
        }
      },
    }
  })
}

/**
 * Read the installer-written config file. Missing or malformed files are not a
 * startup failure: the panel reports the missing credential when it first asks
 * for a document, which keeps the plugin visible and explains the fix.
 * @returns {Record<string, unknown>} parsed object, or an empty object.
 */
function readStoredConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Atomically persist the account so the next start uses it. The temporary file
 * is created with 0600 before the rename, so the password is never briefly
 * readable by another user.
 * @param {{ baseUrl: string, email: string, password: string, timeoutMs: number }} settings - verified account.
 */
function writeConfigFile(settings) {
  const directory = dirname(CONFIG_FILE)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${CONFIG_FILE}.${String(process.pid)}.${String(Date.now())}.tmp`
  const content = JSON.stringify(
    {
      baseUrl: settings.baseUrl,
      email: settings.email,
      password: settings.password,
      timeoutMs: settings.timeoutMs,
    },
    null,
    2,
  )
  writeFileSync(temporary, content + '\n', { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, CONFIG_FILE)
}

/**
 * Resolve settings by precedence: plugin-row config → environment → config file.
 * Keeping the row empty is what lets the market hot-mount the bundle patch
 * (that path only accepts plain insert rows), while the file still carries the
 * account for a fresh start.
 * @param {Record<string, unknown>} config - loader-provided config.
 * @returns {{ baseUrl: string, email: string, password: string, timeoutMs: number }} settings.
 */
function readConfig(config) {
  const row = config && typeof config === 'object' ? config : {}
  const env = typeof process !== 'undefined' && process.env ? process.env : {}
  const stored = readStoredConfig()
  const timeout = Number(row.timeoutMs ?? env.YAPI_TIMEOUT_MS ?? stored.timeoutMs)
  return {
    baseUrl: normalizeBaseUrl(row.baseUrl ?? env.YAPI_BASE_URL ?? stored.baseUrl ?? ''),
    email: String(row.email ?? env.YAPI_EMAIL ?? stored.email ?? '').trim(),
    password: String(row.password ?? env.YAPI_PASSWORD ?? stored.password ?? ''),
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 120_000) : 20_000,
  }
}

/**
 * Create the in-memory YAPI session and its two JSON verbs.
 * @param {{ baseUrl: string, email: string, password: string, timeoutMs: number }} settings - resolved config.
 * @param {any} logger - DSH logger (optional methods).
 * @returns {{ getJson: Function, ensureSession: Function, status: Function }} client face.
 */
function createYapiClient(settings, logger) {
  const { baseUrl, email, password, timeoutMs } = settings
  let cookie = ''
  let expiresAt = 0
  let pendingLogin = null
  let user = null
  let lastLoginAt = 0

  async function login() {
    if (baseUrl === '') {
      throw new YapiError(
        '未配置 YAPI 地址。请在面板「账号设置」填写，或设置 YAPI_BASE_URL。',
        'NO_CONFIG',
      )
    }
    if (email === '' || password === '') {
      throw new YapiError(
        `未配置 YAPI 账号。请编辑 ${CONFIG_FILE} 填写 baseUrl / email / password，或在面板「账号设置」中填写。`,
        'NO_CREDENTIALS',
      )
    }
    let response
    try {
      response = await fetch(`${baseUrl}/api/user/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: timeoutSignal(timeoutMs),
      })
    } catch (error) {
      throw new YapiError(`无法连接 YAPI（${baseUrl}）：${describe(error)}`, 'NETWORK')
    }
    const text = await response.text()
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
    if (!payload || typeof payload !== 'object') {
      throw new YapiError(`YAPI 登录响应不是 JSON（HTTP ${response.status}），请检查地址是否正确。`, 'LOGIN_BAD_RESPONSE')
    }
    if (payload.errcode !== 0) {
      throw new YapiError(`YAPI 登录失败：${payload.errmsg || `错误码 ${String(payload.errcode)}`}`, 'LOGIN_FAILED')
    }
    const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    const pairs = []
    for (const line of lines) {
      const pair = String(line).split(';')[0].trim()
      if (pair.startsWith('_yapi_')) pairs.push(pair)
    }
    if (pairs.length === 0) {
      throw new YapiError('YAPI 登录成功，但响应没有返回 _yapi_token Cookie。', 'LOGIN_NO_COOKIE')
    }
    cookie = pairs.join('; ')
    // YAPI's token lives for seven days; refresh a day early so a stale cookie
    // never reaches a query.
    expiresAt = Date.now() + 6 * 24 * 60 * 60 * 1000
    user = payload.data && typeof payload.data === 'object' ? payload.data : null
    lastLoginAt = Date.now()
    logger?.info?.(`[yapi] 登录成功：${user?.email || email}`)
    return cookie
  }

  async function ensureSession(force) {
    if (!force && cookie !== '' && Date.now() < expiresAt) return cookie
    if (pendingLogin === null) {
      pendingLogin = login().finally(() => {
        pendingLogin = null
      })
    }
    return pendingLogin
  }

  async function getJson(pathname, options = {}) {
    const retry = options.retry !== false
    await ensureSession(false)
    let response
    try {
      response = await fetch(`${baseUrl}${pathname}`, {
        method: 'GET',
        headers: { cookie, accept: 'application/json' },
        redirect: 'manual',
        signal: timeoutSignal(timeoutMs),
      })
    } catch (error) {
      throw new YapiError(`无法连接 YAPI（${baseUrl}）：${describe(error)}`, 'NETWORK')
    }

    const retryAfterSessionLoss = async (code, message) => {
      if (!retry) throw new YapiError(message, code)
      cookie = ''
      expiresAt = 0
      await ensureSession(true)
      return getJson(pathname, { retry: false })
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      return retryAfterSessionLoss('SESSION_LOST', 'YAPI 会话已失效，重新登录后仍被重定向。')
    }
    if (response.status === 401 || response.status === 403) {
      return retryAfterSessionLoss('SESSION_LOST', `YAPI 拒绝访问（HTTP ${response.status}），请确认账号有该项目的权限。`)
    }
    const text = await response.text()
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
    if (!payload || typeof payload !== 'object') {
      return retryAfterSessionLoss('BAD_RESPONSE', 'YAPI 返回了非 JSON 响应，可能是登录已失效或服务异常。')
    }
    if (payload.errcode !== 0) {
      const code = Number(payload.errcode)
      if ([40011, 40012, 40013].includes(code)) {
        return retryAfterSessionLoss('SESSION_LOST', 'YAPI 会话已失效。')
      }
      throw new YapiError(payload.errmsg || `YAPI 错误码 ${code}`, `YAPI_${code}`)
    }
    return payload.data
  }

  return {
    getJson,
    ensureSession,
    status: () => ({ baseUrl, loggedIn: cookie !== '', user, lastLoginAt }),
  }
}

/**
 * Install the YAPI routes on the profile's authenticated connection channel.
 * @param {any} ctx - DSH host context.
 * @param {Record<string, unknown>} [config] - plugin row config.
 */
export function apply(ctx, config = {}) {
  registerBundledSkill(ctx)
  // Mutable so POST /api/yapi/settings can swap the account without a restart.
  const state = {
    settings: readConfig(config),
    client: null,
  }
  state.client = createYapiClient(state.settings, ctx.logger)
  const projectCache = new Map()
  const listCache = new Map()

  /** Everything the panel may know about the account — never the password. */
  function settingsView() {
    const status = state.client.status()
    return {
      baseUrl: state.settings.baseUrl,
      email: state.settings.email,
      hasPassword: state.settings.password !== '',
      loggedIn: status.loggedIn,
      user: status.user ? { username: status.user.username ?? '', email: status.user.email ?? '' } : null,
      configFile: CONFIG_FILE,
    }
  }

  async function projectOf(projectId) {
    const cached = projectCache.get(projectId)
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.data
    const data = await state.client.getJson(`/api/project/get?id=${encodeURIComponent(projectId)}`)
    projectCache.set(projectId, { at: Date.now(), data })
    return data
  }

  async function interfacesOf(projectId) {
    const cached = listCache.get(projectId)
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.list
    const data = await state.client.getJson(
      `/api/interface/list?project_id=${encodeURIComponent(projectId)}&page=1&limit=2000`,
    )
    const list = Array.isArray(data && data.list) ? data.list : []
    listCache.set(projectId, { at: Date.now(), list })
    return list
  }

  async function handleSearch(request) {
    let body = null
    try {
      body = await request.json()
    } catch {
      return jsonResponse({ ok: false, error: { code: 'BAD_REQUEST', message: '请求体必须是 JSON。' } }, 400)
    }
    const projectId = Number(body && body.projectId)
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      return jsonResponse(
        { ok: false, error: { code: 'BAD_PROJECT', message: '请输入有效的项目 ID。' } },
        400,
      )
    }
    const keyword = String((body && body.keyword) ?? '').trim()
    if (keyword === '') {
      return jsonResponse({ ok: true, data: { projectId, projectName: '', total: 0, items: [] } })
    }
    try {
      const list = await interfacesOf(projectId)
      let projectName = ''
      try {
        const project = await projectOf(projectId)
        projectName = String((project && project.name) ?? '')
      } catch (error) {
        ctx.logger?.warn?.(`[yapi] 搜索时读取项目 ${projectId} 失败：${describe(error)}`)
      }
      const items = rankInterfaces(list, keyword, 30).map((item) => ({
        id: Number(item._id),
        method: String(item.method ?? '').toUpperCase(),
        path: String(item.path ?? ''),
        title: String(item.title ?? ''),
      }))
      return jsonResponse({ ok: true, data: { projectId, projectName, total: list.length, items } })
    } catch (error) {
      return jsonResponse({ ok: false, error: { code: error.code || 'UNKNOWN', message: describe(error) } }, 200)
    }
  }

  async function handleInterface(request) {
    let body = null
    try {
      body = await request.json()
    } catch {
      return jsonResponse({ ok: false, error: { code: 'BAD_REQUEST', message: '请求体必须是 JSON：{"id": 10001}' } }, 400)
    }
    const id = parseDocId(body && typeof body === 'object' ? body.id : body)
    if (id === null) {
      return jsonResponse({ ok: false, error: { code: 'BAD_ID', message: '请输入有效的文档 ID（例如 10001）或接口链接。' } }, 400)
    }
    try {
      const raw = await state.client.getJson(`/api/interface/get?id=${id}`)
      if (!raw || typeof raw !== 'object' || Number(raw._id) <= 0) {
        throw new YapiError(`YAPI 没有返回文档 ${id} 的数据，可能已被删除。`, 'NO_DATA')
      }
      let project = null
      const projectId = Number(raw && raw.project_id)
      if (Number.isSafeInteger(projectId) && projectId > 0) {
        try {
          project = await projectOf(projectId)
        } catch (error) {
          ctx.logger?.warn?.(`[yapi] 读取项目 ${projectId} 失败：${describe(error)}`)
        }
      }
      return jsonResponse({ ok: true, data: normalizeInterface(raw, project, state.settings.baseUrl) })
    } catch (error) {
      return jsonResponse({ ok: false, error: { code: error.code || 'UNKNOWN', message: describe(error) } }, 200)
    }
  }

  async function handleHealth() {
    try {
      await state.client.ensureSession(false)
      return jsonResponse({ ok: true, ...settingsView() })
    } catch (error) {
      return jsonResponse({ ok: false, error: { code: error.code || 'UNKNOWN', message: describe(error) } }, 200)
    }
  }

  /**
   * GET returns the current account; POST verifies the submitted account with a
   * real YAPI login and only then persists it. A failed login changes nothing,
   * so a typo cannot lock the panel out of a working account.
   */
  async function handleSettings(request) {
    if (request.method === 'GET') {
      return jsonResponse({ ok: true, ...settingsView() })
    }
    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET / POST。' } }, 405)
    }
    let body = null
    try {
      body = await request.json()
    } catch {
      return jsonResponse({ ok: false, error: { code: 'BAD_REQUEST', message: '请求体必须是 JSON。' } }, 400)
    }
    const current = state.settings
    const stored = readStoredConfig()
    const baseUrl = normalizeBaseUrl((body && body.baseUrl) || current.baseUrl || stored.baseUrl || '')
    if (baseUrl === '') {
      return jsonResponse(
        { ok: false, error: { code: 'NO_CONFIG', message: '请填写 YAPI 地址（例如 https://yapi.example.com）。' } },
        200,
      )
    }
    const email = String((body && body.email) ?? current.email ?? stored.email ?? '').trim()
    const typedPassword = body && typeof body.password === 'string' ? body.password : ''
    const password =
      typedPassword !== '' ? typedPassword : current.password || String(stored.password ?? '')
    if (email === '' || password === '') {
      return jsonResponse(
        { ok: false, error: { code: 'NO_CREDENTIALS', message: '请填写账号和密码。' } },
        200,
      )
    }

    const next = { baseUrl, email, password, timeoutMs: current.timeoutMs }
    const probe = createYapiClient(next, ctx.logger)
    try {
      await probe.ensureSession(true)
    } catch (error) {
      return jsonResponse(
        { ok: false, error: { code: error.code || 'LOGIN_FAILED', message: describe(error) } },
        200,
      )
    }
    try {
      writeConfigFile(next)
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: { code: 'SAVE_FAILED', message: `登录成功，但写入配置文件失败：${describe(error)}` },
        },
        200,
      )
    }

    state.settings = next
    state.client = probe
    projectCache.clear()
    listCache.clear()
    const user = probe.status().user
    ctx.logger?.info?.(`[yapi] 账号已更新：${user?.email || email}`)
    return jsonResponse({ ok: true, ...settingsView() })
  }

  ctx.inject(['connection'], (scope) => {
    const routes = [
      { path: '/api/yapi/interface', methods: ['POST'], requestBody: 'buffered', fetch: handleInterface },
      { path: '/api/yapi/search', methods: ['POST'], requestBody: 'buffered', fetch: handleSearch },
      { path: '/api/yapi/health', methods: ['GET'], requestBody: 'buffered', fetch: handleHealth },
      { path: '/api/yapi/settings', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handleSettings },
    ]
    for (const route of routes) scope.connection.fetch.register(route)
    ctx.logger?.info?.(`[yapi] 已注册 ${routes.length} 条路由：/api/yapi/{interface,search,health,settings}；配置 ${CONFIG_FILE}`)
  })
}
