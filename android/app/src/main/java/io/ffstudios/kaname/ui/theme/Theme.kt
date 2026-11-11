package io.ffstudios.kaname.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val DarkScheme = darkColorScheme(
    primary = Ink.Accent500,
    onPrimary = Color.White,
    primaryContainer = Ink.Accent900,
    onPrimaryContainer = Ink.Accent300,
    secondary = Ink.Accent400,
    onSecondary = Ink.Bg,
    tertiary = Ink.Ok,
    background = Ink.Bg,
    onBackground = Ink.Text,
    surface = Ink.Bg,
    onSurface = Ink.Text,
    surfaceVariant = Ink.Surface2,
    onSurfaceVariant = Ink.Text2,
    surfaceContainerLowest = Ink.BgInset,
    surfaceContainerLow = Ink.Surface,
    surfaceContainer = Ink.Surface,
    surfaceContainerHigh = Ink.Surface2,
    surfaceContainerHighest = Ink.Surface3,
    outline = Ink.BorderStrong,
    outlineVariant = Ink.Border,
    error = Ink.Danger,
    onError = Ink.Bg,
    errorContainer = Ink.Danger.copy(alpha = 0.14f),
    onErrorContainer = Ink.Danger,
)

private val LightScheme = lightColorScheme(
    primary = Paper.Accent500,
    onPrimary = Color.White,
    primaryContainer = Paper.Accent500.copy(alpha = 0.12f),
    onPrimaryContainer = Paper.Accent700,
    secondary = Paper.Accent400,
    onSecondary = Color.White,
    tertiary = Paper.Ok,
    background = Paper.Bg,
    onBackground = Paper.Text,
    surface = Paper.Bg,
    onSurface = Paper.Text,
    surfaceVariant = Paper.Surface2,
    onSurfaceVariant = Paper.Text2,
    surfaceContainerLowest = Paper.Surface,
    surfaceContainerLow = Paper.Surface,
    surfaceContainer = Paper.Surface,
    surfaceContainerHigh = Paper.Surface2,
    surfaceContainerHighest = Paper.Surface3,
    outline = Paper.BorderStrong,
    outlineVariant = Paper.Border,
    error = Paper.Danger,
    onError = Color.White,
    errorContainer = Paper.Danger.copy(alpha = 0.10f),
    onErrorContainer = Paper.Danger,
)

/** Monospace for hostnames, IPs, ids — matches the web panel's `--kn-font-mono` usage. */
val MonoFamily: FontFamily = FontFamily.Monospace

private val base = Typography()
private val KanameTypography = Typography(
    headlineSmall = base.headlineSmall.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.3).sp),
    titleLarge = base.titleLarge.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.2).sp),
    titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold),
    labelSmall = base.labelSmall.copy(letterSpacing = 1.2.sp, fontWeight = FontWeight.Medium),
)

private val KanameShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(6.dp),
    medium = RoundedCornerShape(8.dp),
    large = RoundedCornerShape(12.dp),
    extraLarge = RoundedCornerShape(16.dp),
)

@Composable
fun KanameTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalStatusColors provides if (darkTheme) DarkStatus else LightStatus) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkScheme else LightScheme,
            typography = KanameTypography,
            shapes = KanameShapes,
            content = content,
        )
    }
}

object KanameThemeExt {
    val status: StatusColors
        @Composable @ReadOnlyComposable get() = LocalStatusColors.current
}

val MonoStyle: TextStyle
    @Composable @ReadOnlyComposable get() = MaterialTheme.typography.bodySmall.copy(fontFamily = MonoFamily)
