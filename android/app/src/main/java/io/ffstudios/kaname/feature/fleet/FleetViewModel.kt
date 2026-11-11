package io.ffstudios.kaname.feature.fleet

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.ffstudios.kaname.AppContainer
import io.ffstudios.kaname.core.api.ApiException
import io.ffstudios.kaname.core.api.ApiResult
import io.ffstudios.kaname.core.api.ConnectionState
import io.ffstudios.kaname.core.api.HealthState
import io.ffstudios.kaname.core.api.Server
import io.ffstudios.kaname.core.model.Panel
import io.ffstudios.kaname.navigation.Routes
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class FleetUiState(
    val panel: Panel? = null,
    val servers: List<Server> = emptyList(),
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val error: ApiException? = null,
    val query: String = "",
) {
    val filtered: List<Server> get() = filterServers(servers, query)
    val connectedCount: Int get() = servers.count { it.connectionState == ConnectionState.Connected }
    val unhealthyCount: Int
        get() = servers.count { it.healthState == HealthState.Warning || it.healthState == HealthState.Critical }
}

/** Matches name, hostname, address, OS and label keys/values; all terms must match. */
fun filterServers(servers: List<Server>, query: String): List<Server> {
    val terms = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (terms.isEmpty()) return servers
    return servers.filter { s ->
        val hay = buildString {
            append(s.name).append(' ').append(s.hostname).append(' ')
            append(s.address.orEmpty()).append(' ').append(s.os.orEmpty()).append(' ')
            append(s.provider.orEmpty()).append(' ').append(s.connection).append(' ').append(s.health).append(' ')
            s.labels.forEach { (k, v) -> append(k).append('=').append(v).append(' ') }
            if (s.simulated) append("simulated")
        }.lowercase()
        terms.all { hay.contains(it) }
    }
}

class FleetViewModel(
    private val container: AppContainer,
    handle: SavedStateHandle,
) : ViewModel() {
    val panelId: String = checkNotNull(handle[Routes.ARG_PANEL_ID])
    private val _state = MutableStateFlow(FleetUiState())
    val state: StateFlow<FleetUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            val panel = container.panelRepository.get(panelId)
            _state.update { it.copy(panel = panel) }
            load()
        }
    }

    fun onQuery(q: String) = _state.update { it.copy(query = q) }

    fun refresh() {
        if (_state.value.refreshing) return
        _state.update { it.copy(refreshing = true) }
        viewModelScope.launch { load() }
    }

    private suspend fun load() {
        val panel = _state.value.panel ?: return _state.update { it.copy(loading = false, refreshing = false) }
        when (val r = container.panelSessions.fleet(panel).listAllServers()) {
            is ApiResult.Success -> _state.update {
                it.copy(servers = r.value.sortedBy { s -> s.name.lowercase() }, loading = false, refreshing = false, error = null)
            }
            // Keep the last good list on screen; show the error above it.
            is ApiResult.Failure -> _state.update { it.copy(loading = false, refreshing = false, error = r.error) }
        }
    }

    fun signOut(onDone: () -> Unit) {
        val panel = _state.value.panel ?: return onDone()
        viewModelScope.launch {
            container.authRepository.logout(panel)
            onDone()
        }
    }
}
