/** Manifest/patch integrity: the package ships the bundle row it documents. */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = name => readFileSync(new URL(name, root), 'utf8')

test('package.json points at the Host entry and the bundle patch', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.name, 'dsh-session-bridge')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(manifest.files.includes('lib'))
  assert.ok(manifest.files.includes('cordis.patch.yml'))
})

test('the bundle patch inserts the documented row without a target allowlist', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /id:\s*session-bridge/u)
  assert.match(patch, /name:\s*'dsh-session-bridge'/u)
  assert.match(patch, /sendMode:\s*queue/u)
  assert.match(patch, /allowFileRoots:\s*\[\s*\]/u)
  assert.match(patch, /allowPrivateUrls:\s*false/u)
  assert.doesNotMatch(patch, /allowedSessionIds/u)
})

test('README documents the new config and attachment surface', () => {
  const readme = read('README.md')
  for (const key of ['allowFileRoots', 'allowPrivateUrls', 'sendMode', 'enabled', 'attachments', 'imageFallback']) {
    assert.match(readme, new RegExp(key, 'u'))
  }
  assert.match(readme, /session_send/u)
  assert.match(readme, /验证/u)
})
