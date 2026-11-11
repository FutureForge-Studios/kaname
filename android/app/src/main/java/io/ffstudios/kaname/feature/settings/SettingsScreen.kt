package io.ffstudios.kaname.feature.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import io.ffstudios.kaname.BuildConfig
import io.ffstudios.kaname.ui.components.appContainer
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val settings = appContainer().settingsRepository
    val lockEnabled by settings.appLockEnabled.collectAsState(initial = false)
    val appLock = LocalAppLock.current
    val available = remember(appLock) { appLock?.isAvailable() == true }
    val scope = rememberCoroutineScope()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            ListItem(
                headlineContent = { Text("App lock") },
                supportingContent = {
                    Text(
                        if (available) {
                            "Require fingerprint, face or screen lock to open Kaname."
                        } else {
                            "Set up a screen lock or biometrics on this phone to use app lock."
                        },
                    )
                },
                trailingContent = {
                    Switch(
                        checked = lockEnabled,
                        enabled = available || lockEnabled,
                        onCheckedChange = { want ->
                            // Confirm with the authenticator either way, so a picked-up phone can't turn it off.
                            appLock?.authenticate(if (want) "Turn on app lock" else "Turn off app lock") { ok ->
                                if (ok) scope.launch { settings.setAppLock(want) }
                            }
                        },
                    )
                },
            )
            HorizontalDivider()
            ListItem(
                headlineContent = { Text("Sessions") },
                supportingContent = {
                    Text("Panel sessions are stored encrypted with a key kept in this phone's hardware keystore, and are never backed up.")
                },
            )
            HorizontalDivider()
            ListItem(headlineContent = { Text("Version") }, supportingContent = { Text(BuildConfig.VERSION_NAME) })
        }
    }
}
