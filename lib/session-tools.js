/**
 * Tools that create a Session or a Workspace.
 *
 * `session_create` uses `sessionController.create`, optionally
 * `sessionController.selectModel`, and optionally `sessionController.rename`.
 * Model/effort validation happens before the Session is created, so a typo in a
 * model id does not leave a half-configured blank Session behind.
 *
 * `workspace_create` creates the directory (optional) and registers it through
 * `workspaceController.create`; it can also rename the Workspace.
 *
 * @module dsh-session-bridge/session-tools
 */

import { mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { SessionBridgeError } from './errors.js'

/** Trim an optional string argument. */
function optionalText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Join a bounded number of labels for an error message. */
function formatList(values, limit = 12) {
  const list = values.filter(value => typeof value === 'string' && value !== '')
  if (list.length === 0) return '（无）'
  const shown = list.slice(0, limit)
  return list.length > shown.length ? `${shown.join(', ')} 等 ${list.length} 个` : shown.join(', ')
}

/** Error message from a Host failure, without losing a local cause. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Validate the requested model and reasoning effort against the Host catalog.
 *
 * @param controller - live `sessionController`.
 * @param args - raw tool arguments.
 * @returns `{ provider, model, reasoningEffort? }`, or undefined when neither a
 *   model nor an effort was requested.
 */
async function resolveModelSelection(controller, args) {
  const provider = optionalText(args?.provider)
  const model = optionalText(args?.model)
  const reasoningEffort = optionalText(args?.reasoningEffort)
  if (provider === '' && model === '' && reasoningEffort === '') return undefined
  if ((provider === '') !== (model === '')) {
    throw new SessionBridgeError('bad-model', 'provider 和 model 必须同时提供，或者都不提供。')
  }

  let catalog
  try {
    catalog = await controller.modelCatalog()
  } catch (error) {
    throw new SessionBridgeError('model-catalog-failed', `读取模型目录失败：${messageOf(error)}`, { cause: error })
  }
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  let selectedProvider = provider
  let selectedModel = model
  if (selectedProvider === '') {
    const fallback = catalog?.default
    if (fallback === undefined || typeof fallback.provider !== 'string' || typeof fallback.model !== 'string') {
      throw new SessionBridgeError('bad-model', '没有指定 provider/model，且宿主没有可用的默认模型。')
    }
    selectedProvider = fallback.provider
    selectedModel = fallback.model
  }

  const group = groups.find(candidate => candidate.id === selectedProvider)
  if (group === undefined) {
    throw new SessionBridgeError(
      'unknown-provider',
      `未知的模型提供方 "${selectedProvider}"；可用：${formatList(groups.map(candidate => candidate.id))}。`
    )
  }
  const entry = Array.isArray(group.models)
    ? group.models.find(candidate => candidate.id === selectedModel)
    : undefined
  if (entry === undefined) {
    throw new SessionBridgeError(
      'unknown-model',
      `提供方 "${selectedProvider}" 下没有模型 "${selectedModel}"；可用：${formatList((group.models ?? []).map(candidate => candidate.id))}。`
    )
  }

  if (reasoningEffort === '') return { provider: selectedProvider, model: selectedModel }
  const efforts = Array.isArray(entry.reasoning?.efforts)
    ? entry.reasoning.efforts.map(effort => effort.id)
    : []
  if (!efforts.includes(reasoningEffort)) {
    throw new SessionBridgeError(
      'unknown-reasoning-effort',
      `模型 "${selectedProvider}/${selectedModel}" 没有推理强度 "${reasoningEffort}"；可用：${formatList(efforts)}。`
    )
  }
  return { provider: selectedProvider, model: selectedModel, reasoningEffort }
}

/**
 * Build the `session_create` tool.
 * @param options - `{ getController, logger }`.
 * @returns a registry-ready tool definition.
 */
export function createSessionCreateTool({ getController, getWorkspaceRegistry, logger }) {
  return {
    name: 'session_create',
    description: '新建一个空白 DSH 会话（普通会话，不发送消息）。'
      + '可指定 cwd 或 workspaceId 之一；cwd 必须是已存在的绝对目录，workspaceId 可先用 workspace_create 创建。'
      + '可选 title 立即命名会话。'
      + '可选 provider + model 指定会话模型，reasoningEffort 指定推理强度；三者都不传则沿用宿主默认模型。'
      + '只传 reasoningEffort 时使用宿主默认模型加该推理强度。模型/强度会先对照宿主模型目录校验，避免创建出配置错误的会话。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: '会话工作目录，必须是绝对路径；与 workspaceId 二选一。' },
        workspaceId: { type: 'string', description: '目标工作区 ID；与 cwd 二选一。' },
        title: { type: 'string', description: '可选：创建后立即设置的会话标题。' },
        provider: { type: 'string', description: '可选：模型提供方 ID，例如 deepseek-official；必须与 model 同时提供。' },
        model: { type: 'string', description: '可选：模型 ID，例如 deepseek-v4-pro；必须与 provider 同时提供。' },
        reasoningEffort: { type: 'string', description: '可选：推理强度 ID，例如 max / high / medium / low；不传则使用模型默认值。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          created: { type: 'boolean' },
          sessionId: { type: 'string' },
          workspaceId: { type: 'string' },
          cwd: { type: 'string' },
          title: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          reasoningEffort: { type: 'string' }
        },
        required: ['created', 'sessionId', 'workspaceId', 'cwd', 'title', 'provider', 'model', 'reasoningEffort']
      },
      render: (_args, value) => {
        const parts = [`已创建会话 ${value.sessionId}`]
        if (value.title !== '') parts.push(`标题：${value.title}`)
        if (value.workspaceId !== '') parts.push(`工作区：${value.workspaceId}`)
        else if (value.cwd !== '') parts.push(`目录：${value.cwd}`)
        if (value.provider !== '') {
          parts.push(`模型：${value.provider}/${value.model}`)
          if (value.reasoningEffort !== '') parts.push(`推理强度：${value.reasoningEffort}`)
        } else {
          parts.push('模型：宿主默认')
        }
        return [{ type: 'text', text: `${parts.join('；')}。` }]
      }
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const cwd = optionalText(args?.cwd)
      const workspaceId = optionalText(args?.workspaceId)
      const title = optionalText(args?.title)
      if (cwd !== '' && workspaceId !== '') {
        throw new SessionBridgeError('bad-location', 'cwd 与 workspaceId 只能提供一个。')
      }
      if (cwd !== '' && !isAbsolute(cwd)) {
        throw new SessionBridgeError('bad-location', `cwd 必须是绝对路径：${cwd}`)
      }

      const controller = typeof getController === 'function' ? getController() : getController
      if (controller === undefined || controller === null || typeof controller.create !== 'function') {
        throw new SessionBridgeError(
          'host-unavailable',
          '当前 DSH 宿主没有提供 sessionController.create，无法新建会话。'
        )
      }

      // `sessionController.create` only attaches a Session to a Workspace when
      // it receives `workspaceId`. A cwd that matches a registered Workspace
      // therefore has to be resolved first, otherwise the new (already visible
      // after its first message) conversation never shows up in that
      // Workspace's sidebar list.
      let resolvedWorkspaceId = workspaceId
      let resolvedCwd = cwd
      if (cwd !== '' && workspaceId === '') {
        const registry = typeof getWorkspaceRegistry === 'function' ? getWorkspaceRegistry() : getWorkspaceRegistry
        if (registry !== undefined && registry !== null && typeof registry.resolveByPath === 'function') {
          try {
            const workspace = await registry.resolveByPath(cwd)
            if (workspace !== undefined && workspace !== null && workspace.id !== undefined) {
              resolvedWorkspaceId = String(workspace.id)
              if (typeof workspace.path === 'string' && workspace.path !== '') resolvedCwd = workspace.path
            }
          } catch (error) {
            // Resolution is best-effort: a missing directory or an unavailable
            // registry leaves the Session ungrouped and the Host reports the
            // real creation failure, rather than masking it here.
            logger?.debug?.(`session-bridge: could not resolve workspace for ${cwd}: ${messageOf(error)}`)
          }
        }
      }

      // Validate the model before creating anything, so a typo leaves no
      // half-configured blank Session behind.
      const requestedSelection = await resolveModelSelection(controller, args)

      let created
      try {
        created = await controller.create(
          resolvedWorkspaceId !== ''
            ? { workspaceId: resolvedWorkspaceId }
            : resolvedCwd !== '' ? { cwd: resolvedCwd } : {}
        )
      } catch (error) {
        throw new SessionBridgeError('session-create-failed', `新建会话失败：${messageOf(error)}`, { cause: error })
      }
      const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
      if (sessionId === '') {
        throw new SessionBridgeError('session-create-failed', '宿主创建会话后没有返回 sessionId。')
      }

      let selected = requestedSelection
      if (requestedSelection !== undefined) {
        try {
          const result = await controller.selectModel({ sessionId, ...requestedSelection })
          if (result?.selected !== undefined && result.selected !== null) selected = result.selected
        } catch (error) {
          throw new SessionBridgeError(
            'model-selection-failed',
            `会话 ${sessionId} 已创建，但设置模型失败：${messageOf(error)}`,
            { cause: error }
          )
        }
      }

      let finalTitle = ''
      if (title !== '') {
        if (typeof controller.rename !== 'function') {
          throw new SessionBridgeError(
            'title-failed',
            `会话 ${sessionId} 已创建，但当前宿主不支持重命名。`,
          )
        }
        try {
          const renamed = await controller.rename({ sessionId, title })
          finalTitle = typeof renamed?.title === 'string' ? renamed.title : title
        } catch (error) {
          throw new SessionBridgeError(
            'title-failed',
            `会话 ${sessionId} 已创建，但设置标题失败：${messageOf(error)}`,
            { cause: error }
          )
        }
      }

      logger?.info?.(
        `session-bridge: created session ${sessionId}`
        + `${selected === undefined ? ' with default model' : ` with ${selected.provider}/${selected.model}${selected.reasoningEffort === undefined ? '' : ` (${selected.reasoningEffort})`}`}`
      )
      return {
        created: true,
        sessionId,
        workspaceId: resolvedWorkspaceId,
        cwd: resolvedCwd,
        title: finalTitle,
        provider: selected?.provider ?? '',
        model: selected?.model ?? '',
        reasoningEffort: selected?.reasoningEffort ?? ''
      }
    }
  }
}

/**
 * Build the `workspace_create` tool.
 * @param options - `{ getWorkspaceController, logger }`.
 * @returns a registry-ready tool definition.
 */
export function createWorkspaceCreateTool({ getWorkspaceController, logger }) {
  return {
    name: 'workspace_create',
    description: '新建或复用一个 DSH 工作区（Workspace）。'
      + 'path 必须是绝对目录；默认会递归创建缺失目录，可传 createDirectory: false 要求目录已存在。'
      + '同一目录已有工作区时复用并返回 created: false。'
      + '可选 title 立即重命名工作区。工作区注册不删除目录、文件或会话。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '工作区目录的绝对路径。' },
        title: { type: 'string', description: '可选：工作区显示名称；不传则使用目录名。' },
        createDirectory: { type: 'boolean', description: '目录不存在时是否递归创建，默认 true。' }
      },
      required: ['path']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          created: { type: 'boolean' },
          workspaceId: { type: 'string' },
          path: { type: 'string' },
          title: { type: 'string' }
        },
        required: ['created', 'workspaceId', 'path', 'title']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.created ? '已创建工作区' : '已复用现有工作区'} ${value.title}`
          + `（workspaceId ${value.workspaceId}，path ${value.path}）。`
      }]
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const path = optionalText(args?.path)
      if (path === '') throw new SessionBridgeError('bad-path', 'path 不能为空。')
      if (!isAbsolute(path)) throw new SessionBridgeError('bad-path', `path 必须是绝对路径：${path}`)
      const title = optionalText(args?.title)
      const createDirectory = args?.createDirectory !== false

      const controller = typeof getWorkspaceController === 'function' ? getWorkspaceController() : getWorkspaceController
      if (controller === undefined || controller === null || typeof controller.create !== 'function') {
        throw new SessionBridgeError(
          'host-unavailable',
          '当前 DSH 宿主没有提供 workspaceController.create，无法新建工作区。'
        )
      }

      if (createDirectory) {
        try {
          await mkdir(path, { recursive: true })
        } catch (error) {
          throw new SessionBridgeError('workspace-directory-failed', `创建目录失败：${messageOf(error)}`, { cause: error })
        }
      }

      let result
      try {
        result = await controller.create({ path })
      } catch (error) {
        throw new SessionBridgeError('workspace-create-failed', `新建工作区失败：${messageOf(error)}`, { cause: error })
      }
      const workspace = result?.workspace
      const workspaceId = typeof workspace?.workspaceId === 'string' ? workspace.workspaceId : ''
      if (workspaceId === '') {
        throw new SessionBridgeError('workspace-create-failed', '宿主创建工作区后没有返回 workspaceId。')
      }

      let finalTitle = typeof workspace?.title === 'string' ? workspace.title : ''
      if (title !== '' && title !== finalTitle) {
        if (typeof controller.rename !== 'function') {
          throw new SessionBridgeError(
            'workspace-rename-failed',
            `工作区 ${workspaceId} 已创建，但当前宿主不支持重命名。`
          )
        }
        try {
          const renamed = await controller.rename({ workspaceId, title })
          finalTitle = typeof renamed?.workspace?.title === 'string' ? renamed.workspace.title : title
        } catch (error) {
          throw new SessionBridgeError(
            'workspace-rename-failed',
            `工作区 ${workspaceId} 已创建，但设置名称失败：${messageOf(error)}`,
            { cause: error }
          )
        }
      }

      logger?.info?.(`session-bridge: ${result.created === true ? 'created' : 'reused'} workspace ${workspaceId}`)
      return {
        created: result.created === true,
        workspaceId,
        path: typeof workspace?.path === 'string' ? workspace.path : path,
        title: finalTitle
      }
    }
  }
}
