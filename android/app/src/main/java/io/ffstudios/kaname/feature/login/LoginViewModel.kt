package io.ffstudios.kaname.feature.login

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.ffstudios.kaname.AppContainer
import io.ffstudios.kaname.core.api.ApiException
import io.ffstudios.kaname.core.api.ApiResult
import io.ffstudios.kaname.core.auth.LoginOutcome
import io.ffstudios.kaname.core.model.Panel
import io.ffstudios.kaname.navigation.Routes
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class LoginUiState(
    val panel: Panel? = null,
    val missingPanel: Boolean = false,
    val sessionExpired: Boolean = false,
    val email: String = "",
    val password: String = "",
    val remember: Boolean = true,
    /** Non-null once the server asked for a second factor. */
    val totpChallenge: String? = null,
    val code: String = "",
    val busy: Boolean = false,
    val error: ApiException? = null,
)

class LoginViewModel(
    private val container: AppContainer,
    handle: SavedStateHandle,
) : ViewModel() {
    private val panelId: String = checkNotNull(handle[Routes.ARG_PANEL_ID])
    private val _state = MutableStateFlow(LoginUiState(sessionExpired = handle[Routes.ARG_EXPIRED] ?: false))
    val state: StateFlow<LoginUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            val panel = container.panelRepository.get(panelId)
            _state.update { it.copy(panel = panel, missingPanel = panel == null, email = panel?.lastEmail.orEmpty()) }
        }
    }

    fun onEmail(v: String) = _state.update { it.copy(email = v, error = null) }
    fun onPassword(v: String) = _state.update { it.copy(password = v, error = null) }
    fun onRemember(v: Boolean) = _state.update { it.copy(remember = v) }
    fun onCode(v: String) = _state.update { it.copy(code = v.take(64), error = null) }

    /** Back from the code step to the password step. */
    fun cancelTotp() = _state.update { it.copy(totpChallenge = null, code = "", error = null) }

    fun submit(onSignedIn: (String) -> Unit) {
        val s = _state.value
        val panel = s.panel ?: return
        if (s.busy) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val result = if (s.totpChallenge == null) {
                container.authRepository.login(panel, s.email, s.password, s.remember)
            } else {
                container.authRepository.submitTotp(panel, s.totpChallenge, s.code)
            }
            when (result) {
                is ApiResult.Failure -> _state.update { it.copy(busy = false, error = result.error) }
                is ApiResult.Success -> when (val outcome = result.value) {
                    is LoginOutcome.TotpRequired ->
                        _state.update { it.copy(busy = false, totpChallenge = outcome.challenge, code = "", password = "") }
                    is LoginOutcome.SignedIn -> {
                        _state.update { it.copy(busy = false, password = "", code = "") }
                        onSignedIn(panel.id)
                    }
                }
            }
        }
    }
}
