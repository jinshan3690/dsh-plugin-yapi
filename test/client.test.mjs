/**
 * Client-half tests: load client.js in a VM with a stubbed module loader and
 * verify the schema annotator that powers "带备注" and the field table.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function loadClient() {
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: {
        load(registration) {
          sandbox.__registration = registration
        },
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  const registration = sandbox.__registration
  assert.equal(registration.id, 'dsh-plugin-yapi')
  const React = {
    createElement: () => ({}),
    cloneElement: (element) => element,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useMemo: (factory) => factory(),
  }
  const plugin = registration.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  return { plugin, hooks: sandbox.__YAPI_PANEL_TEST__ }
}

test('client bundle registers the yapi slots', () => {
  const { plugin } = loadClient()
  const calls = []
  plugin.apply({
    slots: {
      inject(name, factory) {
        calls.push('inject:' + name)
        factory()
      },
      register(options) {
        calls.push('register:' + options.name + ':' + (options.id || options.key))
        return () => {}
      },
    },
  })
  assert.deepEqual(calls, [
    'inject:sidebar.panellist',
    'register:sidebar.panellist:yapi',
    'inject:main',
    'register:main:yapi',
  ])
})

test('annotateSchemaValue emits JSONC comments and a field list', () => {
  const { hooks } = loadClient()
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'integer', description: '主键' },
      name: { type: 'string', description: '名称' },
      list: {
        type: 'array',
        items: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', description: '编码' } },
        },
      },
      nested: {
        type: 'object',
        description: '嵌套对象',
        properties: { deep: { type: 'string', description: '深层' } },
      },
    },
    required: ['id'],
  }
  const example = { id: 0, name: '', list: [{ code: '' }], nested: { deep: '' } }
  const result = hooks.annotateSchemaValue(JSON.stringify(schema), JSON.stringify(example))

  assert.match(result.text, /"id": 0, \/\/ 主键/u)
  assert.match(result.text, /"name": "", \/\/ 名称/u)
  assert.match(result.text, /"nested": \{ \/\/ 嵌套对象/u)
  assert.match(result.text, /"code": "" \/\/ 编码/u)

  // Removing the line comments must leave the original payload intact.
  const stripped = result.text.replace(/\/\/.*$/gmu, '')
  assert.deepEqual(JSON.parse(stripped), example)

  assert.deepEqual(JSON.parse(JSON.stringify(result.fields)), [
    { path: 'id', type: 'integer', required: true, description: '主键' },
    { path: 'name', type: 'string', required: false, description: '名称' },
    { path: 'list', type: 'array<object>', required: false, description: '' },
    { path: 'list[].code', type: 'string', required: true, description: '编码' },
    { path: 'nested', type: 'object', required: false, description: '嵌套对象' },
    { path: 'nested.deep', type: 'string', required: false, description: '深层' },
  ])
})

test('annotateFormValue keeps form descriptions', () => {
  const { hooks } = loadClient()
  const form = [
    { name: 'file', type: 'file', required: true, desc: '上传文件' },
    { name: 'size', type: 'integer', required: false, desc: '文件大小' },
  ]
  const result = hooks.annotateFormValue(form, JSON.stringify({ file: '', size: 0 }))
  assert.match(result.text, /"file": "", \/\/ 上传文件/u)
  assert.match(result.text, /"size": 0 \/\/ 文件大小/u)
  assert.deepEqual(JSON.parse(JSON.stringify(result.fields)), [
    { path: 'file', type: 'file', required: true, description: '上传文件' },
    { path: 'size', type: 'integer', required: false, description: '文件大小' },
  ])
})

test('annotationFor prefers the form shape and falls back to raw text', () => {
  const { hooks } = loadClient()
  const doc = {
    request: {
      bodyType: 'form',
      bodyIsJsonSchema: false,
      form: [{ name: 'a', type: 'string', required: false, desc: '甲' }],
      body: { kind: 'json', example: '{\n  "a": ""\n}', raw: '', annotated: '{"a":""}' },
    },
    response: {
      bodyType: 'json',
      bodyIsJsonSchema: false,
      body: { kind: 'text', example: 'plain text', raw: 'plain text' },
    },
  }
  assert.match(hooks.annotationFor(doc, 'request').text, /"a": "" \/\/ 甲/u)
  const response = hooks.annotationFor(doc, 'response')
  assert.equal(response.text, 'plain text')
  assert.equal(response.tree.total, 0)
})

test('buildTreeFromSchema nests objects and arrays instead of flattening', () => {
  const { hooks } = loadClient()
  const schema = {
    type: 'object',
    required: ['code'],
    properties: {
      code: { type: 'integer', description: '状态码' },
      data: {
        type: 'object',
        description: '业务数据',
        required: ['list'],
        properties: {
          list: {
            type: 'array',
            description: '列表',
            items: {
              type: 'object',
              required: ['id'],
              properties: { id: { type: 'integer', description: '主键' } },
            },
          },
          name: { type: 'string', description: '名称' },
        },
      },
    },
  }
  const example = { code: 0, data: { list: [{ id: 0 }], name: '' } }
  const tree = hooks.buildTreeFromSchema(JSON.stringify(schema), JSON.stringify(example))
  assert.equal(tree.total, 5)
  assert.deepEqual(
    JSON.parse(JSON.stringify(tree.nodes.map((node) => [node.name, node.kind, node.required]))),
    [
      ['code', 'scalar', true],
      ['data', 'object', false],
    ],
  )
  const data = tree.nodes[1]
  assert.equal(data.children.length, 2)
  const list = data.children[0]
  assert.equal(list.kind, 'array')
  assert.equal(list.type, 'array<object>')
  assert.equal(list.required, true)
  assert.equal(list.children[0].path, 'data.list[].id')
  assert.equal(list.children[0].required, true)
  assert.equal(list.children[0].description, '主键')
  assert.equal(data.children[1].name, 'name')
})

test('fieldTreeFor builds a form tree from the normalized form rows', () => {
  const { hooks } = loadClient()
  const doc = {
    request: {
      bodyType: 'form',
      bodyIsJsonSchema: false,
      form: [
        { name: 'file', type: 'file', required: true, desc: '上传文件' },
        { name: 'size', type: 'integer', required: false, desc: '文件大小' },
      ],
      body: { kind: 'json', example: '{\n  "file": "",\n  "size": 0\n}' },
    },
    response: { bodyType: 'json', bodyIsJsonSchema: false, body: { kind: 'none', example: '' } },
  }
  const tree = hooks.fieldTreeFor(doc, 'request')
  assert.equal(tree.total, 2)
  assert.deepEqual(
    JSON.parse(JSON.stringify(tree.nodes.map((node) => [node.name, node.type, node.required]))),
    [
      ['file', 'file', true],
      ['size', 'integer', false],
    ],
  )
  assert.equal(hooks.fieldTreeFor(doc, 'response').total, 0)
})

test('filterTree keeps the ancestors needed to reach a match', () => {
  const { hooks } = loadClient()
  const schema = {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        properties: {
          list: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'integer', description: '主键' } } },
          },
          name: { type: 'string', description: '名称' },
        },
      },
    },
  }
  const example = { data: { list: [{ id: 0 }], name: '' } }
  const tree = hooks.buildTreeFromSchema(JSON.stringify(schema), JSON.stringify(example))
  const filtered = hooks.filterTree(tree.nodes, '主键')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].name, 'data')
  assert.equal(filtered[0].children.length, 1)
  assert.equal(filtered[0].children[0].name, 'list')
  assert.equal(filtered[0].children[0].children[0].name, 'id')
  assert.equal(hooks.countMatches(filtered, '主键'), 1)
})

test('buildCopyText includes only the checked sections', () => {
  const { hooks } = loadClient()
  const doc = {
    id: 10001,
    title: 'Demo',
    method: 'POST',
    path: '/x',
    request: {
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      query: [{ name: 'page', type: 'integer', required: true, example: '1', desc: '页码' }],
      params: [],
      form: [],
      body: { kind: 'json', example: '{"a":""}', raw: '' },
    },
    response: { body: { kind: 'json', example: '{"code":0}', raw: '' } },
  }
  const requestAnnotation = {
    text: '{"a":""}',
    tree: { total: 1, nodes: [{ id: 'a', name: 'a', type: 'string', required: false, description: '甲', children: [] }] },
  }
  const responseAnnotation = {
    text: '{"code":0}',
    tree: { total: 1, nodes: [{ id: 'code', name: 'code', type: 'integer', required: false, description: '', children: [] }] },
  }
  const all = {
    title: true,
    address: true,
    headers: true,
    params: true,
    requestBody: true,
    responseBody: true,
    desc: true,
  }
  const text = hooks.buildCopyText(
    doc,
    all,
    'https://api.example.com/x',
    'example',
    requestAnnotation,
    responseAnnotation,
    '说明',
  )
  assert.match(text, /^# Demo（#10001）/u)
  assert.match(text, /## 请求地址\nPOST https:\/\/api\.example\.com\/x/u)
  assert.match(text, /## 请求头\nContent-Type: application\/json/u)
  assert.match(text, /## 请求参数\nQuery:\n- page = 1（integer，必填，页码）/u)
  assert.match(text, /## 请求 Body\n\{"a":""\}/u)
  assert.match(text, /## 返回体\n\{"code":0\}/u)
  assert.match(text, /## 接口说明\n说明/u)

  const onlyResponse = {
    title: false,
    address: false,
    headers: false,
    params: false,
    requestBody: false,
    responseBody: true,
    desc: false,
  }
  const only = hooks.buildCopyText(
    doc,
    onlyResponse,
    'https://api.example.com/x',
    'example',
    requestAnnotation,
    responseAnnotation,
    '说明',
  )
  assert.equal(only, '## 返回体\n{"code":0}')
})


test('buildTreeFromSchema shows a root-level array as one expandable array node', () => {
  const { hooks } = loadClient()
  const schema = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        scheduleDataList: {
          type: 'array',
          items: { type: 'object', properties: { scheduleKey: { type: 'string' } } },
        },
      },
    },
  }
  const example = [{ id: 1, scheduleDataList: [{ scheduleKey: 'k' }] }]
  const tree = hooks.buildTreeFromSchema(JSON.stringify(schema), JSON.stringify(example))
  assert.equal(tree.nodes.length, 1)
  assert.equal(tree.nodes[0].kind, 'array')
  assert.equal(tree.nodes[0].name, '[]')
  assert.equal(tree.nodes[0].children.length, 2)
  assert.equal(tree.nodes[0].children[0].name, 'id')
  assert.equal(tree.nodes[0].children[1].kind, 'array')
  assert.equal(tree.nodes[0].children[1].children[0].name, 'scheduleKey')
})
