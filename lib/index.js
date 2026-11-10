/**
 * dsh-session-bridge — Host half.
 *
 * Registers one model tool, `session_send`, which delivers a user message into
 * *another* DSH session through the Host `sessionController.prompt` service.
 * That is the same admission entry the IM bridge and the composer use, so the
 * target sees an ordinary user message and runs an ordinary turn; nothing is
 * injected into its system prompt and no transcript is rewritten.
 *
 * v0.2 deliberately has **no target allowlist and no plugin-level payload
 * cap**: every ordinary session is addressable, text is optional, and local
 * paths / `file://` / http(s) URLs can ride along as attachments. Files are
 * streamed rather than buffered, so the plugin itself does not impose a count
 * or byte limit. The Host still enforces its own image limits and session
 * gates.
 *
 * Images are sent through `fileUploads.uploadImageStream`; generic files
 * through `fileUploads.uploadStream`; when the target model does not accept
 * images, images are automatically retried as generic file attachments.
 *
 * The host contract this relies on (`sessionController.prompt({ requestId,
 * sessionId, mode, content }, signal)`, `fileUploads.uploadStream(...)`,
 * `fileUploads.uploadImageStream(...)`) is verified against the installed DSH
 * build; `tools/check-host.mjs` re-checks it on demand.
 *
 * @module dsh-session-bridge
 */

import { randomUUID } from 'node:crypto'

import {
  AttachmentInputError,
  prepareAttachments,
  uploadFilePart,
  uploadImagePart
} from './attachments.js'
import { normalizeConfig } from './config.js'

/** Stable Cordis plugin name. */
export const name = 'session-bridge'

/**
 * Services required before the tool can exist: the registry to mount into, and
 * the Host API that admits a prompt into another Session. `fileUploads` is
 * resolved lazily because a text-only send does not need it.
 */
export const inject = ['tools', 'sessionController']

/** The model-facing tool name. */
export const TOOL_NAME = 'session_send'

/** One refused or failed session send, carrying a stable machine code. */
export class SessionBridgeError extends Error {
  /**
   * @param code - stable code.
   * @param message - user/agent-facing explanation.
   * @param options - standard `Error` options (a preserved `cause`).
   */
  constructor(code, message, options = undefined) {
    super(message, options)
    this.name = 'SessionBridgeError'
    this.code = code
  }
}

/**
 * Read one optional Host service without assuming this composition mounts it.
 * A Cordis context throws when an uninjected service property is read, so the
 * direct read is guarded and `get` is the fallback for optional services.
 *
 * @param ctx - Cordis host context.
 * @param name - service name.
 * @returns the service, or undefined.
 */
export function resolveHostService(ctx, name) {
  try {
    const direct = ctx?.[name]
    if (direct !== undefined && direct !== null) return direct
  } catch {
    /* not injected into this context */
  }
  if (typeof ctx?.get === 'function') {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Read an optional non-service hook (tests inject `fetch`) without tripping the
 * same uninjected-property guard.
 * @param ctx - Cordis host context.
 * @param name - property name.
 * @returns the value, or undefined.
 */
function optionalProperty(ctx, name) {
  try {
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/**
 * Resolve the Host session controller.
 * @param ctx - Cordis host context.
 * @returns the controller, or undefined when this composition lacks one.
 */
export function resolveSessionController(ctx) {
  return resolveHostService(ctx, 'sessionController')
}

/**
 * Validate and normalize the target id.
 * @param value - raw `args.sessionId`.
 * @returns the trimmed id.
 * @throws {SessionBridgeError} when it is absent or contains control characters.
 */
function requireSessionId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (id === '') {
    throw new SessionBridgeError('bad-session-id', 'sessionId 不能为空；请给出目标会话的完整 ID（形如 session-<uuid>）。')
  }
  if (/[\u0000-\u001f\u007f]/u.test(id)) {
    throw new SessionBridgeError('bad-session-id', 'sessionId 含有控制字符，已拒绝。')
  }
  return id
}

/**
 * Validate and normalize the attachment list.
 * @param value - raw `args.attachments`.
 * @returns strings, or an empty array.
 * @throws {SessionBridgeError} when a non-array or non-string entry arrives.
 */
function requireAttachmentInputs(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new SessionBridgeError('bad-attachments', 'attachments 必须是字符串数组（本机路径、file:// 或 http(s) URL）。')
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new SessionBridgeError('bad-attachments', `第 ${index + 1} 个附件必须是字符串路径或 URL。`)
    }
    return entry
  })
}

/**
 * Use the caller's AbortSignal when it is a real one, otherwise give the Host a
 * signal it can safely call `throwIfAborted()` on.
 * @param exec - the tool execution carrier.
 * @returns an AbortSignal.
 */
function executionSignal(exec) {
  const candidate = exec?.signal
  if (candidate !== undefined && candidate !== null
    && typeof candidate.throwIfAborted === 'function'
    && typeof candidate.addEventListener === 'function') {
    return candidate
  }
  return new AbortController().signal
}

/** Read the target error's reason field across Host error shapes. */
function errorReason(error) {
  return error?.details?.reason
    ?? error?.reason
    ?? error?.cause?.details?.reason
    ?? ''
}

/**
 * Whether the Host refused a prompt because the target model lacks vision.
 * @param error - the prompt admission failure.
 * @returns whether the image path should be retried as generic files.
 */
function isImageUnsupported(error) {
  if (errorReason(error) === 'MODEL_DOES_NOT_SUPPORT_IMAGES') return true
  return /MODEL_DOES_NOT_SUPPORT_IMAGES|does not support image/iu.test(String(error?.message ?? error))
}

/** Turn an attachment failure into the tool's own typed failure. */
function attachmentFailure(error) {
  if (error instanceof SessionBridgeError) return error
  if (error instanceof AttachmentInputError) {
    return new SessionBridgeError(error.code, error.message, { cause: error })
  }
  return new SessionBridgeError(
    'attachment-failed',
    `处理附件失败：${error instanceof Error ? error.message : String(error)}`,
    { cause: error }
  )
}

/**
 * Build the first prompt's content: optional text, images uploaded as stored
 * image parts, generic files uploaded to the target Session and cited by
 * receipt.
 *
 * @returns `{ parts, entries }`, where entries let the image fallback reuse
 *   already-uploaded file parts.
 */
async function buildContent({ text, prepared, sessionId, fileUploads, signal }) {
  const parts = []
  if (text !== '') parts.push({ type: 'text', text })
  const entries = []
  for (const attachment of prepared) {
    if (attachment.kind === 'image') {
      const part = await uploadImagePart({ fileUploads, sessionId, attachment, signal })
      parts.push(part)
      entries.push({ kind: 'image', attachment, part })
    } else {
      const part = await uploadFilePart({ fileUploads, sessionId, attachment, signal })
      parts.push(part)
      entries.push({ kind: 'file', attachment, part })
    }
  }
  return { parts, entries }
}

/**
 * Rebuild the message with every image re-uploaded as a generic file, keeping
 * generic files that were already uploaded and any text.
 */
async function buildImageFallback({ text, entries, sessionId, fileUploads, signal }) {
  const parts = []
  if (text !== '') parts.push({ type: 'text', text })
  for (const entry of entries) {
    if (entry.kind === 'file') {
      parts.push(entry.part)
      continue
    }
    const part = await uploadFilePart({ fileUploads, sessionId, attachment: entry.attachment, signal })
    parts.push(part)
  }
  return { parts }
}

/**
 * Build the registry-ready `session_send` definition.
 *
 * Exported separately so the offline suite can drive `execute` with a fake
 * controller, exactly as the Loader would drive it with the real one.
 *
 * @param options - `{ getController, getFileUploads, getFetch, settings,
 *   logger }`.
 * @returns a tool definition accepted by `ctx.tools.register`.
 */
export function createSessionSendTool({
  getController,
  getFileUploads,
  getFetch,
  settings: rawSettings,
  logger
}) {
  const settings = normalizeConfig(rawSettings)
  return {
    name: TOOL_NAME,
    description: '向任意 DSH 会话投递一条用户消息（跨会话发消息）。'
      + '没有白名单限制：sessionId 可以是任何普通会话，但必须由用户明确给出；已归档或 subagent 会话仍由宿主 gate 决定。'
      + 'text 与 attachments 至少提供一个。attachments 支持本机文件路径、file:// URL 和 http(s) URL；'
      + '插件不设附件数量或大小上限，文件采用流式上传（宿主自己的图片限额仍然生效）。'
      + '图片（PNG/JPEG/WebP/GIF）作为图片内容发送，目标模型不支持视觉时自动降级为文件附件；'
      + '普通文件会上传到目标会话，模型拿到只读路径而不是字节。'
      + '投递成功只表示宿主已受理并放进目标会话的收件队列，不代表目标已经回答。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: {
          type: 'string',
          description: '目标 DSH 会话 ID，形如 session-<uuid>。'
        },
        text: {
          type: 'string',
          description: '要投递的文本；首尾空白会被去掉。text 与 attachments 至少提供一个。'
        },
        attachments: {
          type: 'array',
          items: { type: 'string' },
          description: '可选附件列表，每项是本机文件路径、file:// URL 或 http(s) URL；数量和大小由宿主/文件系统/网络决定。'
        }
      },
      required: ['sessionId']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'boolean' },
          sessionId: { type: 'string' },
          requestId: { type: 'string' },
          mode: { type: 'string' },
          attachments: { type: 'number' },
          images: { type: 'number' },
          files: { type: 'number' },
          imageFallback: { type: 'boolean' }
        },
        required: ['sent', 'sessionId', 'requestId', 'mode', 'attachments', 'images', 'files', 'imageFallback']
      },
      render: (_args, value) => {
        const counts = value.attachments > 0
          ? `，附件 ${value.attachments} 个（图片 ${value.images}、文件 ${value.files}）`
          : ''
        const fallback = value.imageFallback === true
          ? '；目标模型不支持图片，图片已降级为文件附件'
          : ''
        return [{
          type: 'text',
          text: `已投递到会话 ${value.sessionId}（requestId ${value.requestId}，模式 ${value.mode}${counts}${fallback}；宿主已受理，不代表对方已回复）。`
        }]
      }
    },
    async execute(args, exec) {
      const sessionId = requireSessionId(args?.sessionId)
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      const attachmentInputs = requireAttachmentInputs(args?.attachments)
      if (text === '' && attachmentInputs.length === 0) {
        throw new SessionBridgeError('bad-text', 'text 和 attachments 至少提供一个。')
      }

      exec?.signal?.throwIfAborted?.()

      const controller = typeof getController === 'function' ? getController() : getController
      if (controller === undefined || controller === null || typeof controller.prompt !== 'function') {
        throw new SessionBridgeError(
          'host-unavailable',
          '当前 DSH 宿主没有提供 sessionController.prompt，无法投递跨会话消息。'
          + '请确认插件运行在带 session-controller 的桌面 / Web 组合里。'
        )
      }

      const signal = executionSignal(exec)
      const fileUploads = typeof getFileUploads === 'function' ? getFileUploads() : getFileUploads
      const fetchImpl = typeof getFetch === 'function' ? getFetch() : getFetch
      const baseDir = typeof exec?.agent?.session?.header?.cwd === 'string' && exec.agent.session.header.cwd !== ''
        ? exec.agent.session.header.cwd
        : process.cwd()

      let prepared
      try {
        prepared = await prepareAttachments(attachmentInputs, {
          baseDir,
          allowFileRoots: settings.allowFileRoots,
          allowPrivateUrls: settings.allowPrivateUrls,
          fetchImpl,
          signal
        })
      } catch (error) {
        throw attachmentFailure(error)
      }

      try {
        const built = await buildContent({
          text,
          prepared: prepared.attachments,
          sessionId,
          fileUploads,
          signal
        })

        let requestId = randomUUID()
        let result
        let imageFallback = false
        try {
          result = await controller.prompt({
            requestId,
            sessionId,
            mode: settings.sendMode,
            content: built.parts
          }, signal)
        } catch (error) {
          if (!prepared.attachments.some(attachment => attachment.kind === 'image') || !isImageUnsupported(error)) {
            throw new SessionBridgeError(
              'delivery-failed',
              `向会话 ${sessionId} 投递失败：${error instanceof Error ? error.message : String(error)}`,
              { cause: error }
            )
          }
          imageFallback = true
          let fallback
          try {
            fallback = await buildImageFallback({
              text,
              entries: built.entries,
              sessionId,
              fileUploads,
              signal
            })
          } catch (fallbackError) {
            throw new SessionBridgeError(
              'attachment-failed',
              `目标模型不支持图片，且图片降级为文件附件失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
              { cause: fallbackError }
            )
          }
          requestId = randomUUID()
          try {
            result = await controller.prompt({
              requestId,
              sessionId,
              mode: settings.sendMode,
              content: fallback.parts
            }, signal)
          } catch (fallbackError) {
            throw new SessionBridgeError(
              'delivery-failed',
              `向会话 ${sessionId} 投递失败（已尝试把图片降级为文件附件）：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
              { cause: fallbackError }
            )
          }
        }
        if (result !== undefined && result !== null && result.accepted === false) {
          throw new SessionBridgeError(
            'delivery-rejected',
            `宿主拒绝了发往会话 ${sessionId} 的消息（accepted: false）。`
          )
        }

        const images = prepared.attachments.filter(attachment => attachment.kind === 'image').length
        const files = prepared.attachments.length - images
        logger?.info?.(
          `session-bridge: delivered ${requestId} to ${sessionId} (${settings.sendMode}, `
          + `${prepared.attachments.length} attachment(s)${imageFallback ? ', image fallback' : ''})`
        )
        return {
          sent: true,
          sessionId,
          requestId,
          mode: settings.sendMode,
          attachments: prepared.attachments.length,
          images,
          files,
          imageFallback
        }
      } finally {
        await prepared.cleanup()
      }
    }
  }
}

/**
 * Mount the Host half.
 * @param ctx - the Cordis host context (provides `tools` and `sessionController`).
 * @param config - optional Loader config (`enabled`, `sendMode`,
 *   `allowFileRoots`, `allowPrivateUrls`).
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const logger = ctx?.logger ?? console
  if (!settings.enabled) {
    logger.info?.('session-bridge: disabled by config')
    return
  }
  if (typeof ctx?.tools?.register !== 'function') {
    logger.warn?.('session-bridge: tools service is unavailable; session_send was not registered')
    return
  }
  const tool = createSessionSendTool({
    getController: () => resolveSessionController(ctx),
    getFileUploads: () => resolveHostService(ctx, 'fileUploads'),
    getFetch: () => {
      const injected = optionalProperty(ctx, 'fetch')
      return typeof injected === 'function' ? injected : globalThis.fetch
    },
    settings,
    logger
  })
  ctx.tools.register(tool)
  logger.info?.(
    `session-bridge: registered ${TOOL_NAME} (mode ${settings.sendMode}, `
    + `${settings.allowFileRoots.length === 0 ? 'unrestricted file roots' : `${settings.allowFileRoots.length} file root(s)`}, `
    + `${settings.allowPrivateUrls ? 'private URLs allowed' : 'private URLs blocked'})`
  )
}
