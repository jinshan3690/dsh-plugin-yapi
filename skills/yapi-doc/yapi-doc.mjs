#!/usr/bin/env node
/**
 * yapi-doc — read YAPI interface documentation from the terminal.
 *
 * Standalone on purpose: no plugin imports, no npm dependencies. Copy this one
 * file anywhere and run it with Node 20+. It reads the YAPI account from
 * `$DSH_HOME/dsh-plugin-yapi.json` (the panel's 账号设置 writes it) or from
 * YAPI_BASE_URL / YAPI_EMAIL / YAPI_PASSWORD.
 *
 * Usage:
 *   yapi-doc 10001
 *   yapi-doc https://your-yapi.example.com/project/1/interface/api/10001
 *   yapi-doc --search warehouse --project 1
 *   yapi-doc 10001 --full          # include the response body example
 *   yapi-doc 10001 --json          # structured output
 *   yapi-doc 10001 --no-fields     # skip field documentation
 *   yapi-doc install-skill         # install SKILL.md + CLI into ~/.agents/skills/yapi-doc
 *   yapi-doc sync-skills           # install into every detected tool skill root
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CONFIG_FILE = join(DSH_HOME, 'dsh-plugin-yapi.json')

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function normalizeBaseUrl(value) {
  return String(value === undefined || value === null ? '' : value).trim().replace(/\/+$/u, '')
}

function joinUrl() {
  let out = ''
  for (let index = 0; index < arguments.length; index += 1) {
    const text = String(arguments[index] === undefined || arguments[index] === null ? '' : arguments[index]).trim()
    if (text === '') continue
    if (out === '') out = text.replace(/\/+$/u, '')
    else out += '/' + text.replace(/^\/+/u, '').replace(/\/+$/u, '')
  }
  return out
}

function parseDocId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (text === '') return null
  if (/^\d{1,12}$/u.test(text)) return Number(text) > 0 ? Number(text) : null
  const patterns = [/\/interface\/api\/(\d{1,12})(?:[/?#]|$)/u, /[?&]id=(\d{1,12})(?:[&#]|$)/u]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match && Number(match[1]) > 0) return Number(match[1])
  }
  const trailing = /(\d{1,12})\/?(?:[?#].*)?$/u.exec(text)
  return trailing && Number(trailing[1]) > 0 ? Number(trailing[1]) : null
}

function stripHtml(html) {
  return String(html === undefined || html === null ? '' : html)
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function parseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
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
  return current && typeof current === 'object' ? current : {}
}

function schemaComment(node) {
  const description = unwrapComposite(node).description
  return String(description === undefined || description === null ? '' : description)
    .replace(/\s+/g, ' ')
    .trim()
}

function typeLabel(node) {
  const schema = unwrapComposite(node)
  let type = schema.type
  if (Array.isArray(type)) type = type.filter((item) => item !== 'null').join(' | ') || 'null'
  if (type === 'array') {
    const items = Array.isArray(schema.items) ? schema.items[0] : schema.items
    const inner = items ? typeLabel(items) : ''
    return inner ? 'array<' + inner + '>' : 'array'
  }
  if (!type && schema.properties) return 'object'
  return type || ''
}

function exampleFromSchema(input, depth = 0) {
  if (depth > 40) return null
  if (!input || typeof input !== 'object') return null
  const schema = unwrapComposite(input)
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  let type = schema.type
  if (Array.isArray(type)) type = type.find((item) => item !== 'null') || 'null'
  if (schema.enum && schema.enum.length > 0) return schema.enum[0]
  if (type === 'object' || schema.properties) {
    const out = {}
    for (const [key, child] of Object.entries(schema.properties || {})) out[key] = exampleFromSchema(child, depth + 1)
    return out
  }
  if (type === 'array') {
    const items = Array.isArray(schema.items) ? schema.items[0] : schema.items
    return items ? [exampleFromSchema(items, depth + 1)] : []
  }
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return false
  if (type === 'string') {
    if (schema.format === 'date-time') return '2024-01-01T00:00:00Z'
    if (schema.format === 'date') return '2024-01-01'
    return ''
  }
  return null
}

function isSubsequence(needle, haystack) {
  let index = 0
  for (let cursor = 0; cursor < haystack.length && index < needle.length; cursor += 1) {
    if (haystack[cursor] === needle[index]) index += 1
  }
  return index === needle.length
}

function rankInterfaces(list, keyword, limit = 30) {
  const query = String(keyword === undefined || keyword === null ? '' : keyword).trim().toLowerCase()
  if (query === '') return []
  const tokens = query.split(/\s+/u).filter(Boolean)
  const ranked = []
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue
    const id = String(item._id ?? '')
    const path = String(item.path ?? '')
    const title = String(item.title ?? '')
    const lowerPath = path.toLowerCase()
    const lowerTitle = title.toLowerCase()
    let score = 0
    if (id === query) score = 1200
    else if (lowerPath === query) score = 1100
    else if (lowerPath.startsWith(query)) score = 1000
    else {
      const pathAt = lowerPath.indexOf(query)
      if (pathAt !== -1) score = 900 - Math.min(pathAt, 80)
      else {
        const titleAt = lowerTitle.indexOf(query)
        if (titleAt !== -1) score = 700 - Math.min(titleAt, 80)
        else if (tokens.length > 1 && tokens.every((token) => `${lowerPath} ${lowerTitle}`.includes(token))) score = 500
        else if (query.length >= 2 && isSubsequence(query, lowerPath)) score = 400
        else if (query.length >= 2 && isSubsequence(query, lowerTitle)) score = 300
      }
    }
    if (score > 0) ranked.push({ item, score, path: lowerPath })
  }
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      left.path.length - right.path.length ||
      left.path.localeCompare(right.path) ||
      String(left.item._id).localeCompare(String(right.item._id)),
  )
  return ranked.slice(0, limit).map((entry) => entry.item)
}

function normalizeParam(item) {
  const entry = item && typeof item === 'object' ? item : {}
  return {
    name: String(entry.name ?? '').trim(),
    type: String(entry.type ?? '').trim(),
    value: entry.value === undefined || entry.value === null ? '' : String(entry.value),
    example: entry.example === undefined || entry.example === null ? '' : String(entry.example),
    required: entry.required === '1' || entry.required === true,
    desc: stripHtml(entry.desc ?? ''),
  }
}

function formValue(field) {
  const type = String(field.type ?? '').toLowerCase()
  if (field.example !== undefined && field.example !== null && field.example !== '') {
    if (type === 'integer' || type === 'number') {
      const parsed = Number(field.example)
      return Number.isFinite(parsed) ? parsed : field.example
    }
    if (type === 'boolean') return field.example === true || field.example === 'true' || field.example === '1'
    return field.example
  }
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return false
  return ''
}

function bodyView(rawText, type, isSchema, formRows) {
  const text = typeof rawText === 'string' ? rawText : ''
  if (type === 'form' || (!isSchema && Array.isArray(formRows) && formRows.length > 0 && text.trim() === '')) {
    const object = {}
    for (const row of formRows || []) object[row.name] = formValue(row)
    const keys = Object.keys(object)
    return { kind: keys.length > 0 ? 'json' : 'none', example: JSON.stringify(object, null, 2), raw: text }
  }
  if (text.trim() === '') return { kind: 'none', example: '', raw: '' }
  if (isSchema) {
    const schema = parseJson(text)
    if (schema !== undefined) return { kind: 'json', example: JSON.stringify(exampleFromSchema(schema), null, 2), raw: text }
  }
  const parsed = parseJson(text)
  return parsed !== undefined
    ? { kind: 'json', example: JSON.stringify(parsed, null, 2), raw: text }
    : { kind: 'text', example: text, raw: text }
}

function buildDoc(raw, project, baseUrl) {
  const projectId = Number(raw.project_id)
  const path = String(raw.path ?? '')
  const envs = Array.isArray(project?.env) ? project.env.filter((env) => env && env.domain) : []
  const basepath = typeof project?.basepath === 'string' ? project.basepath : ''
  return {
    id: Number(raw._id),
    title: String(raw.title ?? ''),
    method: String(raw.method ?? 'GET').toUpperCase(),
    path,
    status: String(raw.status ?? ''),
    tags: Array.isArray(raw.tag) ? raw.tag.map(String) : [],
    desc: stripHtml(raw.desc ?? ''),
    author: String(raw.username ?? ''),
    updatedAt: Number(raw.up_time) > 0 ? Number(raw.up_time) * 1000 : null,
    pageUrl: joinUrl(baseUrl, '/project', String(projectId), '/interface/api', String(raw._id)),
    projectId,
    projectName: String(project?.name ?? ''),
    basepath,
    address: envs.length > 0 ? joinUrl(envs[0].domain, basepath, path) : joinUrl(basepath, path),
    headers: (Array.isArray(raw.req_headers) ? raw.req_headers : []).map(normalizeParam),
    query: (Array.isArray(raw.req_query) ? raw.req_query : []).map(normalizeParam),
    params: (Array.isArray(raw.req_params) ? raw.req_params : []).map(normalizeParam),
    form: (Array.isArray(raw.req_body_form) ? raw.req_body_form : []).map(normalizeParam),
    requestBody: bodyView(raw.req_body_other, String(raw.req_body_type ?? ''), raw.req_body_is_json_schema === true, raw.req_body_form),
    responseBody: bodyView(raw.res_body, String(raw.res_body_type ?? ''), raw.res_body_is_json_schema === true, []),
  }
}

function collectFields(schema, path, out) {
  const node = unwrapComposite(schema)
  const required = Array.isArray(node.required) ? node.required : []
  const properties = node.properties && typeof node.properties === 'object' ? node.properties : {}
  for (const [key, child] of Object.entries(properties)) {
    const childPath = path ? path + '.' + key : key
    out.push({
      path: childPath,
      type: typeLabel(child),
      required: required.includes(key),
      description: schemaComment(child),
    })
    const childNode = unwrapComposite(child)
    if (childNode.properties) collectFields(childNode, childPath, out)
    else if (childNode.type === 'array') {
      const items = Array.isArray(childNode.items) ? childNode.items[0] : childNode.items
      const itemNode = unwrapComposite(items)
      if (itemNode.properties) collectFields(itemNode, childPath + '[]', out)
    }
  }
  return out
}

function requestFields(raw) {
  if (raw.req_body_is_json_schema === true) {
    const schema = parseJson(raw.req_body_other)
    return schema === undefined ? [] : collectFields(schema, '', [])
  }
  return (Array.isArray(raw.req_body_form) ? raw.req_body_form : []).map((row) => ({
    path: String(row.name ?? ''),
    type: String(row.type ?? ''),
    required: row.required === '1' || row.required === true,
    description: stripHtml(row.desc ?? ''),
  }))
}

function responseFields(raw) {
  if (raw.res_body_is_json_schema !== true) return []
  const schema = parseJson(raw.res_body)
  return schema === undefined ? [] : collectFields(schema, '', [])
}

/* ------------------------------------------------------------------ */
/* skill installer                                                     */
/* ------------------------------------------------------------------ */

/**
 * Copy this CLI and its SKILL.md into a skill root. Used outside DSH, where
 * `dsh plugin add` is not available. The copied SKILL.md is rewritten so every
 * command points at the new location.
 * @param {string} dirArg - optional target directory; defaults to ~/.agents/skills/yapi-doc.
 */
function copySkillTo(target) {
  const sourceDir = dirname(fileURLToPath(import.meta.url))
  const sourceSkill = join(sourceDir, 'SKILL.md')
  const sourceCli = join(sourceDir, 'yapi-doc.mjs')
  if (!existsSync(sourceSkill) || !existsSync(sourceCli)) {
    throw new Error('找不到 skill 文件；请从完整安装包运行，或用 --dir 指定目标目录。')
  }
  const directory = resolve(target)
  mkdirSync(directory, { recursive: true })
  const targetCli = join(directory, 'yapi-doc.mjs')
  if (resolve(targetCli) !== resolve(sourceCli)) copyFileSync(sourceCli, targetCli)
  chmodSync(targetCli, 0o755)
  const windowsTarget = directory.replace(/\//gu, '\\')
  const content = readFileSync(sourceSkill, 'utf8')
    .split('$HOME/.dsh/skills/yapi-doc')
    .join(directory)
    .split('%USERPROFILE%\\.dsh\\skills\\yapi-doc')
    .join(windowsTarget)
  const targetSkill = join(directory, 'SKILL.md')
  if (resolve(targetSkill) !== resolve(sourceSkill)) writeFileSync(targetSkill, content, 'utf8')
  return directory
}

function installSkill(dirArg) {
  const target = copySkillTo(dirArg || join(homedir(), '.agents', 'skills', 'yapi-doc'))
  console.log('Skill installed: ' + target)
  console.log('Run: node "' + join(target, 'yapi-doc.mjs') + '" <doc-id>')
}

function copySyncSkillTo(root) {
  const sourceDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'yapi-sync')
  const source = join(sourceDir, 'SKILL.md')
  if (!existsSync(source)) return undefined
  const directory = join(root, 'yapi-sync')
  mkdirSync(directory, { recursive: true })
  copyFileSync(source, join(directory, 'SKILL.md'))
  return directory
}

const HOME_AGENTS = [
  ['Trae', '.trae', '.trae/skills'],
  ['WorkBuddy', '.workbuddy', '.workbuddy/skills'],
  ['Qoder CN', '.qoder-cn', '.qoder-cn/skills'],
  ['Qoder', '.qoder', '.qoder/skills'],
  ['GitHub Copilot', '.copilot', '.copilot/skills'],
  ['CodeBuddy', '.codebuddy', '.codebuddy/skills'],
  ['Claude Code', '.claude', '.claude/skills'],
  ['Cursor', '.cursor', '.cursor/skills'],
  ['Gemini CLI', '.gemini', '.gemini/skills'],
  ['Droid', '.factory', '.factory/skills'],
  ['fx', '.fx', '.fx/skills'],
  ['Kilo Code', '.kilo', '.kilo/skills'],
  ['Augment', '.augment', '.augment/skills'],
  ['Continue', '.continue', '.continue/skills'],
  ['AiderDesk', '.aider-desk', '.aider-desk/skills'],
  ['Goose', '.goose', '.goose/skills'],
  ['Kiro', '.kiro', '.kiro/skills'],
  ['Qwen Code', '.qwen', '.qwen/skills'],
  ['CodeArts', '.codeartsdoer', '.codeartsdoer/skills'],
  ['Codemaker', '.codemaker', '.codemaker/skills'],
  ['Code Studio', '.codestudio', '.codestudio/skills'],
  ['Command Code', '.commandcode', '.commandcode/skills'],
  ['Firebender', '.firebender', '.firebender/skills'],
  ['ForgeCode', '.forge', '.forge/skills'],
  ['Amp', '.config/amp', '.config/agents/skills'],
  ['OpenCode', '.config/opencode', '.config/opencode/skills'],
  ['Devin', '.config/devin', '.config/devin/skills'],
  ['Crush', '.config/crush', '.config/crush/skills'],
  ['Cortex', '.snowflake/cortex', '.snowflake/cortex/skills'],
]

function detectedSkillTargets(extraDirs) {
  const home = homedir()
  const targets = []
  const add = function (label, dir) {
    const resolved = resolve(dir)
    if (!targets.some(function (item) { return item.dir === resolved })) {
      targets.push({ label, dir: resolved })
    }
  }
  for (const [label, detect, skills] of HOME_AGENTS) {
    if (existsSync(join(home, detect))) add(label, join(home, skills))
  }
  add('Agent Skills（Codex / Cline / Zed / 通用）', join(home, '.agents', 'skills'))
  if (existsSync(DSH_HOME)) add('DSH', join(DSH_HOME, 'skills'))
  for (const dir of extraDirs) add('custom', dir)
  return targets
}

function syncSkills(extraDirs, dryRun) {
  const targets = detectedSkillTargets(extraDirs)
  console.log('yapi-doc / yapi-sync skill 同步：')
  for (const item of targets) {
    if (dryRun) {
      console.log('  - ' + item.label + '  ' + item.dir)
      continue
    }
    copySkillTo(join(item.dir, 'yapi-doc'))
    copySyncSkillTo(item.dir)
    console.log('  ✓ ' + item.label + '  ' + item.dir)
  }
  if (!dryRun) {
    console.log('')
    console.log('重启对应应用后生效。')
  }
}

/* ------------------------------------------------------------------ */
/* YAPI session                                                        */
/* ------------------------------------------------------------------ */

function readSettings() {
  let stored = {}
  try {
    stored = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    stored = {}
  }
  const env = process.env
  const timeout = Number(stored.timeoutMs)
  return {
    baseUrl: normalizeBaseUrl(env.YAPI_BASE_URL || stored.baseUrl),
    email: String(env.YAPI_EMAIL || stored.email || '').trim(),
    password: String(env.YAPI_PASSWORD || stored.password || ''),
    authType: String(env.YAPI_AUTH_TYPE || stored.authType || 'normal').trim().toLowerCase() === 'ldap' ? 'ldap' : 'normal',
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 120000) : 20000,
  }
}

async function createSession(settings) {
  if (settings.baseUrl === '') {
    throw new Error(
      '未配置 YAPI 地址。打开 YAPI 面板 → 账号设置填写，或设置 YAPI_BASE_URL。',
    )
  }
  if (settings.email === '' || settings.password === '') {
    throw new Error(
      '未配置 YAPI 账号。打开 YAPI 面板 → 账号设置填写，或编辑 ' +
        CONFIG_FILE +
        '，也可设置 YAPI_EMAIL / YAPI_PASSWORD 环境变量。',
    )
  }
  let cookie = ''
  async function login() {
    let response
    try {
      const loginPath = settings.authType === 'ldap' ? '/api/user/login_by_ldap' : '/api/user/login'
      response = await fetch(settings.baseUrl + loginPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: settings.email, password: settings.password }),
        signal: AbortSignal.timeout(settings.timeoutMs),
      })
    } catch (error) {
      throw new Error('无法连接 YAPI（' + settings.baseUrl + '）：' + (error && error.message ? error.message : error))
    }
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error('YAPI 登录响应不是 JSON（HTTP ' + response.status + '）')
    }
    if (!payload || payload.errcode !== 0) {
      throw new Error('YAPI 登录失败：' + ((payload && payload.errmsg) || '未知错误'))
    }
    const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    const pairs = lines.map((line) => String(line).split(';')[0].trim()).filter((pair) => pair.startsWith('_yapi_'))
    if (pairs.length === 0) throw new Error('YAPI 登录成功，但响应没有返回 Cookie')
    cookie = pairs.join('; ')
  }
  async function get(pathname, retry = true) {
    if (cookie === '') await login()
    let response
    try {
      response = await fetch(settings.baseUrl + pathname, {
        headers: { cookie, accept: 'application/json' },
        signal: AbortSignal.timeout(settings.timeoutMs),
      })
    } catch (error) {
      throw new Error('无法连接 YAPI（' + settings.baseUrl + '）：' + (error && error.message ? error.message : error))
    }
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
    if (!payload) {
      if (retry) {
        cookie = ''
        await login()
        return get(pathname, false)
      }
      throw new Error('YAPI 返回了非 JSON 响应（HTTP ' + response.status + '）')
    }
    if (payload.errcode === 40011 && retry) {
      cookie = ''
      await login()
      return get(pathname, false)
    }
    if (payload.errcode !== 0) throw new Error('YAPI 错误：' + (payload.errmsg || String(payload.errcode)))
    return payload.data
  }
  return { get }
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

const STATUS_LABEL = {
  done: '已完成',
  undone: '开发中',
  design: '设计中',
  deprecated: '已废弃',
  stub: '未完成',
}

function codeFence(text, lang) {
  return ['```' + (lang || ''), text, '```'].join('\n')
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

function fieldLine(field) {
  const type = field.type ? field.type : '—'
  const required = field.required ? '必填' : '可选'
  const description = field.description ? ' — ' + field.description : ''
  return '- ' + field.path + ': ' + type + ', ' + required + description
}

function paramLines(title, rows) {
  if (rows.length === 0) return []
  const lines = [title + ':']
  for (const row of rows) {
    const bits = []
    if (row.type) bits.push(row.type)
    bits.push(row.required ? '必填' : '可选')
    if (row.example) bits.push('示例 ' + row.example)
    const description = row.desc ? ' — ' + row.desc : ''
    lines.push('- ' + row.name + (bits.length ? '（' + bits.join('，') + '）' : '') + description)
  }
  return lines
}

function renderDoc(doc, requestFieldRows, responseFieldRows, options) {
  const lines = ['# ' + (doc.title || '未命名接口') + '（#' + doc.id + '）', doc.method + ' ' + doc.path]
  if (doc.projectName) lines.push('项目：' + doc.projectName + '（' + doc.projectId + '）')
  if (doc.status) lines.push('状态：' + (STATUS_LABEL[doc.status] || doc.status))
  if (doc.tags.length > 0) lines.push('标签：' + doc.tags.join(' / '))
  lines.push('YAPI：' + doc.pageUrl)
  if (doc.updatedAt) lines.push('更新：' + formatTime(doc.updatedAt))
  if (doc.desc) lines.push('', '## 接口说明', doc.desc)

  lines.push('', '## 请求地址', doc.method + ' ' + (doc.address || doc.path))

  if (doc.headers.length > 0) {
    lines.push('', '## 请求头')
    for (const row of doc.headers) {
      lines.push('- ' + row.name + ': ' + row.value + (row.required ? '（必填）' : '') + (row.desc ? ' — ' + row.desc : ''))
    }
  }

  const paramSections = [
    ...paramLines('Query', doc.query),
    ...paramLines('Path', doc.params),
    ...paramLines('Form', doc.form),
  ]
  if (paramSections.length > 0) lines.push('', '## 请求参数', ...paramSections)

  if (doc.requestBody.kind !== 'none') {
    lines.push('', '## 请求 Body', codeFence(doc.requestBody.example, doc.requestBody.kind === 'json' ? 'json' : ''))
  }

  if (!options.noFields) {
    if (requestFieldRows.length > 0) {
      lines.push('', '## 请求字段（' + requestFieldRows.length + '）')
      for (const field of requestFieldRows) lines.push(fieldLine(field))
    }
    if (responseFieldRows.length > 0) {
      lines.push('', '## 返回字段（' + responseFieldRows.length + '）')
      for (const field of responseFieldRows) lines.push(fieldLine(field))
    }
  }

  if (options.full && doc.responseBody.kind !== 'none') {
    lines.push('', '## 返回体', codeFence(doc.responseBody.example, doc.responseBody.kind === 'json' ? 'json' : ''))
  }

  return lines.join('\n')
}

function renderGlobalSearch(keyword, items, projects) {
  const lines = ['# YAPI 全局搜索：' + keyword]
  if (projects.length > 0) {
    lines.push('项目匹配：' + projects.map((project) => project.name + '（#' + project.id + '）').join(' / '))
  }
  lines.push('')
  for (const item of items) {
    const project = item.projectName
      ? '（' + item.projectName + ' #' + item.projectId + '）'
      : item.projectId
        ? '（项目 #' + item.projectId + '）'
        : ''
    lines.push(
      String(item.id) +
        '  ' +
        String(item.method).padEnd(6, ' ') +
        '  ' +
        String(item.path) +
        '  — ' +
        String(item.title) +
        project,
    )
  }
  return lines.join('\n')
}

function renderSearch(projectId, projectName, total, keyword, matches) {
  const lines = ['# YAPI 接口搜索：' + keyword]
  lines.push('项目：' + projectId + (projectName ? '（' + projectName + '）' : '') + '，共 ' + total + ' 个接口，' + matches.length + ' 个匹配')
  lines.push('')
  for (const item of matches) {
    lines.push(String(item._id) + '  ' + String(item.method || '').padEnd(6, ' ') + '  ' + String(item.path || '') + '  — ' + String(item.title || ''))
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

function printHelp() {
  console.log(`yapi-doc — 读取 YAPI 接口文档

用法：
  yapi-doc <文档ID|链接> [选项]
  yapi-doc --search <关键字> --project <项目ID>
  yapi-doc --search <关键字> --global
  yapi-doc install-skill [--dir <目录>]
  yapi-doc sync-skills [--dir <目录> ...] [--dry-run]

选项：
  --json          输出结构化 JSON（默认 Markdown）
  --full          额外输出返回体示例（默认只输出返回字段说明）
  --no-fields     不输出请求/返回字段说明
  --project <id>  --search 只搜当前项目（可选）
  --global        --search 搜所有项目（默认；YAPI /api/project/search）
  --dir <目录>    install-skill 的目标目录（默认 ~/.agents/skills/yapi-doc）
  --dry-run       sync-skills 只显示检测到的目标，不写入
  -h, --help      显示帮助

账号：
  读取 ${CONFIG_FILE}
  或环境变量 YAPI_BASE_URL / YAPI_EMAIL / YAPI_PASSWORD / YAPI_AUTH_TYPE
  （YAPI_AUTH_TYPE=ldap 使用 LDAP 登录，默认普通登录）

示例：
  yapi-doc 10001
  yapi-doc https://your-yapi.example.com/project/1/interface/api/10001
  yapi-doc --search warehouse --project 1
  yapi-doc 10001 --full --json
  yapi-doc install-skill
  yapi-doc install-skill --dir ~/.claude/skills/yapi-doc
  yapi-doc sync-skills
  yapi-doc sync-skills --dry-run`)
}

function parseArgs(argv) {
  const options = {
    target: '',
    search: '',
    projectId: 0,
    global: false,
    json: false,
    full: false,
    noFields: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') {
      options.help = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--full') {
      options.full = true
      continue
    }
    if (arg === '--no-fields') {
      options.noFields = true
      continue
    }
    if (arg === '--global') {
      options.global = true
      continue
    }
    if (arg === '--project') {
      options.projectId = Number(argv[++index]) || 0
      continue
    }
    if (arg.startsWith('--project=')) {
      options.projectId = Number(arg.slice('--project='.length)) || 0
      continue
    }
    if (arg === '--search') {
      options.search = String(argv[++index] || '').trim()
      continue
    }
    if (arg.startsWith('--search=')) {
      options.search = arg.slice('--search='.length).trim()
      continue
    }
    if (arg.startsWith('-')) throw new Error('未知选项：' + arg)
    if (options.target !== '') throw new Error('只能指定一个文档 ID 或链接')
    options.target = arg
  }
  return options
}

async function main() {
  if (process.argv[2] === 'sync-skills') {
    const dirs = []
    let dryRun = false
    for (let index = 3; index < process.argv.length; index += 1) {
      const arg = process.argv[index]
      if (arg === '-h' || arg === '--help') {
        printHelp()
        return
      }
      if (arg === '--dry-run') {
        dryRun = true
        continue
      }
      if (arg === '--dir') {
        const dir = process.argv[index + 1] || ''
        if (dir === '') throw new Error('--dir 需要一个目录')
        dirs.push(dir)
        index += 1
        continue
      }
      if (arg.startsWith('--dir=')) {
        const dir = arg.slice('--dir='.length)
        if (dir === '') throw new Error('--dir 需要一个目录')
        dirs.push(dir)
        continue
      }
      throw new Error('未知选项：' + arg)
    }
    syncSkills(dirs, dryRun)
    return
  }
  if (process.argv[2] === 'install-skill') {
    let target = ''
    for (let index = 3; index < process.argv.length; index += 1) {
      const arg = process.argv[index]
      if (arg === '-h' || arg === '--help') {
        printHelp()
        return
      }
      if (arg === '--dir') {
        target = process.argv[index + 1] || ''
        if (target === '') throw new Error('--dir 需要一个目录')
        index += 1
      } else if (arg.startsWith('--dir=')) {
        target = arg.slice('--dir='.length)
        if (target === '') throw new Error('--dir 需要一个目录')
      } else {
        throw new Error('未知选项：' + arg)
      }
    }
    installSkill(target)
    return
  }
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  if (options.search === '' && options.target === '') {
    printHelp()
    throw new Error('请提供文档 ID / 链接，或使用 --search <关键字>')
  }
  const settings = readSettings()
  const session = await createSession(settings)

  if (options.search !== '') {
    if (options.global || !Number.isSafeInteger(options.projectId) || options.projectId <= 0) {
      const data = await session.get('/api/project/search?q=' + encodeURIComponent(options.search))
      const rows = Array.isArray(data?.interface) ? data.interface.slice(0, 10) : []
      const projectNames = new Map()
      const nameOf = async function (projectId) {
        if (projectNames.has(projectId)) return projectNames.get(projectId)
        let name = ''
        try {
          const project = await session.get('/api/project/get?id=' + encodeURIComponent(projectId))
          name = String(project?.name ?? '')
        } catch {
          name = ''
        }
        projectNames.set(projectId, name)
        return name
      }
      const items = []
      for (const row of rows) {
        const id = Number(row._id)
        if (!Number.isSafeInteger(id) || id <= 0) continue
        let raw = null
        try {
          raw = await session.get('/api/interface/get?id=' + id)
        } catch {
          raw = null
        }
        const projectId = Number(raw?.project_id || row.projectId || 0)
        items.push({
          id,
          method: String(raw?.method ?? '').toUpperCase(),
          path: String(raw?.path ?? ''),
          title: String(raw?.title ?? row.title ?? ''),
          projectId,
          projectName: projectId > 0 ? await nameOf(projectId) : '',
        })
      }
      const projects = (Array.isArray(data?.project) ? data.project : []).slice(0, 10).map((row) => ({
        id: Number(row._id),
        name: String(row.name ?? ''),
      }))
      if (options.json) {
        console.log(
          JSON.stringify(
            { ok: true, data: { global: true, keyword: options.search, items, projects } },
            null,
            2,
          ),
        )
        return
      }
      console.log(renderGlobalSearch(options.search, items, projects))
      return
    }
    if (!Number.isSafeInteger(options.projectId) || options.projectId <= 0) {
      throw new Error('请用 --project <项目ID> 指定当前项目，或用 --global 搜所有项目')
    }
    const project = await session.get('/api/project/get?id=' + encodeURIComponent(options.projectId)).catch(() => null)
    const data = await session.get(
      '/api/interface/list?project_id=' + encodeURIComponent(options.projectId) + '&page=1&limit=2000',
    )
    const list = Array.isArray(data?.list) ? data.list : []
    const matches = rankInterfaces(list, options.search, 30)
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            data: {
              projectId: options.projectId,
              projectName: String(project?.name ?? ''),
              total: list.length,
              keyword: options.search,
              items: matches.map((item) => ({
                id: Number(item._id),
                method: String(item.method ?? '').toUpperCase(),
                path: String(item.path ?? ''),
                title: String(item.title ?? ''),
              })),
            },
          },
          null,
          2,
        ),
      )
      return
    }
    console.log(renderSearch(options.projectId, String(project?.name ?? ''), list.length, options.search, matches))
    return
  }

  const id = parseDocId(options.target)
  if (id === null) throw new Error('无法从输入中解析文档 ID：' + options.target)
  const raw = await session.get('/api/interface/get?id=' + encodeURIComponent(id))
  const project =
    raw && Number(raw.project_id) > 0
      ? await session.get('/api/project/get?id=' + encodeURIComponent(raw.project_id)).catch(() => null)
      : null
  const doc = buildDoc(raw, project, settings.baseUrl)
  const requestFieldRows = requestFields(raw)
  const responseFieldRows = responseFields(raw)

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          data: Object.assign({}, doc, {
            requestFields: requestFieldRows,
            responseFields: responseFieldRows,
          }),
        },
        null,
        2,
      ),
    )
    return
  }
  console.log(renderDoc(doc, requestFieldRows, responseFieldRows, options))
}

main().catch((error) => {
  console.error('yapi-doc: ' + (error && error.message ? error.message : String(error)))
  process.exit(1)
})
