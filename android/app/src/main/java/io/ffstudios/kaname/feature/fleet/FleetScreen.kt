package io.ffstudios.kaname.feature.fleet

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.createSavedStateHandle
import io.ffstudios.kaname.core.api.ConnectionState
import io.ffstudios.kaname.core.api.Server
import io.ffstudios.kaname.ui.components.ConnectionChip
import io.ffstudios.kaname.ui.components.ErrorPanel
import io.ffstudios.kaname.ui.components.Format
import io.ffstudios.kaname.ui.components.HealthChip
import io.ffstudios.kaname.ui.components.NotEncryptedBadge
import io.ffstudios.kaname.ui.components.SimulatedBadge
import io.ffstudios.kaname.ui.components.kanameViewModel
import io.ffstudios.kaname.ui.theme.KanameThemeExt
import io.ffstudios.kaname.ui.theme.MonoStyle

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen(
    onBack: () -> Unit,
    onOpenServer: (panelId: String, serverId: String) -> Unit,
    onSignedOut: () -> Unit,
) {
    val vm = kanameViewModel { FleetViewModel(it, createSavedStateHandle()) }
    val state by vm.state.collectAsStateWithLifecycle()
    var menu by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(state.panel?.label ?: "Servers", maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (state.panel?.isEncrypted == false) NotEncryptedBadge()
                        }
                        state.panel?.let {
                            Text(it.displayHost, style = MonoStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, contentDescription = "More") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(text = { Text("Refresh") }, onClick = { menu = false; vm.refresh() })
                            DropdownMenuItem(text = { Text("Sign out") }, onClick = { menu = false; vm.signOut(onSignedOut) })
                        }
                    }
                },
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.refreshing,
            onRefresh = vm::refresh,
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            LazyColumn(
                contentPadding = PaddingValues(16.dp, 4.dp, 16.dp, 24.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                item(key = "search") {
                    OutlinedTextField(
                        value = state.query,
                        onValueChange = vm::onQuery,
                        placeholder = { Text("Search name, host, IP, label…") },
                        leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
                        trailingIcon = {
                            if (state.query.isNotEmpty()) {
                                IconButton(onClick = { vm.onQuery("") }) { Icon(Icons.Outlined.Close, contentDescription = "Clear search") }
                            }
                        },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                if (!state.loading && state.servers.isNotEmpty()) {
                    item(key = "summary") {
                        Text(
                            "${state.servers.size} servers · ${state.connectedCount} connected · ${state.unhealthyCount} need attention",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                state.error?.let { err -> item(key = "error") { ErrorPanel(err, onRetry = vm::refresh) } }
                when {
                    state.loading -> item(key = "loading") {
                        Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    }
                    state.servers.isEmpty() && state.error == null -> item(key = "empty") {
                        Text(
                            "No servers on this panel yet. Enroll one from the web panel (Infrastructure → Servers → Add server).",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(vertical = 24.dp),
                        )
                    }
                    state.filtered.isEmpty() && state.servers.isNotEmpty() -> item(key = "nomatch") {
                        Text("Nothing matches “${state.query}”.", modifier = Modifier.padding(vertical = 24.dp))
                    }
                }
                items(state.filtered, key = { it.id }) { server ->
                    ServerCard(server, onClick = { onOpenServer(vm.panelId, server.id) })
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ServerCard(server: Server, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Card(
        modifier = modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    server.name,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (server.simulated) SimulatedBadge()
            }
            Text(
                listOfNotNull(server.hostname, server.address).distinct().joinToString("  ·  "),
                style = MonoStyle,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (server.platformLine.isNotEmpty()) {
                Text(server.platformLine, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            // Both axes, always, side by side (design-system.md §6).
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                ConnectionChip(server.connectionState)
                HealthChip(server.healthState)
            }
            if (server.connectionState != ConnectionState.Connected && server.lastSeenAt != null) {
                Text(
                    "Last seen ${Format.ago(server.lastSeenAt)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            server.healthReasons.firstOrNull()?.let { reason ->
                val more = server.healthReasons.size - 1
                Text(
                    Format.healthReason(reason) + if (more > 0) "  (+$more)" else "",
                    style = MaterialTheme.typography.bodySmall,
                    color = KanameThemeExt.status.warn,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            server.latest?.let { latest ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    MiniMeter("CPU", latest.cpuPercent, Modifier.weight(1f))
                    MiniMeter("MEM", latest.memoryPercent, Modifier.weight(1f))
                    latest.disks.maxByOrNull { it.usedPercent }?.let { MiniMeter("DISK", it.usedPercent, Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable
private fun MiniMeter(label: String, percent: Double, modifier: Modifier = Modifier) {
    val s = KanameThemeExt.status
    val color: Color = when {
        percent >= 90 -> s.danger
        percent >= 75 -> s.warn
        else -> MaterialTheme.colorScheme.primary
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row {
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Box(Modifier.width(6.dp))
            Text(Format.percent(percent), style = MonoStyle)
        }
        LinearProgressIndicator(
            progress = { (percent / 100.0).toFloat().coerceIn(0f, 1f) },
            color = color,
            trackColor = s.hairline,
            strokeCap = StrokeCap.Butt,
            gapSize = 0.dp,
            drawStopIndicator = {},
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
