package io.ffstudios.kaname.core.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Every failure the app can show, mirroring `ApiError` in apps/web/lib/api.ts.
 *
 * The control plane guarantees a machine [code], a human [message], an optional
 * [remediation] and optional per-field messages, so screens never have to fall
 * back to "something went wrong". Failures that happen before the server can
 * answer use the client codes in [ClientErrorCodes] with [status] = 0.
 */
class ApiException(
    val code: String,
    override val message: String,
    /** HTTP status, or 0 when the request never got an answer. */
    val status: Int,
    val remediation: Remediation? = null,
    /** Dotted field path -> message, ready to bind onto a form. */
    val fields: Map<String, String> = emptyMap(),
    val requestId: String? = null,
    /** Seconds from `Retry-After`, present on 429s. */
    val retryAfterSeconds: Long? = null,
    val detail: JsonElement? = null,
    cause: Throwable? = null,
) : Exception(message, cause) {

    /** True while retrying is plausibly useful rather than just noisy. */
    val retryable: Boolean
        get() = code == ClientErrorCodes.NETWORK_ERROR ||
            code == ErrorCodes.AGENT_TIMEOUT ||
            code == ErrorCodes.AGENT_OFFLINE ||
            code == ErrorCodes.RATE_LIMITED ||
            status >= 500

    val isUnauthenticated: Boolean get() = status == 401 || code == ErrorCodes.UNAUTHENTICATED

    override fun toString(): String = "ApiException($status $code: $message, request_id=$requestId)"
}

/** Codes from packages/contract/src/primitives.ts `errorCode`. Kept as strings so new codes never crash parsing. */
object ErrorCodes {
    const val BAD_REQUEST = "bad_request"
    const val VALIDATION_FAILED = "validation_failed"
    const val UNAUTHENTICATED = "unauthenticated"
    const val TOTP_REQUIRED = "totp_required"
    const val FORBIDDEN = "forbidden"
    const val NOT_FOUND = "not_found"
    const val CONFLICT = "conflict"
    const val RATE_LIMITED = "rate_limited"
    const val AGENT_OFFLINE = "agent_offline"
    const val AGENT_TIMEOUT = "agent_timeout"
    const val INTERNAL_ERROR = "internal_error"
}

/** Failures that happen before a control plane can answer at all. */
object ClientErrorCodes {
    const val NETWORK_ERROR = "network_error"
    const val TLS_ERROR = "tls_error"
    const val MALFORMED_RESPONSE = "malformed_response"
    const val INVALID_URL = "invalid_url"
}

@Serializable
data class Remediation(
    val summary: String,
    val actions: List<RemediationAction> = emptyList(),
)

@Serializable
data class RemediationAction(
    val label: String,
    /** A web-panel route; the app can't follow these, but shows the label. */
    val href: String? = null,
    val action: String? = null,
    /** Literal value the operator should copy (a DNS record, a command). */
    val copy: String? = null,
)

@Serializable
internal data class ErrorEnvelope(val error: ErrorBody? = null)

@Serializable
internal data class ErrorBody(
    val code: String? = null,
    val message: String? = null,
    val detail: JsonElement? = null,
    val remediation: Remediation? = null,
    val fields: Map<String, String>? = null,
    @kotlinx.serialization.SerialName("request_id") val requestId: String? = null,
)

internal fun fallbackCode(status: Int): String = when (status) {
    401 -> ErrorCodes.UNAUTHENTICATED
    403 -> ErrorCodes.FORBIDDEN
    404 -> ErrorCodes.NOT_FOUND
    409 -> ErrorCodes.CONFLICT
    422 -> ErrorCodes.VALIDATION_FAILED
    429 -> ErrorCodes.RATE_LIMITED
    else -> ErrorCodes.INTERNAL_ERROR
}

internal fun fallbackMessage(status: Int): String = when (status) {
    401 -> "This session is no longer signed in."
    403 -> "This account does not hold the permission for that."
    404 -> "That resource does not exist."
    429 -> "Too many attempts. Wait a moment and try again."
    else -> "The control plane answered $status."
}
