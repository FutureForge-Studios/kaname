package io.ffstudios.kaname.ui.components

import java.time.Duration
import java.time.Instant
import java.util.Locale

object Format {
    fun bytes(value: Long?): String {
        if (value == null) return "—"
        val units = listOf("B", "KiB", "MiB", "GiB", "TiB", "PiB")
        var v = value.toDouble()
        var i = 0
        while (v >= 1024 && i < units.lastIndex) {
            v /= 1024; i++
        }
        return if (i == 0) "$value B" else String.format(Locale.ROOT, "%.1f %s", v, units[i])
    }

    fun percent(value: Double): String = String.format(Locale.ROOT, "%.0f%%", value)

    fun uptime(seconds: Long?): String {
        if (seconds == null) return "—"
        val d = seconds / 86_400
        val h = (seconds % 86_400) / 3600
        val m = (seconds % 3600) / 60
        return when {
            d > 0 -> "${d}d ${h}h"
            h > 0 -> "${h}h ${m}m"
            else -> "${m}m"
        }
    }

    /** "3m ago" from an ISO-8601 timestamp; "—" when absent or unparsable. */
    fun ago(iso: String?, now: Instant = Instant.now()): String {
        val t = iso?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return "—"
        val s = Duration.between(t, now).seconds
        return when {
            s < 0 -> "just now"
            s < 60 -> "${s}s ago"
            s < 3600 -> "${s / 60}m ago"
            s < 86_400 -> "${s / 3600}h ago"
            else -> "${s / 86_400}d ago"
        }
    }

    /** `warning:disk /var 88% full` → `disk /var 88% full`. */
    fun healthReason(raw: String): String = raw.substringAfter(':', raw).trim()
}
