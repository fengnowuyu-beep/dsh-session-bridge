/** The session_send tool: registration, arbitrary targets, attachments, fallback. */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionBridgeError } from '../lib/index.js'
import { callTool, createFakeHost, liveSignal } from '../test-support/fake-host.mjs'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const TARGET = 'session-any-target'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-session-bridge-tool-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function execFor(dir, signal = liveSignal()) {
  return {
    signal,
    agent: { session: { header: { cwd: dir } } }
  }
}

test('apply registers one tool with sessionId required and optional attachments', () => {
  const host = createFakeHost()
  assert.equal(host.registered.length, 1)
  const tool = host.tool
  assert.equal(tool.name, 'session_send')
  assert.deepEqual(tool.parameters.required, ['sessionId'])
  assert.equal(tool.parameters.properties.sessionId.type, 'string')
  assert.equal(tool.parameters.properties.text.type, 'string')
  assert.equal(tool.parameters.properties.attachments.type, 'array')
  assert.equal(tool.parameters.properties.attachments.items.type, 'string')
  assert.deepEqual(tool.output.schema.required, [
    'sent', 'sessionId', 'requestId', 'mode', 'attachments', 'images', 'files', 'imageFallback'
  ])
})

test('any session id is accepted: there is no target allowlist', async () => {
  const host = createFakeHost()
  const result = await callTool(host, { sessionId: TARGET, text: 'hello' }, { signal: liveSignal() })
  assert.equal(result.sent, true)
  assert.equal(result.sessionId, TARGET)
  assert.equal(result.attachments, 0)
  assert.equal(result.imageFallback, false)
  assert.deepEqual(host.prompts[0].request, {
    requestId: result.requestId,
    sessionId: TARGET,
    mode: 'queue',
    content: [{ type: 'text', text: 'hello' }]
  })
})

test('text is trimmed and each send uses a fresh request id', async () => {
  const host = createFakeHost()
  const first = await callTool(host, { sessionId: TARGET, text: '  one\n' }, { signal: liveSignal() })
  const second = await callTool(host, { sessionId: TARGET, text: 'two' }, { signal: liveSignal() })
  assert.equal(host.prompts[0].request.content[0].text, 'one')
  assert.match(first.requestId, UUID_V4)
  assert.notEqual(first.requestId, second.requestId)
})

test('text has no plugin-level length cap', async () => {
  const host = createFakeHost()
  const text = 'x'.repeat(100_000)
  const result = await callTool(host, { sessionId: TARGET, text }, { signal: liveSignal() })
  assert.equal(result.sent, true)
  assert.equal(host.prompts[0].request.content[0].text.length, 100_000)
})

test('text and attachments must not both be empty', async () => {
  const host = createFakeHost()
  await assert.rejects(
    () => callTool(host, { sessionId: TARGET }, { signal: liveSignal() }),
    error => error.code === 'bad-text' && /至少提供一个/u.test(error.message)
  )
  await assert.rejects(
    () => callTool(host, { sessionId: TARGET, text: '   ', attachments: [] }, { signal: liveSignal() }),
    error => error.code === 'bad-text'
  )
  assert.equal(host.prompts.length, 0)
})

test('attachments must be a string array', async () => {
  const host = createFakeHost()
  await assert.rejects(
    () => callTool(host, { sessionId: TARGET, attachments: 'a.txt' }, { signal: liveSignal() }),
    error => error.code === 'bad-attachments'
  )
  await assert.rejects(
    () => callTool(host, { sessionId: TARGET, attachments: [7] }, { signal: liveSignal() }),
    error => error.code === 'bad-attachments'
  )
  assert.equal(host.prompts.length, 0)
})

test('an image-only message becomes one stored image part', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'pixel.png'), PNG)
  const host = createFakeHost()
  const result = await callTool(
    host,
    { sessionId: TARGET, attachments: ['pixel.png'] },
    execFor(dir)
  )
  assert.equal(result.sent, true)
  assert.equal(result.attachments, 1)
  assert.equal(result.images, 1)
  assert.equal(result.files, 0)
  const part = host.prompts[0].request.content[0]
  assert.equal(part.type, 'image')
  assert.equal(part.attachment.mediaType, 'image/png')
  assert.equal(part.attachment.name, 'pixel.png')
  assert.equal(part.encodedBytes, PNG.length)
  assert.equal(host.uploads.length, 1)
  assert.equal(host.uploads[0].kind, 'image')
})

test('a generic file is uploaded to the target session and cited by receipt', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'notes.txt'), 'hello bridge')
  const host = createFakeHost()
  const result = await callTool(
    host,
    { sessionId: TARGET, text: 'see attached', attachments: ['notes.txt'] },
    execFor(dir)
  )
  assert.equal(result.files, 1)
  assert.deepEqual(host.prompts[0].request.content, [
    { type: 'text', text: 'see attached' },
    { type: 'file', receiptId: 'receipt-1' }
  ])
  assert.equal(host.uploads.length, 1)
  assert.equal(host.uploads[0].kind, 'file')
  assert.equal(host.uploads[0].request.sessionId, TARGET)
  assert.equal(host.uploads[0].request.name, 'notes.txt')
  assert.equal(host.uploads[0].bytes.toString('utf8'), 'hello bridge')
})

test('text, image, and file preserve input order in the content list', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'pixel.png'), PNG)
  await writeFile(join(dir, 'notes.txt'), 'body')
  const host = createFakeHost()
  await callTool(
    host,
    { sessionId: TARGET, text: 'hello', attachments: ['pixel.png', 'notes.txt'] },
    execFor(dir)
  )
  const content = host.prompts[0].request.content
  assert.equal(content[0].type, 'text')
  assert.equal(content[1].type, 'image')
  assert.equal(content[2].type, 'file')
  assert.equal(content[2].receiptId, 'receipt-2')
})

test('there is no plugin-level attachment count cap', async (t) => {
  const dir = await tempDir(t)
  const attachments = []
  for (let index = 0; index < 6; index += 1) {
    const name = `file-${index}.txt`
    await writeFile(join(dir, name), `body ${index}`)
    attachments.push(name)
  }
  const host = createFakeHost()
  const result = await callTool(host, { sessionId: TARGET, attachments }, execFor(dir))
  assert.equal(result.attachments, 6)
  assert.equal(host.uploads.length, 6)
})

test('an http(s) attachment is downloaded and uploaded as an image part', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
  }
  const host = createFakeHost({ fetchImpl })
  const result = await callTool(
    host,
    { sessionId: TARGET, attachments: ['https://example.com/pixel.png'] },
    { signal: liveSignal() }
  )
  assert.equal(result.images, 1)
  assert.deepEqual(calls, ['https://example.com/pixel.png'])
  assert.equal(host.prompts[0].request.content[0].type, 'image')
  assert.equal(host.uploads[0].kind, 'image')
})

test('a private URL is refused before fetch or prompt', async () => {
  let calls = 0
  const host = createFakeHost({
    fetchImpl: async () => {
      calls += 1
      return new Response('x', { status: 200 })
    }
  })
  await assert.rejects(
    () => callTool(host, { sessionId: TARGET, attachments: ['http://127.0.0.1/secret.txt'] }, { signal: liveSignal() }),
    error => error.code === 'private-url'
  )
  assert.equal(calls, 0)
  assert.equal(host.prompts.length, 0)
})

test('allowFileRoots refuses a local file outside the configured roots', async (t) => {
  const root = await tempDir(t)
  const outside = await tempDir(t)
  await writeFile(join(outside, 'secret.txt'), 'secret')
  const host = createFakeHost({ config: { allowFileRoots: [root] } })
  await assert.rejects(
    () => callTool(host, { sessionId: TARGET, attachments: [join(outside, 'secret.txt')] }, execFor(outside)),
    error => error.code === 'file-outside-roots'
  )
  assert.equal(host.prompts.length, 0)
})

test('an image is retried as a file attachment when the target model lacks vision', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'pixel.png'), PNG)
  const imageError = Object.assign(
    new Error('session/attachment-invalid: Model does not support image input.'),
    { details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } }
  )
  const host = createFakeHost({ promptErrors: [imageError, undefined] })
  const result = await callTool(
    host,
    { sessionId: TARGET, text: 'look', attachments: ['pixel.png'] },
    execFor(dir)
  )
  assert.equal(result.sent, true)
  assert.equal(result.imageFallback, true)
  assert.equal(host.prompts.length, 2)
  assert.equal(host.prompts[0].request.content[1].type, 'image')
  assert.deepEqual(host.prompts[1].request.content, [
    { type: 'text', text: 'look' },
    { type: 'file', receiptId: 'receipt-2' }
  ])
  assert.equal(host.uploads.length, 2)
  assert.equal(host.uploads[0].kind, 'image')
  assert.equal(host.uploads[1].kind, 'file')
  assert.deepEqual(host.uploads[1].bytes, PNG)
})

test('fallback keeps already-uploaded generic files and uploads only the image again', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'pixel.png'), PNG)
  await writeFile(join(dir, 'notes.txt'), 'body')
  const imageError = Object.assign(
    new Error('Model does not support image input.'),
    { details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } }
  )
  const host = createFakeHost({ promptErrors: [imageError, undefined] })
  const result = await callTool(
    host,
    { sessionId: TARGET, attachments: ['pixel.png', 'notes.txt'] },
    execFor(dir)
  )
  assert.equal(result.imageFallback, true)
  assert.equal(host.uploads.length, 3)
  assert.deepEqual(host.uploads.map(upload => upload.kind), ['image', 'file', 'file'])
  assert.equal(host.prompts[1].request.content.length, 2)
  assert.ok(host.prompts[1].request.content.every(part => part.type === 'file'))
})

test('fallback fails clearly when the service can read images but not upload files', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'pixel.png'), PNG)
  const imageError = Object.assign(
    new Error('Model does not support image input.'),
    { details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } }
  )
  const fileUploads = {
    async uploadImageStream() {
      return {
        receiptId: 'image-receipt',
        image: {
          type: 'image',
          attachment: { attachmentId: 'sha256:fake', mediaType: 'image/png', name: 'pixel.png', bytes: PNG.length },
          encodedBytes: PNG.length
        }
      }
    }
  }
  const host = createFakeHost({ promptErrors: [imageError, undefined], fileUploads })
  await assert.rejects(
    () => callTool(host, { sessionId: TARGET, attachments: ['pixel.png'] }, execFor(dir)),
    error => error.code === 'attachment-failed' && /降级/u.test(error.message)
  )
  assert.equal(host.prompts.length, 1)
})

test('an image without fileUploads fails before prompt admission', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'pixel.png'), PNG)
  const host = createFakeHost({ omitFileUploads: true })
  await assert.rejects(
    () => callTool(host, { sessionId: TARGET, attachments: ['pixel.png'] }, execFor(dir)),
    error => error.code === 'file-uploads-unavailable'
  )
  assert.equal(host.prompts.length, 0)
})

test('a generic file without fileUploads fails before prompt admission', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'notes.txt'), 'body')
  const host = createFakeHost({ omitFileUploads: true })
  await assert.rejects(
    () => callTool(host, { sessionId: TARGET, attachments: ['notes.txt'] }, execFor(dir)),
    error => error.code === 'file-uploads-unavailable'
  )
  assert.equal(host.prompts.length, 0)
})

test('text-only sends still work without fileUploads', async () => {
  const host = createFakeHost({ omitFileUploads: true })
  const result = await callTool(host, { sessionId: TARGET, text: 'hi' }, { signal: liveSignal() })
  assert.equal(result.sent, true)
})

test('an accepted:false host answer is a failure, not a success', async () => {
  const host = createFakeHost({ promptResult: { accepted: false } })
  await assert.rejects(
    () => callTool(host, { sessionId: TARGET, text: 'hi' }, { signal: liveSignal() }),
    error => error.code === 'delivery-rejected'
  )
})

test('a non-image host refusal is wrapped with its cause', async () => {
  const cause = new Error('session/not-found: session "x" not found')
  const host = createFakeHost({ promptError: cause })
  await assert.rejects(
    () => callTool(host, { sessionId: TARGET, text: 'hi' }, { signal: liveSignal() }),
    error => {
      assert.equal(error.code, 'delivery-failed')
      assert.match(error.message, /session\/not-found/u)
      assert.equal(error.cause, cause)
      return true
    }
  )
})

test('a composition without a session controller fails loudly at call time', async () => {
  const host = createFakeHost({ omitSessionController: true })
  await assert.rejects(
    () => callTool(host, { sessionId: TARGET, text: 'hi' }, { signal: liveSignal() }),
    error => error.code === 'host-unavailable'
  )
})

test('invalid session ids are rejected, but there is no plugin length cap', async () => {
  const host = createFakeHost()
  for (const sessionId of ['', '   ', 'session-\u0000abc']) {
    await assert.rejects(
      () => callTool(host, { sessionId, text: 'hi' }, { signal: liveSignal() }),
      error => error.code === 'bad-session-id'
    )
  }
  const longId = `session-${'a'.repeat(600)}`
  const result = await callTool(host, { sessionId: longId, text: 'hi' }, { signal: liveSignal() })
  assert.equal(result.sessionId, longId)
})

test('a missing signal still gives the host a usable AbortSignal', async () => {
  const host = createFakeHost()
  await callTool(host, { sessionId: TARGET, text: 'hi' })
  const { signal } = host.prompts[0]
  assert.equal(typeof signal.throwIfAborted, 'function')
  assert.equal(signal.aborted, false)
})

test('an already-aborted signal stops before admission', async () => {
  const host = createFakeHost()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => callTool(host, { sessionId: TARGET, text: 'hi' }, { signal: controller.signal }),
    error => error.name === 'AbortError'
  )
  assert.equal(host.prompts.length, 0)
})

test('enabled:false registers nothing', () => {
  const host = createFakeHost({ config: { enabled: false } })
  assert.equal(host.registered.length, 0)
  assert.ok(host.logs.some(entry => String(entry.args[0]).includes('disabled by config')))
})

test('a missing tools service is reported instead of crashing apply', () => {
  const host = createFakeHost({ omitTools: true })
  assert.equal(host.registered.length, 0)
  assert.ok(host.logs.some(entry => entry.level === 'warn'))
})

test('render mentions attachment counts and the image fallback', () => {
  const host = createFakeHost()
  const parts = host.tool.output.render({}, {
    sent: true,
    sessionId: TARGET,
    requestId: 'request-1',
    mode: 'queue',
    attachments: 2,
    images: 1,
    files: 1,
    imageFallback: true
  })
  assert.equal(parts.length, 1)
  assert.match(parts[0].text, /附件 2 个/u)
  assert.match(parts[0].text, /图片 1/u)
  assert.match(parts[0].text, /文件 1/u)
  assert.match(parts[0].text, /降级/u)
  assert.match(parts[0].text, /宿主已受理/u)
})
