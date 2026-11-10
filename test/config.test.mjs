/** Configuration normalization: no target allowlist, no payload caps. */

import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../lib/config.js'

test('an absent config means enabled, queue mode, no file fence, private URLs blocked', () => {
  const settings = normalizeConfig(undefined)
  assert.equal(settings.enabled, true)
  assert.equal(settings.sendMode, 'queue')
  assert.deepEqual(settings.allowFileRoots, [])
  assert.equal(settings.allowPrivateUrls, false)
  assert.equal(Object.isFrozen(settings), true)
  assert.equal(Object.isFrozen(settings.allowFileRoots), true)
})

test('there is no target allowlist any more', () => {
  const settings = normalizeConfig({ allowedSessionIds: ['session-a'] })
  assert.equal('allowedSessionIds' in settings, false)
})

test('file roots are trimmed and de-duplicated, without a count cap', () => {
  const roots = Array.from({ length: 50 }, (_, index) => ` E:/root-${index} `)
  const settings = normalizeConfig({
    allowFileRoots: [' E:/work ', 'E:/work', '', '   ', 7, null, 'D:/data', ...roots]
  })
  assert.equal(settings.allowFileRoots.length, 52)
  assert.equal(settings.allowFileRoots[0], 'E:/work')
  assert.equal(settings.allowFileRoots[1], 'D:/data')
})

test('a bare string is not treated as a one-item root list', () => {
  const settings = normalizeConfig({ allowFileRoots: 'E:/work' })
  assert.deepEqual(settings.allowFileRoots, [])
})

test('sendMode accepts only steer; everything else falls back to queue', () => {
  assert.equal(normalizeConfig({ sendMode: 'steer' }).sendMode, 'steer')
  assert.equal(normalizeConfig({ sendMode: 'queue' }).sendMode, 'queue')
  assert.equal(normalizeConfig({ sendMode: 'STEER' }).sendMode, 'queue')
  assert.equal(normalizeConfig({ sendMode: 'later' }).sendMode, 'queue')
})

test('allowPrivateUrls is true only when explicitly set to boolean true', () => {
  assert.equal(normalizeConfig({ allowPrivateUrls: true }).allowPrivateUrls, true)
  assert.equal(normalizeConfig({ allowPrivateUrls: 'true' }).allowPrivateUrls, false)
  assert.equal(normalizeConfig({ allowPrivateUrls: 1 }).allowPrivateUrls, false)
})

test('enabled: false is preserved and nothing else is disabled implicitly', () => {
  assert.equal(normalizeConfig({ enabled: false }).enabled, false)
  assert.equal(normalizeConfig({ enabled: 'no' }).enabled, true)
})
