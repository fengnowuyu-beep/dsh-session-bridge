/**
 * Optional Host service access for dsh-session-bridge.
 *
 * A Cordis context throws when an uninjected service property is read
 * ("cannot get property ... without inject"), so the direct read is guarded and
 * `get` is the fallback for services the plugin deliberately does not inject
 * (for example `workspaceController` or `fileUploads`).
 *
 * @module dsh-session-bridge/services
 */

/**
 * Read one optional Host service without assuming this composition mounts it.
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
export function optionalProperty(ctx, name) {
  try {
    return ctx?.[name]
  } catch {
    return undefined
  }
}
