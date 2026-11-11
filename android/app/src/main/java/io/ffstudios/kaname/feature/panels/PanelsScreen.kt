package io.ffstudios.kaname.feature.panels

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.ffstudios.kaname.core.auth.PanelStatus
import io.ffstudios.kaname.core.model.Panel
import io.ffstudios.kaname.ui.components.NotEncryptedBadge
import io.ffstudios.kaname.ui.components.kanameViewModel
import io.ffstudios.kaname.ui.theme.KanameThemeExt
import io.ffstudios.kaname.ui.theme.MonoStyle

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PanelsScreen(
    onAddPanel: () -> Unit,
    onEditPanel: (String) -> Unit,
    onOpenFleet: (String) -> Unit,
    onSignIn: (String) -> Unit,
    onOpenSettings: () -> Unit,
) {
    val vm = kanameViewModel { PanelsViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    var confirmDelete by remember { mutableStateOf<Panel?>(null) }

    // Coming back from login / edit: re-check every panel's session.
    LifecycleResumeEffect(vm) {
        vm.refresh()
        onPauseOrDispose { }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Kaname") },
                actions = {
                    IconButton(onClick = onOpenSettings) { Icon(Icons.Outlined.Settings, contentDescription = "Settings") }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onAddPanel,
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("Add panel") },
            )
        },
    ) { padding ->
        val refreshing = state.statuses.values.any { it is PanelStatus.Checking }
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = vm::refresh,
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            if (state.loaded && state.panels.isEmpty()) {
                EmptyPanels(onAddPanel)
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 96.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(state.panels, key = { it.id }) { panel ->
                        val status = state.statuses[panel.id] ?: PanelStatus.Checking
                        PanelCard(
                            panel = panel,
                            status = status,
                            onClick = {
                                if (status is PanelStatus.SignedIn) onOpenFleet(panel.id) else onSignIn(panel.id)
                            },
                            onEdit = { onEditPanel(panel.id) },
                            onSignOut = { vm.signOut(panel) },
                            onDelete = { confirmDelete = panel },
                        )
                    }
                }
            }
        }
    }

    confirmDelete?.let { panel ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Remove ${panel.label}?") },
            text = { Text("This signs out and forgets the panel on this phone. Nothing changes on the panel itself.") },
            confirmButton = {
                TextButton(onClick = { vm.delete(panel); confirmDelete = null }) { Text("Remove") }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun EmptyPanels(onAddPanel: () -> Unit) {
    // A scrollable container so pull-to-refresh still works on an empty screen.
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(32.dp)) {
        item {
            Column(
                Modifier.fillMaxWidth().padding(top = 80.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(
                    Modifier.size(48.dp).background(MaterialTheme.colorScheme.primary, RoundedCornerShape(10.dp)),
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Outlined.Dns, contentDescription = null, tint = Color.White) }
                Text("No panels yet", style = MaterialTheme.typography.titleLarge)
                Text(
                    "Add the address of a Kaname panel — the same one you open in a browser — and sign in to see its servers.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = onAddPanel) { Text("Add your first panel") }
            }
        }
    }
}

@Composable
private fun PanelCard(
    panel: Panel,
    status: PanelStatus,
    onClick: () -> Unit,
    onEdit: () -> Unit,
    onSignOut: () -> Unit,
    onDelete: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(Modifier.padding(start = 16.dp, top = 14.dp, bottom = 14.dp, end = 4.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(panel.label, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (!panel.isEncrypted) NotEncryptedBadge()
                }
                Text(panel.displayHost, style = MonoStyle, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                Spacer(Modifier.size(2.dp))
                PanelStatusLine(status)
            }
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, contentDescription = "Panel actions") }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("Edit") }, onClick = { menu = false; onEdit() })
                    if (status is PanelStatus.SignedIn) {
                        DropdownMenuItem(text = { Text("Sign out") }, onClick = { menu = false; onSignOut() })
                    }
                    DropdownMenuItem(text = { Text("Remove") }, onClick = { menu = false; onDelete() })
                }
            }
        }
    }
}

@Composable
private fun PanelStatusLine(status: PanelStatus) {
    val s = KanameThemeExt.status
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        when (status) {
            PanelStatus.Checking -> {
                CircularProgressIndicator(Modifier.size(10.dp), strokeWidth = 1.5.dp)
                StatusText("Checking…", MaterialTheme.colorScheme.onSurfaceVariant)
            }
            is PanelStatus.SignedIn -> {
                Box(Modifier.size(8.dp).background(s.ok, RoundedCornerShape(50)))
                val who = status.session.user?.let { "${it.name} · ${it.email}" } ?: "Signed in"
                StatusText(who, MaterialTheme.colorScheme.onSurface)
            }
            PanelStatus.SignedOut -> {
                Box(Modifier.size(8.dp).background(s.neutral, RoundedCornerShape(50)))
                StatusText("Signed out — tap to sign in", MaterialTheme.colorScheme.onSurfaceVariant)
            }
            is PanelStatus.Unreachable -> {
                Box(Modifier.size(8.dp).background(s.danger, RoundedCornerShape(50)))
                StatusText(status.error.message, s.danger)
            }
        }
    }
}

@Composable
private fun StatusText(text: String, color: Color) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
}
