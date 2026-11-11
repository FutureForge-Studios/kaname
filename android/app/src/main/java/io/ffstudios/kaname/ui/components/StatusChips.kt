package io.ffstudios.kaname.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.ffstudios.kaname.core.api.ConnectionState
import io.ffstudios.kaname.core.api.HealthState
import io.ffstudios.kaname.ui.theme.KanameThemeExt

/*
 * The two status axes (docs/design-system.md §6). Reachability and health are
 * independent and are NEVER collapsed into one dot: a box can be connected and
 * critical, or disconnected and unknown. Always render both chips.
 */

private enum class DotStyle { Solid, Pulse, Hollow }

@Composable
fun ConnectionChip(state: ConnectionState, modifier: Modifier = Modifier) {
    val s = KanameThemeExt.status
    val (label, color, style) = when (state) {
        ConnectionState.Connected -> Triple("Connected", s.ok, DotStyle.Solid)
        ConnectionState.Degraded -> Triple("Degraded", s.warn, DotStyle.Pulse)
        ConnectionState.Disconnected -> Triple("Disconnected", s.danger, DotStyle.Hollow)
        ConnectionState.NeverEnrolled -> Triple("Not enrolled", s.neutral, DotStyle.Hollow)
        ConnectionState.Revoked -> Triple("Revoked", s.danger, DotStyle.Hollow)
        ConnectionState.Unknown -> Triple("Unknown", s.neutral, DotStyle.Hollow)
    }
    StatusChip(label, color, style, "Reachability: $label", modifier)
}

@Composable
fun HealthChip(state: HealthState, modifier: Modifier = Modifier) {
    val s = KanameThemeExt.status
    val (label, color) = when (state) {
        HealthState.Healthy -> "Healthy" to s.ok
        HealthState.Warning -> "Warning" to s.warn
        HealthState.Critical -> "Critical" to s.danger
        HealthState.Unknown -> "Health unknown" to s.neutral
    }
    StatusChip(label, color, DotStyle.Solid, "Health: $label", modifier, square = true)
}

@Composable
private fun StatusChip(
    label: String,
    color: Color,
    style: DotStyle,
    description: String,
    modifier: Modifier = Modifier,
    square: Boolean = false,
) {
    Row(
        modifier = modifier
            .semantics { contentDescription = description }
            .background(color.copy(alpha = 0.12f), RoundedCornerShape(50))
            .padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Dot(color, style, square)
        Text(label, style = MaterialTheme.typography.labelMedium, color = color)
    }
}

@Composable
private fun Dot(color: Color, style: DotStyle, square: Boolean) {
    val shape = if (square) RoundedCornerShape(2.dp) else CircleShape
    val alpha = if (style == DotStyle.Pulse) {
        val t = rememberInfiniteTransition(label = "pulse")
        val a by t.animateFloat(1f, 0.35f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "pulseAlpha")
        a
    } else {
        1f
    }
    val m = Modifier.size(8.dp).alpha(alpha)
    when (style) {
        DotStyle.Hollow -> Box(m.border(1.5.dp, color, shape))
        else -> Box(m.background(color, shape))
    }
}

/** Plain-HTTP panel: credentials and the session cookie cross the network unencrypted. */
@Composable
fun NotEncryptedBadge(modifier: Modifier = Modifier) {
    Badge("NOT ENCRYPTED", KanameThemeExt.status.warn, modifier)
}

/** Simulated hosts are labelled unmistakably, as in the web panel. */
@Composable
fun SimulatedBadge(modifier: Modifier = Modifier) {
    Badge("SIMULATED", KanameThemeExt.status.info, modifier)
}

@Composable
fun Badge(text: String, color: Color, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier
            .border(1.dp, color.copy(alpha = 0.5f), RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 1.dp),
        style = MaterialTheme.typography.labelSmall,
        color = color,
    )
}
