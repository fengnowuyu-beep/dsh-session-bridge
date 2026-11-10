/** Attachment preparation: streaming sources, image detection, URL temp files. */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  AttachmentInputError,
  imageMediaType,
  prepareAttachments,
  uploadFilePart,
  uploadImagePart
} from '../lib/attachments.js'
import { createFakeFileUploads } from '../test-support/fake-host.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-session-bridge-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('image detection uses magic bytes, not the extension', () => {
  assert.equal(imageMediaType(PNG), 'image/png')
  assert.equal(imageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(imageMediaType(Buffer.from('GIF89a......', 'ascii')), 'image/gif')
  assert.equal(imageMediaType(Buffer.from('RIFF0000WEBP', 'ascii')), 'image/webp')
  assert.equal(imageMediaType(Buffer.from('hello')), undefined)
  assert.equal(imageMediaType(Buffer.alloc(0)), undefined)
})

test('a local image becomes an image descriptor and a local file becomes a file descriptor', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'pixel.png'), PNG)
  await writeFile(join(dir, 'notes.txt'), 'hello bridge')
  const prepared = await prepareAttachments(['pixel.png', 'notes.txt'], { baseDir: dir })
  t.after(prepared.cleanup)
  assert.equal(prepared.attachments.length, 2)
  assert.equal(prepared.attachments[0].kind, 'image')
  assert.equal(prepared.attachments[0].mediaType, 'image/png')
  assert.equal(prepared.attachments[0].name, 'pixel.png')
  assert.equal(prepared.attachments[0].path, join(dir, 'pixel.png'))
  assert.equal(prepared.attachments[1].kind, 'file')
  assert.equal(prepared.attachments[1].name, 'notes.txt')
  assert.equal(await readFile(prepared.attachments[1].path, 'utf8'), 'hello bridge')
})

test('relative paths resolve against the caller cwd and file URLs are accepted', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'data.txt')
  await writeFile(file, 'x')
  const relative = await prepareAttachments(['data.txt'], { baseDir: dir })
  assert.equal(relative.attachments[0].path, file)
  const url = await prepareAttachments([pathToFileURL(file).href], {})
  assert.equal(url.attachments[0].name, 'data.txt')
  await relative.cleanup()
  await url.cleanup()
})

test('allowFileRoots admits files inside a root and refuses files outside', async (t) => {
  const root = await tempDir(t)
  const outside = await tempDir(t)
  await writeFile(join(root, 'inside.txt'), 'in')
  await writeFile(join(outside, 'outside.txt'), 'out')
  const allowed = await prepareAttachments([join(root, 'inside.txt')], { allowFileRoots: [root] })
  assert.equal(allowed.attachments.length, 1)
  await allowed.cleanup()
  await assert.rejects(
    () => prepareAttachments([join(outside, 'outside.txt')], { allowFileRoots: [root] }),
    error => error instanceof AttachmentInputError && error.code === 'file-outside-roots'
  )
})

test('an empty root list means no local-path restriction', async (t) => {
  const outside = await tempDir(t)
  await writeFile(join(outside, 'free.txt'), 'ok')
  const prepared = await prepareAttachments([join(outside, 'free.txt')], { allowFileRoots: [] })
  assert.equal(await readFile(prepared.attachments[0].path, 'utf8'), 'ok')
  await prepared.cleanup()
})

test('there is no plugin-level attachment count cap', async (t) => {
  const dir = await tempDir(t)
  const paths = []
  for (let index = 0; index < 12; index += 1) {
    const path = join(dir, `file-${index}.txt`)
    await writeFile(path, `file ${index}`)
    paths.push(path)
  }
  const prepared = await prepareAttachments(paths, {})
  assert.equal(prepared.attachments.length, 12)
  await prepared.cleanup()
})

test('missing and directory paths fail with clear codes', async (t) => {
  const dir = await tempDir(t)
  await assert.rejects(
    () => prepareAttachments(['missing.txt'], { baseDir: dir }),
    error => error.code === 'file-not-found'
  )
  await mkdir(join(dir, 'folder'))
  await assert.rejects(
    () => prepareAttachments(['folder'], { baseDir: dir }),
    error => error.code === 'not-a-file'
  )
})

test('an http(s) URL is downloaded to a temporary file and detected as an image', async (t) => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
  }
  const prepared = await prepareAttachments(['https://example.com/assets/pixel.png'], {
    fetchImpl,
    allowPrivateUrls: false
  })
  t.after(prepared.cleanup)
  assert.equal(calls.length, 1)
  assert.equal(prepared.attachments[0].kind, 'image')
  assert.equal(prepared.attachments[0].name, 'pixel.png')
  assert.deepEqual(await readFile(prepared.attachments[0].path), PNG)
})

test('the temporary URL file is removed by cleanup', async (t) => {
  const fetchImpl = async () => new Response('temporary', { status: 200 })
  const prepared = await prepareAttachments(['https://example.com/data.txt'], { fetchImpl })
  const path = prepared.attachments[0].path
  assert.equal(await readFile(path, 'utf8'), 'temporary')
  await prepared.cleanup()
  await assert.rejects(() => stat(path), error => error.code === 'ENOENT')
})

test('obviously local URLs are refused unless allowPrivateUrls is set', async () => {
  let called = 0
  const fetchImpl = async () => {
    called += 1
    return new Response('x', { status: 200 })
  }
  await assert.rejects(
    () => prepareAttachments(['http://127.0.0.1/secret.png'], { fetchImpl }),
    error => error.code === 'private-url'
  )
  assert.equal(called, 0)
  const allowed = await prepareAttachments(['http://127.0.0.1/secret.txt'], {
    fetchImpl,
    allowPrivateUrls: true
  })
  assert.equal(allowed.attachments[0].kind, 'file')
  assert.equal(called, 1)
  await allowed.cleanup()
})

test('URL redirects are followed and the final name is used', async (t) => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).endsWith('/start')) {
      return new Response(null, { status: 302, headers: { location: '/assets/final.txt' } })
    }
    return new Response('final', { status: 200 })
  }
  const prepared = await prepareAttachments(['https://example.com/start'], { fetchImpl })
  t.after(prepared.cleanup)
  assert.deepEqual(calls, ['https://example.com/start', 'https://example.com/assets/final.txt'])
  assert.equal(prepared.attachments[0].name, 'final.txt')
  assert.equal(await readFile(prepared.attachments[0].path, 'utf8'), 'final')
})

test('a non-2xx URL response fails without producing an attachment', async () => {
  const fetchImpl = async () => new Response('nope', { status: 404 })
  await assert.rejects(
    () => prepareAttachments(['https://example.com/nope'], { fetchImpl }),
    error => error.code === 'download-failed'
  )
})

test('uploadFilePart streams the file to the target session and returns a receipt part', async (t) => {
  const dir = await tempDir(t)
  const path = join(dir, 'notes.txt')
  await writeFile(path, 'hello')
  const { fileUploads, uploads } = createFakeFileUploads()
  const part = await uploadFilePart({
    fileUploads,
    sessionId: 'session-target',
    attachment: { kind: 'file', name: 'notes.txt', path },
    signal: new AbortController().signal
  })
  assert.deepEqual(part, { type: 'file', receiptId: 'receipt-1' })
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].kind, 'file')
  assert.equal(uploads[0].request.sessionId, 'session-target')
  assert.equal(uploads[0].request.name, 'notes.txt')
  assert.equal(uploads[0].bytes.toString('utf8'), 'hello')
})

test('uploadImagePart streams the image and returns the stored image part', async (t) => {
  const dir = await tempDir(t)
  const path = join(dir, 'pixel.png')
  await writeFile(path, PNG)
  const { fileUploads, uploads } = createFakeFileUploads()
  const part = await uploadImagePart({
    fileUploads,
    sessionId: 'session-target',
    attachment: { kind: 'image', name: 'pixel.png', mediaType: 'image/png', path },
    signal: new AbortController().signal
  })
  assert.equal(part.type, 'image')
  assert.equal(part.attachment.mediaType, 'image/png')
  assert.equal(uploads[0].kind, 'image')
  assert.equal(uploads[0].request.mediaType, 'image/png')
  assert.deepEqual(uploads[0].bytes, PNG)
})

test('upload helpers refuse to run without a fileUploads service', async (t) => {
  const dir = await tempDir(t)
  const path = join(dir, 'a.txt')
  await writeFile(path, 'x')
  await assert.rejects(
    () => uploadFilePart({
      fileUploads: undefined,
      sessionId: 'session-target',
      attachment: { kind: 'file', name: 'a.txt', path },
      signal: new AbortController().signal
    }),
    error => error.code === 'file-uploads-unavailable'
  )
  await assert.rejects(
    () => uploadImagePart({
      fileUploads: undefined,
      sessionId: 'session-target',
      attachment: { kind: 'image', name: 'p.png', mediaType: 'image/png', path },
      signal: new AbortController().signal
    }),
    error => error.code === 'file-uploads-unavailable'
  )
})
