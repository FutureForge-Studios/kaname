package io.ffstudios.kaname.feature.panels

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.createSavedStateHandle
import io.ffstudios.kaname.ui.components.NotEncryptedBadge
import io.ffstudios.kaname.ui.components.kanameViewModel
import io.ffstudios.kaname.ui.theme.KanameThemeExt

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PanelEditScreen(onBack: () -> Unit, onSaved: (panelId: String, isNew: Boolean) -> Unit) {
    val vm = kanameViewModel { PanelEditViewModel(it, createSavedStateHandle()) }
    val state by vm.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (state.isNew) "Add panel" else "Edit panel") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            OutlinedTextField(
                value = state.url,
                onValueChange = vm::onUrl,
                label = { Text("Panel address") },
                placeholder = { Text("https://panel.example.com or http://203.0.113.10") },
                singleLine = true,
                isError = state.urlError != null,
                supportingText = {
                    Text(state.urlError ?: "The address you open the web panel on. https:// is assumed if you leave the scheme off.")
                },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = state.label,
                onValueChange = vm::onLabel,
                label = { Text("Name (optional)") },
                placeholder = { Text("Production") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            if (state.looksCleartext) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    NotEncryptedBadge()
                    Text(
                        "Your password and session travel unencrypted over http://. That is how a fresh install " +
                            "answers on its IP; use it only on a network you trust, and switch to https:// once the panel has a domain.",
                        style = MaterialTheme.typography.bodySmall,
                        color = KanameThemeExt.status.warn,
                    )
                }
            }
            Button(
                onClick = { vm.save(onSaved) },
                enabled = state.loaded && !state.saving && state.url.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (state.isNew) "Save and sign in" else "Save") }
        }
    }
}
