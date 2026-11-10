/**
 * Configuration normalization for dsh-session-bridge.
 *
 * There is deliberately no target allowlist and no payload size/count cap: the
 * operator asked for every ordinary session to be addressable and for
 * attachments to be limited only by the Host and the filesystem/network. What
 * remains are two optional fences for the file/URL surface:
 *
 *  - `allowFileRoots` — when non-empty, local attachments must resolve inside
 *    one of these directories. Empty means "no path restriction".
 *  - `allowPrivateUrls` — when false (default), http(s) downloads refuse
 *    loopback / private / link-local IP literals. Hostnames are not pinned by
 *    DNS here; this is a best-effort fence, not an SSRF boundary.
 *
 * Normalization is forgiving about *shape* and strict about *effect*: blank or
 * non-string root entries are dropped, and a misspelled mode falls back to
 * `queue`. Nothing is inferred.
 *
 * @module dsh-session-bridge/config
 */

/** Delivery modes `sessionController.prompt` understands. */
export const SEND_MODES = Object.freeze(['queue', 'steer'])

/** Mode used when the config omits or misspells one. */
export const DEFAULT_SEND_MODE = 'queue'

/**
 * Turn raw Loader config into the object the tool actually uses.
 *
 * @param raw - the `config` object supplied by the profile patch row.
 * @returns `{ enabled, sendMode, allowFileRoots, allowPrivateUrls }`.
 */
export function normalizeConfig(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const roots = []
  const seen = new Set()
  if (Array.isArray(value.allowFileRoots)) {
    for (const entry of value.allowFileRoots) {
      if (typeof entry !== 'string') continue
      const root = entry.trim()
      if (root === '' || seen.has(root)) continue
      seen.add(root)
      roots.push(root)
    }
  }
  return Object.freeze({
    enabled: value.enabled !== false,
    sendMode: value.sendMode === 'steer' ? 'steer' : DEFAULT_SEND_MODE,
    allowFileRoots: Object.freeze(roots),
    allowPrivateUrls: value.allowPrivateUrls === true
  })
}
