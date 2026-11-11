package io.ffstudios.kaname.feature.panels

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.ffstudios.kaname.AppContainer
import io.ffstudios.kaname.core.api.PanelUrls
import io.ffstudios.kaname.core.model.Panel
import io.ffstudios.kaname.navigation.Routes
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

data class PanelEditUiState(
    val isNew: Boolean = true,
    val loaded: Boolean = false,
    val label: String = "",
    val url: String = "",
    val urlError: String? = null,
    val saving: Boolean = false,
) {
    /** Shown live while typing so the warning is seen before saving. */
    val looksCleartext: Boolean get() = url.trim().startsWith("http://", ignoreCase = true)
}

class PanelEditViewModel(
    private val container: AppContainer,
    handle: SavedStateHandle,
) : ViewModel() {
    private val panelId: String? = handle[Routes.ARG_PANEL_ID]
    private var existing: Panel? = null

    private val _state = MutableStateFlow(PanelEditUiState(isNew = panelId == null, loaded = panelId == null))
    val state: StateFlow<PanelEditUiState> = _state.asStateFlow()

    init {
        if (panelId != null) {
            viewModelScope.launch {
                existing = container.panelRepository.get(panelId)
                val p = existing
                _state.update {
                    if (p == null) it.copy(isNew = true, loaded = true) else it.copy(label = p.label, url = p.baseUrl, loaded = true)
                }
            }
        }
    }

    fun onLabel(v: String) = _state.update { it.copy(label = v) }
    fun onUrl(v: String) = _state.update { it.copy(url = v, urlError = null) }

    /** Saves and reports `(panelId, isNew)`. */
    fun save(onSaved: (String, Boolean) -> Unit) {
        val s = _state.value
        val parsed = PanelUrls.parse(s.url)
        if (parsed is PanelUrls.Parsed.Invalid) {
            _state.update { it.copy(urlError = parsed.reason) }
            return
        }
        val url = PanelUrls.canonical((parsed as PanelUrls.Parsed.Valid).url)
        val label = s.label.trim().ifEmpty { url.substringAfter("://") }
        _state.update { it.copy(saving = true) }
        viewModelScope.launch {
            val old = existing
            val panel = old?.copy(label = label, baseUrl = url)
                ?: Panel(id = UUID.randomUUID().toString(), label = label, baseUrl = url, createdAt = System.currentTimeMillis())
            // A session belongs to an origin; never replay it against a different URL.
            if (old != null && old.baseUrl != url) container.panelSessions.clearSession(old.id)
            container.panelRepository.upsert(panel)
            _state.update { it.copy(saving = false) }
            onSaved(panel.id, old == null)
        }
    }
}
