package io.ffstudios.kaname.navigation

import android.net.Uri

/**
 * Every destination in the app. String routes, so they are easy to read in
 * logs and to deep-link later. Always build them with the helpers below.
 * See android/ARCHITECTURE.md for which screen owns which route.
 */
object Routes {
    const val ARG_PANEL_ID = "panelId"
    const val ARG_SERVER_ID = "serverId"
    const val ARG_EXPIRED = "expired"

    /** Home: saved panels (Termius-style "hosts"). */
    const val PANELS = "panels"

    /** Add (no arg) or edit a panel. */
    const val PANEL_EDIT = "panel/edit?$ARG_PANEL_ID={$ARG_PANEL_ID}"
    fun panelEdit(panelId: String? = null) = if (panelId == null) "panel/edit" else "panel/edit?$ARG_PANEL_ID=${enc(panelId)}"

    /** Sign in to one panel; `expired=true` when bounced here by a 401. */
    const val LOGIN = "login/{$ARG_PANEL_ID}?$ARG_EXPIRED={$ARG_EXPIRED}"
    fun login(panelId: String, expired: Boolean = false) = "login/${enc(panelId)}?$ARG_EXPIRED=$expired"

    /** The panel's servers. */
    const val FLEET = "fleet/{$ARG_PANEL_ID}"
    fun fleet(panelId: String) = "fleet/${enc(panelId)}"

    /** Server detail with tabs (Overview / Services / Containers / Processes / Jobs). */
    const val SERVER = "server/{$ARG_PANEL_ID}/{$ARG_SERVER_ID}"
    fun server(panelId: String, serverId: String) = "server/${enc(panelId)}/${enc(serverId)}"

    /** Interactive shell on a server (placeholder until the terminal screen lands). */
    const val TERMINAL = "terminal/{$ARG_PANEL_ID}/{$ARG_SERVER_ID}"
    fun terminal(panelId: String, serverId: String) = "terminal/${enc(panelId)}/${enc(serverId)}"

    const val SETTINGS = "settings"

    private fun enc(s: String): String = Uri.encode(s)
}
