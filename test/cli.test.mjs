import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('yapi-doc install-skill copies the CLI and rewrites the skill paths', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'yapi-doc-skill-'))
  execFileSync(
    process.execPath,
    [path.join(root, 'skills/yapi-doc/yapi-doc.mjs'), 'install-skill', '--dir', target],
    { encoding: 'utf8' },
  )
  const skill = fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')
  const cli = path.join(target, 'yapi-doc.mjs')
  assert.ok(fs.existsSync(cli), 'CLI copied')
  assert.ok((fs.statSync(cli).mode & 0o111) !== 0, 'CLI executable')
  assert.ok(skill.includes(target), 'SKILL.md points at the install directory')
  assert.ok(!skill.includes('$HOME/.dsh/skills/yapi-doc'), 'old paths rewritten')
})
