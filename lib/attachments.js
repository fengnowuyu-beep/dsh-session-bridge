/**
 * Attachment preparation for dsh-session-bridge.
 *
 * There is no plugin-level size or count cap any more. Local files are opened
 * and streamed; URLs are downloaded once to a temporary file and streamed from
 * there, so a large attachment does not sit in memory. Raster images are
 * streamed through `fileUploads.uploadImageStream` (the Host still enforces its
 * own image limits) and generic files through `fileUploads.uploadStream`.
 *
 * Every URL download is bounded by time and redirect count only; those are
 * operational guards, not payload limits. Temporary files are removed by the
 * returned `cleanup` function after the send finishes, success or failure.
 *
 * @module dsh-session-bridge/attachments
 */

import { createReadStream } from 'node:fs'
import { mkdtemp, open, realpath, rm, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Maximum time one URL download may take. */
export const DOWNLOAD_TIMEOUT_MS = 30_000

/** Maximum time one file upload may take. */
export const UPLOAD_TIMEOUT_MS = 120_000

/** Maximum redirects followed for one URL. */
export const MAX_REDIRECTS = 5

/** Bytes read to recognise an image header. */
export const PREFIX_BYTES = 64

/** One refused or failed attachment operation. */
export class AttachmentInputError extends Error {
  /**
   * @param code - stable machine code.
   * @param message - user/agent-facing explanation.
   * @param options - standard `Error` options.
   */
  constructor(code, message, options = undefined) {
    super(message, options)
    this.name = 'AttachmentInputError'
    this.code = code
  }
}

/**
 * Detect the supported raster formats from their leading bytes.
 * Extension and Content-Type are advisory only.
 *
 * @param bytes - candidate header bytes.
 * @returns one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`, or
 *   undefined.
 */
export function imageMediaType(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return 'image/png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6) {
    const header = data.subarray(0, 6).toString('ascii')
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  }
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return undefined
}

/** Whether one input names an http(s) URL. */
function isHttpUrl(value) {
  return /^https?:\/\//iu.test(value)
}

/** Whether one input names a file URL. */
function isFileUrl(value) {
  return /^file:\/\//iu.test(value)
}

/** Compare a resolved path with a root, case-insensitively on Windows. */
function isInside(child, root) {
  const normalizedChild = process.platform === 'win32' ? child.toLowerCase() : child
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  if (normalizedChild === normalizedRoot) return true
  return normalizedChild.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`)
}

/**
 * Best-effort check for an IP literal or hostname that is obviously local.
 * DNS is intentionally not pinned; this is not an SSRF boundary.
 * @param hostname - URL hostname, brackets already removed.
 * @returns whether the host is obviously local/private.
 */
function isObviousLocalHost(hostname) {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const version = isIP(host)
  if (version === 4) {
    const parts = host.split('.').map(Number)
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
    const [a, b] = parts
    return a === 0
      || a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224
  }
  if (version === 6) {
    if (host === '::' || host === '::1') return true
    if (host.startsWith('fc') || host.startsWith('fd')) return true
    if (/^fe[89ab]/u.test(host)) return true
    if (host.startsWith('::ffff:')) {
      const mapped = host.slice(7)
      if (isIP(mapped) === 4) return isObviousLocalHost(mapped)
    }
  }
  return false
}

/**
 * Validate one URL before it is fetched.
 * @param raw - absolute URL string.
 * @param allowPrivateUrls - operator's explicit opt-in.
 * @throws {AttachmentInputError} when the URL is not http(s), carries
 *   credentials, or points at an obviously local host without opt-in.
 */
function assertUrlAllowed(raw, allowPrivateUrls) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new AttachmentInputError('bad-url', `不是有效的 URL：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AttachmentInputError('bad-url', `只支持 http(s) URL：${raw}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new AttachmentInputError('bad-url', 'URL 不能包含用户名或密码。')
  }
  if (allowPrivateUrls) return
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  if (isObviousLocalHost(hostname)) {
    throw new AttachmentInputError(
      'private-url',
      `URL 指向本机或内网地址（${url.hostname}），默认拒绝。`
      + '如确实需要，请在插件配置里设置 allowPrivateUrls: true。'
    )
  }
}

/**
 * A timeout signal that also cancels when its parent does.
 * @param parent - caller signal, possibly undefined.
 * @param milliseconds - timeout budget.
 * @param label - reason text used when the timer fires.
 * @returns `{ signal, dispose }`.
 */
function timeoutSignal(parent, milliseconds, label) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label}超时（${Math.round(milliseconds / 1000)} 秒）`))
  }, milliseconds)
  timer.unref?.()
  const onAbort = () => controller.abort(parent?.reason)
  if (parent?.aborted === true) controller.abort(parent.reason)
  else parent?.addEventListener?.('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      parent?.removeEventListener?.('abort', onAbort)
    }
  }
}

/** Add the extension implied by an image media type when the name has none. */
function ensureImageExtension(name, mediaType) {
  if (mediaType === undefined || extname(name) !== '') return name
  const extension = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp'
  }[mediaType]
  return `${name}${extension ?? ''}`
}

/** Read the first bytes of a file for raster detection. */
async function readPrefix(path, length = PREFIX_BYTES) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Validate one local file and return its path/name.
 * @param rawPath - absolute path, or a relative path resolved from `baseDir`.
 * @param options - `{ baseDir, allowFileRoots }`.
 * @returns `{ path, name }`.
 */
async function prepareLocalFile(rawPath, options) {
  const { baseDir, allowFileRoots } = options
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(baseDir ?? process.cwd(), rawPath)
  let info
  try {
    info = await stat(absolute)
  } catch (error) {
    throw new AttachmentInputError('file-not-found', `找不到附件文件：${rawPath}`, { cause: error })
  }
  if (!info.isFile()) {
    throw new AttachmentInputError('not-a-file', `附件不是普通文件：${rawPath}`)
  }
  if (allowFileRoots.length > 0) {
    const real = await realpath(absolute)
    let inside = false
    for (const root of allowFileRoots) {
      try {
        if (isInside(real, await realpath(resolve(root)))) {
          inside = true
          break
        }
      } catch {
        // An unusable configured root cannot match any file.
      }
    }
    if (!inside) {
      throw new AttachmentInputError('file-outside-roots', `附件“${rawPath}”不在 allowFileRoots 允许的目录内。`)
    }
  }
  return { path: absolute, name: basename(absolute) }
}

/** Pull a display name out of Content-Disposition, if one is present. */
function dispositionName(header) {
  if (typeof header !== 'string' || header === '') return ''
  const matched = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/iu.exec(header)
  if (matched === null) return ''
  try {
    return basename(decodeURIComponent(matched[1].trim()))
  } catch {
    return basename(matched[1].trim())
  }
}

/**
 * Download one http(s) URL to a temporary file. No payload size cap is applied;
 * the time and redirect limits are operational guards.
 *
 * @param raw - URL string.
 * @param options - `{ fetchImpl, allowPrivateUrls, signal, dir, index }`.
 * @returns `{ path, name }`.
 */
async function downloadUrlToFile(raw, options) {
  const { fetchImpl, allowPrivateUrls, signal, dir, index } = options
  if (typeof fetchImpl !== 'function') {
    throw new AttachmentInputError('download-unavailable', '当前运行环境没有可用的 fetch，无法下载 URL 附件。')
  }
  const timeout = timeoutSignal(signal, DOWNLOAD_TIMEOUT_MS, '下载附件')
  try {
    let current = raw
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      assertUrlAllowed(current, allowPrivateUrls)
      let response
      try {
        response = await fetchImpl(current, {
          method: 'GET',
          redirect: 'manual',
          signal: timeout.signal,
          headers: {
            accept: '*/*',
            'user-agent': 'dsh-session-bridge/0.2'
          }
        })
      } catch (error) {
        if (timeout.signal.aborted) {
          throw new AttachmentInputError('download-failed', `下载附件被取消或超时：${current}`, { cause: error })
        }
        throw new AttachmentInputError('download-failed', `下载附件失败：${current}`, { cause: error })
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null || location === '') {
          throw new AttachmentInputError('download-failed', `URL 返回重定向但没有 Location：${current}`)
        }
        if (redirects === MAX_REDIRECTS) {
          throw new AttachmentInputError('download-failed', `URL 重定向超过 ${MAX_REDIRECTS} 次：${raw}`)
        }
        current = new URL(location, current).toString()
        continue
      }
      if (!response.ok) {
        throw new AttachmentInputError('download-failed', `下载附件返回 HTTP ${response.status}：${current}`)
      }
      const filePath = join(dir, `attachment-${index + 1}`)
      const handle = await open(filePath, 'wx')
      let bytes = 0
      try {
        if (response.body !== null && response.body !== undefined) {
          for await (const chunk of response.body) {
            const buffer = Buffer.from(chunk)
            if (buffer.length === 0) continue
            await handle.write(buffer)
            bytes += buffer.length
          }
        } else {
          const buffer = Buffer.from(await response.arrayBuffer())
          if (buffer.length > 0) {
            await handle.write(buffer)
            bytes = buffer.length
          }
        }
      } finally {
        await handle.close()
      }
      if (bytes === 0) {
        throw new AttachmentInputError('download-failed', `URL 附件内容为空：${current}`)
      }
      const url = new URL(current)
      let name = ''
      try {
        name = basename(decodeURIComponent(url.pathname))
      } catch {
        name = basename(url.pathname)
      }
      if (name === '' || name === '/' || name === '\\') name = `attachment-${index + 1}`
      const headerName = dispositionName(response.headers.get('content-disposition'))
      return { path: filePath, name: headerName === '' ? name : headerName }
    }
  } finally {
    timeout.dispose()
  }
  throw new AttachmentInputError('download-failed', `下载附件失败：${raw}`)
}

/**
 * Resolve every attachment to a streamable local path.
 *
 * No count or byte cap is applied. URL downloads go to one temporary directory
 * owned by the returned cleanup function; call it after the send finishes.
 *
 * @param inputs - array of local paths, `file://`, or http(s) URLs.
 * @param options - `{ baseDir, allowFileRoots, allowPrivateUrls, fetchImpl, signal }`.
 * @returns `{ attachments, cleanup }`, each attachment `{ kind, name, path, mediaType? }`.
 */
export async function prepareAttachments(inputs, options = {}) {
  const list = Array.isArray(inputs) ? inputs : []
  let tempDir
  const cleanup = async () => {
    if (tempDir !== undefined) {
      const dir = tempDir
      tempDir = undefined
      await rm(dir, { recursive: true, force: true })
    }
  }
  const attachments = []
  try {
    for (let index = 0; index < list.length; index += 1) {
      const raw = typeof list[index] === 'string' ? list[index].trim() : ''
      if (raw === '') {
        throw new AttachmentInputError('bad-attachment', `第 ${index + 1} 个附件是空的。`)
      }
      let item
      if (isHttpUrl(raw)) {
        if (tempDir === undefined) {
          tempDir = await mkdtemp(join(tmpdir(), 'dsh-session-bridge-'))
        }
        item = await downloadUrlToFile(raw, {
          fetchImpl: options.fetchImpl,
          allowPrivateUrls: options.allowPrivateUrls === true,
          signal: options.signal,
          dir: tempDir,
          index
        })
      } else {
        const localPath = isFileUrl(raw) ? fileURLToPath(raw) : raw
        item = await prepareLocalFile(localPath, {
          baseDir: options.baseDir,
          allowFileRoots: Array.isArray(options.allowFileRoots) ? options.allowFileRoots : []
        })
      }
      const mediaType = imageMediaType(await readPrefix(item.path))
      attachments.push({
        kind: mediaType === undefined ? 'file' : 'image',
        name: ensureImageExtension(item.name, mediaType),
        path: item.path,
        ...mediaType === undefined ? {} : { mediaType }
      })
    }
    return { attachments, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/**
 * Upload one generic file into the *target* Session and return its receipt part.
 * The Host owns storage and validates the receipt at prompt admission.
 *
 * @param options - `{ fileUploads, sessionId, attachment, signal }`.
 * @returns `{ type: 'file', receiptId }`.
 */
export async function uploadFilePart({ fileUploads, sessionId, attachment, signal }) {
  if (fileUploads === undefined || fileUploads === null || typeof fileUploads.uploadStream !== 'function') {
    throw new AttachmentInputError(
      'file-uploads-unavailable',
      '当前 DSH 宿主没有 fileUploads.uploadStream，无法投递附件。'
      + '请确认运行在桌面 / Web 组合。'
    )
  }
  const timeout = timeoutSignal(signal, UPLOAD_TIMEOUT_MS, '上传附件')
  try {
    const result = await fileUploads.uploadStream({
      sessionId,
      name: attachment.name,
      data: createReadStream(attachment.path),
      signal: timeout.signal
    })
    if (result === undefined || result === null || typeof result.receiptId !== 'string' || result.receiptId === '') {
      throw new AttachmentInputError('upload-failed', `附件“${attachment.name}”上传后没有拿到 receiptId。`)
    }
    return { type: 'file', receiptId: result.receiptId }
  } catch (error) {
    if (error instanceof AttachmentInputError) throw error
    if (timeout.signal.aborted) {
      throw new AttachmentInputError('upload-failed', `上传附件“${attachment.name}”被取消或超时。`, { cause: error })
    }
    throw new AttachmentInputError(
      'upload-failed',
      `附件“${attachment.name}”上传失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  } finally {
    timeout.dispose()
  }
}

/**
 * Upload one raster image into the *target* Session and return the stored image
 * content part the Host's prompt admission accepts.
 *
 * @param options - `{ fileUploads, sessionId, attachment, signal }`.
 * @returns `{ type: 'image', attachment, encodedBytes }`.
 */
export async function uploadImagePart({ fileUploads, sessionId, attachment, signal }) {
  if (fileUploads === undefined || fileUploads === null || typeof fileUploads.uploadImageStream !== 'function') {
    throw new AttachmentInputError(
      'file-uploads-unavailable',
      '当前 DSH 宿主没有 fileUploads.uploadImageStream，无法投递图片附件。'
      + '请确认运行在桌面 / Web 组合。'
    )
  }
  const timeout = timeoutSignal(signal, UPLOAD_TIMEOUT_MS, '上传图片')
  try {
    const result = await fileUploads.uploadImageStream({
      sessionId,
      name: attachment.name,
      mediaType: attachment.mediaType,
      data: createReadStream(attachment.path),
      signal: timeout.signal
    })
    const image = result?.image
    if (image === undefined || image === null) {
      throw new AttachmentInputError('upload-failed', `图片“${attachment.name}”上传后没有拿到 image 引用。`)
    }
    // The Host currently returns the attachment ref itself (`attachmentId`,
    // `mediaType`, `bytes`, ...); accept a complete stored image part too so a
    // future shape change does not break the call.
    if (image.type === 'image' && image.attachment !== undefined) return image
    if (typeof image.attachmentId === 'string') {
      return {
        type: 'image',
        attachment: image,
        encodedBytes: Number.isFinite(Number(image.bytes)) ? Number(image.bytes) : 0
      }
    }
    throw new AttachmentInputError('upload-failed', `图片“${attachment.name}”上传后没有拿到可用的 image 引用。`)
  } catch (error) {
    if (error instanceof AttachmentInputError) throw error
    if (timeout.signal.aborted) {
      throw new AttachmentInputError('upload-failed', `上传图片“${attachment.name}”被取消或超时。`, { cause: error })
    }
    throw new AttachmentInputError(
      'upload-failed',
      `图片“${attachment.name}”上传失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  } finally {
    timeout.dispose()
  }
}
