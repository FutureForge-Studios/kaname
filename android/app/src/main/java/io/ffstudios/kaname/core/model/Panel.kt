package io.ffstudios.kaname.core.model

import io.ffstudios.kaname.core.api.PanelUrls
import kotlinx.serialization.Serializable

/**
 * A saved Kaname control plane — the app's equivalent of a Termius "host".
 * Each panel has its own cookie jar and therefore its own session.
 */
@Serializable
data class Panel(
    /** Stable, filesystem-safe id (UUID). Used in routes and as the cookie file name. */
    val id: String,
    val label: String,
    /** Canonical base URL, no trailing slash, e.g. `http://203.0.113.10` or `https://panel.example.com`. */
    val baseUrl: String,
    /** Pre-fills the login form. Never a password. */
    val lastEmail: String? = null,
    val createdAt: Long = 0,
) {
    val isEncrypted: Boolean get() = PanelUrls.isEncrypted(baseUrl)

    /** `panel.example.com` / `203.0.113.10:4000` for subtitles. */
    val displayHost: String
        get() = baseUrl.substringAfter("://")
}
