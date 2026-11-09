/**
 * dsh-plugin-yapi — client half.
 *
 * Registers two slots, exactly the way the shipped sidebar expects:
 *   sidebar.panellist (list/root)  → the "YAPI" row in the left column
 *   main              (keyed/root) → the workbench panel behind that row
 *
 * Everything is origin-relative: the panel calls `/api/yapi/interface`, and the
 * host half owns the YAPI session. The only external module requested is React
 * from the browser module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-yapi',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo } = React

    const PANEL_ID = 'yapi'
    const PANEL_LABEL = 'YAPI'
    const PANEL_ORDER = 70
    const STYLE_ID = 'dsh-plugin-yapi-style'
    const LAST_KEY = 'dsh-plugin-yapi:last-id'
    const RECENT_KEY = 'dsh-plugin-yapi:recent'
    const COPY_FORMAT_KEY = 'dsh-plugin-yapi:copy-format'
    const TABS_KEY = 'dsh-plugin-yapi:tabs'
    const ACTIVE_KEY = 'dsh-plugin-yapi:active-tab'
    const COPY_OPTIONS_KEY = 'dsh-plugin-yapi:copy-options'
    const DEFAULT_COPY_OPTIONS = {
      title: true,
      address: true,
      headers: true,
      params: true,
      requestBody: true,
      responseBody: true,
      desc: false,
    }
    const COPY_OPTIONS = [
      { key: 'title', label: '接口标题' },
      { key: 'address', label: '请求地址（含方法）' },
      { key: 'headers', label: '请求头' },
      { key: 'params', label: '请求参数（Query / Path / Form）' },
      { key: 'requestBody', label: '请求 Body' },
      { key: 'responseBody', label: '返回体' },
      { key: 'desc', label: '接口说明' },
    ]
    const TABS_CACHE = { initialized: false, tabs: [], activeId: null }

    /* ------------------------------------------------------------------ */
    /* helpers                                                             */
    /* ------------------------------------------------------------------ */

    function readStorage(key, fallback) {
      try {
        const value = window.localStorage.getItem(key)
        return value === null ? fallback : value
      } catch {
        return fallback
      }
    }

    function writeStorage(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* private mode / quota — the panel still works without persistence */
      }
    }

    function readCopyOptions() {
      try {
        const parsed = JSON.parse(readStorage(COPY_OPTIONS_KEY, '{}'))
        const options = Object.assign({}, DEFAULT_COPY_OPTIONS)
        if (parsed && typeof parsed === 'object') {
          for (const key of Object.keys(DEFAULT_COPY_OPTIONS)) {
            if (typeof parsed[key] === 'boolean') options[key] = parsed[key]
          }
        }
        return options
      } catch {
        return Object.assign({}, DEFAULT_COPY_OPTIONS)
      }
    }

    function readRecent() {
      try {
        const parsed = JSON.parse(readStorage(RECENT_KEY, '[]'))
        if (!Array.isArray(parsed)) return []
        return parsed.filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 6)
      } catch {
        return []
      }
    }

    function readStoredTabs() {
      try {
        const parsed = JSON.parse(readStorage(TABS_KEY, '[]'))
        if (!Array.isArray(parsed)) return []
        const tabs = []
        for (const entry of parsed.slice(0, 12)) {
          const id = Number(entry && entry.id)
          if (!Number.isSafeInteger(id) || id <= 0) continue
          if (tabs.some((tab) => tab.id === id)) continue
          tabs.push({
            id: id,
            title: String((entry && entry.title) || ''),
            method: String((entry && entry.method) || ''),
            path: String((entry && entry.path) || ''),
            doc: null,
            loading: false,
            error: null,
            base: '',
          })
        }
        return tabs
      } catch {
        return []
      }
    }

    function ensureTabs() {
      if (TABS_CACHE.initialized) return TABS_CACHE
      TABS_CACHE.initialized = true
      TABS_CACHE.tabs = readStoredTabs()
      const storedActive = Number(readStorage(ACTIVE_KEY, ''))
      TABS_CACHE.activeId = TABS_CACHE.tabs.some((tab) => tab.id === storedActive)
        ? storedActive
        : TABS_CACHE.tabs.length > 0
          ? TABS_CACHE.tabs[0].id
          : null
      return TABS_CACHE
    }

    function looksLikeDocRef(value) {
      const text = String(value === undefined || value === null ? '' : value).trim()
      if (text === '') return false
      if (/^\d{1,12}$/.test(text)) return true
      return /\/interface\/api\/\d+/i.test(text) || /[?&]id=\d+/i.test(text)
    }

    function parseDocId(raw) {
      if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw
      const text = String(raw === undefined || raw === null ? '' : raw).trim()
      if (text === '') return null
      if (/^\d{1,12}$/.test(text)) {
        const id = Number(text)
        return id > 0 ? id : null
      }
      const patterns = [
        /\/interface\/api\/(\d{1,12})(?:[/?#]|$)/,
        /[?&]id=(\d{1,12})(?:[&#]|$)/,
        /(\d{1,12})\/?(?:[?#].*)?$/,
      ]
      for (const pattern of patterns) {
        const match = pattern.exec(text)
        if (match && Number(match[1]) > 0) return Number(match[1])
      }
      return null
    }

    function joinUrl() {
      let out = ''
      for (let index = 0; index < arguments.length; index += 1) {
        const text = String(arguments[index] === undefined || arguments[index] === null ? '' : arguments[index]).trim()
        if (text === '') continue
        if (out === '') out = text.replace(/\/+$/, '')
        else out += '/' + text.replace(/^\/+/, '').replace(/\/+$/, '')
      }
      return out
    }

    function formatTime(timestamp) {
      const date = new Date(timestamp)
      if (Number.isNaN(date.getTime())) return ''
      try {
        return date.toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      } catch {
        return date.toISOString().slice(0, 16).replace('T', ' ')
      }
    }

    function htmlToText(html) {
      const text = String(html === undefined || html === null ? '' : html)
      if (text === '') return ''
      if (typeof document === 'undefined') return text.replace(/<[^>]+>/g, '')
      const holder = document.createElement('div')
      holder.innerHTML = text
      return holder.textContent || ''
    }

    function bodyText(body, mode, annotated) {
      if (!body) return ''
      if (mode === 'schema') return body.raw || ''
      if (mode === 'annotated') return (annotated && annotated.text) || body.example || body.raw || ''
      return body.example || body.raw || ''
    }

    function buildCopyText(doc, options, address, format, requestAnnotation, responseAnnotation, descText) {
      const sections = []
      const mode = format === 'annotated' ? 'annotated' : 'example'
      if (options.title) sections.push('# ' + (doc.title || '未命名接口') + '（#' + doc.id + '）')
      if (options.address) {
        const target = address || doc.path || ''
        sections.push('## 请求地址\n' + doc.method + ' ' + target)
      }
      if (options.headers && doc.request.headers.length > 0) {
        const lines = doc.request.headers.map(function (row) {
          return row.name + ': ' + (row.value || '')
        })
        sections.push('## 请求头\n' + lines.join('\n'))
      }
      if (options.params) {
        const lines = []
        const addRows = function (title, rows) {
          if (rows.length === 0) return
          lines.push(title + ':')
          for (const row of rows) {
            const meta = []
            if (row.type) meta.push(row.type)
            meta.push(row.required ? '必填' : '可选')
            if (row.desc) meta.push(row.desc)
            const example = row.example ? ' = ' + row.example : ''
            lines.push('- ' + row.name + example + '（' + meta.join('，') + '）')
          }
        }
        addRows('Query', doc.request.query)
        addRows('Path', doc.request.params)
        addRows('Form', doc.request.form)
        if (lines.length > 0) sections.push('## 请求参数\n' + lines.join('\n'))
      }
      if (options.requestBody) {
        const text = bodyText(doc.request.body, mode, requestAnnotation)
        if (text.trim() !== '') sections.push('## 请求 Body\n' + text)
      }
      if (options.responseBody) {
        const text = bodyText(doc.response.body, mode, responseAnnotation)
        if (text.trim() !== '') sections.push('## 返回体\n' + text)
      }
      if (options.desc && descText !== '') sections.push('## 接口说明\n' + descText)
      return sections.join('\n\n')
    }

    async function copyText(text) {
      const value = String(text === undefined || text === null ? '' : text)
      if (value === '') return false
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch {
        /* fall through to the selection-based path */
      }
      try {
        const area = document.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-9999px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        area.setSelectionRange(0, value.length)
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }


    /* ------------------------------------------------------------------ */
    /* schema annotation (client-side)                                     */
    /* ------------------------------------------------------------------ */
    /* The host already sends both the generated example and the raw YAPI
     * schema. Annotating in the browser keeps the feature independent of the
     * host half: a client update alone can add field remarks, and the copied
     * JSONC always matches the example the panel shows. */

    function parseJsonSafe(text) {
      if (typeof text !== 'string' || text.trim() === '') return undefined
      try {
        return JSON.parse(text)
      } catch {
        return undefined
      }
    }

    function oneLine(text) {
      return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
    }

    function unwrapComposite(input) {
      let current = input && typeof input === 'object' ? input : {}
      for (let round = 0; round < 8; round += 1) {
        if (!current || typeof current !== 'object') return {}
        if (Array.isArray(current.allOf) && current.allOf.length > 0) {
          const merged = Object.assign({}, current)
          delete merged.allOf
          const properties = Object.assign({}, current.properties || {})
          for (const member of current.allOf) {
            if (member && typeof member === 'object' && member.properties) Object.assign(properties, member.properties)
          }
          merged.properties = properties
          merged.type = merged.type || 'object'
          return merged
        }
        const list = Array.isArray(current.oneOf) ? current.oneOf : Array.isArray(current.anyOf) ? current.anyOf : null
        if (list && list.length > 0 && list[0] && typeof list[0] === 'object') {
          current = list[0]
          continue
        }
        return current
      }
      return current
    }

    function schemaComment(node) {
      return oneLine(unwrapComposite(node).description)
    }

    function typeLabel(node) {
      const schema = unwrapComposite(node)
      let type = schema.type
      if (Array.isArray(type)) type = type.filter(function (item) { return item !== 'null' }).join(' | ') || 'null'
      if (type === 'array') {
        const items = Array.isArray(schema.items) ? schema.items[0] : schema.items
        const inner = items ? typeLabel(items) : ''
        return inner ? 'array<' + inner + '>' : 'array'
      }
      if (!type && schema.properties) return 'object'
      return type || ''
    }

    function renderAnnotated(node, value, depth, state, path) {
      const schema = unwrapComposite(node)
      const pad = '  '.repeat(depth)
      if (Array.isArray(value)) {
        if (value.length === 0) return '[]'
        const items = Array.isArray(schema.items) ? schema.items[0] : schema.items
        const lines = ['[']
        value.forEach(function (item, index) {
          const last = index === value.length - 1
          lines.push(pad + '  ' + renderAnnotated(items, item, depth + 1, state, path + '[]') + (last ? '' : ','))
        })
        lines.push(pad + ']')
        return lines.join('\n')
      }
      if (value && typeof value === 'object') {
        const keys = Object.keys(value)
        if (keys.length === 0) return '{}'
        const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
        const required = Array.isArray(schema.required) ? schema.required : []
        const lines = ['{']
        keys.forEach(function (key, index) {
          const last = index === keys.length - 1
          const child = properties[key]
          const childPath = path ? path + '.' + key : key
          if (!state.seen.has(childPath)) {
            state.seen.add(childPath)
            state.fields.push({
              path: childPath,
              type: typeLabel(child),
              required: required.indexOf(key) !== -1,
              description: schemaComment(child),
            })
          }
          const rendered = renderAnnotated(child, value[key], depth + 1, state, childPath)
          const childLines = rendered.split('\n')
          const comment = schemaComment(child)
          if (value[key] !== null && typeof value[key] === 'object') {
            lines.push(pad + '  ' + JSON.stringify(key) + ': ' + childLines[0] + (comment ? ' // ' + comment : ''))
            for (let line = 1; line < childLines.length - 1; line += 1) lines.push(childLines[line])
            lines.push(childLines[childLines.length - 1] + (last ? '' : ','))
          } else {
            lines.push(
              pad + '  ' + JSON.stringify(key) + ': ' + childLines[0] + (last ? '' : ',') + (comment ? ' // ' + comment : ''),
            )
          }
        })
        lines.push(pad + '}')
        return lines.join('\n')
      }
      return JSON.stringify(value === undefined ? null : value)
    }

    function annotateSchemaValue(raw, exampleText) {
      const schema = parseJsonSafe(raw)
      let value = parseJsonSafe(exampleText)
      if (schema === undefined) return { text: exampleText || '', fields: [] }
      if (value === undefined) value = null
      const state = { fields: [], seen: new Set() }
      return { text: renderAnnotated(schema, value, 0, state, ''), fields: state.fields }
    }

    function annotateFormValue(form, exampleText) {
      const example = parseJsonSafe(exampleText)
      const object = example && typeof example === 'object' ? example : {}
      const fields = form.map(function (field) {
        return {
          path: field.name,
          type: field.type || '',
          required: field.required === true,
          description: field.desc || '',
        }
      })
      const lines = ['{']
      form.forEach(function (field, index) {
        const last = index === form.length - 1
        const value = object[field.name]
        const comment = field.desc ? ' // ' + oneLine(field.desc) : ''
        lines.push('  ' + JSON.stringify(field.name) + ': ' + JSON.stringify(value === undefined ? null : value) + (last ? '' : ',') + comment)
      })
      lines.push('}')
      return { text: lines.join('\n'), fields: fields }
    }

    function countTree(nodes) {
      let total = 0
      for (const node of nodes) total += 1 + countTree(node.children)
      return total
    }

    function treeChildren(schema, value, basePath) {
      const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
      const required = Array.isArray(schema.required) ? schema.required : []
      const object = value && typeof value === 'object' ? value : {}
      return Object.keys(properties).map(function (key) {
        return makeTreeNode(
          key,
          properties[key],
          object[key],
          basePath ? basePath + '.' + key : key,
          required.indexOf(key) !== -1,
        )
      })
    }

    function makeTreeNode(name, nodeSchema, value, path, required) {
      const schema = unwrapComposite(nodeSchema)
      const rawType = schema.type
      const isArray = rawType === 'array' || (Array.isArray(rawType) && rawType.indexOf('array') !== -1)
      const isObject = Boolean(schema.properties) || rawType === 'object'
      const kind = isArray ? 'array' : isObject ? 'object' : 'scalar'
      const children = []
      if (kind === 'object') {
        children.push.apply(children, treeChildren(schema, value, path))
      } else if (kind === 'array') {
        const items = Array.isArray(schema.items) ? schema.items[0] : schema.items
        const itemSchema = unwrapComposite(items)
        if (itemSchema.properties) {
          const itemValue = Array.isArray(value) && value.length > 0 ? value[0] : {}
          children.push.apply(children, treeChildren(itemSchema, itemValue, path + '[]'))
        }
      }
      return {
        id: path,
        name: name,
        path: path,
        type: typeLabel(schema) || '',
        kind: kind,
        required: required === true,
        description: schemaComment(schema),
        children: children,
      }
    }

    function buildTreeFromSchema(raw, exampleText) {
      const schema = parseJsonSafe(raw)
      const value = parseJsonSafe(exampleText)
      if (schema === undefined) return { nodes: [], total: 0 }
      const root = unwrapComposite(schema)
      const nodes = treeChildren(root, value && typeof value === 'object' ? value : {}, '')
      return { nodes: nodes, total: countTree(nodes) }
    }

    function buildTreeFromForm(form, exampleText) {
      const nodes = form.map(function (field) {
        return {
          id: field.name,
          name: field.name,
          path: field.name,
          type: field.type || '',
          kind: 'scalar',
          required: field.required === true,
          description: field.desc || '',
          children: [],
        }
      })
      return { nodes: nodes, total: nodes.length }
    }

    function fieldTreeFor(doc, kind) {
      const source = kind === 'request' ? doc.request : doc.response
      const body = source.body
      if (!body || body.kind === 'none') return { nodes: [], total: 0 }
      if (kind === 'request' && (source.bodyType === 'form' || (doc.request.form.length > 0 && !source.bodyIsJsonSchema))) {
        return buildTreeFromForm(doc.request.form, body.example)
      }
      if (source.bodyIsJsonSchema) return buildTreeFromSchema(body.raw, body.example)
      return { nodes: [], total: 0 }
    }

    function annotationFor(doc, kind) {
      const source = kind === 'request' ? doc.request : doc.response
      const body = source.body
      const tree = fieldTreeFor(doc, kind)
      if (!body || body.kind === 'none') return { text: '', fields: [], tree: tree }
      if (kind === 'request' && (source.bodyType === 'form' || (doc.request.form.length > 0 && !source.bodyIsJsonSchema))) {
        const form = annotateFormValue(doc.request.form, body.example)
        form.tree = tree
        return form
      }
      if (source.bodyIsJsonSchema) {
        const schema = annotateSchemaValue(body.raw, body.example)
        schema.tree = tree
        return schema
      }
      return { text: body.example || '', fields: [], tree: tree }
    }

    const STATUS_LABEL = {
      done: '已完成',
      undone: '开发中',
      design: '设计中',
      deprecated: '已废弃',
      stub: '未完成',
    }

    /* ------------------------------------------------------------------ */
    /* icons                                                               */
    /* ------------------------------------------------------------------ */

    function svg(size, children) {
      const nodes = children.map(function (child, index) {
        if (child && child.key === null) return React.cloneElement(child, { key: 'n' + index })
        return child
      })
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        nodes,
      )
    }

    function strokePath(d, extra) {
      return h('path', Object.assign({
        d: d,
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }, extra || {}))
    }

    function YapiIcon(props) {
      const size = props && props.size ? props.size : 18
      return svg(size, [
        h('path', {
          key: 'doc',
          d: 'M5.5 3.5h8.2L18.5 8v12.5h-13z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          key: 'fold',
          d: 'M13.7 3.5V8h4.8',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          key: 'code',
          d: 'M9.4 11.4 7.2 13.6l2.2 2.2M14.6 11.4l2.2 2.2-2.2 2.2',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ])
    }

    function SearchIcon(props) {
      const size = props && props.size ? props.size : 16
      return svg(size, [
        h('circle', { key: 'c', cx: 11, cy: 11, r: 6.2, stroke: 'currentColor', strokeWidth: 1.7 }),
        strokePath('m16 16 4 4'),
      ])
    }





    function CopyIcon(props) {
      const size = props && props.size ? props.size : 14
      return svg(size, [
        h('rect', { key: 'a', x: 8.5, y: 8.5, width: 11, height: 11, rx: 2.2, stroke: 'currentColor', strokeWidth: 1.6 }),
        strokePath('M6 15.5H5.5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2V6'),
      ])
    }

    function ExternalIcon(props) {
      const size = props && props.size ? props.size : 13
      return svg(size, [
        strokePath('M13.5 5.5H18.5V10.5'),
        strokePath('M18 6 11.5 12.5'),
        strokePath('M9.5 5.5h-3a1.5 1.5 0 0 0-1.5 1.5v11a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-3'),
      ])
    }

    function UserIcon(props) {
      const size = props && props.size ? props.size : 14
      return svg(size, [
        h('circle', { key: 'head', cx: 12, cy: 8.2, r: 3.6, stroke: 'currentColor', strokeWidth: 1.7 }),
        strokePath('M4.9 20.1c.9-3.4 3.7-5.4 7.1-5.4s6.2 2 7.1 5.4'),
      ])
    }

    function CloseIcon(props) {
      const size = props && props.size ? props.size : 16
      return svg(size, [strokePath('M6.5 6.5l11 11M17.5 6.5l-11 11')])
    }

    /* ------------------------------------------------------------------ */
    /* styles                                                              */
    /* ------------------------------------------------------------------ */

    const CSS = [
      '.yapi-root{min-height:100%;--yapi-accent:var(--dsw-alias-brand-primary,#4d6bfe);--yapi-text:var(--dsw-alias-label-primary,#17181c);--yapi-text-2:var(--dsw-alias-label-secondary,#5b5f6b);--yapi-text-3:var(--dsw-alias-label-tertiary,#8a8f9b);--yapi-bg:var(--dsw-alias-bg-base,#fff);--yapi-surface:var(--dsw-alias-bg-layer-1,#f7f8fa);--yapi-surface-2:var(--dsw-alias-bg-layer-2,#fff);--yapi-line:var(--dsw-alias-border-l1,#eaeaef);--yapi-line-2:var(--dsw-alias-border-l2,#dedee5);height:100%;overflow:auto;background:var(--yapi-bg);color:var(--yapi-text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}',
      '.yapi-inner{max-width:1040px;margin:0 auto;padding:36px 32px 96px;box-sizing:border-box}',
      '.yapi-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px}',
      '.yapi-hero-main{min-width:0}',
      '.yapi-hero-side{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:6px}',
      '.yapi-accountstate{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--yapi-text-3)}',
      '.yapi-accountstate[data-set="false"]{color:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.yapi-kicker{display:inline-flex;align-items:center;gap:6px;color:var(--yapi-accent);font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}',
      '.yapi-hero h1{margin:8px 0 6px;font-size:26px;line-height:1.25;font-weight:650;letter-spacing:-.02em}',
      '.yapi-hero p{margin:0;color:var(--yapi-text-2);font-size:13.5px}',
      '.yapi-searchwrap{position:relative}',
      '.yapi-search{display:flex;align-items:center;gap:10px;padding:8px 8px 8px 14px;border:1px solid var(--yapi-line-2);border-radius:14px;background:var(--yapi-surface-2);transition:border-color .15s,box-shadow .15s}',
      '.yapi-search:focus-within{border-color:var(--yapi-accent);box-shadow:0 0 0 3px rgba(77,107,254,.12)}',
      '.yapi-search .yapi-search-ico{display:flex;color:var(--yapi-text-3);flex:none}',
      '.yapi-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:inherit;font-family:inherit;font-size:14px;padding:6px 0}',
      '.yapi-search input::placeholder{color:var(--yapi-text-3)}',
      '.yapi-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;border-radius:9px;background:var(--dsw-alias-button-primary-fill,var(--yapi-accent));color:var(--dsw-alias-label-primary-foreground,#fff);font-family:inherit;font-size:13px;font-weight:600;padding:8px 16px;cursor:pointer;white-space:nowrap;transition:filter .15s,opacity .15s}',
      '.yapi-btn:hover:not(:disabled){filter:brightness(1.06)}',
      '.yapi-btn:disabled{opacity:.55;cursor:not-allowed}',
      '.yapi-btn.ghost{background:transparent;color:var(--yapi-text-2);border-color:var(--yapi-line-2)}',
      '.yapi-btn.ghost:hover:not(:disabled){background:var(--yapi-surface);border-color:var(--yapi-line-2);color:var(--yapi-text);filter:none}',
      '.yapi-btn.sm{padding:5px 10px;font-size:12px;border-radius:7px}',
      '.yapi-hint{margin:8px 2px 0;font-size:12px;color:var(--yapi-text-3)}',
      '.yapi-recent{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px;font-size:12px;color:var(--yapi-text-3)}',
      '.yapi-chip{appearance:none;border:1px solid var(--yapi-line);background:transparent;color:var(--yapi-text-2);border-radius:999px;padding:3px 10px;font-family:inherit;font-size:12px;cursor:pointer}',
      '.yapi-chip:hover{border-color:var(--yapi-accent);color:var(--yapi-accent)}',
      '.yapi-searchpanel{position:absolute;left:0;right:0;top:calc(100% + 8px);z-index:40;border:1px solid var(--yapi-line-2);border-radius:14px;background:var(--yapi-bg);box-shadow:0 18px 48px rgba(15,20,40,.18);overflow:hidden}',
      '.yapi-searchpanel-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--yapi-line);background:var(--yapi-surface)}',
      '.yapi-searchpanel-label{font-size:11.5px;font-weight:600;color:var(--yapi-text-3)}',
      '.yapi-searchpanel-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--yapi-text-3)}',
      '.yapi-searchpanel-refresh{appearance:none;border:1px solid var(--yapi-line);border-radius:7px;background:transparent;color:var(--yapi-text-3);font-family:inherit;font-size:11.5px;padding:4px 8px;cursor:pointer;white-space:nowrap}',
      '.yapi-searchpanel-refresh:hover:not(:disabled){color:var(--yapi-accent);border-color:var(--yapi-accent)}',
      '.yapi-searchpanel-refresh:disabled{opacity:.5;cursor:not-allowed}',
      '.yapi-searchpanel-close{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--yapi-text-3);cursor:pointer;padding:0}',
      '.yapi-searchpanel-close:hover{background:var(--yapi-surface-2);color:var(--yapi-text)}',
      '.yapi-searchpanel-body{max-height:380px;overflow:auto}',
      '.yapi-searchprojects{padding:8px 12px;border-bottom:1px solid var(--yapi-line);display:flex;flex-direction:column;gap:4px}',
      '.yapi-searchprojects-title{font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--yapi-text-3)}',
      '.yapi-searchproject{display:flex;align-items:center;gap:8px;width:100%;border:0;border-radius:7px;background:transparent;color:var(--yapi-text-2);font-family:inherit;font-size:12.5px;padding:6px 8px;text-align:left;cursor:pointer}',
      '.yapi-searchproject:hover{background:var(--yapi-surface)}',
      '.yapi-searchproject-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.yapi-searchproject-id{margin-left:auto;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:10.5px;color:var(--yapi-text-3)}',
      '.yapi-searchitem-project{font-size:10.5px;color:var(--yapi-text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.yapi-searchpanel-state{display:flex;align-items:center;gap:8px;padding:18px 14px;font-size:12.5px;color:var(--yapi-text-3)}',
      '.yapi-searchpanel-error{padding:14px;font-size:12.5px;color:var(--dsw-alias-state-error-primary,#dc2626);word-break:break-word}',
      '.yapi-searchitem{display:flex;align-items:center;gap:10px;width:100%;border:0;border-bottom:1px solid var(--yapi-line);background:transparent;color:inherit;text-align:left;padding:10px 12px;cursor:pointer;font-family:inherit}',
      '.yapi-searchitem:last-child{border-bottom:0}',
      '.yapi-searchitem:hover{background:var(--yapi-surface)}',
      '.yapi-searchitem[data-current="true"]{background:color-mix(in srgb,var(--yapi-accent) 8%,transparent)}',
      '.yapi-searchitem[data-current="true"] .yapi-searchitem-id{color:var(--yapi-accent)}',
      '.yapi-searchitem-method{flex:none;width:42px;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:9.5px;font-weight:800;color:var(--yapi-text-3)}',
      '.yapi-searchitem-method[data-method="GET"]{color:var(--dsw-alias-state-success-primary,#0b8a4b)}',
      '.yapi-searchitem-method[data-method="POST"]{color:var(--dsw-alias-brand-primary,#2058d8)}',
      '.yapi-searchitem-method[data-method="PUT"]{color:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.yapi-searchitem-method[data-method="PATCH"]{color:var(--dsw-alias-state-business-primary,#7c3aed)}',
      '.yapi-searchitem-method[data-method="DELETE"]{color:var(--dsw-alias-state-error-primary,#c62828)}',
      '.yapi-searchitem-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.yapi-searchitem-main code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:12px;color:var(--yapi-text)}',
      '.yapi-searchitem-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--yapi-text-3)}',
      '.yapi-searchitem-id{flex:none;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11px;color:var(--yapi-text-3)}',
      '.yapi-error{margin-top:22px;border:1px solid rgba(220,38,38,.28);background:rgba(220,38,38,.06);border-radius:12px;padding:14px 16px}',
      '.yapi-error-title{font-size:13px;font-weight:650;color:var(--dsw-alias-state-error-primary,#dc2626);margin-bottom:4px}',
      '.yapi-error-msg{font-size:13px;color:var(--yapi-text);word-break:break-word}',
      '.yapi-error-hint{margin-top:8px;font-size:12px;color:var(--yapi-text-3)}',
      '.yapi-error-action{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
      '.yapi-mask{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,18,25,.45)}',
      '.yapi-modal{width:100%;max-width:460px;max-height:90vh;overflow:auto;border:1px solid var(--yapi-line-2);border-radius:16px;background:var(--yapi-bg);box-shadow:0 24px 70px rgba(0,0,0,.28)}',
      '.yapi-modal-head{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--yapi-line)}',
      '.yapi-modal-head h3{margin:0;font-size:15px;font-weight:650}',
      '.yapi-modal-close{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--yapi-text-3);cursor:pointer}',
      '.yapi-modal-close:hover{background:var(--yapi-surface);color:var(--yapi-text)}',
      '.yapi-modal-body{display:flex;flex-direction:column;gap:12px;padding:16px 18px}',
      '.yapi-modal-state{padding:8px 10px;border:1px solid var(--yapi-line);border-radius:8px;background:var(--yapi-surface);font-size:12px;color:var(--yapi-text-2)}',
      '.yapi-formrow{display:flex;flex-direction:column;gap:5px}',
      '.yapi-formrow label{font-size:11.5px;font-weight:600;color:var(--yapi-text-3)}',
      '.yapi-formrow input,.yapi-formrow select{width:100%;box-sizing:border-box;border:1px solid var(--yapi-line);border-radius:8px;background:var(--yapi-surface-2);color:inherit;font-family:inherit;font-size:13px;padding:8px 10px;outline:0}',
      '.yapi-formrow input:focus,.yapi-formrow select:focus{border-color:var(--yapi-accent)}',
      '.yapi-formhint{font-size:11.5px;line-height:1.6;color:var(--yapi-text-3)}',
      '.yapi-modal-error{border:1px solid rgba(220,38,38,.22);border-radius:8px;background:rgba(220,38,38,.07);padding:8px 10px;font-size:12px;line-height:1.55;color:var(--dsw-alias-state-error-primary,#dc2626);word-break:break-word}',
      '.yapi-copymodal{max-width:520px}',
      '.yapi-copymodal .yapi-modal-head,.yapi-copymodal .yapi-modal-foot{user-select:none;-webkit-user-select:none}',
      '.yapi-copycount{margin-left:8px;font-size:11.5px;color:var(--yapi-text-3);user-select:none;-webkit-user-select:none}',
      '.yapi-copytoggleall{margin-left:8px;border:0;background:transparent;color:var(--yapi-accent);font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;padding:4px 6px;white-space:nowrap;user-select:none;-webkit-user-select:none}',
      '.yapi-copytoggleall:hover{text-decoration:underline}',
      '.yapi-checkgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px}',
      '.yapi-check{display:flex;align-items:center;gap:8px;min-width:0;padding:7px 9px;border:1px solid var(--yapi-line);border-radius:8px;background:var(--yapi-surface-2);font-size:12.5px;color:var(--yapi-text-2);cursor:pointer;user-select:none;-webkit-user-select:none}',
      '.yapi-check:hover{border-color:var(--yapi-line-2);color:var(--yapi-text)}',
      '.yapi-check[data-checked="true"]{border-color:var(--yapi-accent);background:color-mix(in srgb,var(--yapi-accent) 7%,var(--yapi-surface-2));color:var(--yapi-text)}',
      '.yapi-check input{width:14px;height:14px;margin:0;flex:none;accent-color:var(--yapi-accent)}',
      '.yapi-copyformatrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--yapi-text-3);user-select:none;-webkit-user-select:none}',
      '.yapi-copyformat-hint{font-size:11.5px;color:var(--yapi-text-3)}',
      '.yapi-copyhint{font-size:11.5px;line-height:1.6;color:var(--yapi-text-3)}',
      '.yapi-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--yapi-line);background:var(--yapi-surface)}',
      '.yapi-loading{display:flex;align-items:center;gap:10px;margin-top:26px;color:var(--yapi-text-3);font-size:13px}',
      '.yapi-spinner{width:16px;height:16px;border:2px solid var(--yapi-line-2);border-top-color:var(--yapi-accent);border-radius:50%;animation:yapi-spin .8s linear infinite}',
      '@keyframes yapi-spin{to{transform:rotate(360deg)}}',
      '.yapi-tabbar{display:flex;align-items:center;gap:8px;margin-top:18px;min-width:0}',
      '.yapi-tabbar-list{display:flex;align-items:center;gap:6px;flex:1;min-width:0;overflow-x:auto;padding-bottom:2px;scrollbar-width:thin}',
      '.yapi-tabbar-list::-webkit-scrollbar{height:6px}',
      '.yapi-tabbar-list::-webkit-scrollbar-thumb{background:var(--yapi-line-2);border-radius:999px}',
      '.yapi-doctab{display:flex;align-items:center;gap:6px;flex:none;max-width:240px;min-width:0;padding:7px 8px 7px 10px;border:1px solid var(--yapi-line);border-radius:9px;background:var(--yapi-surface);color:var(--yapi-text-2);font-size:12.5px;cursor:pointer;user-select:none}',
      '.yapi-doctab:hover{border-color:var(--yapi-line-2);color:var(--yapi-text)}',
      '.yapi-doctab[data-active="true"]{background:var(--yapi-surface-2);border-color:var(--yapi-line-2);color:var(--yapi-text);font-weight:600;box-shadow:0 1px 3px rgba(15,20,40,.06)}',
      '.yapi-doctab-method{flex:none;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:9.5px;font-weight:800;letter-spacing:.04em;color:var(--yapi-text-3)}',
      '.yapi-doctab-method[data-method="GET"]{color:var(--dsw-alias-state-success-primary,#0b8a4b)}',
      '.yapi-doctab-method[data-method="POST"]{color:var(--dsw-alias-brand-primary,#2058d8)}',
      '.yapi-doctab-method[data-method="PUT"]{color:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.yapi-doctab-method[data-method="PATCH"]{color:var(--dsw-alias-state-business-primary,#7c3aed)}',
      '.yapi-doctab-method[data-method="DELETE"]{color:var(--dsw-alias-state-error-primary,#c62828)}',
      '.yapi-doctab-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.yapi-doctab-spin{width:10px;height:10px;flex:none;border:1.5px solid var(--yapi-line-2);border-top-color:var(--yapi-accent);border-radius:50%;animation:yapi-spin .8s linear infinite}',
      '.yapi-doctab-close{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:none;border:0;border-radius:5px;background:transparent;color:var(--yapi-text-3);cursor:pointer;padding:0}',
      '.yapi-doctab-close:hover{background:var(--yapi-line);color:var(--yapi-text)}',
      '.yapi-doctab-clear{flex:none;border:0;background:transparent;color:var(--yapi-text-3);font-family:inherit;font-size:11.5px;cursor:pointer;padding:4px 2px;white-space:nowrap}',
      '.yapi-doctab-clear:hover{color:var(--yapi-text)}',
      '.yapi-doc{margin-top:24px;border:1px solid var(--yapi-line);border-radius:18px;background:var(--yapi-surface);overflow:hidden}',
      '.yapi-doc-head{padding:22px 24px 18px;border-bottom:1px solid var(--yapi-line)}',
      '.yapi-titlebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.yapi-titlebar h2{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em;line-height:1.35}',
      '.yapi-method{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11px;font-weight:800;letter-spacing:.06em;border-radius:6px;padding:3px 8px;flex:none;background:var(--yapi-surface)}',
      '.yapi-method[data-method="GET"]{color:var(--dsw-alias-state-success-primary,#0b8a4b);background:color-mix(in srgb,currentColor 15%,transparent)}',
      '.yapi-method[data-method="POST"]{color:var(--dsw-alias-brand-primary,#2058d8);background:color-mix(in srgb,currentColor 15%,transparent)}',
      '.yapi-method[data-method="PUT"]{color:var(--dsw-alias-state-warn-primary,#b45309);background:color-mix(in srgb,currentColor 16%,transparent)}',
      '.yapi-method[data-method="PATCH"]{color:var(--dsw-alias-state-business-primary,#7c3aed);background:color-mix(in srgb,currentColor 15%,transparent)}',
      '.yapi-method[data-method="DELETE"]{color:var(--dsw-alias-state-error-primary,#c62828);background:color-mix(in srgb,currentColor 15%,transparent)}',
      '.yapi-method[data-method="HEAD"],.yapi-method[data-method="OPTIONS"]{color:var(--yapi-text-3);background:var(--yapi-surface)}',
      '.yapi-status{font-size:11px;font-weight:600;border:1px solid currentColor;border-radius:999px;padding:2px 9px;flex:none}',
      '.yapi-status[data-status="done"]{color:var(--dsw-alias-state-success-primary,#0b8a4b)}',
      '.yapi-status[data-status="undone"]{color:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.yapi-status[data-status="deprecated"]{color:var(--dsw-alias-state-error-primary,#c62828)}',
      '.yapi-status[data-status="design"]{color:var(--dsw-alias-brand-primary,#2058d8)}',
      '.yapi-status[data-status="stub"]{color:var(--yapi-text-3)}',
      '.yapi-openlink{display:inline-flex;align-items:center;gap:4px;margin-left:auto;color:var(--yapi-text-3);text-decoration:none;font-size:12px;border:1px solid var(--yapi-line);border-radius:7px;padding:4px 9px;white-space:nowrap}',
      '.yapi-openlink:hover{color:var(--yapi-accent);border-color:var(--yapi-accent)}',
      '.yapi-titlebar-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.yapi-titlebar-actions .yapi-openlink{margin-left:0}',
      '.yapi-docid{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11px;font-weight:600;color:var(--yapi-text-3);border:1px solid var(--yapi-line);border-radius:6px;padding:2px 6px;white-space:nowrap}',
      '.yapi-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px;font-size:12.5px;color:var(--yapi-text-3)}',
      '.yapi-dot{opacity:.55}',
      '.yapi-addrs{display:grid;grid-template-columns:1.1fr 1.4fr;gap:12px;padding:0 24px 12px}',
      '.yapi-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.yapi-field label{font-size:11.5px;font-weight:600;color:var(--yapi-text-3)}',
      '.yapi-field input{width:100%;box-sizing:border-box;border:1px solid var(--yapi-line);border-radius:8px;background:var(--yapi-surface-2);color:inherit;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:12.5px;padding:7px 10px;outline:0}',
      '.yapi-field input:focus{border-color:var(--yapi-accent)}',
      '.yapi-pathstatic{width:100%;box-sizing:border-box;border:1px solid var(--yapi-line);border-radius:8px;background:var(--yapi-surface-2);padding:7px 10px;min-width:0;overflow:hidden}',
      '.yapi-pathstatic code{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:12.5px;color:var(--yapi-text)}',
      '.yapi-addrpreview{margin:0 24px 6px;font-size:11.5px;color:var(--yapi-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.yapi-addrpreview code{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);color:var(--yapi-text-2)}',
      '.yapi-tabs{display:flex;gap:6px;flex-wrap:wrap;padding:10px 18px;margin-top:12px;border-top:1px solid var(--yapi-line)}',
      '.yapi-tab{appearance:none;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--yapi-text-3);font-family:inherit;font-size:13px;font-weight:500;padding:7px 13px;cursor:pointer}',
      '.yapi-tab:hover{color:var(--yapi-text)}',
      '.yapi-tab[data-active="true"]{background:var(--yapi-surface-2);border-color:var(--yapi-line);color:var(--yapi-text);font-weight:600}',
      '.yapi-tabbody{padding:18px 24px 24px;border-top:1px solid var(--yapi-line);background:var(--yapi-surface-2)}',
      '.yapi-seg{display:inline-flex;border:1px solid var(--yapi-line);border-radius:8px;padding:2px;background:var(--yapi-surface)}',
      '.yapi-seg button{appearance:none;border:0;background:transparent;color:var(--yapi-text-3);font-family:inherit;font-size:12px;padding:3px 9px;border-radius:6px;cursor:pointer}',
      '.yapi-seg button[data-active="true"]{background:var(--yapi-surface-2);color:var(--yapi-text);font-weight:600;box-shadow:0 1px 2px rgba(15,20,40,.09)}',
      '.yapi-fieldpanel{display:flex;flex-direction:column;gap:10px}',
      '.yapi-fieldbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.yapi-fieldbar-left{display:flex;align-items:center;gap:8px}',
      '.yapi-fieldbar-title{font-size:13px;font-weight:600}',
      '.yapi-fieldmatch{font-size:11.5px;font-weight:600;color:var(--yapi-accent)}',
      '.yapi-fieldbar-right{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap}',
      '.yapi-fieldsearch{width:220px;max-width:100%;box-sizing:border-box;border:1px solid var(--yapi-line);border-radius:8px;background:var(--yapi-surface-2);color:inherit;font-family:inherit;font-size:12px;padding:6px 10px;outline:0}',
      '.yapi-fieldsearch:focus{border-color:var(--yapi-accent)}',
      '.yapi-tree{border:1px solid var(--yapi-line);border-radius:12px;overflow:hidden;background:var(--yapi-surface-2)}',
      '.yapi-treehead{display:grid;grid-template-columns:minmax(0,1.4fr) 118px 62px minmax(0,1.6fr);gap:10px;padding:8px 12px;background:var(--yapi-surface);border-bottom:1px solid var(--yapi-line);font-size:11.5px;font-weight:600;color:var(--yapi-text-3)}',
      '.yapi-treehead span:first-child{padding-left:30px}',
      '.yapi-treebody{max-height:540px;overflow:auto}',
      '.yapi-trow{position:relative;display:grid;grid-template-columns:minmax(0,1.4fr) 118px 62px minmax(0,1.6fr);gap:10px;padding:6px 12px;border-bottom:1px solid var(--yapi-line);align-items:start}',
      '.yapi-trow::before{content:"";position:absolute;left:calc(16px + var(--yapi-depth,0) * 16px);top:0;bottom:0;width:2px;border-radius:2px;background:var(--yapi-depth-color);opacity:.32}',
      '.yapi-trow[data-container="true"]{background:color-mix(in srgb,var(--yapi-depth-color) 7%,transparent)}',
      '.yapi-trow[data-match="true"]{background:color-mix(in srgb,#f59e0b 13%,transparent)}',
      '.yapi-trow[data-active-match="true"]{background:color-mix(in srgb,#f59e0b 26%,transparent);box-shadow:inset 3px 0 0 #d97706}',
      '.yapi-trow mark{background:#fbbf24;color:#7c2d12;font-weight:600;border-radius:3px;padding:0 2px}',
      '.yapi-tooltip{position:fixed;z-index:1000;max-width:280px;background:var(--yapi-text);color:var(--yapi-bg);font-size:11.5px;line-height:1.45;padding:7px 9px;border-radius:8px;box-shadow:0 10px 28px rgba(15,20,40,.24);pointer-events:none;word-break:break-all}',
      '.yapi-tooltip-path{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-weight:600}',
      '.yapi-tooltip-meta{margin-top:2px;font-size:10.5px;opacity:.72}',
      '.yapi-trow[data-active-match="true"] mark{background:#b45309;color:#fff}',
      '.yapi-fieldnav{display:inline-flex;align-items:center;gap:3px;margin-left:2px}',
      '.yapi-trow[data-kind="object"] .yapi-ttype{color:#7c3aed;font-weight:600}',
      '.yapi-trow[data-kind="array"] .yapi-ttype{color:#b45309;font-weight:600}',
      '.yapi-trow:last-child{border-bottom:0}',
      '.yapi-trow:hover{background:var(--yapi-surface)}',
      '.yapi-tcell{min-width:0;font-size:12.5px;line-height:1.5}',
      '.yapi-tname{display:flex;align-items:center;gap:6px}',
      '.yapi-tname code{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:12px;color:var(--yapi-text)}',
      '.yapi-tchev{width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;flex:none;border:0;border-radius:4px;background:transparent;color:var(--yapi-text-3);cursor:pointer;padding:0}',
      '.yapi-tchev:hover{background:var(--yapi-line);color:var(--yapi-text)}',
      '.yapi-tchev svg{transition:transform .15s}',
      '.yapi-tchev[data-open="true"] svg{transform:rotate(90deg)}',
      '.yapi-tchev-empty{pointer-events:none}',
      '.yapi-tcount{flex:none;margin-left:2px;font-size:10px;font-weight:600;color:var(--yapi-text-3);border:1px solid var(--yapi-line);border-radius:999px;padding:0 5px}',
      '.yapi-ttype{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11.5px;color:var(--yapi-text-2);word-break:break-word}',
      '.yapi-treq{white-space:nowrap}',
      '.yapi-tdesc{color:var(--yapi-text-2);word-break:break-word}',
      '.yapi-section{margin-bottom:22px}',
      '.yapi-section:last-child{margin-bottom:0}',
      '.yapi-section h3{display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:13px;font-weight:600}',
      '.yapi-count{font-size:11px;font-weight:600;color:var(--yapi-text-3);background:var(--yapi-surface);border:1px solid var(--yapi-line);border-radius:999px;padding:0 7px}',
      '.yapi-tablewrap{border:1px solid var(--yapi-line);border-radius:10px;overflow:auto;background:var(--yapi-surface-2)}',
      '.yapi-table{width:100%;min-width:560px;border-collapse:collapse;font-size:12.5px}',
      '.yapi-table th{text-align:left;font-size:11.5px;font-weight:600;color:var(--yapi-text-3);background:var(--yapi-surface);padding:8px 12px;border-bottom:1px solid var(--yapi-line);white-space:nowrap}',
      '.yapi-table td{padding:8px 12px;border-bottom:1px solid var(--yapi-line);vertical-align:top;color:var(--yapi-text-2);word-break:break-word}',
      '.yapi-table tr:last-child td{border-bottom:0}',
      '.yapi-table td.mono{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:12px;color:var(--yapi-text)}',
      '.yapi-req{font-size:11.5px;font-weight:600;color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.yapi-opt{font-size:11.5px;color:var(--yapi-text-3)}',
      '.yapi-empty{padding:40px 0;text-align:center;font-size:13px;color:var(--yapi-text-3)}',
      '.yapi-desc{white-space:pre-wrap;font-size:13.5px;line-height:1.75;color:var(--yapi-text-2)}',
      '.yapi-toast{position:fixed;left:50%;bottom:36px;z-index:80;transform:translateX(-50%);padding:8px 18px;border:1px solid var(--yapi-line-2);border-radius:999px;background:var(--dsw-alias-bg-layer-3,#2a2d34);color:var(--dsw-alias-label-primary,#fff);font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.2);animation:yapi-rise .18s ease-out;pointer-events:none}',
      '@keyframes yapi-rise{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}',
      '@media (max-width:820px){.yapi-addrs{grid-template-columns:1fr}}',
      '@media (max-width:720px){.yapi-inner{padding:24px 18px 64px}.yapi-doc-head{padding:18px 16px 14px}.yapi-addrs{padding:0 16px 12px}.yapi-addrpreview{margin:0 16px 6px}.yapi-tabbody{padding:16px 16px 22px}.yapi-tabs{padding:6px 10px 0}}',
      '@media (max-width:560px){.yapi-checkgrid{grid-template-columns:1fr}}',
      '@media (prefers-reduced-motion:reduce){.yapi-copy,.yapi-search,.yapi-btn{transition:none}.yapi-spinner{animation:none}.yapi-toast{animation:none}}',
    ].join('\n')

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /* ------------------------------------------------------------------ */
    /* small view pieces                                                   */
    /* ------------------------------------------------------------------ */

    function ParamSection(props) {
      const rows = props.rows || []
      if (rows.length === 0) return null
      const header = props.kind === 'header'
      const columns = header
        ? [
            { key: 'name', label: '名称', className: 'mono' },
            { key: 'value', label: '值', className: 'mono' },
            { key: 'required', label: '必填' },
            { key: 'desc', label: '说明' },
          ]
        : [
            { key: 'name', label: '名称', className: 'mono' },
            { key: 'type', label: '类型' },
            { key: 'required', label: '必填' },
            { key: 'example', label: '示例' },
            { key: 'desc', label: '说明' },
          ]
      return h(
        'div',
        { className: 'yapi-section' },
        h('h3', null, props.title, h('span', { className: 'yapi-count' }, rows.length)),
        h(
          'div',
          { className: 'yapi-tablewrap' },
          h(
            'table',
            { className: 'yapi-table' },
            h('thead', null, h('tr', null, columns.map((column) => h('th', { key: column.key }, column.label)))),
            h(
              'tbody',
              null,
              rows.map((row, index) =>
                h(
                  'tr',
                  { key: row.name + '-' + index },
                  columns.map((column) => {
                    if (column.key === 'required') {
                      return h(
                        'td',
                        { key: column.key },
                        row.required
                          ? h('span', { className: 'yapi-req' }, '必填')
                          : h('span', { className: 'yapi-opt' }, '可选'),
                      )
                    }
                    const value = row[column.key]
                    return h(
                      'td',
                      { key: column.key, className: column.className || '' },
                      value === undefined || value === null || value === '' ? '—' : String(value),
                    )
                  }),
                ),
              ),
            ),
          ),
        ),
      )
    }

    function ChevronIcon(props) {
      const size = props && props.size ? props.size : 12
      return svg(size, [strokePath('m9 6 6 6-6 6')])
    }

    function initialExpanded(nodes) {
      const set = new Set()
      for (const node of nodes) {
        if (node.children.length > 0) set.add(node.id)
      }
      return set
    }

    function collectExpandable(nodes, out) {
      for (const node of nodes) {
        if (node.children.length > 0) {
          out.push(node.id)
          collectExpandable(node.children, out)
        }
      }
      return out
    }

    function filterTree(nodes, keyword) {
      const kept = []
      for (const node of nodes) {
        const children = filterTree(node.children, keyword)
        const haystack = (node.name + ' ' + node.path + ' ' + node.type + ' ' + node.description).toLowerCase()
        if (haystack.indexOf(keyword) !== -1 || children.length > 0) {
          kept.push(Object.assign({}, node, { children: children }))
        }
      }
      return kept
    }

    function countMatches(nodes, keyword) {
      let total = 0
      for (const node of nodes) {
        const haystack = (node.name + ' ' + node.path + ' ' + node.type + ' ' + node.description).toLowerCase()
        if (haystack.indexOf(keyword) !== -1) total += 1
        total += countMatches(node.children, keyword)
      }
      return total
    }

    function collectMatchNodes(nodes, keyword) {
      const matches = []
      const ancestors = new Set()
      if (keyword === '') return { matches: matches, ancestors: ancestors }

      function walk(list, parentPath) {
        for (const node of list) {
          const haystack = (
            node.name +
            ' ' +
            node.path +
            ' ' +
            node.type +
            ' ' +
            node.description
          ).toLowerCase()
          if (haystack.indexOf(keyword) !== -1) matches.push(node)
          if (node.children.length > 0) {
            const before = matches.length
            walk(node.children, parentPath.concat(node.id))
            if (matches.length > before) {
              for (const id of parentPath) ancestors.add(id)
              ancestors.add(node.id)
            }
          }
        }
      }

      walk(nodes, [])
      return { matches: matches, ancestors: ancestors }
    }

    function flattenTree(nodes, expanded, depth, out) {
      for (const node of nodes) {
        out.push({ node: node, depth: depth })
        if (node.children.length > 0 && expanded.has(node.id)) {
          flattenTree(node.children, expanded, depth + 1, out)
        }
      }
      return out
    }

    const DEPTH_COLORS = ['#94a3b8', '#60a5fa', '#34d399', '#f59e0b', '#a78bfa', '#f472b6']

    function highlightText(text, keyword) {
      const value = String(text === undefined || text === null ? '' : text)
      if (keyword === '') return value
      const lower = value.toLowerCase()
      if (lower.indexOf(keyword) === -1) return value
      const parts = []
      let cursor = 0
      let index = lower.indexOf(keyword, cursor)
      let key = 0
      while (index !== -1) {
        if (index > cursor) parts.push(value.slice(cursor, index))
        parts.push(h('mark', { key: 'm' + key }, value.slice(index, index + keyword.length)))
        key += 1
        cursor = index + keyword.length
        index = lower.indexOf(keyword, cursor)
      }
      if (cursor < value.length) parts.push(value.slice(cursor))
      return parts
    }

    function FieldPanel(props) {
      const tree = props.tree || { nodes: [], total: 0 }
      const nodes = tree.nodes
      const [query, setQuery] = useState('')
      const [expanded, setExpanded] = useState(function () {
        return initialExpanded(nodes)
      })

      useEffect(
        function () {
          setExpanded(initialExpanded(nodes))
          setQuery('')
        },
        [nodes],
      )

      const [matchIndex, setMatchIndex] = useState(0)
      const [hoverTip, setHoverTip] = useState(null)
      const rowRefs = useRef(new Map())
      const keyword = query.trim().toLowerCase()
      const matchInfo = collectMatchNodes(nodes, keyword)
      const matchNodes = matchInfo.matches
      const matchCount = matchNodes.length
      const safeIndex = matchCount === 0 ? 0 : Math.min(matchIndex, matchCount - 1)
      const activeMatch = matchNodes[safeIndex] || null
      const visibleExpanded =
        keyword === ''
          ? expanded
          : new Set(Array.from(expanded).concat(Array.from(matchInfo.ancestors)))
      const rows = flattenTree(nodes, visibleExpanded, 0, [])
      const expandable = collectExpandable(nodes, [])
      const allExpanded =
        expandable.length > 0 &&
        expandable.every(function (id) {
          return expanded.has(id)
        })

      useEffect(
        function () {
          setMatchIndex(0)
        },
        [keyword],
      )

      useEffect(
        function () {
          setMatchIndex(function (previous) {
            return Math.max(0, Math.min(previous, matchCount - 1))
          })
        },
        [matchCount],
      )

      useEffect(
        function () {
          if (!activeMatch) return
          const element = rowRefs.current.get(activeMatch.id)
          if (element && element.scrollIntoView) {
            element.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }
        },
        [activeMatch ? activeMatch.id : '', keyword],
      )

      function toggle(node) {
        setExpanded(function (previous) {
          const next = new Set(previous)
          if (next.has(node.id)) next.delete(node.id)
          else next.add(node.id)
          return next
        })
      }

      function toggleAll() {
        setExpanded(allExpanded ? new Set() : new Set(expandable))
      }

      function goMatch(delta) {
        if (matchCount === 0) return
        setMatchIndex(function (previous) {
          return (previous + delta + matchCount) % matchCount
        })
      }

      function showTip(node, depth, event) {
        const padding = 12
        const maxX = Math.max(8, (window.innerWidth || 1200) - 300)
        const maxY = Math.max(8, (window.innerHeight || 800) - 76)
        setHoverTip({
          x: Math.min(event.clientX + padding, maxX),
          y: Math.min(event.clientY + padding, maxY),
          path: node.path || node.name || '',
          type: node.type || '',
          depth: depth + 1,
        })
      }

      return h(
        'div',
        { className: 'yapi-fieldpanel' },
        h(
          'div',
          { className: 'yapi-fieldbar' },
          h(
            'div',
            { className: 'yapi-fieldbar-left' },
            h('span', { className: 'yapi-fieldbar-title' }, props.title),
            h('span', { className: 'yapi-count' }, tree.total),
            keyword !== ''
              ? h(
                  'span',
                  { className: 'yapi-fieldmatch' },
                  matchCount > 0 ? safeIndex + 1 + ' / ' + matchCount : '无匹配',
                )
              : null,
            keyword !== ''
              ? h(
                  'span',
                  { className: 'yapi-fieldnav' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'yapi-btn ghost sm',
                      disabled: matchCount === 0,
                      title: '上一处匹配（↑）',
                      onClick: function () {
                        goMatch(-1)
                      },
                    },
                    '↑',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'yapi-btn ghost sm',
                      disabled: matchCount === 0,
                      title: '下一处匹配（↓）',
                      onClick: function () {
                        goMatch(1)
                      },
                    },
                    '↓',
                  ),
                )
              : null,
          ),
          h(
            'div',
            { className: 'yapi-fieldbar-right' },
            h('input', {
              className: 'yapi-fieldsearch',
              value: query,
              placeholder: '高亮字段 / 类型 / 备注…',
              spellCheck: false,
              onChange: function (event) {
                setQuery(event.target.value)
              },
              onKeyDown: function (event) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  goMatch(1)
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  goMatch(-1)
                }
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'yapi-btn ghost sm',
                disabled: expandable.length === 0,
                title: '展开或收起全部层级',
                onClick: toggleAll,
              },
              allExpanded ? '收起全部' : '展开全部',
            ),
          ),
        ),
        rows.length === 0
          ? h('div', { className: 'yapi-empty' }, '该接口没有提供字段说明')
          : h(
              'div',
              { className: 'yapi-tree' },
              h(
                'div',
                { className: 'yapi-treehead' },
                h('span', null, '字段'),
                h('span', null, '类型'),
                h('span', null, '必填'),
                h('span', null, '说明'),
              ),
              h(
                'div',
                {
                  className: 'yapi-treebody',
                  onScroll: function () {
                    if (hoverTip) setHoverTip(null)
                  },
                },
                rows.map(function (row, index) {
                  const node = row.node
                  const open = expanded.has(node.id)
                  const hasChildren = node.children.length > 0
                  const kind = String(node.type).startsWith('array')
                    ? 'array'
                    : node.type === 'object'
                      ? 'object'
                      : 'field'
                  const haystack = (
                    node.name +
                    ' ' +
                    node.path +
                    ' ' +
                    node.type +
                    ' ' +
                    node.description
                  ).toLowerCase()
                  const matched = keyword !== '' && haystack.indexOf(keyword) !== -1
                  return h(
                    'div',
                    {
                      key: node.id + '-' + index,
                      className: 'yapi-trow',
                      ref: function (element) {
                        if (element) rowRefs.current.set(node.id, element)
                        else rowRefs.current.delete(node.id)
                      },
                      onMouseEnter: function (event) {
                        showTip(node, row.depth, event)
                      },
                      onMouseLeave: function () {
                        setHoverTip(null)
                      },
                      'data-container': hasChildren ? 'true' : 'false',
                      'data-kind': kind,
                      'data-match': matched ? 'true' : 'false',
                      'data-active-match': activeMatch && activeMatch.id === node.id ? 'true' : 'false',
                      style: {
                        '--yapi-depth': row.depth,
                        '--yapi-depth-color': DEPTH_COLORS[row.depth % DEPTH_COLORS.length],
                      },
                    },
                    h(
                      'div',
                      { className: 'yapi-tcell yapi-tname', style: { paddingLeft: 8 + row.depth * 16 + 'px' } },
                      hasChildren
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'yapi-tchev',
                              'data-open': open ? 'true' : 'false',
                              'aria-label': open ? '收起' : '展开',
                              onClick: function () {
                                toggle(node)
                              },
                            },
                            h(ChevronIcon, { size: 11 }),
                          )
                        : h('span', { className: 'yapi-tchev yapi-tchev-empty' }),
                      h('code', null, highlightText(node.name, keyword)),
                      hasChildren ? h('span', { className: 'yapi-tcount' }, node.children.length) : null,
                    ),
                    h('div', { className: 'yapi-tcell yapi-ttype' }, highlightText(node.type || '—', keyword)),
                    h(
                      'div',
                      { className: 'yapi-tcell yapi-treq' },
                      node.required
                        ? h('span', { className: 'yapi-req' }, '必填')
                        : h('span', { className: 'yapi-opt' }, '可选'),
                    ),
                    h('div', { className: 'yapi-tcell yapi-tdesc' }, highlightText(node.description || '—', keyword)),
                  )
                }),
              ),
            ),
        hoverTip
          ? h(
              'div',
              {
                className: 'yapi-tooltip',
                style: { left: hoverTip.x + 'px', top: hoverTip.y + 'px' },
              },
              h('div', { className: 'yapi-tooltip-path' }, hoverTip.path),
              h(
                'div',
                { className: 'yapi-tooltip-meta' },
                (hoverTip.type ? hoverTip.type + ' · ' : '') + '第 ' + hoverTip.depth + ' 层',
              ),
            )
          : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* panel                                                               */
    /* ------------------------------------------------------------------ */

    function YapiPanel() {
      const [input, setInput] = useState(function () {
        return readStorage(LAST_KEY, '')
      })
      const [tabs, setTabs] = useState(function () {
        return ensureTabs().tabs
      })
      const [activeId, setActiveId] = useState(function () {
        return ensureTabs().activeId
      })
      const [tab, setTab] = useState('params')
      const [copyFormat, setCopyFormat] = useState(function () {
        return readStorage(COPY_FORMAT_KEY, 'annotated') === 'json' ? 'json' : 'annotated'
      })
      const [base, setBase] = useState(function () {
        const cache = ensureTabs()
        const active = cache.tabs.find((item) => item.id === cache.activeId)
        return active && active.doc && active.doc.project.envs.length > 0 ? active.doc.project.envs[0].domain : ''
      })
      const [recent, setRecent] = useState(readRecent)
      const [toast, setToast] = useState(null)
      const [copyOpen, setCopyOpen] = useState(false)
      const [copyOptions, setCopyOptions] = useState(readCopyOptions)
      const [search, setSearch] = useState({
        open: false,
        keyword: '',
        loading: false,
        error: '',
        items: [],
        projects: [],
        total: 0,
        projectName: '',
      })
      const [searchView, setSearchView] = useState('search')
      const [category, setCategory] = useState({
        loading: false,
        error: '',
        catid: 0,
        catName: '',
        items: [],
        total: 0,
      })
      const [account, setAccount] = useState(null)
      const [accountOpen, setAccountOpen] = useState(false)
      const [accountForm, setAccountForm] = useState({ baseUrl: '', email: '', password: '', authType: 'normal' })
      const [accountSaving, setAccountSaving] = useState(false)
      const [accountError, setAccountError] = useState('')

      const tabsRef = useRef(tabs)
      const toastTimer = useRef(0)
      const searchTimer = useRef(0)
      const searchSeq = useRef(0)
      const categorySeq = useRef(0)
      const searchWrapRef = useRef(null)
      const autoTabbed = useRef(false)

      const activeTab = tabs.find((item) => item.id === activeId) || null
      const doc = activeTab && activeTab.doc ? activeTab.doc : null
      const loading = activeTab ? activeTab.loading : false
      const error = activeTab ? activeTab.error : null

      useEffect(function () {
        return function () {
          clearTimeout(toastTimer.current)
          clearTimeout(searchTimer.current)
        }
      }, [])

      useEffect(
        function () {
          if (!doc) return
          setBase(doc.project.envs.length > 0 ? doc.project.envs[0].domain : '')
        },
        [doc],
      )

      useEffect(
        function () {
          if (searchView !== 'category') return
          if (!doc || !doc.catid) {
            setSearchView('search')
            return
          }
          loadCategory(doc.catid, doc.project.id)
        },
        [searchView, doc],
      )

      useEffect(
        function () {
          setCopyOpen(false)
        },
        [activeId],
      )

      useEffect(
        function () {
          tabsRef.current = tabs
          TABS_CACHE.tabs = tabs
          TABS_CACHE.activeId = activeId
          writeStorage(
            TABS_KEY,
            JSON.stringify(
              tabs.map(function (item) {
                return { id: item.id, title: item.title, method: item.method, path: item.path }
              }),
            ),
          )
          writeStorage(ACTIVE_KEY, activeId === null ? '' : String(activeId))
        },
        [tabs, activeId],
      )

      useEffect(
        function () {
          if (tabsRef.current.length === 0) {
            const last = readStorage(LAST_KEY, '')
            if (last) openDoc(last)
            return
          }
          const active = tabsRef.current.find((item) => item.id === activeId)
          if (active && !active.doc && !active.loading) fetchDoc(active.id)
        },
        [],
      )

      useEffect(function () {
        fetch('/api/yapi/settings')
          .then(function (response) {
            return response.json().catch(function () {
              return null
            })
          })
          .then(function (payload) {
            if (payload && payload.ok) setAccount(payload)
          })
          .catch(function () {})
      }, [])

      useEffect(
        function () {
          if (!accountOpen && !search.open && !copyOpen) return undefined
          function handleKey(event) {
            if (event.key !== 'Escape') return
            setAccountOpen(false)
            setCopyOpen(false)
            setSearch(function (previous) {
              return Object.assign({}, previous, { open: false })
            })
          }
          window.addEventListener('keydown', handleKey)
          return function () {
            window.removeEventListener('keydown', handleKey)
          }
        },
        [accountOpen, search.open, copyOpen],
      )

      useEffect(
        function () {
          if (!search.open) return undefined
          function handlePointer(event) {
            if (searchWrapRef.current && !searchWrapRef.current.contains(event.target)) {
              setSearch(function (previous) {
                return Object.assign({}, previous, { open: false })
              })
            }
          }
          document.addEventListener('mousedown', handlePointer)
          return function () {
            document.removeEventListener('mousedown', handlePointer)
          }
        },
        [search.open],
      )

      function commitTabs(next) {
        tabsRef.current = next
        setTabs(next)
      }

      function updateTabs(updater) {
        const next = updater(tabsRef.current)
        commitTabs(next)
        return next
      }

      function selectTab(id) {
        setActiveId(id)
        const target = tabsRef.current.find((item) => item.id === id)
        if (target && !target.doc && !target.loading && !target.error) fetchDoc(id)
      }

      function closeTab(id) {
        const currentTabs = tabsRef.current
        const index = currentTabs.findIndex((item) => item.id === id)
        const next = currentTabs.filter((item) => item.id !== id)
        commitTabs(next)
        if (next.length === 0) writeStorage(LAST_KEY, '')
        if (activeId === id) {
          const fallback = next[Math.max(0, index - 1)] || next[0] || null
          setActiveId(fallback ? fallback.id : null)
          if (fallback && !fallback.doc && !fallback.loading && !fallback.error) fetchDoc(fallback.id)
        }
      }

      function closeAll() {
        commitTabs([])
        setActiveId(null)
        writeStorage(LAST_KEY, '')
        setSearch(function (previous) {
          return Object.assign({}, previous, { open: false })
        })
      }

      function openDoc(raw, meta, options) {
        const id = parseDocId(raw)
        if (id === null) return false
        const keepInput = Boolean(options && options.keepInput)
        if (!keepInput) {
          setInput(String(id))
          writeStorage(LAST_KEY, String(id))
        }
        setActiveId(id)
        const existing = tabsRef.current.find((item) => item.id === id)
        if (existing) {
          if (!existing.doc && !existing.loading) fetchDoc(id)
          return true
        }
        const label = meta && typeof meta === 'object' ? meta : {}
        updateTabs(function (previous) {
          return previous.concat([
            {
              id: id,
              title: String(label.title || ''),
              method: String(label.method || ''),
              path: String(label.path || ''),
              doc: null,
              loading: true,
              error: null,
              base: '',
            },
          ])
        })
        fetchDoc(id)
        return true
      }

      function fetchDoc(id) {
        updateTabs(function (previous) {
          return previous.map(function (item) {
            return item.id === id ? Object.assign({}, item, { loading: true, error: null }) : item
          })
        })
        fetch('/api/yapi/interface', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: id }),
        })
          .then(function (response) {
            return response
              .json()
              .catch(function () {
                return null
              })
              .then(function (payload) {
                if (!payload) {
                  if (response.status === 401) throw new Error('DSH 登录已失效，请刷新页面后重试。')
                  throw new Error('接口返回了非 JSON 响应（HTTP ' + response.status + '）')
                }
                if (!payload.ok) {
                  const failure = new Error((payload.error && payload.error.message) || '获取 YAPI 文档失败')
                  failure.code = (payload.error && payload.error.code) || ''
                  throw failure
                }
                const loaded = payload.data
                updateTabs(function (previous) {
                  return previous.map(function (item) {
                    return item.id === id
                      ? Object.assign({}, item, {
                          doc: loaded,
                          title: loaded.title,
                          method: loaded.method,
                          path: loaded.path,
                          base: loaded.project.envs.length > 0 ? loaded.project.envs[0].domain : '',
                          loading: false,
                          error: null,
                        })
                      : item
                  })
                })
                addRecent(id)
                if (!autoTabbed.current) {
                  autoTabbed.current = true
                  const hasBody = loaded.request.body && loaded.request.body.kind !== 'none'
                  const hasParams =
                    loaded.request.query.length + loaded.request.params.length + loaded.request.form.length > 0
                  setTab(hasBody ? 'request' : hasParams ? 'params' : 'response')
                }
              })
          })
          .catch(function (failure) {
            updateTabs(function (previous) {
              return previous.map(function (item) {
                return item.id === id
                  ? Object.assign({}, item, {
                      loading: false,
                      error: {
                        message: (failure && failure.message) || String(failure),
                        code: (failure && failure.code) || '',
                      },
                    })
                  : item
              })
            })
          })
      }

      function addRecent(id) {
        setRecent(function (previous) {
          const next = [id].concat(previous.filter((item) => item !== id)).slice(0, 6)
          writeStorage(RECENT_KEY, JSON.stringify(next))
          return next
        })
      }

      function showToast(message) {
        setToast(message)
        clearTimeout(toastTimer.current)
        toastTimer.current = window.setTimeout(function () {
          setToast(null)
        }, 1900)
      }

      function changeCopyFormat(next) {
        setCopyFormat(next)
        writeStorage(COPY_FORMAT_KEY, next)
      }

      function updateAccountForm(patch) {
        setAccountForm(function (previous) {
          return Object.assign({}, previous, patch)
        })
      }

      function openAccount() {
        setAccountOpen(true)
        setAccountError('')
        fetch('/api/yapi/settings')
          .then(function (response) {
            return response.json().catch(function () {
              return null
            })
          })
          .then(function (payload) {
            if (!payload || !payload.ok) {
              throw new Error((payload && payload.error && payload.error.message) || '读取账号设置失败')
            }
            setAccount(payload)
            setAccountForm({ baseUrl: payload.baseUrl || '', email: payload.email || '', password: '', authType: payload.authType || 'normal' })
          })
          .catch(function (error) {
            setAccountError((error && error.message) || String(error))
          })
      }

      function saveAccount() {
        if (accountSaving) return
        setAccountSaving(true)
        setAccountError('')
        fetch('/api/yapi/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(accountForm),
        })
          .then(function (response) {
            return response.json().catch(function () {
              return null
            })
          })
          .then(function (payload) {
            if (!payload) throw new Error('宿主返回了非 JSON 响应')
            if (!payload.ok) throw new Error((payload.error && payload.error.message) || '保存失败')
            setAccount(payload)
            setAccountForm({ baseUrl: payload.baseUrl || '', email: payload.email || '', password: '', authType: payload.authType || 'normal' })
            setAccountOpen(false)
            showToast('账号已保存并登录成功')
            if (activeId !== null) fetchDoc(activeId)
          })
          .catch(function (error) {
            setAccountError((error && error.message) || String(error))
          })
          .finally(function () {
            setAccountSaving(false)
          })
      }

      function runSearch(keyword) {
        const text = String(keyword === undefined || keyword === null ? '' : keyword).trim()
        if (text === '') return
        const sequence = ++searchSeq.current
        setSearch(function (previous) {
          return Object.assign({}, previous, {
            open: true,
            keyword: text,
            loading: true,
            error: '',
            items: [],
            projects: [],
            total: 0,
            projectName: '',
          })
        })
        fetch('/api/yapi/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ global: true, keyword: text }),
        })
          .then(function (response) {
            return response.json().catch(function () {
              return null
            })
          })
          .then(function (payload) {
            if (sequence !== searchSeq.current) return
            if (!payload) throw new Error('宿主返回了非 JSON 响应')
            if (!payload.ok) throw new Error((payload.error && payload.error.message) || '搜索失败')
            const data = payload.data || {}
            setSearch(function (previous) {
              return Object.assign({}, previous, {
                loading: false,
                items: Array.isArray(data.items) ? data.items : [],
                projects: Array.isArray(data.projects) ? data.projects : [],
                total: Number(data.total) || 0,
                projectName: data.projectName || '',
              })
            })
          })
          .catch(function (failure) {
            if (sequence !== searchSeq.current) return
            setSearch(function (previous) {
              return Object.assign({}, previous, {
                loading: false,
                error: (failure && failure.message) || String(failure),
                items: [],
                projects: [],
                total: 0,
              })
            })
          })
      }

      function scheduleSearch(keyword) {
        clearTimeout(searchTimer.current)
        searchTimer.current = window.setTimeout(function () {
          runSearch(keyword)
        }, 280)
      }

      function handleSearchInput(value) {
        setInput(value)
        setSearchView('search')
        clearTimeout(searchTimer.current)
        const text = value.trim()
        if (text === '' || looksLikeDocRef(text)) {
          setSearch(function (previous) {
            return Object.assign({}, previous, { open: false, loading: false, error: '' })
          })
          return
        }
        scheduleSearch(text)
      }

      function openSearchProject(project) {
        if (!project || project.pageUrl === '') return
        window.open(project.pageUrl, '_blank', 'noopener,noreferrer')
      }

      function loadCategory(catid, projectId) {
        const sequence = ++categorySeq.current
        setCategory(function (previous) {
          return Object.assign({}, previous, {
            loading: true,
            error: '',
            catid,
            items: [],
            total: 0,
          })
        })
        fetch('/api/yapi/category', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ catid, projectId }),
        })
          .then(function (response) {
            return response.json().catch(function () {
              return null
            })
          })
          .then(function (payload) {
            if (sequence !== categorySeq.current) return
            if (!payload) throw new Error('宿主返回了非 JSON 响应')
            if (!payload.ok) throw new Error((payload.error && payload.error.message) || '读取目录失败')
            const data = payload.data || {}
            setCategory({
              loading: false,
              error: '',
              catid: Number(data.catid) || catid,
              catName: data.catName || '',
              items: Array.isArray(data.items) ? data.items : [],
              total: Number(data.total) || 0,
            })
          })
          .catch(function (failure) {
            if (sequence !== categorySeq.current) return
            setCategory(function (previous) {
              return Object.assign({}, previous, {
                loading: false,
                error: (failure && failure.message) || String(failure),
                items: [],
                total: 0,
              })
            })
          })
      }

      function switchSearchView(next) {
        if (next === 'category') {
          if (!doc || !doc.catid) return
          setSearchView('category')
          setSearch(function (previous) {
            return Object.assign({}, previous, { open: true, loading: false, error: '' })
          })
          return
        }
        setSearchView('search')
        if (input.trim() !== '' && !looksLikeDocRef(input)) {
          runSearch(input)
        } else {
          setSearch(function (previous) {
            return Object.assign({}, previous, { open: false })
          })
        }
      }

      function openCategory() {
        if (!doc || !doc.catid) return
        setSearchView('category')
        setSearch(function (previous) {
          return Object.assign({}, previous, { open: true, loading: false, error: '' })
        })
      }

      function openCategoryItem(item) {
        openDoc(item.id, { title: item.title, method: item.method, path: item.path }, { keepInput: true })
      }

      function openSearchResult(item) {
        openDoc(item.id, { title: item.title, method: item.method, path: item.path }, { keepInput: true })
        setSearch(function (previous) {
          return Object.assign({}, previous, { open: false })
        })
      }

      function submit(event) {
        event.preventDefault()
        const text = input.trim()
        if (text === '') return
        setSearchView('search')
        if (looksLikeDocRef(text)) {
          setSearch(function (previous) {
            return Object.assign({}, previous, { open: false })
          })
          openDoc(text)
          return
        }
        runSearch(text)
      }

      function copySelected() {
        if (!doc) return
        const text = buildCopyText(
          doc,
          copyOptions,
          address,
          copyFormat,
          requestAnnotation,
          responseAnnotation,
          descText,
        )
        if (text.trim() === '') {
          showToast('请至少勾选一项内容')
          return
        }
        copyToClipboard('所选内容', text).then(function (ok) {
          if (ok) setCopyOpen(false)
        })
      }

      function copyToClipboard(label, text) {
        if (!text) {
          showToast('没有可复制的内容')
          return Promise.resolve(false)
        }
        return copyText(text).then(function (ok) {
          if (!ok) {
            showToast('复制失败，请手动选择文本')
            return false
          }
          showToast('已复制' + label)
          return true
        })
      }

      function updateCopyOption(key, value) {
        setCopyOptions(function (previous) {
          const next = Object.assign({}, previous)
          next[key] = value
          writeStorage(COPY_OPTIONS_KEY, JSON.stringify(next))
          return next
        })
      }

      function toggleAllCopyOptions() {
        const all = Object.keys(DEFAULT_COPY_OPTIONS).every(function (key) {
          return copyOptions[key]
        })
        const next = {}
        for (const key of Object.keys(DEFAULT_COPY_OPTIONS)) next[key] = !all
        setCopyOptions(next)
        writeStorage(COPY_OPTIONS_KEY, JSON.stringify(next))
      }

      const address = useMemo(
        function () {
          if (!doc) return ''
          const domain = base || (doc.project.envs.length > 0 ? doc.project.envs[0].domain : '')
          return joinUrl(domain, doc.project.basepath, doc.path)
        },
        [doc, base],
      )

      const requestBody = doc ? doc.request.body : null
      const responseBody = doc ? doc.response.body : null
      const requestAnnotation = useMemo(
        function () {
          return doc ? annotationFor(doc, 'request') : null
        },
        [doc],
      )
      const responseAnnotation = useMemo(
        function () {
          return doc ? annotationFor(doc, 'response') : null
        },
        [doc],
      )
      const copyCount = Object.keys(DEFAULT_COPY_OPTIONS).filter(function (key) {
        return copyOptions[key]
      }).length

      const paramSections = doc
        ? [
            { key: 'headers', title: 'Headers', kind: 'header', rows: doc.request.headers },
            { key: 'query', title: 'Query 参数', kind: 'param', rows: doc.request.query },
            { key: 'params', title: 'Path 参数', kind: 'param', rows: doc.request.params },
            { key: 'form', title: 'Form 参数', kind: 'param', rows: doc.request.form },
          ].filter(function (section) {
            return section.rows.length > 0
          })
        : []

      const descText = doc ? doc.markdown || htmlToText(doc.desc) : ''

      return h(
        'div',
        { className: 'yapi-root' },
        h(
          'div',
          { className: 'yapi-inner' },
          h(
            'header',
            { className: 'yapi-hero' },
            h(
              'div',
              { className: 'yapi-hero-main' },
              h('div', { className: 'yapi-kicker' }, h(YapiIcon, { size: 14 }), 'YAPI · 接口工作台'),
              h('h1', null, 'YAPI 接口文档'),
              h('p', null, '输入文档 ID 或链接，获取接口信息，并一键复制请求地址、方法类型、请求 Body 与返回体。'),
            ),
            h(
              'div',
              { className: 'yapi-hero-side' },
              h(
                'span',
                {
                  className: 'yapi-accountstate',
                  'data-set': account && account.hasPassword ? 'true' : 'false',
                  title: account && account.email ? account.email : '点击「账号设置」填写 YAPI 账号',
                },
                account && account.hasPassword
                  ? (account.user && account.user.email) || account.email || '已配置账号'
                  : '未配置账号',
              ),
              h(
                'button',
                { type: 'button', className: 'yapi-btn ghost sm', onClick: openAccount },
                h(UserIcon, { size: 13 }),
                '账号设置',
              ),
            ),
          ),
          h(
            'div',
            { className: 'yapi-searchwrap', ref: searchWrapRef },
            h(
              'form',
              { className: 'yapi-search', onSubmit: submit },
              h('span', { className: 'yapi-search-ico' }, h(SearchIcon, { size: 17 })),
              h('input', {
                value: input,
                placeholder: '输入文档 ID / 链接直接打开，或输入关键字搜索接口',
                spellCheck: false,
                autoComplete: 'off',
                onChange: function (event) {
                  handleSearchInput(event.target.value)
                },
                onFocus: function () {
                  if (search.keyword !== '' && input.trim() !== '' && !looksLikeDocRef(input)) {
                    setSearch(function (previous) {
                      return Object.assign({}, previous, { open: true })
                    })
                  }
                },
              }),
              h(
                'button',
                {
                  type: 'submit',
                  className: 'yapi-btn',
                  disabled: loading || (!looksLikeDocRef(input) && input.trim() === ''),
                },
                looksLikeDocRef(input) ? (loading ? '打开中…' : '打开文档') : '搜索接口',
              ),
            ),
            (search.open && searchView === 'category') ||
            (search.open &&
              searchView === 'search' &&
              input.trim() !== '' &&
              !looksLikeDocRef(input))
              ? h(
                  'div',
                  { className: 'yapi-searchpanel', role: 'listbox' },
                  h(
                    'div',
                    { className: 'yapi-searchpanel-head' },
                    h(
                      'div',
                      { className: 'yapi-seg yapi-searchview' },
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-active': searchView === 'search' ? 'true' : 'false',
                          onClick: function () {
                            switchSearchView('search')
                          },
                        },
                        '搜索',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-active': searchView === 'category' ? 'true' : 'false',
                          disabled: !doc || !doc.catid,
                          title:
                            doc && doc.catid
                              ? '查看当前接口所在目录的其他接口'
                              : '当前没有可用的接口目录',
                          onClick: function () {
                            switchSearchView('category')
                          },
                        },
                        '同目录',
                      ),
                    ),
                    h(
                      'span',
                      { className: 'yapi-searchpanel-label' },
                      searchView === 'category' ? '同目录' : '接口搜索',
                    ),
                    h(
                      'span',
                      { className: 'yapi-searchpanel-meta' },
                      searchView === 'category'
                        ? (category.catName || '目录 #' + category.catid) +
                          (category.total > 0 ? ' · 共 ' + category.total + ' 个接口' : '')
                        : search.total > 0
                          ? '匹配 ' + search.total
                          : '',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'yapi-searchpanel-refresh',
                        disabled: searchView === 'category' ? category.loading : search.loading,
                        title: '重新加载',
                        onClick: function () {
                          if (searchView === 'category') {
                            if (doc && doc.catid) loadCategory(doc.catid, doc.project.id)
                          } else {
                            runSearch(search.keyword || input)
                          }
                        },
                      },
                      '刷新',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'yapi-searchpanel-close',
                        'aria-label': '关闭搜索',
                        onClick: function () {
                          setSearchView('search')
                          setSearch(function (previous) {
                            return Object.assign({}, previous, { open: false })
                          })
                        },
                      },
                      h(CloseIcon, { size: 14 }),
                    ),
                  ),
                  searchView === 'category'
                    ? h(
                        'div',
                        { className: 'yapi-searchpanel-body' },
                        category.loading
                          ? h(
                              'div',
                              { className: 'yapi-searchpanel-state' },
                              h('span', { className: 'yapi-spinner' }),
                              '正在读取同目录接口…',
                            )
                          : category.error !== ''
                            ? h('div', { className: 'yapi-searchpanel-error' }, category.error)
                            : category.items.length === 0
                              ? h('div', { className: 'yapi-searchpanel-state' }, '该目录没有接口')
                              : category.items.map(function (item) {
                                  return h(
                                    'button',
                                    {
                                      key: item.id,
                                      type: 'button',
                                      className: 'yapi-searchitem',
                                      'data-current': item.id === activeId ? 'true' : 'false',
                                      onClick: function () {
                                        openCategoryItem(item)
                                      },
                                    },
                                    h(
                                      'span',
                                      { className: 'yapi-searchitem-method', 'data-method': item.method },
                                      item.method,
                                    ),
                                    h(
                                      'span',
                                      { className: 'yapi-searchitem-main' },
                                      h('code', null, item.path || '/'),
                                      h(
                                        'span',
                                        { className: 'yapi-searchitem-title' },
                                        item.title || '未命名接口',
                                      ),
                                      item.id === activeId
                                        ? h(
                                            'span',
                                            { className: 'yapi-searchitem-project' },
                                            '当前接口',
                                          )
                                        : null,
                                    ),
                                    h('span', { className: 'yapi-searchitem-id' }, '#' + item.id),
                                  )
                                }),
                      )
                    : h(
                        'div',
                        { className: 'yapi-searchpanel-body' },
                        search.projects.length > 0
                          ? h(
                              'div',
                              { className: 'yapi-searchprojects' },
                              h('div', { className: 'yapi-searchprojects-title' }, '项目'),
                              search.projects.map(function (project) {
                                return h(
                                  'button',
                                  {
                                    key: project.id,
                                    type: 'button',
                                    className: 'yapi-searchproject',
                                    onClick: function () {
                                      openSearchProject(project)
                                    },
                                  },
                                  h(
                                    'span',
                                    { className: 'yapi-searchproject-name' },
                                    project.name || '未命名项目',
                                  ),
                                  h('span', { className: 'yapi-searchproject-id' }, '#' + project.id),
                                )
                              }),
                            )
                          : null,
                        search.loading
                          ? h(
                              'div',
                              { className: 'yapi-searchpanel-state' },
                              h('span', { className: 'yapi-spinner' }),
                              '正在搜索接口…',
                            )
                          : search.error !== ''
                            ? h('div', { className: 'yapi-searchpanel-error' }, search.error)
                            : search.items.length === 0
                              ? h(
                                  'div',
                                  { className: 'yapi-searchpanel-state' },
                                  search.keyword === ''
                                    ? '输入关键字搜索接口路径或标题'
                                    : '没有匹配的接口',
                                )
                              : search.items.map(function (item) {
                                  return h(
                                    'button',
                                    {
                                      key: item.id,
                                      type: 'button',
                                      className: 'yapi-searchitem',
                                      onClick: function () {
                                        openSearchResult(item)
                                      },
                                    },
                                    h(
                                      'span',
                                      { className: 'yapi-searchitem-method', 'data-method': item.method },
                                      item.method,
                                    ),
                                    h(
                                      'span',
                                      { className: 'yapi-searchitem-main' },
                                      h('code', null, item.path || '/'),
                                      h(
                                        'span',
                                        { className: 'yapi-searchitem-title' },
                                        item.title || '未命名接口',
                                      ),
                                      item.projectId || item.projectName
                                        ? h(
                                            'span',
                                            { className: 'yapi-searchitem-project' },
                                            (item.projectName || '项目') +
                                              (item.projectId ? ' #' + item.projectId : ''),
                                          )
                                        : null,
                                    ),
                                    h('span', { className: 'yapi-searchitem-id' }, '#' + item.id),
                                  )
                                }),
                      ),
                )
              : null,
          ),
          h(
            'div',
            { className: 'yapi-hint' },
            '输入文档 ID 或完整链接直接打开；输入路径 / 标题关键字搜索项目接口，点击结果会新建标签页。',
          ),
          recent.length > 0
            ? h(
                'div',
                { className: 'yapi-recent' },
                h('span', null, '最近'),
                recent.map(function (id) {
                  return h(
                    'button',
                    {
                      key: id,
                      type: 'button',
                      className: 'yapi-chip',
                      onClick: function () {
                        openDoc(id)
                      },
                    },
                    '#' + id,
                  )
                }),
              )
            : null,
          tabs.length > 0
            ? h(
                'div',
                { className: 'yapi-tabbar' },
                h(
                  'div',
                  { className: 'yapi-tabbar-list' },
                  tabs.map(function (item) {
                    const active = item.id === activeId
                    return h(
                      'div',
                      {
                        key: item.id,
                        className: 'yapi-doctab',
                        'data-active': active ? 'true' : 'false',
                        role: 'button',
                        tabIndex: 0,
                        title: item.title || '#' + item.id,
                        onClick: function () {
                          selectTab(item.id)
                        },
                        onKeyDown: function (event) {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            selectTab(item.id)
                          }
                        },
                      },
                      item.method
                        ? h(
                            'span',
                            { className: 'yapi-doctab-method', 'data-method': item.method },
                            item.method,
                          )
                        : null,
                      h('span', { className: 'yapi-doctab-title' }, item.title || '#' + item.id),
                      item.loading ? h('span', { className: 'yapi-doctab-spin' }) : null,
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'yapi-doctab-close',
                          'aria-label': '关闭标签页',
                          onClick: function (event) {
                            event.stopPropagation()
                            closeTab(item.id)
                          },
                        },
                        h(CloseIcon, { size: 12 }),
                      ),
                    )
                  }),
                ),
                tabs.length > 1
                  ? h(
                      'button',
                      { type: 'button', className: 'yapi-doctab-clear', onClick: closeAll },
                      '全部关闭',
                    )
                  : null,
              )
            : null,
          error
            ? h(
                'div',
                { className: 'yapi-error', role: 'alert' },
                h('div', { className: 'yapi-error-title' }, '获取失败'),
                h('div', { className: 'yapi-error-msg' }, error.message),
                h(
                  'div',
                  { className: 'yapi-error-hint' },
                  '请检查文档 ID 与账号权限；若提示未配置账号，点下方按钮直接填写。',
                ),
                h(
                  'div',
                  { className: 'yapi-error-action' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'yapi-btn ghost sm',
                      onClick: function () {
                        if (activeId !== null) fetchDoc(activeId)
                      },
                    },
                    '重试',
                  ),
                  error.code === 'NO_CONFIG' ||
                  error.code === 'NO_CREDENTIALS' ||
                  error.code === 'LOGIN_FAILED' ||
                  error.code === 'SESSION_LOST' ||
                  error.code === 'SAVE_FAILED'
                    ? h(
                        'button',
                        { type: 'button', className: 'yapi-btn sm', onClick: openAccount },
                        '配置账号',
                      )
                    : null,
                ),
              )
            : null,
          loading && !doc
            ? h('div', { className: 'yapi-loading' }, h('span', { className: 'yapi-spinner' }), '正在读取 YAPI 文档…')
            : null,
          doc
            ? h(
                'section',
                { className: 'yapi-doc' },
                h(
                  'div',
                  { className: 'yapi-doc-head' },
                  h(
                    'div',
                    { className: 'yapi-titlebar' },
                    h('span', { className: 'yapi-method', 'data-method': doc.method }, doc.method),
                    h('h2', null, doc.title || '未命名接口'),
                    h('span', { className: 'yapi-docid', title: '接口 ID' }, '#' + doc.id),
                    doc.status
                      ? h(
                          'span',
                          { className: 'yapi-status', 'data-status': doc.status },
                          STATUS_LABEL[doc.status] || doc.status,
                        )
                      : null,
                    h(
                      'div',
                      { className: 'yapi-titlebar-actions' },
                      doc.catid
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'yapi-btn ghost sm',
                              title: '查看当前接口所在目录的其他接口',
                              onClick: openCategory,
                            },
                            '同目录',
                          )
                        : null,
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'yapi-btn sm',
                          onClick: function () {
                            setCopyOpen(true)
                          },
                        },
                        h(CopyIcon, { size: 13 }),
                        '复制',
                      ),
                      h(
                        'a',
                        {
                          className: 'yapi-openlink',
                          href: doc.pageUrl,
                          target: '_blank',
                          rel: 'noreferrer noopener',
                        },
                        '在 YAPI 打开',
                        h(ExternalIcon, { size: 12 }),
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'yapi-meta' },
                    h(
                      'span',
                      null,
                      (doc.project.name || '未命名项目') +
                        (doc.project.id ? '（' + doc.project.id + '）' : ''),
                    ),
                    h('span', { className: 'yapi-dot' }, '·'),
                    h('span', null, doc.tags.length > 0 ? doc.tags.join(' / ') : '未分组'),
                    doc.author
                      ? h('span', { className: 'yapi-dot' }, '·')
                      : null,
                    doc.author ? h('span', null, doc.author) : null,
                    doc.updatedAt
                      ? h('span', { className: 'yapi-dot' }, '·')
                      : null,
                    doc.updatedAt ? h('span', null, '更新于 ' + formatTime(doc.updatedAt)) : null,
                  ),
                ),
                h(
                  'div',
                  { className: 'yapi-addrs' },
                  h(
                    'div',
                    { className: 'yapi-field' },
                    h('label', null, '服务地址'),
                    h('input', {
                      value: base,
                      placeholder: doc.project.envs.length > 0 ? doc.project.envs[0].domain : 'https://api.example.com',
                      spellCheck: false,
                      onChange: function (event) {
                        setBase(event.target.value)
                      },
                    }),
                  ),
                  h(
                    'div',
                    { className: 'yapi-field' },
                    h('label', null, '接口路径'),
                    h('div', { className: 'yapi-pathstatic' }, h('code', null, doc.path || '/')),
                  ),
                ),
                h(
                  'div',
                  { className: 'yapi-addrpreview' },
                  '完整请求地址：',
                  h('code', null, address || '—'),
                ),
                h(
                  'div',
                  { className: 'yapi-tabs' },
                  [
                    { id: 'params', label: '请求参数' },
                    { id: 'request', label: '请求字段' },
                    { id: 'response', label: '返回字段' },
                    { id: 'desc', label: '说明' },
                  ].map(function (item) {
                    return h(
                      'button',
                      {
                        key: item.id,
                        type: 'button',
                        className: 'yapi-tab',
                        'data-tab': item.id,
                        'data-active': tab === item.id ? 'true' : 'false',
                        onClick: function () {
                          setTab(item.id)
                        },
                      },
                      item.label,
                    )
                  }),
                ),
                h(
                  'div',
                  { className: 'yapi-tabbody' },
                  tab === 'params'
                    ? paramSections.length > 0
                      ? paramSections.map(function (section) {
                          return h(ParamSection, {
                            key: section.key,
                            title: section.title,
                            kind: section.kind,
                            rows: section.rows,
                          })
                        })
                      : h('div', { className: 'yapi-empty' }, '该接口没有 Query、Path、Header 或 Form 参数')
                    : null,
                  tab === 'request'
                    ? requestBody.kind === 'none'
                      ? h('div', { className: 'yapi-empty' }, '该接口没有请求 Body')
                      : h(FieldPanel, {
                          title: '请求字段',
                          tree: requestAnnotation.tree,
                        })
                    : null,
                  tab === 'response'
                    ? responseBody.kind === 'none'
                      ? h('div', { className: 'yapi-empty' }, '该接口没有返回体')
                      : h(FieldPanel, {
                          title: '返回字段',
                          tree: responseAnnotation.tree,
                        })
                    : null,
                  tab === 'desc'
                    ? descText === ''
                      ? h('div', { className: 'yapi-empty' }, '该接口没有说明')
                      : h('div', { className: 'yapi-desc' }, descText)
                    : null,
                ),
              )
            : null,
          copyOpen && doc
            ? h(
                'div',
                {
                  className: 'yapi-mask',
                  role: 'presentation',
                  onClick: function () {
                    setCopyOpen(false)
                  },
                },
                h(
                  'div',
                  {
                    className: 'yapi-modal yapi-copymodal',
                    role: 'dialog',
                    'aria-modal': 'true',
                    'aria-label': '复制接口内容',
                    onClick: function (event) {
                      event.stopPropagation()
                    },
                  },
                  h(
                    'div',
                    { className: 'yapi-modal-head' },
                    h('h3', null, '复制接口内容'),
                    h('span', { className: 'yapi-copycount' }, '已选 ' + copyCount + ' 项'),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'yapi-copytoggleall',
                        onClick: toggleAllCopyOptions,
                      },
                      copyCount === COPY_OPTIONS.length ? '清空' : '全选',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'yapi-modal-close',
                        'aria-label': '关闭',
                        onClick: function () {
                          setCopyOpen(false)
                        },
                      },
                      h(CloseIcon, { size: 16 }),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'yapi-modal-body' },
                    h(
                      'div',
                      { className: 'yapi-checkgrid' },
                      COPY_OPTIONS.map(function (option) {
                        const checked = copyOptions[option.key] === true
                        return h(
                          'label',
                          {
                            key: option.key,
                            className: 'yapi-check',
                            'data-checked': checked ? 'true' : 'false',
                          },
                          h('input', {
                            type: 'checkbox',
                            checked: checked,
                            onChange: function (event) {
                              updateCopyOption(option.key, event.target.checked)
                            },
                          }),
                          h('span', null, option.label),
                        )
                      }),
                    ),
                    h(
                      'div',
                      { className: 'yapi-copyformatrow' },
                      h('span', null, 'Body 格式'),
                      h(
                        'div',
                        { className: 'yapi-seg' },
                        h(
                          'button',
                          {
                            type: 'button',
                            'data-active': copyFormat === 'json' ? 'true' : 'false',
                            onClick: function () {
                              changeCopyFormat('json')
                            },
                          },
                          '纯 JSON',
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            'data-active': copyFormat === 'annotated' ? 'true' : 'false',
                            onClick: function () {
                              changeCopyFormat('annotated')
                            },
                          },
                          '带备注',
                        ),
                      ),
                      h('span', { className: 'yapi-copyformat-hint' }, '只影响请求 / 返回 Body'),
                    ),
                    h(
                      'div',
                      { className: 'yapi-copyhint' },
                      '复制出的是一段可直接粘贴的文本：按勾选项组合标题、地址、请求头、参数、Body、返回体和说明。',
                    ),
                  ),
                  h(
                    'div',
                    { className: 'yapi-modal-foot' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'yapi-btn ghost',
                        onClick: function () {
                          setCopyOpen(false)
                        },
                      },
                      '取消',
                    ),
                    h('button', { type: 'button', className: 'yapi-btn', onClick: copySelected }, '复制'),
                  ),
                ),
              )
            : null,
          accountOpen
            ? h(
                'div',
                {
                  className: 'yapi-mask',
                  role: 'presentation',
                  onClick: function () {
                    setAccountOpen(false)
                  },
                },
                h(
                  'div',
                  {
                    className: 'yapi-modal',
                    role: 'dialog',
                    'aria-modal': 'true',
                    'aria-label': 'YAPI 账号设置',
                    onClick: function (event) {
                      event.stopPropagation()
                    },
                  },
                  h(
                    'div',
                    { className: 'yapi-modal-head' },
                    h('h3', null, 'YAPI 账号设置'),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'yapi-modal-close',
                        'aria-label': '关闭',
                        onClick: function () {
                          setAccountOpen(false)
                        },
                      },
                      h(CloseIcon, { size: 16 }),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'yapi-modal-body' },
                    h(
                      'div',
                      { className: 'yapi-modal-state' },
                      account && account.loggedIn
                        ? '当前已登录：' +
                            ((account.user && (account.user.email || account.user.username)) || account.email || '')
                        : account && account.hasPassword
                          ? '账号已保存，尚未登录'
                          : '尚未配置 YAPI 账号',
                    ),
                    h(
                      'div',
                      { className: 'yapi-formrow' },
                      h('label', null, 'YAPI 地址'),
                      h('input', {
                        value: accountForm.baseUrl,
                        placeholder: 'https://your-yapi.example.com',
                        spellCheck: false,
                        onChange: function (event) {
                          updateAccountForm({ baseUrl: event.target.value })
                        },
                      }),
                    ),
                    h(
                      'div',
                      { className: 'yapi-formrow' },
                      h('label', null, '登录方式'),
                      h(
                        'select',
                        {
                          value: accountForm.authType || 'normal',
                          onChange: function (event) {
                            updateAccountForm({ authType: event.target.value })
                          },
                        },
                        h('option', { value: 'normal' }, '普通登录'),
                        h('option', { value: 'ldap' }, 'LDAP'),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'yapi-formrow' },
                      h('label', null, '账号（邮箱）'),
                      h('input', {
                        value: accountForm.email,
                        placeholder: 'you@example.com',
                        spellCheck: false,
                        autoComplete: 'username',
                        onChange: function (event) {
                          updateAccountForm({ email: event.target.value })
                        },
                      }),
                    ),
                    h(
                      'div',
                      { className: 'yapi-formrow' },
                      h('label', null, '密码'),
                      h('input', {
                        type: 'password',
                        value: accountForm.password,
                        placeholder: account && account.hasPassword ? '已保存，留空表示不修改' : '输入 YAPI 密码',
                        autoComplete: 'current-password',
                        onChange: function (event) {
                          updateAccountForm({ password: event.target.value })
                        },
                      }),
                    ),
                    h(
                      'div',
                      { className: 'yapi-formhint' },
                      '普通登录使用 YAPI 账号密码；LDAP 使用 LDAP 账号密码（需 YAPI 服务端开启 LDAP）。点击「测试并保存」后，插件会先用这组账号真实登录 YAPI；成功后才写入 ' +
                        ((account && account.configFile) || '~/.dsh/dsh-plugin-yapi.json') +
                        '（权限 0600）。密码只保存在 Host 端，不会回传页面。',
                    ),
                    accountError ? h('div', { className: 'yapi-modal-error' }, accountError) : null,
                  ),
                  h(
                    'div',
                    { className: 'yapi-modal-foot' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'yapi-btn ghost',
                        onClick: function () {
                          setAccountOpen(false)
                        },
                      },
                      '取消',
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'yapi-btn', disabled: accountSaving, onClick: saveAccount },
                      accountSaving ? '验证中…' : '测试并保存',
                    ),
                  ),
                ),
              )
            : null,
          toast ? h('div', { className: 'yapi-toast', role: 'status' }, toast) : null,
        ),
      )
    }

    if (typeof globalThis !== 'undefined') {
      globalThis.__YAPI_PANEL_TEST__ = {
        parseDocId: parseDocId,
        joinUrl: joinUrl,
        annotateSchemaValue: annotateSchemaValue,
        annotateFormValue: annotateFormValue,
        annotationFor: annotationFor,
        buildTreeFromSchema: buildTreeFromSchema,
        fieldTreeFor: fieldTreeFor,
        buildCopyText: buildCopyText,
        filterTree: filterTree,
        countMatches: countMatches,
        YapiPanel: YapiPanel,
        YapiIcon: YapiIcon,
      }
    }

    return {
      name: PANEL_ID,
      inject: ['slots'],
      apply(ctx) {
        ensureStyle()
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: PANEL_LABEL },
            YapiIcon,
          )
        })
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_ID }, YapiPanel)
        })
      },
    }
  },
})
