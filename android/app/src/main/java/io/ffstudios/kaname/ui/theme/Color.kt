package io.ffstudios.kaname.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/*
 * Palette from packages/ui/src/styles/tokens.css (`--kn-*`), dark first.
 * Ink canvas, paper text, one purple accent; status colours carry meaning only.
 */
internal object Ink {
    val Bg = Color(0xFF0A0A0C)
    val BgInset = Color(0xFF060608)
    val Surface = Color(0xFF131316)
    val Surface2 = Color(0xFF1A1A1F)
    val Surface3 = Color(0xFF24242B)
    val Text = Color(0xFFF5F4F0)
    val Text2 = Color(0xFFB3B2AF)
    val Text3 = Color(0xFF8E8D8B)
    val Border = Color(0x14FFFFFF) // 8%
    val BorderStrong = Color(0x29FFFFFF) // 16%
    val Accent300 = Color(0xFFC9B6FF)
    val Accent400 = Color(0xFFA98DF8)
    val Accent500 = Color(0xFF7A4FF4)
    val Accent700 = Color(0xFF5A30D4)
    val Accent900 = Color(0xFF3B2391)
    val Ok = Color(0xFF4FE3CB)
    val Warn = Color(0xFFFBB13C)
    val Danger = Color(0xFFF45B69)
    val Info = Color(0xFF7CB7FF)
}

internal object Paper {
    val Bg = Color(0xFFF5F4F0)
    val BgInset = Color(0xFFECEAE4)
    val Surface = Color(0xFFFFFFFF)
    val Surface2 = Color(0xFFF0EEE9)
    val Surface3 = Color(0xFFE6E3DC)
    val Text = Color(0xFF0A0A0C)
    val Text2 = Color(0xFF52525B)
    val Text3 = Color(0xFF6B6B74)
    val Border = Color(0x1C09090B) // 11%
    val BorderStrong = Color(0x3809090B) // 22%
    val Accent400 = Color(0xFF6A3EE8)
    val Accent500 = Color(0xFF7A4FF4)
    val Accent700 = Color(0xFF5A30D4)
    val Ok = Color(0xFF0B7564)
    val Warn = Color(0xFF8F5300)
    val Danger = Color(0xFFC42B3C)
    val Info = Color(0xFF22639E)
}

/** Semantic status colours that Material's scheme has no slot for. */
@Immutable
data class StatusColors(
    val ok: Color,
    val warn: Color,
    val danger: Color,
    val info: Color,
    val neutral: Color,
    val hairline: Color,
    val hairlineStrong: Color,
    val inset: Color,
) {
    fun soft(c: Color): Color = c.copy(alpha = 0.12f)
}

internal val DarkStatus = StatusColors(Ink.Ok, Ink.Warn, Ink.Danger, Ink.Info, Ink.Text3, Ink.Border, Ink.BorderStrong, Ink.BgInset)
internal val LightStatus = StatusColors(Paper.Ok, Paper.Warn, Paper.Danger, Paper.Info, Paper.Text3, Paper.Border, Paper.BorderStrong, Paper.BgInset)

val LocalStatusColors = staticCompositionLocalOf { DarkStatus }
