/**
 * Shared error type for dsh-session-bridge tools.
 * @module dsh-session-bridge/errors
 */

/** One refused or failed session-bridge operation, carrying a stable code. */
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
