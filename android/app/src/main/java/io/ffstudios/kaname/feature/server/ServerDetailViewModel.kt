package io.ffstudios.kaname.feature.server

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.ffstudios.kaname.AppContainer
import io.ffstudios.kaname.core.api.ApiException
import io.ffstudios.kaname.core.api.ApiResult
import io.ffstudios.kaname.core.api.KanameApiClient
import io.ffstudios.kaname.core.api.Server
import io.ffstudios.kaname.core.model.Panel
import io.ffstudios.kaname.navigation.Routes
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ServerDetailUiState(
    val panel: Panel? = null,
    val server: Server? = null,
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val error: ApiException? = null,
)

/**
 * Loads the header (`GET /servers/:id`). Tab content should get its own
 * ViewModel (e.g. `ServicesViewModel`) built with the same [panelId]/[serverId]
 * from the SavedStateHandle and [client] from `container.panelSessions`.
 */
class ServerDetailViewModel(
    private val container: AppContainer,
    handle: SavedStateHandle,
) : ViewModel() {
    val panelId: String = checkNotNull(handle[Routes.ARG_PANEL_ID])
    val serverId: String = checkNotNull(handle[Routes.ARG_SERVER_ID])

    private val _state = MutableStateFlow(ServerDetailUiState())
    val state: StateFlow<ServerDetailUiState> = _state.asStateFlow()

    /** The panel's API client, for tab ViewModels that want to share it. */
    val client: KanameApiClient? get() = _state.value.panel?.let(container.panelSessions::client)

    init {
        viewModelScope.launch {
            _state.update { it.copy(panel = container.panelRepository.get(panelId)) }
            load()
        }
    }

    fun refresh() {
        _state.update { it.copy(refreshing = true) }
        viewModelScope.launch { load() }
    }

    private suspend fun load() {
        val panel = _state.value.panel ?: return _state.update { it.copy(loading = false, refreshing = false) }
        when (val r = container.panelSessions.fleet(panel).getServer(serverId)) {
            is ApiResult.Success -> _state.update { it.copy(server = r.value, loading = false, refreshing = false, error = null) }
            is ApiResult.Failure -> _state.update { it.copy(loading = false, refreshing = false, error = r.error) }
        }
    }
}
