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

test('yapi-doc sync-skills detects and updates known tool roots', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yapi-doc-sync-'))
  fs.mkdirSync(path.join(home, '.trae'))
  fs.mkdirSync(path.join(home, '.workbuddy'))
  fs.mkdirSync(path.join(home, '.dsh'))
  const dshHome = path.join(home, '.dsh')
  execFileSync(process.execPath, [path.join(root, 'skills/yapi-doc/yapi-doc.mjs'), 'sync-skills'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, DSH_HOME: dshHome },
  })
  for (const relative of ['.trae', '.workbuddy', '.agents', '.dsh']) {
    const target = path.join(home, relative, 'skills', 'yapi-doc')
    assert.ok(fs.existsSync(path.join(target, 'SKILL.md')), relative + ' SKILL.md')
    const cli = path.join(target, 'yapi-doc.mjs')
    assert.ok(fs.existsSync(cli), relative + ' CLI')
    assert.ok(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8').includes(target), relative + ' paths')
  }
  assert.ok(!fs.existsSync(path.join(home, '.codex')), 'does not create absent tool dirs')
})
