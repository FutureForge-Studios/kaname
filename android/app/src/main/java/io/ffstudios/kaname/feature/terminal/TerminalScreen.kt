package io.ffstudios.kaname.feature.terminal

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.createSavedStateHandle
import io.ffstudios.kaname.AppContainer
import io.ffstudios.kaname.navigation.Routes
import io.ffstudios.kaname.ui.components.kanameViewModel
import io.ffstudios.kaname.ui.theme.MonoStyle

/**
 * PLACEHOLDER for the terminal agent. Route: `terminal/{panelId}/{serverId}`.
 *
 * Wiring that already exists:
 * - `container.panelSessions.terminal(panel).openSession(serverId, cols, rows)` →
 *   `TerminalApi.Opened(ticket, webSocketUrl)`; the URL is rebuilt from the panel's
 *   base URL (see `PanelUrls.terminalWebSocketUrl`), not the server's `ws_url`.
 * - `container.panelSessions.client(panel).okHttp.newWebSocket(Request(url), listener)`
 *   — same cookie jar and connection pool. Ticket: 30 s, single use, IP-bound.
 * - Socket protocol (apps/control-plane/src/routes/terminal.ts): binary frames are
 *   raw PTY bytes both ways; text frames are control, e.g. `{"t":"resize","cols":..,"rows":..}`.
 */
class TerminalViewModel(
    @Suppress("unused") private val container: AppContainer,
    handle: SavedStateHandle,
) : ViewModel() {
    val panelId: String = checkNotNull(handle[Routes.ARG_PANEL_ID])
    val serverId: String = checkNotNull(handle[Routes.ARG_SERVER_ID])
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(onBack: () -> Unit) {
    val vm = kanameViewModel { TerminalViewModel(it, createSavedStateHandle()) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Terminal") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("The terminal is coming in the next build.", style = MaterialTheme.typography.titleMedium)
            Text("server ${vm.serverId}", style = MonoStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
