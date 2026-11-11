package io.ffstudios.kaname.core.storage

import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/**
 * One panel's cookie jar.
 *
 * Whatever the control plane sets is kept — `kaname_session` over http,
 * `__Host-kaname_session` over https, or anything a future version adds —
 * so nothing here hard-codes a cookie name.
 *
 * Persistent cookies (with an expiry; "remember me") are written through to
 * [storage], which encrypts them. Session cookies (no expiry, from
 * `remember=false`) live in memory only and end with the process, which is
 * what the operator asked for by unticking "remember".
 */
class PersistentCookieJar(
    private val panelId: String,
    private val storage: CookieStorage,
    private val clock: () -> Long = System::currentTimeMillis,
) : CookieJar {
    private val cookies = mutableListOf<Cookie>()
    private var loaded = false

    @Synchronized
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        ensureLoaded()
        var persistentChanged = false
        for (incoming in cookies) {
            val replaced = this.cookies.removeAll { it.sameIdentity(incoming) }
            this.cookies += incoming
            if (incoming.persistent || replaced) persistentChanged = true
        }
        if (pruneExpired()) persistentChanged = true
        if (persistentChanged) flush()
    }

    @Synchronized
    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        ensureLoaded()
        if (pruneExpired()) flush()
        return cookies.filter { it.matches(url) }
    }

    /** True when a session-bearing cookie is present (cheap "probably signed in" check). */
    @Synchronized
    fun hasCookies(): Boolean {
        ensureLoaded()
        pruneExpired()
        return cookies.isNotEmpty()
    }

    @Synchronized
    fun clear() {
        cookies.clear()
        loaded = true
        storage.clear(panelId)
    }

    private fun ensureLoaded() {
        if (loaded) return
        loaded = true
        val now = clock()
        cookies += storage.read(panelId).filter { it.expiresAt > now }.map { it.toOkHttp() }
    }

    /** Server clears a cookie by re-setting it already expired; drop those. */
    private fun pruneExpired(): Boolean {
        val now = clock()
        return cookies.removeAll { it.expiresAt <= now }
    }

    private fun flush() {
        storage.write(panelId, cookies.filter { it.persistent }.map(StoredCookie::from))
    }

    private fun Cookie.sameIdentity(other: Cookie) =
        name == other.name && domain == other.domain && path == other.path && hostOnly == other.hostOnly
}
