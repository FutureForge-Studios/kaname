package io.ffstudios.kaname.core.auth

import io.ffstudios.kaname.core.api.ApiException
import io.ffstudios.kaname.core.api.ApiResult
import io.ffstudios.kaname.core.api.ClientErrorCodes
import io.ffstudios.kaname.core.api.LoginResponse
import io.ffstudios.kaname.core.api.SessionInfo
import io.ffstudios.kaname.core.api.User
import io.ffstudios.kaname.core.model.Panel
import io.ffstudios.kaname.core.storage.PanelRepository

/** What the login screen does next. */
sealed interface LoginOutcome {
    data class SignedIn(val user: User) : LoginOutcome
    data class TotpRequired(val challenge: String) : LoginOutcome
}

/** Connection state of a saved panel, as shown on its home-screen card. */
sealed interface PanelStatus {
    data object Checking : PanelStatus
    data class SignedIn(val session: SessionInfo) : PanelStatus
    data object SignedOut : PanelStatus
    data class Unreachable(val error: ApiException) : PanelStatus
}

class AuthRepository(
    private val sessions: PanelSessions,
    private val panels: PanelRepository,
) {
    suspend fun login(panel: Panel, email: String, password: String, remember: Boolean): ApiResult<LoginOutcome> {
        // A fresh sign-in replaces whatever the jar held.
        sessions.clearSession(panel.id)
        val result = sessions.auth(panel).login(email, password, remember)
        if (result is ApiResult.Success) panels.rememberEmail(panel.id, email.trim())
        return result.toOutcome()
    }

    suspend fun submitTotp(panel: Panel, challenge: String, code: String): ApiResult<LoginOutcome> =
        sessions.auth(panel).submitTotp(challenge, code).toOutcome()

    /** Server-side revoke when reachable; local cookies are dropped regardless. */
    suspend fun logout(panel: Panel) {
        if (sessions.hasStoredSession(panel)) sessions.auth(panel).logout()
        sessions.clearSession(panel.id)
    }

    suspend fun probe(panel: Panel): PanelStatus = when (val r = sessions.auth(panel).session()) {
        is ApiResult.Success -> if (r.value.user != null) PanelStatus.SignedIn(r.value) else PanelStatus.SignedOut
        // 401 = reachable but signed out; anything else (network, TLS, 5xx, not-Kaname) = unreachable.
        is ApiResult.Failure -> if (r.error.isUnauthenticated) PanelStatus.SignedOut else PanelStatus.Unreachable(r.error)
    }

    private fun ApiResult<LoginResponse>.toOutcome(): ApiResult<LoginOutcome> = when (this) {
        is ApiResult.Failure -> this
        is ApiResult.Success -> {
            val user = value.user
            val challenge = value.challenge
            when {
                value.status == "ok" && user != null -> ApiResult.Success(LoginOutcome.SignedIn(user))
                value.status == "totp_required" && challenge != null -> ApiResult.Success(LoginOutcome.TotpRequired(challenge))
                else -> ApiResult.Failure(
                    ApiException(ClientErrorCodes.MALFORMED_RESPONSE, "Unexpected sign-in response (${value.status}).", 200),
                )
            }
        }
    }
}
