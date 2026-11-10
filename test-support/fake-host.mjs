/**
 * A minimal stand-in for the Cordis host: the real `apply` runs against a fake
 * `tools` registry, a fake `sessionController`, a fake `fileUploads` service,
 * and an injectable fetch. The suite exercises registration, validation,
 * attachment preparation, upload receipts, URL downloads, and image fallback
 * without booting DSH.
 */

import { apply } from '../lib/index.js'

/**
 * Build a fake controller that records every prompt admission.
 * @param options - `promptResult`, `promptError`, or `promptErrors` (one entry
 *   per call; an undefined/absent entry succeeds).
 * @returns `{ controller, prompts }`.
 */
export function createFakeController(options = {}) {
  const prompts = []
  let call = 0
  const controller = {
    async prompt(request, signal) {
      prompts.push({ request, signal })
      const indexed = Array.isArray(options.promptErrors) ? options.promptErrors[call] : undefined
      const error = indexed !== undefined ? indexed : call === 0 ? options.promptError : undefined
      call += 1
      if (error !== undefined) throw error
      return options.promptResult === undefined ? { accepted: true } : options.promptResult
    }
  }
  return { controller, prompts }
}

/**
 * Build a fake `fileUploads` service that drains each stream and records the
 * exact bytes plus the request envelope.
 * @returns `{ fileUploads, uploads }`.
 */
export function createFakeFileUploads() {
  const uploads = []
  const fileUploads = {
    async uploadStream(request) {
      const chunks = []
      for await (const chunk of request.data) chunks.push(Buffer.from(chunk))
      uploads.push({ kind: 'file', request, bytes: Buffer.concat(chunks) })
      return { receiptId: `receipt-${uploads.length}`, file: { id: `file-${uploads.length}` } }
    },
    async uploadImageStream(request) {
      const chunks = []
      for await (const chunk of request.data) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      uploads.push({ kind: 'image', request, bytes })
      return {
        receiptId: `receipt-${uploads.length}`,
        image: {
          type: 'image',
          attachment: {
            attachmentId: `sha256:fake-${uploads.length}`,
            mediaType: request.mediaType,
            bytes: bytes.length,
            name: request.name
          },
          encodedBytes: bytes.length
        }
      }
    }
  }
  return { fileUploads, uploads }
}

/**
 * Mount the plugin against a fake host.
 * @param options - `{ config, controller, promptResult, promptError,
 *   promptErrors, omitSessionController, omitTools, omitFileUploads,
 *   fileUploads, fetchImpl }`.
 * @returns `{ ctx, registered, prompts, logs, tool, uploads, fetchCalls }`.
 */
export function createFakeHost(options = {}) {
  const registered = []
  const logs = []
  const createdController = options.controller === undefined ? createFakeController(options) : undefined
  const controller = options.controller ?? createdController.controller
  const prompts = createdController?.prompts ?? []
  const createdUploads = options.fileUploads === undefined ? createFakeFileUploads() : undefined
  const fileUploads = options.fileUploads ?? createdUploads.fileUploads
  const uploads = createdUploads?.uploads ?? []
  const fetchCalls = []
  const fetchImpl = options.fetchImpl ?? (async (url) => {
    fetchCalls.push(String(url))
    throw new Error(`unexpected fetch in test: ${String(url)}`)
  })
  const ctx = {
    logger: {
      info: (...args) => logs.push({ level: 'info', args }),
      warn: (...args) => logs.push({ level: 'warn', args }),
      debug: () => {}
    },
    tools: options.omitTools === true
      ? undefined
      : {
          register(definition) {
            registered.push(definition)
            return () => {}
          }
        },
    ...options.omitSessionController === true ? {} : { sessionController: controller },
    ...options.omitFileUploads === true ? {} : { fileUploads },
    fetch: fetchImpl
  }
  apply(ctx, options.config)
  return { ctx, registered, prompts, logs, tool: registered[0], uploads, fetchCalls, controller }
}

/** Run one tool call with an optional execution carrier. */
export function callTool(host, args, exec = {}) {
  return host.tool.execute(args, exec)
}

/** A fresh not-aborted signal. */
export function liveSignal() {
  return new AbortController().signal
}

/** Build a fetch response body from bytes. */
export function responseFromBytes(bytes, init = {}) {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
    ...init
  })
}
