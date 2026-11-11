package io.ffstudios.kaname.feature.panels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.ffstudios.kaname.AppContainer
import io.ffstudios.kaname.core.auth.PanelStatus
import io.ffstudios.kaname.core.model.Panel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class PanelsUiState(
    val loaded: Boolean = false,
    val panels: List<Panel> = emptyList(),
    val statuses: Map<String, PanelStatus> = emptyMap(),
)

class PanelsViewModel(private val container: AppContainer) : ViewModel() {
    private val statuses = MutableStateFlow<Map<String, PanelStatus>>(emptyMap())
    private val probedUrls = mutableMapOf<String, String>()

    val state: StateFlow<PanelsUiState> =
        combine(container.panelRepository.panels, statuses) { panels, st ->
            panels.forEach { p -> if (probedUrls[p.id] != p.baseUrl) probe(p) }
            PanelsUiState(loaded = true, panels = panels.sortedBy { it.label.lowercase() }, statuses = st)
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), PanelsUiState())

    fun refresh() {
        state.value.panels.forEach(::probe)
    }

    private fun probe(panel: Panel) {
        probedUrls[panel.id] = panel.baseUrl
        statuses.update { it + (panel.id to PanelStatus.Checking) }
        viewModelScope.launch {
            val status = container.authRepository.probe(panel)
            statuses.update { it + (panel.id to status) }
        }
    }

    fun signOut(panel: Panel) {
        viewModelScope.launch {
            container.authRepository.logout(panel)
            statuses.update { it + (panel.id to PanelStatus.SignedOut) }
        }
    }

    fun delete(panel: Panel) {
        viewModelScope.launch {
            container.authRepository.logout(panel)
            container.panelRepository.delete(panel.id)
            probedUrls.remove(panel.id)
            statuses.update { it - panel.id }
        }
    }
}
