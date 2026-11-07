/**
 * Pure helpers behind the YAPI panel.
 *
 * Nothing in this file touches the network or the DSH runtime: `index.js`
 * turns a YAPI `/api/interface/get` payload into a browser-friendly document,
 * and the tests exercise the same functions directly. Keeping the example
 * generator here means the browser never has to understand YAPI's schema
 * dialect.
 */

/** HTTP methods the panel knows how to color and copy. */
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

/**
 * Trim trailing slashes so `baseUrl + pathname` never doubles a separator.
 * An empty value stays empty: the plugin has no built-in YAPI host.
 * @param {unknown} value - configured origin.
 * @returns {string} normalized origin without a trailing slash.
 */
export function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/u, '')
}

/**
 * Join URL fragments with exactly one slash between them.
 * @param {...unknown} parts - origin, optional base path, optional endpoint.
 * @returns {string} the joined address.
 */
export function joinUrl(...parts) {
  let out = ''
  for (const part of parts) {
    const text = String(part ?? '').trim()
    if (text === '') continue
    if (out === '') out = text.replace(/\/+$/u, '')
    else out += '/' + text.replace(/^\/+/u, '').replace(/\/+$/u, '')
  }
  return out
}

/**
 * Pull a YAPI interface id out of a raw id, a numeric string, or a full
 * documentation URL (`.../project/1/interface/api/10001`).
 * @param {unknown} value - user input.
 * @returns {number | null} a positive integer id, or null when unparseable.
 */
export function parseDocId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  const text = String(value ?? '').trim()
  if (text === '') return null
  if (/^\d{1,12}$/u.test(text)) {
    const id = Number(text)
    return Number.isSafeInteger(id) && id > 0 ? id : null
  }
  const patterns = [
    /\/interface\/api\/(\d{1,12})(?:[/?#]|$)/u,
    /[?&]id=(\d{1,12})(?:[&#]|$)/u,
    /\/api\/interface\/get\?id=(\d{1,12})(?:[&#]|$)/u,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) {
      const id = Number(match[1])
      if (Number.isSafeInteger(id) && id > 0) return id
    }
  }
  const trailing = /(\d{1,12})\/?(?:[?#].*)?$/u.exec(text)
  if (trailing) {
    const id = Number(trailing[1])
    if (Number.isSafeInteger(id) && id > 0) return id
  }
  return null
}

/**
 * Turn YAPI's rich-text description into readable plain text.
 * @param {unknown} html - the `desc` field.
 * @returns {string} text with tags and entities removed.
 */
export function stripHtml(html) {
  const text = String(html ?? '')
  if (text === '') return ''
  return text
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/giu, '\n')
    .replace(/<li[^>]*>/giu, '- ')
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

/** @param {unknown} value @returns {unknown} parsed JSON, or undefined. */
function tryParseJson(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** @param {unknown} value @returns {string} pretty JSON, or '' when undefined. */
function pretty(value) {
  if (value === undefined) return ''
  return JSON.stringify(value, null, 2)
}

/** @param {Record<string, unknown>} schema @returns {Record<string, unknown>} */
function unwrapComposite(schema) {
  let current = schema
  for (let round = 0; round < 8; round += 1) {
    if (!current || typeof current !== 'object') return {}
    const allOf = Array.isArray(current.allOf) ? current.allOf : null
    if (allOf && allOf.length > 0) {
      const merged = { ...current }
      delete merged.allOf
      const properties = { ...(current.properties || {}) }
      for (const member of allOf) {
        if (member && typeof member === 'object' && member.properties) Object.assign(properties, member.properties)
      }
      merged.properties = properties
      merged.type = merged.type || 'object'
      return merged
    }
    const list = Array.isArray(current.oneOf)
      ? current.oneOf
      : Array.isArray(current.anyOf)
        ? current.anyOf
        : null
    if (list && list.length > 0 && list[0] && typeof list[0] === 'object') {
      current = list[0]
      continue
    }
    return current
  }
  return current && typeof current === 'object' ? current : {}
}

/**
 * Generate a copy-friendly example value from a YAPI JSON schema.
 * @param {unknown} input - a JSON schema node.
 * @param {{ maxNodes?: number, maxDepth?: number }} [options] - safety limits.
 * @returns {{ value: unknown, truncated: boolean, nodes: number }} example value and limits status.
 */
export function exampleFromSchema(input, options = {}) {
  const maxNodes = Number.isFinite(options.maxNodes) ? Number(options.maxNodes) : 20000
  const maxDepth = Number.isFinite(options.maxDepth) ? Number(options.maxDepth) : 48
  const state = { nodes: 0, truncated: false }

  const walk = (node, depth) => {
    state.nodes += 1
    if (state.nodes > maxNodes) {
      state.truncated = true
      return null
    }
    if (typeof node === 'boolean') return node ? {} : null
    if (!node || typeof node !== 'object') return null
    if (depth > maxDepth) {
      state.truncated = true
      return null
    }

    const schema = unwrapComposite(node)
    // YAPI keeps a resolved-schema marker in `$$ref`; it is documentation, not data.
    if (schema.example !== undefined) return schema.example
    if (schema.default !== undefined) return schema.default

    let type = schema.type
    if (Array.isArray(type)) type = type.find((item) => item !== 'null') || 'null'
    if (!type) {
      if (schema.properties) type = 'object'
      else if (schema.items) type = 'array'
      else if (schema.enum) type = typeof schema.enum[0] === 'number' ? 'number' : 'string'
    }

    if (schema.enum && schema.enum.length > 0) return schema.enum[0]
    if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0]

    switch (type) {
      case 'object': {
        const out = {}
        const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
        for (const [key, child] of Object.entries(properties)) out[key] = walk(child, depth + 1)
        if (Object.keys(properties).length === 0 && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          out['additionalProp1'] = walk(schema.additionalProperties, depth + 1)
        }
        return out
      }
      case 'array': {
        const items = Array.isArray(schema.items) ? schema.items[0] : schema.items
        if (!items) return []
        return [walk(items, depth + 1)]
      }
      case 'integer':
        return 0
      case 'number':
        return 0
      case 'boolean':
        return false
      case 'null':
        return null
      case 'string': {
        if (schema.format === 'date-time') return '2024-01-01T00:00:00Z'
        if (schema.format === 'date') return '2024-01-01'
        if (schema.format === 'email') return 'user@example.com'
        if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000000'
        return ''
      }
      default:
        return null
    }
  }

  const value = walk(input, 0)
  return { value, truncated: state.truncated, nodes: state.nodes }
}

/**
 * Build the copyable request body plus the raw schema text.
 * @param {Record<string, unknown>} raw - YAPI interface payload.
 * @returns {{ kind: 'none'|'json'|'text', example: string, raw: string, truncated: boolean }} body views.
 */
export function buildRequestPayload(raw) {
  const type = String(raw.req_body_type ?? '').toLowerCase()
  const bodyText = typeof raw.req_body_other === 'string' ? raw.req_body_other : ''
  const form = Array.isArray(raw.req_body_form) ? raw.req_body_form : []

  if (type === 'form' || (type === '' && form.length > 0)) {
    if (form.length === 0) return { kind: 'none', example: '', raw: bodyText, truncated: false }
    const object = {}
    for (const field of form) {
      if (!field || typeof field !== 'object') continue
      const name = String(field.name ?? '').trim() || 'field'
      object[name] = formExample(field)
    }
    return { kind: 'json', example: pretty(object), raw: bodyText, truncated: false }
  }

  if (bodyText.trim() === '') return { kind: 'none', example: '', raw: '', truncated: false }

  if (raw.req_body_is_json_schema === true) {
    const schema = tryParseJson(bodyText)
    if (schema !== undefined) {
      const generated = exampleFromSchema(schema)
      return { kind: 'json', example: pretty(generated.value), raw: bodyText, truncated: generated.truncated }
    }
  }

  const parsed = tryParseJson(bodyText)
  if (parsed !== undefined) return { kind: 'json', example: pretty(parsed), raw: bodyText, truncated: false }
  return { kind: 'text', example: bodyText, raw: bodyText, truncated: false }
}

/**
 * Build the copyable response body plus the raw schema text.
 * @param {Record<string, unknown>} raw - YAPI interface payload.
 * @returns {{ kind: 'none'|'json'|'text', example: string, raw: string, truncated: boolean }} body views.
 */
export function buildResponsePayload(raw) {
  const bodyText = typeof raw.res_body === 'string' ? raw.res_body : ''
  if (bodyText.trim() === '') return { kind: 'none', example: '', raw: '', truncated: false }

  if (raw.res_body_is_json_schema === true) {
    const schema = tryParseJson(bodyText)
    if (schema !== undefined) {
      const generated = exampleFromSchema(schema)
      return { kind: 'json', example: pretty(generated.value), raw: bodyText, truncated: generated.truncated }
    }
  }

  const parsed = tryParseJson(bodyText)
  if (parsed !== undefined) return { kind: 'json', example: pretty(parsed), raw: bodyText, truncated: false }
  return { kind: 'text', example: bodyText, raw: bodyText, truncated: false }
}

/** @param {Record<string, unknown>} field @returns {unknown} */
function formExample(field) {
  const type = String(field.type ?? '').toLowerCase()
  const example = field.example
  if (example !== undefined && example !== null && example !== '') {
    if (type === 'integer' || type === 'number') {
      const parsed = Number(example)
      return Number.isFinite(parsed) ? parsed : example
    }
    if (type === 'boolean') return example === true || example === 'true' || example === '1'
    return example
  }
  if (type === 'file') return ''
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return false
  return ''
}

/** @param {unknown} item @returns {{ name: string, type: string, required: boolean, example: string, desc: string, value: string }} */
function normalizeParam(item) {
  const entry = item && typeof item === 'object' ? item : {}
  return {
    name: String(entry.name ?? '').trim(),
    type: String(entry.type ?? '').trim(),
    required: entry.required === '1' || entry.required === true,
    example: entry.example === undefined || entry.example === null ? '' : String(entry.example),
    desc: stripHtml(entry.desc ?? ''),
    value: entry.value === undefined || entry.value === null ? '' : String(entry.value),
  }
}

/**
 * Whether every character of `needle` appears in `haystack` in order.
 * @param {string} needle - lower-case query.
 * @param {string} haystack - lower-case target.
 * @returns {boolean} true for an in-order subsequence match.
 */
function isSubsequence(needle, haystack) {
  let index = 0
  for (let cursor = 0; cursor < haystack.length && index < needle.length; cursor += 1) {
    if (haystack[cursor] === needle[index]) index += 1
  }
  return index === needle.length
}

/**
 * Rank a YAPI project's interface list against one keyword.
 *
 * Paths are the primary key (the user asked for "接口地址" search), titles are
 * the fallback, and a cheap in-order subsequence match handles acronym-style
 * queries such as `whlist` for `/admin/warehouse/list`.
 * @param {unknown} list - `/api/interface/list` rows.
 * @param {unknown} keyword - user query; spaces split it into required tokens.
 * @param {number} [limit] - maximum rows returned.
 * @returns {Array<Record<string, unknown>>} matching rows, best first.
 */
export function rankInterfaces(list, keyword, limit = 30) {
  const query = String(keyword ?? '').trim().toLowerCase()
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
  return ranked.slice(0, Math.max(1, Number.isFinite(limit) ? limit : 30)).map((entry) => entry.item)
}

/**
 * Shape one YAPI interface payload into the document the browser renders.
 *
 * The browser receives both views of each body: `example` (generated, good for
 * copying into a client) and `raw` (the schema exactly as YAPI stores it).
 * @param {Record<string, unknown>} raw - `/api/interface/get` data.
 * @param {Record<string, unknown> | null} project - `/api/project/get` data.
 * @param {string} baseUrl - the YAPI origin.
 * @returns {Record<string, unknown>} normalized document.
 */
export function normalizeInterface(raw, project, baseUrl) {
  const id = Number(raw._id)
  const projectId = Number(raw.project_id)
  const envs = Array.isArray(project?.env)
    ? project.env
        .filter((env) => env && typeof env === 'object' && env.domain)
        .map((env) => ({
          name: String(env.name ?? '默认'),
          domain: String(env.domain ?? ''),
        }))
    : []
  const basepath = typeof project?.basepath === 'string' ? project.basepath : ''
  const path = String(raw.path ?? '')

  return {
    id,
    title: String(raw.title ?? ''),
    method: String(raw.method ?? 'GET').toUpperCase(),
    path,
    status: String(raw.status ?? ''),
    tags: Array.isArray(raw.tag) ? raw.tag.map((tag) => String(tag)).filter(Boolean) : [],
    desc: String(raw.desc ?? ''),
    markdown: String(raw.markdown ?? ''),
    author: String(raw.username ?? ''),
    updatedAt: Number(raw.up_time) > 0 ? Number(raw.up_time) * 1000 : null,
    pageUrl: joinUrl(baseUrl, '/project', String(projectId), '/interface/api', String(id)),
    project: {
      id: projectId,
      name: String(project?.name ?? ''),
      basepath,
      envs,
      address: envs.length > 0 ? joinUrl(envs[0].domain, basepath, path) : joinUrl(basepath, path),
    },
    request: {
      headers: (Array.isArray(raw.req_headers) ? raw.req_headers : []).map(normalizeParam),
      query: (Array.isArray(raw.req_query) ? raw.req_query : []).map(normalizeParam),
      params: (Array.isArray(raw.req_params) ? raw.req_params : []).map(normalizeParam),
      form: (Array.isArray(raw.req_body_form) ? raw.req_body_form : []).map(normalizeParam),
      bodyType: String(raw.req_body_type ?? ''),
      bodyIsJsonSchema: raw.req_body_is_json_schema === true,
      body: buildRequestPayload(raw),
    },
    response: {
      bodyType: String(raw.res_body_type ?? ''),
      bodyIsJsonSchema: raw.res_body_is_json_schema === true,
      body: buildResponsePayload(raw),
    },
  }
}
