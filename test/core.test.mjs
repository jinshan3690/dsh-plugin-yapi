/**
 * Unit tests for the pure helpers. Run with: node --test test/core.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  exampleFromSchema,
  joinUrl,
  normalizeBaseUrl,
  normalizeInterface,
  parseDocId,
  rankInterfaces,
  stripHtml,
} from '../lib/core.js'

test('parseDocId accepts ids, urls and query strings', () => {
  assert.equal(parseDocId(10001), 10001)
  assert.equal(parseDocId('10001'), 10001)
  assert.equal(parseDocId('https://yapi.example.com/project/25/interface/api/10001'), 10001)
  assert.equal(parseDocId('https://yapi.example.com/api/interface/get?id=10001'), 10001)
  assert.equal(parseDocId('  https://yapi.example.com/project/25/interface/api/10001?x=1#top '), 10001)
  assert.equal(parseDocId(''), null)
  assert.equal(parseDocId('abc'), null)
  assert.equal(parseDocId(0), null)
})

test('joinUrl never doubles or drops separators', () => {
  assert.equal(joinUrl('https://yapi.example.com/', '/project', '25'), 'https://yapi.example.com/project/25')
  assert.equal(joinUrl('http://htm.com:8089/index.php', '/report_form/x'), 'http://htm.com:8089/index.php/report_form/x')
  assert.equal(joinUrl('', '', '/x'), '/x')
  assert.equal(joinUrl('https://a'), 'https://a')
})

test('normalizeBaseUrl trims slashes and defaults', () => {
  assert.equal(normalizeBaseUrl('https://yapi.example.com/'), 'https://yapi.example.com')
  assert.equal(normalizeBaseUrl(''), '')
})

test('stripHtml flattens YAPI rich text', () => {
  assert.equal(stripHtml('<p>a</p><p>b &amp; c</p>'), 'a\nb & c')
  assert.equal(stripHtml(''), '')
})

test('exampleFromSchema follows objects, arrays, enums and formats', () => {
  const { value, truncated } = exampleFromSchema({
    type: 'object',
    properties: {
      name: { type: 'string' },
      count: { type: 'integer' },
      ok: { type: 'boolean' },
      when: { type: 'string', format: 'date-time' },
      kind: { type: 'string', enum: ['a', 'b'] },
      list: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } },
      maybe: { type: ['string', 'null'] },
      fixed: { type: 'string', example: 'demo' },
      nested: { allOf: [{ properties: { deep: { type: 'number' } } }] },
    },
  })
  assert.equal(truncated, false)
  assert.deepEqual(value, {
    name: '',
    count: 0,
    ok: false,
    when: '2024-01-01T00:00:00Z',
    kind: 'a',
    list: [{ id: 0 }],
    maybe: '',
    fixed: 'demo',
    nested: { deep: 0 },
  })
})

test('exampleFromSchema stops at the node budget', () => {
  const wide = { type: 'object', properties: {} }
  for (let index = 0; index < 40; index += 1) wide.properties['p' + index] = { type: 'object', properties: { a: { type: 'string' } } }
  const result = exampleFromSchema(wide, { maxNodes: 10 })
  assert.equal(result.truncated, true)
})

test('normalizeInterface carries both body views and project envs', () => {
  const raw = {
    _id: 1,
    title: 'demo',
    method: 'post',
    path: '/x',
    project_id: 9,
    status: 'done',
    tag: ['t'],
    req_headers: [{ name: 'Content-Type', value: 'application/json', required: '1' }],
    req_query: [{ name: 'page', type: 'integer', required: '0', example: '1' }],
    req_params: [],
    req_body_form: [],
    req_body_type: 'json',
    req_body_is_json_schema: true,
    req_body_other: JSON.stringify({ type: 'object', properties: { a: { type: 'string' } } }),
    res_body_type: 'json',
    res_body_is_json_schema: true,
    res_body: JSON.stringify({ type: 'object', properties: { code: { type: 'integer' } } }),
    up_time: 1700000000,
  }
  const project = { name: 'P', basepath: '/v1', env: [{ name: 'dev', domain: 'https://dev.example.com' }] }
  const doc = normalizeInterface(raw, project, 'https://yapi.example.com')
  assert.equal(doc.method, 'POST')
  assert.equal(doc.path, '/x')
  assert.equal(doc.request.headers[0].required, true)
  assert.equal(doc.request.query[0].required, false)
  assert.equal(doc.request.body.example, '{\n  "a": ""\n}')
  assert.equal(doc.response.body.example, '{\n  "code": 0\n}')
  assert.equal(doc.project.envs[0].domain, 'https://dev.example.com')
  assert.equal(doc.project.address, 'https://dev.example.com/v1/x')
  assert.equal(doc.pageUrl, 'https://yapi.example.com/project/9/interface/api/1')
  assert.equal(doc.updatedAt, 1700000000000)
})

test('normalizeInterface turns form fields into a JSON example', () => {
  const doc = normalizeInterface(
    {
      _id: 2,
      project_id: 1,
      path: '/upload',
      method: 'POST',
      req_body_type: 'form',
      req_body_form: [
        { name: 'file', type: 'file' },
        { name: 'size', type: 'integer', example: '3' },
        { name: 'on', type: 'boolean' },
      ],
      res_body: '',
    },
    null,
    'https://yapi.example.com',
  )
  assert.equal(doc.request.body.kind, 'json')
  assert.deepEqual(JSON.parse(doc.request.body.example), { file: '', size: 3, on: false })
  assert.equal(doc.response.body.kind, 'none')
})

test('rankInterfaces prefers paths and supports title and fuzzy matches', () => {
  const list = [
    { _id: 1, method: 'POST', path: '/admin/warehouse/list', title: '仓库列表' },
    { _id: 2, method: 'GET', path: '/admin/warehouse/detail', title: '仓库详情' },
    { _id: 3, method: 'POST', path: '/report_form/business', title: '商机审核' },
    { _id: 4, method: 'POST', path: '/api/order', title: '订单' },
  ]
  assert.deepEqual(rankInterfaces(list, 'warehouse').map((item) => item._id), [1, 2])
  assert.deepEqual(rankInterfaces(list, '仓库详情').map((item) => item._id), [2])
  assert.deepEqual(rankInterfaces(list, 'whlist').map((item) => item._id), [1])
  assert.deepEqual(rankInterfaces(list, '2').map((item) => item._id), [2])
  assert.deepEqual(rankInterfaces(list, '   '), [])
  assert.equal(rankInterfaces(list, 'warehouse', 1).length, 1)
})
