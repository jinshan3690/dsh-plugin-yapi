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
  if (String(url).endsWith('/api/user/login') || String(url).endsWith('/api/user/login_by_ldap')) {
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
  if (String(url).includes('/api/project/search')) {
    return {
      headers: { getSetCookie: () => [] },
      text: async () =>
        JSON.stringify({
          errcode: 0,
          data: {
            project: [{ _id: 9, name: 'Demo Project' }],
            group: [],
            interface: [{ _id: 10001, title: 'Demo Interface', projectId: 9 }],
          },
        }),
    }
  }
  if (String(url).includes('/api/interface/get')) {
    return {
      headers: { getSetCookie: () => [] },
      text: async () =>
        JSON.stringify({
          errcode: 0,
          data: {
            _id: 10001,
            project_id: 9,
            title: 'Demo Interface',
            path: '/business/closure/config',
            method: 'POST',
          },
        }),
    }
  }
  if (String(url).includes('/api/project/get')) {
    return {
      headers: { getSetCookie: () => [] },
      text: async () =>
        JSON.stringify({
          errcode: 0,
          data: {
            _id: 9,
            name: 'Demo Project',
            basepath: '',
            cats: [{ _id: 9019, name: 'Business Closure' }],
          },
        }),
    }
  }
  if (String(url).includes('/api/interface/list_cat')) {
    return {
      headers: { getSetCookie: () => [] },
      text: async () =>
        JSON.stringify({
          errcode: 0,
          data: {
            count: 2,
            list: [
              { _id: 10001, path: '/business/closure/config', method: 'POST', title: 'Demo Interface' },
              { _id: 10002, path: '/business/closure/save', method: 'GET', title: 'Save Closure' },
            ],
          },
        }),
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
  authType: 'normal',
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
    authType: 'normal',
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
  assert.equal(candidates.length, 2)
  assert.deepEqual(candidates.map((item) => item.name), ['yapi-doc', 'yapi-sync'])
  assert.equal(candidates[0].source, 'bundled')
  assert.equal(candidates[0].invocation.userInvocable, true)
  const loaded = await provider.get(candidates[0])
  assert.equal(loaded.name, 'yapi-doc')
  assert.match(loaded.content, /yapi-doc\.mjs/u)
  assert.equal(loaded.resourceBase.kind, 'directory')
  assert.ok(fs.existsSync(path.join(loaded.resourceBase.path, 'yapi-doc.mjs')))
  const syncLoaded = await provider.get(candidates[1])
  assert.equal(syncLoaded.name, 'yapi-sync')
  assert.match(syncLoaded.content, /yapi-sync/u)
})


test('LDAP login uses /api/user/login_by_ldap and persists authType', async () => {
  loginCalls.length = 0
  const { settingsRoute } = boot(baseConfig)
  const response = await settingsRoute.fetch({
    method: 'POST',
    json: async () => ({ ...baseConfig, authType: 'ldap' }),
  })
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.authType, 'ldap')
  assert.ok(loginCalls.some((url) => url.endsWith('/api/user/login_by_ldap')))
  const stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  assert.equal(stored.authType, 'ldap')
})

test('global search uses YAPI project/search and enriches paths', async () => {
  const { routes } = boot(baseConfig)
  const searchRoute = routes.find((item) => item.path === '/api/yapi/search')
  assert.ok(searchRoute, 'search route registered')
  const response = await searchRoute.fetch({
    method: 'POST',
    json: async () => ({ global: true, keyword: 'business/closure/config' }),
  })
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.data.global, true)
  assert.equal(payload.data.items[0].id, 10001)
  assert.equal(payload.data.items[0].path, '/business/closure/config')
  assert.equal(payload.data.items[0].projectId, 9)
  assert.equal(payload.data.projects[0].id, 9)
})


test('category route lists interfaces in the current catid', async () => {
  const { routes } = boot(baseConfig)
  const categoryRoute = routes.find((item) => item.path === '/api/yapi/category')
  assert.ok(categoryRoute, 'category route registered')
  const response = await categoryRoute.fetch({
    method: 'POST',
    json: async () => ({ catid: 9019, projectId: 9 }),
  })
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.data.catid, 9019)
  assert.equal(payload.data.catName, 'Business Closure')
  assert.equal(payload.data.total, 2)
  assert.equal(payload.data.items[0].id, 10001)
  assert.equal(payload.data.items[0].path, '/business/closure/config')
})
