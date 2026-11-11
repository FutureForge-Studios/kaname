package io.ffstudios.kaname.core.terminal

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/**
 * The seam between the terminal UI and whatever carries its bytes.
 *
 * The terminal screen renders a [TerminalConnection] and knows nothing about
 * where it goes. Two transports implement it:
 *
 * - **Kaname** (the default): a ticketed WebSocket through the control plane
 *   (`POST /terminal/sessions` → `/api/v1/terminal/{ticket}`). Audited and
 *   recorded by the panel; the host needs no inbound port.
 * - **Direct SSH**: phone → host sshd with an on-device key. Bypasses the
 *   control plane entirely, so it is NOT ticketed, audited or recorded by
 *   Kaname — the UI must say so wherever it is offered.
 *
 * Bytes are raw PTY bytes in both directions; the UI does its own UTF-8 decode.
 */
interface TerminalConnection {
    /** Short label for tabs, e.g. "web-01" or "deploy@10.0.0.5". */
    val title: String

    /** Which path the bytes take; drives the "audited" vs "direct" badge. */
    val kind: TerminalKind

    val state: StateFlow<TerminalState>

    /** PTY output. Hot; collect once. Completes when the connection closes. */
    val output: Flow<ByteArray>

    /** Opens the connection. Safe to call once; failures land in [state]. */
    suspend fun connect(cols: Int, rows: Int)

    fun write(bytes: ByteArray)

    fun resize(cols: Int, rows: Int)

    /** Idempotent. */
    fun close(reason: String = "closed by user")
}

enum class TerminalKind { Kaname, KanameContainer, DirectSsh }

sealed interface TerminalState {
    data object Idle : TerminalState
    data object Connecting : TerminalState
    data object Open : TerminalState

    /** [code] is the WebSocket close code (4401, 4503, …) or null for SSH/network. */
    data class Closed(val reason: String, val code: Int? = null, val error: Boolean = false) : TerminalState
}
