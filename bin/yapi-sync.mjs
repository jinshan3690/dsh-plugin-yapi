#!/usr/bin/env node
/** Top-level alias for `yapi-doc sync-skills`. */
process.argv.splice(2, 0, 'sync-skills')
await import('../skills/yapi-doc/yapi-doc.mjs')
