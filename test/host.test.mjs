/**
 * Host-half tests for the account settings route. A stubbed YAPI login keeps
 * the test offline while exercising the real route handler, the "verify before
 * persist" rule, and the 0600 config write.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-yapi-host-'))
process.env.DSH_HOME = home

const loginCalls = []
globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/api/user/login')) {
    loginCalls.push(String(url))
    const body = JSON.parse(options.body)
    if (body.password !== 'good-password') {
      return {
        headers: { getSetCookie: () => [] },
        text: async () => JSON.stringify({ errcode: 1, errmsg: '密码错误' }),
      }
    }
    return {
      headers: { getSetCookie: () => ['_yapi_token=token-value; Path=/', '_yapi_uid=7; Path=/'] },
      text: async () =>
        JSON.stringify({ errcode: 0, msg: 'ok', data: { username: 'tester', email: body.email } }),
    }
  }
  throw new Error('unexpected fetch: ' + String(url))
}

const { apply, CONFIG_FILE } = await import('../index.js?host-test=' + Date.now())

function boot(config) {
  const routes = []
  const ctx = {
    logger: { info() {}, warn() {} },
    skills: { registerProvider() { return () => {} } },
    inject(_deps, callback) {
      callback({
        connection: {
          fetch: {
            register(route) {
              routes.push(route)
              return async () => {}
            },
          },
        },
      })
    },
  }
  apply(ctx, config)
  const route = routes.find((item) => item.path === '/api/yapi/settings')
  assert.ok(route, 'settings route registered')
  return { routes, route, settingsRoute: route }
}

const baseConfig = {
  baseUrl: 'https://yapi.example.test',
  email: 'tester@example.test',
  password: 'good-password',
  timeoutMs: 5000,
}

test('GET settings never returns the password', async () => {
  const { settingsRoute } = boot(baseConfig)
  const response = await settingsRoute.fetch({ method: 'GET' })
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.email, 'tester@example.test')
  assert.equal(payload.hasPassword, true)
  assert.equal(payload.loggedIn, false)
  assert.equal('password' in payload, false)
  assert.equal(payload.configFile, CONFIG_FILE)
})

test('a failed login changes nothing', async () => {
  const { settingsRoute } = boot(baseConfig)
  const before = fs.existsSync(CONFIG_FILE)
  const response = await settingsRoute.fetch({
    method: 'POST',
    json: async () => ({ baseUrl: baseConfig.baseUrl, email: baseConfig.email, password: 'wrong' }),
  })
  const payload = await response.json()
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'LOGIN_FAILED')
  assert.equal(fs.existsSync(CONFIG_FILE), before)
})

test('a verified login persists the account with 0600', async () => {
  const { settingsRoute } = boot(baseConfig)
  const response = await settingsRoute.fetch({
    method: 'POST',
    json: async () => ({ baseUrl: baseConfig.baseUrl, email: 'new@example.test', password: 'good-password' }),
  })
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.loggedIn, true)
  assert.equal(payload.user.email, 'new@example.test')

  const stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  assert.deepEqual(stored, {
    baseUrl: 'https://yapi.example.test',
    email: 'new@example.test',
    password: 'good-password',
    timeoutMs: 5000,
  })
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(CONFIG_FILE).mode & 0o777, 0o600)
  }
})

test('an empty password reuses the saved one', async () => {
  const { settingsRoute } = boot(baseConfig)
  const response = await settingsRoute.fetch({
    method: 'POST',
    json: async () => ({ baseUrl: baseConfig.baseUrl, email: baseConfig.email, password: '' }),
  })
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(loginCalls.length > 0, true)
})

test('missing credentials are rejected before any network call', async () => {
  const { settingsRoute } = boot({ baseUrl: 'https://yapi.example.test', email: '', password: '', timeoutMs: 5000 })
  const calls = loginCalls.length
  const response = await settingsRoute.fetch({
    method: 'POST',
    json: async () => ({ baseUrl: 'https://yapi.example.test', email: '', password: '' }),
  })
  const payload = await response.json()
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'NO_CREDENTIALS')
  assert.equal(loginCalls.length, calls)
})

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

test('registers the bundled yapi-doc skill when no user copy exists', async () => {
  let provider = null
  const ctx = {
    logger: { info() {}, warn() {} },
    skills: {
      registerProvider(create) {
        provider = create({ signal: new AbortController().signal, invalidate() {} })
        return () => {}
      },
    },
    inject(_deps, callback) {
      callback({ connection: { fetch: { register() { return async () => {} } } } })
    },
  }
  apply(ctx, baseConfig)
  assert.ok(provider, 'bundled skill provider registered')
  const candidates = await provider.list()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, 'yapi-doc')
  assert.equal(candidates[0].source, 'bundled')
  const loaded = await provider.get(candidates[0])
  assert.equal(loaded.name, 'yapi-doc')
  assert.match(loaded.content, /yapi-doc\.mjs/u)
  assert.equal(loaded.resourceBase.kind, 'directory')
  assert.ok(fs.existsSync(path.join(loaded.resourceBase.path, 'yapi-doc.mjs')))
})
