/** session_create and workspace_create: create, model selection, workspace registration. */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionBridgeError } from '../lib/index.js'
import { callNamedTool, createFakeHost, liveSignal } from '../test-support/fake-host.mjs'

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-session-bridge-tools-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('session_create with no location uses the Host default', async () => {
  const host = createFakeHost()
  const result = await callNamedTool(host, 'session_create', {}, { signal: liveSignal() })
  assert.deepEqual(host.created, [{}])
  assert.equal(result.created, true)
  assert.equal(result.sessionId, 'session-created-1')
  assert.equal(result.provider, '')
  assert.equal(result.model, '')
  assert.equal(result.reasoningEffort, '')
  assert.equal(host.selections.length, 0)
})

test('session_create accepts an absolute cwd or a workspaceId, but not both', async (t) => {
  const dir = await tempDir(t)
  const host = createFakeHost()
  await callNamedTool(host, 'session_create', { cwd: dir }, { signal: liveSignal() })
  assert.deepEqual(host.created[0], { cwd: dir })
  await callNamedTool(host, 'session_create', { workspaceId: 'workspace-1' }, { signal: liveSignal() })
  assert.deepEqual(host.created[1], { workspaceId: 'workspace-1' })
  await assert.rejects(
    () => callNamedTool(host, 'session_create', { cwd: dir, workspaceId: 'workspace-1' }, { signal: liveSignal() }),
    error => error.code === 'bad-location'
  )
  await assert.rejects(
    () => callNamedTool(host, 'session_create', { cwd: 'relative/dir' }, { signal: liveSignal() }),
    error => error.code === 'bad-location'
  )
  assert.equal(host.created.length, 2)
})

test('session_create can rename the new session', async () => {
  const host = createFakeHost()
  const result = await callNamedTool(host, 'session_create', { title: '  测试会话  ' }, { signal: liveSignal() })
  assert.deepEqual(host.renames, [{ sessionId: 'session-created-1', title: '测试会话' }])
  assert.equal(result.title, '测试会话')
})

test('session_create validates and applies provider, model, and reasoning effort', async () => {
  const host = createFakeHost()
  const result = await callNamedTool(host, 'session_create', {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'medium'
  }, { signal: liveSignal() })
  assert.deepEqual(host.selections, [{
    sessionId: 'session-created-1',
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'medium'
  }])
  assert.equal(result.provider, 'deepseek-official')
  assert.equal(result.model, 'deepseek-v4-pro')
  assert.equal(result.reasoningEffort, 'medium')
})

test('reasoningEffort alone uses the catalog default model', async () => {
  const host = createFakeHost()
  const result = await callNamedTool(host, 'session_create', { reasoningEffort: 'max' }, { signal: liveSignal() })
  assert.deepEqual(host.selections, [{
    sessionId: 'session-created-1',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'max'
  }])
  assert.equal(result.provider, 'deepseek-official')
  assert.equal(result.model, 'deepseek-flash')
  assert.equal(result.reasoningEffort, 'max')
})

test('unknown providers, models, and efforts fail before a session is created', async () => {
  const host = createFakeHost()
  await assert.rejects(
    () => callNamedTool(host, 'session_create', { provider: 'unknown', model: 'x' }, { signal: liveSignal() }),
    error => error.code === 'unknown-provider'
  )
  await assert.rejects(
    () => callNamedTool(host, 'session_create', { provider: 'deepseek-official', model: 'x' }, { signal: liveSignal() }),
    error => error.code === 'unknown-model'
  )
  await assert.rejects(
    () => callNamedTool(host, 'session_create', {
      provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'ultra'
    }, { signal: liveSignal() }),
    error => error.code === 'unknown-reasoning-effort'
  )
  await assert.rejects(
    () => callNamedTool(host, 'session_create', { provider: 'deepseek-official' }, { signal: liveSignal() }),
    error => error.code === 'bad-model'
  )
  assert.equal(host.created.length, 0)
})

test('a session creation failure is wrapped', async () => {
  const host = createFakeHost({ createError: new Error('session/create-failed') })
  await assert.rejects(
    () => callNamedTool(host, 'session_create', {}, { signal: liveSignal() }),
    error => error.code === 'session-create-failed' && /session\/create-failed/u.test(error.message)
  )
})

test('a model selection failure reports the already-created session id', async () => {
  const host = createFakeHost({ selectError: new Error('provider unavailable') })
  await assert.rejects(
    () => callNamedTool(host, 'session_create', {
      provider: 'deepseek-official', model: 'deepseek-flash'
    }, { signal: liveSignal() }),
    error => {
      assert.equal(error.code, 'model-selection-failed')
      assert.match(error.message, /session-created-1/u)
      return true
    }
  )
  assert.equal(host.created.length, 1)
})

test('a rename failure reports the already-created session id', async () => {
  const host = createFakeHost({ renameError: new Error('title rejected') })
  await assert.rejects(
    () => callNamedTool(host, 'session_create', { title: 'x' }, { signal: liveSignal() }),
    error => {
      assert.equal(error.code, 'title-failed')
      assert.match(error.message, /session-created-1/u)
      return true
    }
  )
})

test('session_create without a session controller fails clearly', async () => {
  const host = createFakeHost({ omitSessionController: true })
  await assert.rejects(
    () => callNamedTool(host, 'session_create', {}, { signal: liveSignal() }),
    error => error.code === 'host-unavailable'
  )
})

test('workspace_create creates the directory and registers the workspace', async (t) => {
  const parent = await tempDir(t)
  const path = join(parent, 'new-workspace')
  const host = createFakeHost()
  const result = await callNamedTool(host, 'workspace_create', { path, title: '新工作区' }, { signal: liveSignal() })
  assert.equal(result.created, true)
  assert.equal(result.workspaceId, 'workspace-1')
  assert.equal(result.path, path)
  assert.equal(result.title, '新工作区')
  await stat(path)
  assert.deepEqual(host.workspaceRenames, [{ workspaceId: 'workspace-1', title: '新工作区' }])
})

test('workspace_create reuses an existing workspace for the same directory', async (t) => {
  const parent = await tempDir(t)
  const path = join(parent, 'existing-workspace')
  const host = createFakeHost()
  const first = await callNamedTool(host, 'workspace_create', { path }, { signal: liveSignal() })
  const second = await callNamedTool(host, 'workspace_create', { path }, { signal: liveSignal() })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(first.workspaceId, second.workspaceId)
})

test('workspace_create validates the path and requires the Host service', async () => {
  const host = createFakeHost()
  await assert.rejects(
    () => callNamedTool(host, 'workspace_create', { path: 'relative/dir' }, { signal: liveSignal() }),
    error => error.code === 'bad-path'
  )
  const missing = createFakeHost({ omitWorkspaceController: true })
  await assert.rejects(
    () => callNamedTool(missing, 'workspace_create', { path: 'E:/tmp' }, { signal: liveSignal() }),
    error => error.code === 'host-unavailable'
  )
})

test('a workspace creation failure is wrapped', async (t) => {
  const parent = await tempDir(t)
  const path = join(parent, 'broken')
  const host = createFakeHost({
    workspaceController: {
      async create() { throw new Error('registry unavailable') },
      async rename() { throw new Error('unused') }
    }
  })
  await assert.rejects(
    () => callNamedTool(host, 'workspace_create', { path }, { signal: liveSignal() }),
    error => error.code === 'workspace-create-failed' && /registry unavailable/u.test(error.message)
  )
})

test('render output names the created resources', () => {
  const host = createFakeHost()
  const sessionText = host.tools.session_create.output.render({}, {
    created: true,
    sessionId: 'session-1',
    workspaceId: '',
    cwd: 'E:/work',
    title: '测试',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'max'
  })[0].text
  assert.match(sessionText, /session-1/u)
  assert.match(sessionText, /deepseek-official\/deepseek-flash/u)
  assert.match(sessionText, /推理强度：max/u)
  const workspaceText = host.tools.workspace_create.output.render({}, {
    created: true,
    workspaceId: 'workspace-1',
    path: 'E:/work',
    title: '测试工作区'
  })[0].text
  assert.match(workspaceText, /已创建工作区/u)
  assert.match(workspaceText, /workspace-1/u)
})
