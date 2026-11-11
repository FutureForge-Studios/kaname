package io.ffstudios.kaname.feature.server

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.createSavedStateHandle
import io.ffstudios.kaname.core.api.Server
import io.ffstudios.kaname.ui.components.ConnectionChip
import io.ffstudios.kaname.ui.components.ErrorPanel
import io.ffstudios.kaname.ui.components.Format
import io.ffstudios.kaname.ui.components.HealthChip
import io.ffstudios.kaname.ui.components.SimulatedBadge
import io.ffstudios.kaname.ui.components.kanameViewModel
import io.ffstudios.kaname.ui.theme.KanameThemeExt
import io.ffstudios.kaname.ui.theme.MonoStyle

/** Tabs on the server screen. Each one's content is owned by [ServerTabContent]. */
enum class ServerTab(val title: String) {
    Overview("Overview"),
    Services("Services"),
    Containers("Containers"),
    Processes("Processes"),
    Jobs("Jobs"),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServerDetailScreen(
    onBack: () -> Unit,
    onOpenTerminal: (panelId: String, serverId: String) -> Unit,
) {
    val vm = kanameViewModel { ServerDetailViewModel(it, createSavedStateHandle()) }
    val state by vm.state.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(ServerTab.Overview) }
    val server = state.server

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(server?.name ?: "Server", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    IconButton(onClick = vm::refresh, enabled = !state.refreshing) {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
        floatingActionButton = {
            // The primary action on this screen: a shell on the box.
            if (server != null) {
                ExtendedFloatingActionButton(
                    onClick = { onOpenTerminal(vm.panelId, vm.serverId) },
                    icon = { Icon(Icons.Outlined.Terminal, contentDescription = null) },
                    text = { Text("Open terminal") },
                    containerColor = if (server.canOpenTerminal) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.surfaceContainerHighest
                    },
                    contentColor = if (server.canOpenTerminal) {
                        MaterialTheme.colorScheme.onPrimary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when {
                state.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                server == null -> state.error?.let { ErrorPanel(it, Modifier.padding(16.dp), onRetry = vm::refresh) }
                else -> {
                    state.error?.let { ErrorPanel(it, Modifier.padding(16.dp), onRetry = vm::refresh) }
                    ServerHeader(server)
                    PrimaryScrollableTabRow(selectedTabIndex = tab.ordinal, edgePadding = 16.dp) {
                        ServerTab.entries.forEach { t ->
                            Tab(selected = tab == t, onClick = { tab = t }, text = { Text(t.title) })
                        }
                    }
                    HorizontalDivider()
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        ServerTabContent(tab, vm.panelId, server)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ServerHeader(server: Server) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(server.hostname, style = MonoStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (server.simulated) SimulatedBadge()
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            ConnectionChip(server.connectionState)
            HealthChip(server.healthState)
        }
        if (!server.canOpenTerminal) {
            Text(
                "The agent is not connected, so a terminal cannot open right now.",
                style = MaterialTheme.typography.bodySmall,
                color = KanameThemeExt.status.warn,
            )
        }
    }
}

/**
 * EXTENSION POINT for the server-detail agent: replace each placeholder with
 * the real tab (e.g. `ServicesTab(panelId, server.id)` in feature/server/services/).
 */
@Composable
fun ServerTabContent(tab: ServerTab, panelId: String, server: Server) {
    when (tab) {
        ServerTab.Overview -> OverviewTab(server)
        ServerTab.Services -> PlaceholderTab("Services", "systemd units with start / stop / restart.")
        ServerTab.Containers -> PlaceholderTab("Containers", "Docker / Podman containers on this host.")
        ServerTab.Processes -> PlaceholderTab("Processes", "Live process list with signals.")
        ServerTab.Jobs -> PlaceholderTab("Jobs", "Recent jobs that targeted this server.")
    }
}

@Composable
private fun OverviewTab(server: Server) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (server.healthReasons.isNotEmpty()) {
            Text("Why", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            server.healthReasons.forEach {
                Text("• " + Format.healthReason(it), color = KanameThemeExt.status.warn, style = MaterialTheme.typography.bodyMedium)
            }
        }
        Fact("Address", server.address ?: "—", mono = true)
        Fact("Platform", server.platformLine.ifEmpty { "—" })
        Fact("Kernel", server.kernel ?: "—", mono = true)
        Fact("CPU", listOfNotNull(server.cpuModel, server.cpuCores?.let { "$it cores" }).joinToString(" · ").ifEmpty { "—" })
        Fact("Memory", Format.bytes(server.memoryTotal))
        Fact("Uptime", Format.uptime(server.uptimeSeconds))
        Fact("Last seen", Format.ago(server.lastSeenAt))
        Fact("Agent", server.agentVersion ?: "—", mono = true)
        Fact("Provider", server.provider ?: "—")
        server.latest?.let { l ->
            Fact("CPU now", Format.percent(l.cpuPercent))
            Fact("Memory used", "${Format.bytes(l.memoryUsed)} of ${Format.bytes(l.memoryTotal)}")
            l.disks.forEach { d -> Fact("Disk ${d.mount}", "${Format.percent(d.usedPercent)} of ${Format.bytes(d.total)}") }
        }
        if (server.labels.isNotEmpty()) {
            Fact("Labels", server.labels.entries.joinToString("  ") { "${it.key}=${it.value}" }, mono = true)
        }
        Spacer(Modifier.height(72.dp)) // keep clear of the FAB
    }
}

@Composable
private fun Fact(label: String, value: String, mono: Boolean = false) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(0.38f))
        Text(value, style = if (mono) MonoStyle else MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(0.62f))
    }
}

@Composable
private fun PlaceholderTab(title: String, description: String) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(description, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("Coming soon in the app — use the web panel for now.", style = MaterialTheme.typography.bodySmall)
    }
}
