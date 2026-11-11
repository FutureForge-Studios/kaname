package io.ffstudios.kaname.core.auth

import io.ffstudios.kaname.core.api.AuthApi
import io.ffstudios.kaname.core.api.FleetApi
import io.ffstudios.kaname.core.api.JobsApi
import io.ffstudios.kaname.core.api.KanameApiClient
import io.ffstudios.kaname.core.api.TerminalApi
import io.ffstudios.kaname.core.model.Panel
import io.ffstudios.kaname.core.storage.CookieStorage
import io.ffstudios.kaname.core.storage.PersistentCookieJar
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient

/**
 * Owns one [KanameApiClient] (and cookie jar) per panel. All per-panel
 * clients derive from one base [OkHttpClient], so they share its connection
 * pool and dispatcher.
 *
 * A 401 on any authenticated call emits the panel id on [sessionExpired];
 * the nav host listens and routes back to that panel's login screen.
 */
class PanelSessions(
    private val baseClient: OkHttpClient,
    private val cookieStorage: CookieStorage,
) {
    private val clients = mutableMapOf<String, Entry>()

    private val _sessionExpired = MutableSharedFlow<String>(
        extraBufferCapacity = 8,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val sessionExpired: SharedFlow<String> = _sessionExpired.asSharedFlow()

    private class Entry(val baseUrl: String, val jar: PersistentCookieJar, val client: KanameApiClient)

    @Synchronized
    fun client(panel: Panel): KanameApiClient = entry(panel).client

    fun auth(panel: Panel) = AuthApi(client(panel))
    fun fleet(panel: Panel) = FleetApi(client(panel))
    fun jobs(panel: Panel) = JobsApi(client(panel))
    fun terminal(panel: Panel) = TerminalApi(client(panel))

    @Synchronized
    fun hasStoredSession(panel: Panel): Boolean = entry(panel).jar.hasCookies()

    /** Drops this panel's cookies (sign out locally, or panel deleted / URL changed). */
    @Synchronized
    fun clearSession(panelId: String) {
        clients.remove(panelId)?.jar?.clear() ?: cookieStorage.clear(panelId)
    }

    private fun entry(panel: Panel): Entry {
        clients[panel.id]?.let { if (it.baseUrl == panel.baseUrl) return it }
        val jar = PersistentCookieJar(panel.id, cookieStorage)
        val ok = baseClient.newBuilder().cookieJar(jar).build()
        val client = KanameApiClient(panel.baseUrl.toHttpUrl(), ok, onSessionExpired = { _sessionExpired.tryEmit(panel.id) })
        return Entry(panel.baseUrl, jar, client).also { clients[panel.id] = it }
    }
}
