package io.ffstudios.kaname.feature.login

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.createSavedStateHandle
import io.ffstudios.kaname.ui.components.ErrorPanel
import io.ffstudios.kaname.ui.components.NotEncryptedBadge
import io.ffstudios.kaname.ui.components.kanameViewModel
import io.ffstudios.kaname.ui.theme.KanameThemeExt
import io.ffstudios.kaname.ui.theme.MonoStyle

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreen(onBack: () -> Unit, onSignedIn: (panelId: String) -> Unit) {
    val vm = kanameViewModel { LoginViewModel(it, createSavedStateHandle()) }
    val state by vm.state.collectAsStateWithLifecycle()
    val submit = { vm.submit(onSignedIn) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.panel?.label ?: "Sign in") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            val panel = state.panel
            if (state.missingPanel) {
                Text("This panel no longer exists on this phone.")
                return@Column
            }
            if (panel != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(panel.displayHost, style = MonoStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (!panel.isEncrypted) NotEncryptedBadge()
                }
            }
            if (state.sessionExpired && state.error == null && state.totpChallenge == null) {
                Text(
                    "Your session on this panel ended. Sign in again to continue.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = KanameThemeExt.status.warn,
                )
            }

            if (state.totpChallenge == null) {
                Text("Sign in", style = MaterialTheme.typography.headlineSmall)
                OutlinedTextField(
                    value = state.email,
                    onValueChange = vm::onEmail,
                    label = { Text("Email") },
                    singleLine = true,
                    isError = state.error?.fields?.containsKey("email") == true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.Username },
                )
                OutlinedTextField(
                    value = state.password,
                    onValueChange = vm::onPassword,
                    label = { Text("Password") },
                    singleLine = true,
                    isError = state.error?.fields?.containsKey("password") == true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { submit() }),
                    modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.Password },
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = state.remember, onCheckedChange = vm::onRemember)
                    Column {
                        Text("Keep me signed in")
                        Text(
                            "Off: the session ends when the app is closed.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            } else {
                Text("Two-factor code", style = MaterialTheme.typography.headlineSmall)
                Text(
                    "Enter the 6-digit code from your authenticator app, or one of your recovery codes.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = state.code,
                    onValueChange = vm::onCode,
                    label = { Text("Code") },
                    singleLine = true,
                    textStyle = MonoStyle.copy(fontSize = MaterialTheme.typography.titleLarge.fontSize),
                    // Text, not number: recovery codes are alphanumeric.
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onGo = { submit() }),
                    modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.SmsOtpCode },
                )
                TextButton(onClick = vm::cancelTotp) { Text("Use a different account") }
            }

            state.error?.let { ErrorPanel(it) }

            val canSubmit = !state.busy && panel != null && if (state.totpChallenge == null) {
                state.email.isNotBlank() && state.password.isNotEmpty()
            } else {
                state.code.trim().length >= 6
            }
            Button(onClick = submit, enabled = canSubmit, modifier = Modifier.fillMaxWidth()) {
                if (state.busy) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Text(if (state.totpChallenge == null) "Sign in" else "Verify")
                }
            }
        }
    }
}
