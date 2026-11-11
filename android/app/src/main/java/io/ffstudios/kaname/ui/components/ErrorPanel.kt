package io.ffstudios.kaname.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.ffstudios.kaname.core.api.ApiException
import io.ffstudios.kaname.core.api.ErrorCodes
import io.ffstudios.kaname.ui.theme.MonoStyle

/**
 * Renders an [ApiException] the way the web panel does: the message, then the
 * remediation summary (what to do about it), then the request id for support.
 */
@Composable
fun ErrorPanel(
    error: ApiException,
    modifier: Modifier = Modifier,
    onRetry: (() -> Unit)? = null,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
            contentColor = MaterialTheme.colorScheme.onSurface,
        ),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                Text(errorHeadline(error), style = MaterialTheme.typography.titleSmall)
            }
            error.remediation?.summary?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            error.remediation?.actions?.mapNotNull { it.copy }?.forEach { copy ->
                SelectionContainer { Text(copy, style = MonoStyle) }
            }
            if (error.fields.isNotEmpty()) {
                error.fields.forEach { (field, msg) ->
                    Text("$field: $msg", style = MaterialTheme.typography.bodySmall)
                }
            }
            error.requestId?.let {
                SelectionContainer {
                    Text("request $it", style = MonoStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (onRetry != null && error.retryable) {
                TextButton(onClick = onRetry, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                    Text("Retry")
                }
            }
        }
    }
}

/** The headline, with the 429 wait spelled out. */
fun errorHeadline(error: ApiException): String =
    if (error.code == ErrorCodes.RATE_LIMITED) {
        val wait = error.retryAfterSeconds?.let { " Try again in ${it}s." } ?: " Wait a minute and try again."
        "Too many attempts.$wait"
    } else {
        error.message
    }
