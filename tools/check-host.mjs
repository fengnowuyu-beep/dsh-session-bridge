/**
 * Check the host contract this plugin compiles against — directly out of the
 * installed `app.asar`, without unpacking it or booting DSH.
 *
 *   node tools/check-host.mjs [app.asar]
 *
 * The plugin calls `ctx.sessionController.prompt({ requestId, sessionId, mode,
 * content }, signal)` and the Loader injects the service under the name
 * `sessionController`. If a DSH upgrade ever changes either fact, this check
 * fails here instead of at the first cross-session send.
 *
 * Exit codes: 0 = contract matches, 1 = mismatch, 2 = archive/package missing.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'

const DEFAULT_ASAR = 'D:/Software/DeepSeek Harness/resources/app.asar'
const archive = process.argv[2] ?? process.env.DSH_ASAR ?? DEFAULT_ASAR

/** Read the asar header (JSON file tree) and the byte offset where data begins. */
function readArchive(path) {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const pickleSize = head.readUInt32LE(4)
    const jsonLength = head.readUInt32LE(12)
    if (jsonLength <= 2 || jsonLength > size) throw new Error(`implausible asar header length ${jsonLength}`)
    const buffer = Buffer.alloc(jsonLength)
    readSync(fd, buffer, 0, jsonLength, 16)
    return {
      header: JSON.parse(buffer.toString('utf8')),
      dataOffset: 8 + pickleSize
    }
  } finally {
    closeSync(fd)
  }
}

/** Find one entry by exact archive path. */
function findEntry(node, wanted, path = '') {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = path === '' ? name : `${path}/${name}`
    if (full === wanted) return entry
    if (entry.files !== undefined) {
      const found = findEntry(entry, wanted, full)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** Read one file entry's bytes. */
function readEntry(path, entry, dataOffset) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(Number(entry.size))
    readSync(fd, buffer, 0, buffer.length, dataOffset + Number(entry.offset))
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

let archiveInfo
try {
  archiveInfo = readArchive(archive)
} catch (error) {
  process.stderr.write(`无法读取 app.asar：${archive}\n${String(error?.message ?? error)}\n`)
  process.exit(2)
}

const PREFIX = 'dsh/node_modules/@deepseek-ai/dsh-api-session-controller'
const controllerEntry = findEntry(archiveInfo.header, `${PREFIX}/lib/index.js`)
const packageEntry = findEntry(archiveInfo.header, `${PREFIX}/package.json`)
if (controllerEntry === undefined) {
  process.stderr.write(`归档里找不到 ${PREFIX}/lib/index.js —— 这版 DSH 可能没有挂载会话控制器。\n`)
  process.exit(2)
}

const source = readEntry(archive, controllerEntry, archiveInfo.dataOffset)
const version = packageEntry === undefined
  ? '未知'
  : JSON.parse(readEntry(archive, packageEntry, archiveInfo.dataOffset)).version

const UPLOAD_PREFIX = 'dsh/node_modules/@deepseek-ai/dsh-client-file-upload'
const uploadEntry = findEntry(archiveInfo.header, `${UPLOAD_PREFIX}/lib/index.js`)
const uploadPackageEntry = findEntry(archiveInfo.header, `${UPLOAD_PREFIX}/package.json`)
const uploadSource = uploadEntry === undefined
  ? ''
  : readEntry(archive, uploadEntry, archiveInfo.dataOffset)
const uploadVersion = uploadPackageEntry === undefined
  ? '未知'
  : JSON.parse(readEntry(archive, uploadPackageEntry, archiveInfo.dataOffset)).version

const checks = [
  { source, label: '服务名 sessionController', pattern: /super\(ctx, ["']sessionController["']/u },
  { source, label: 'prompt(request, signal) 对外入口', pattern: /async prompt\(request, signal\)\s*\{/u },
  { source, label: 'prompt 交给内部 commands.prompt', pattern: /this\.commands\.prompt\(request, source\)/u },
  { source, label: 'mode=steer 分支', pattern: /request\.mode === ["']steer["']/u },
  { source, label: 'steer 调用 agent.steer', pattern: /agent\.steer\(message\)/u },
  { source, label: '默认 queue 走 agent.followup', pattern: /agent\.followup\(message\)/u },
  { source, label: 'list(_request, signal) 返回 items', pattern: /async list\(_request, signal\)[\s\S]{0,400}?items:\s*\(await this\.listState\.list\(signal\)\)/u },
  { source, label: 'hasPromptContent 接受非文本内容', pattern: /function hasPromptContent\(content\)\s*\{/u },
  { source, label: 'file 内容按 receipt 解析', pattern: /part\.type !== ["']file["'][\s\S]{0,300}?staged\(part\.receiptId\)/u },
  { source: uploadSource, label: '服务名 fileUploads', pattern: /super\(ctx, ["']fileUploads["']\)/u },
  { source: uploadSource, label: 'fileUploads.uploadStream(request)', pattern: /async uploadStream\(request\)\s*\{/u },
  { source: uploadSource, label: 'fileUploads.uploadImageStream(request)', pattern: /async uploadImageStream\(request\)\s*\{/u }
]

process.stdout.write(`app.asar: ${archive}\n`)
process.stdout.write(`会话控制器版本: ${version}\n`)
process.stdout.write(`文件上传服务版本: ${uploadVersion}\n`)
let failed = 0
for (const check of checks) {
  if (check.pattern.test(check.source)) {
    process.stdout.write(`  ok   ${check.label}\n`)
  } else {
    failed += 1
    process.stdout.write(`  FAIL ${check.label}\n`)
  }
}

if (failed > 0) {
  process.stdout.write(`\n宿主契约不匹配：${checks.length - failed}/${checks.length} 项通过。插件可能需要跟着 DSH 升级调整。\n`)
  process.exit(1)
}
process.stdout.write(`\n宿主契约匹配：${checks.length}/${checks.length} 项通过。\n`)
