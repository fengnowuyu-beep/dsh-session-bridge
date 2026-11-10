/**
 * A minimal stand-in for the Cordis host: the real `apply` runs against fake
 * `tools`, `sessionController`, `workspaceController`, and `fileUploads`
 * services plus an injectable fetch. The suite exercises registration,
 * validation, attachment preparation, upload receipts, URL downloads, image
 * fallback, session creation, and workspace creation without booting DSH.
 */

import { basename } from 'node:path'

import { apply } from '../lib/index.js'

const DEFAULT_CATALOG = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash' },
  routableProviders: ['deepseek-official'],
  groups: [{
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      {
        id: 'deepseek-flash',
        name: 'Flash',
        reasoning: { efforts: [{ id: 'max', name: 'Max' }, { id: 'high', name: 'High' }], defaultEffort: 'max' }
      },
      {
        id: 'deepseek-v4-pro',
        name: 'Pro',
        reasoning: { efforts: [{ id: 'max', name: 'Max' }, { id: 'medium', name: 'Medium' }], defaultEffort: 'max' }
      }
    ]
  }],
  failures: []
}

/**
 * Build a fake controller that records prompt admission plus the session
 * create/select/rename calls used by `session_create`.
 * @param options - `promptResult`, `promptError`, `promptErrors`, `catalog`,
 *   `createError`, `selectError`, `renameError`.
 * @returns `{ controller, prompts, created, selections, renames }`.
 */
export function createFakeController(options = {}) {
  const prompts = []
  const created = []
  const selections = []
  const renames = []
  let call = 0
  let nextSession = 1
  const controller = {
    async prompt(request, signal) {
      prompts.push({ request, signal })
      const indexed = Array.isArray(options.promptErrors) ? options.promptErrors[call] : undefined
      const error = indexed !== undefined ? indexed : call === 0 ? options.promptError : undefined
      call += 1
      if (error !== undefined) throw error
      return options.promptResult === undefined ? { accepted: true } : options.promptResult
    },
    async create(request) {
      created.push(request)
      if (options.createError !== undefined) throw options.createError
      return { sessionId: `session-created-${nextSession++}` }
    },
    async modelCatalog() {
      if (options.catalogError !== undefined) throw options.catalogError
      return options.catalog ?? DEFAULT_CATALOG
    },
    async selectModel(request) {
      selections.push(request)
      if (options.selectError !== undefined) throw options.selectError
      return { selected: { ...request } }
    },
    async rename(request) {
      renames.push(request)
      if (options.renameError !== undefined) throw options.renameError
      return { title: request.title, seq: 1 }
    }
  }
  return { controller, prompts, created, selections, renames }
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
 * Build a fake workspace controller.
 * @returns `{ workspaceController, workspaces, renames }`.
 */
export function createFakeWorkspaceController() {
  const workspaces = []
  const renames = []
  let nextId = 1
  const workspaceController = {
    async create(request) {
      const existing = workspaces.find(workspace => workspace.path === request.path)
      if (existing !== undefined) return { workspace: { ...existing }, created: false }
      const workspace = {
        workspaceId: `workspace-${nextId++}`,
        path: request.path,
        title: basename(request.path),
        sessionIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      workspaces.push(workspace)
      return { workspace: { ...workspace }, created: true }
    },
    async rename(request) {
      renames.push(request)
      const workspace = workspaces.find(candidate => candidate.workspaceId === request.workspaceId)
      if (workspace === undefined) throw new Error('workspace not found')
      workspace.title = request.title
      workspace.updatedAt = Date.now()
      return { workspace: { ...workspace } }
    }
  }
  return { workspaceController, workspaces, renames }
}

/**
 * Build a fake workspace registry that resolves exact paths to workspace ids.
 * @param byPath - map of absolute path to `{ id, path }`.
 * @returns `{ resolveByPath }`.
 */
export function createFakeWorkspaceRegistry(byPath = {}) {
  return {
    async resolveByPath(path) {
      const entry = byPath[path]
      if (entry === undefined) return undefined
      return { id: entry.id, path: entry.path ?? path }
    }
  }
}

/**
 * Mount the plugin against a fake host.
 * @param options - `{ config, controller, promptResult, promptError,
 *   promptErrors, createError, selectError, renameError, catalog,
 *   omitSessionController, omitTools, omitFileUploads, omitWorkspaceController,
 *   omitWorkspaceRegistry, fileUploads, workspaceController, workspaceRegistry,
 *   workspacesByPath, fetchImpl }`.
 * @returns `{ ctx, registered, tools, prompts, logs, tool, uploads,
 *   fetchCalls, controller, created, selections, renames, workspaces,
 *   workspaceRegistry }`.
 */
export function createFakeHost(options = {}) {
  const registered = []
  const logs = []
  const createdController = options.controller === undefined ? createFakeController(options) : undefined
  const controller = options.controller ?? createdController.controller
  const prompts = createdController?.prompts ?? []
  const created = createdController?.created ?? []
  const selections = createdController?.selections ?? []
  const sessionRenames = createdController?.renames ?? []

  const createdUploads = options.fileUploads === undefined ? createFakeFileUploads() : undefined
  const fileUploads = options.fileUploads ?? createdUploads.fileUploads
  const uploads = createdUploads?.uploads ?? []

  const createdWorkspace = options.workspaceController === undefined ? createFakeWorkspaceController() : undefined
  const workspaceController = options.workspaceController ?? createdWorkspace.workspaceController
  const workspaces = createdWorkspace?.workspaces ?? []
  const workspaceRenames = createdWorkspace?.renames ?? []
  const workspaceRegistry = options.workspaceRegistry
    ?? createFakeWorkspaceRegistry(options.workspacesByPath ?? {})

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
    ...options.omitWorkspaceController === true ? {} : { workspaceController },
    ...options.omitWorkspaceRegistry === true ? {} : { workspaceRegistry },
    fetch: fetchImpl
  }
  apply(ctx, options.config)
  const tools = Object.fromEntries(registered.map(definition => [definition.name, definition]))
  return {
    ctx,
    registered,
    tools,
    prompts,
    logs,
    tool: tools.session_send,
    uploads,
    fetchCalls,
    controller,
    created,
    selections,
    renames: sessionRenames,
    workspaces,
    workspaceRenames,
    workspaceRegistry
  }
}

/** Run one tool call with an optional execution carrier. */
export function callTool(host, args, exec = {}) {
  return host.tool.execute(args, exec)
}

/** Run one named tool call. */
export function callNamedTool(host, name, args, exec = {}) {
  const tool = host.tools[name]
  if (tool === undefined) throw new Error(`tool ${name} was not registered`)
  return tool.execute(args, exec)
}

/** A fresh not-aborted signal. */
export function liveSignal() {
  return new AbortController().signal
}
