package io.ffstudios.kaname

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import io.ffstudios.kaname.feature.settings.AppLockController
import io.ffstudios.kaname.feature.settings.LocalAppLock
import io.ffstudios.kaname.navigation.KanameNavHost
import io.ffstudios.kaname.ui.theme.KanameTheme

/** Single activity. A FragmentActivity because BiometricPrompt needs one. */
class MainActivity : FragmentActivity() {
    private lateinit var appLock: AppLockController

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        appLock = AppLockController(this)
        val settings = (application as KanameApp).container.settingsRepository

        setContent {
            KanameTheme {
                val lockEnabled by settings.appLockEnabled.collectAsState(initial = null)
                CompositionLocalProvider(LocalAppLock provides appLock) {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        when {
                            lockEnabled == null -> Unit // reading settings; show nothing rather than flash content
                            lockEnabled == true && !appLock.unlocked -> LockScreen(onUnlock = ::promptUnlock)
                            else -> KanameNavHost()
                        }
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        appLock.onStart()
    }

    override fun onStop() {
        super.onStop()
        appLock.onStop(isChangingConfigurations)
    }

    private fun promptUnlock() {
        appLock.authenticate(getString(R.string.unlock_title), getString(R.string.unlock_subtitle))
    }
}

@Composable
private fun LockScreen(onUnlock: () -> Unit) {
    LaunchedEffect(Unit) { onUnlock() }
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Icon(Icons.Outlined.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Text("Kaname is locked", style = MaterialTheme.typography.titleLarge)
            Button(onClick = onUnlock) { Text("Unlock") }
        }
    }
}
