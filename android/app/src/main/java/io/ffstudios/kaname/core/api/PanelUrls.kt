package io.ffstudios.kaname.core.api

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * URL rules for a saved panel.
 *
 * A panel's base URL is what the operator types: the origin the web panel
 * answers on, optionally with a path prefix if it sits behind a proxy
 * (`https://ops.example.com/kaname`). The REST API lives at `<base>/api/v1`.
 * Plain `http://` is allowed because the installer serves `http://<ip>` by
 * default; the UI badges such panels as not encrypted.
 */
object PanelUrls {
    const val API_PREFIX = "api/v1"

    sealed interface Parsed {
        data class Valid(val url: HttpUrl) : Parsed
        data class Invalid(val reason: String) : Parsed
    }

    /**
     * Normalises user input: trims, defaults the scheme to https, drops query,
     * fragment and trailing slashes, and strips a pasted `/api/v1` suffix.
     */
    fun parse(input: String): Parsed {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) return Parsed.Invalid("Enter the panel's address.")
        val withScheme = when {
            trimmed.startsWith("http://", ignoreCase = true) ||
                trimmed.startsWith("https://", ignoreCase = true) -> trimmed
            trimmed.contains("://") -> return Parsed.Invalid("Use an http:// or https:// address.")
            else -> "https://$trimmed"
        }
        val url = withScheme.toHttpUrlOrNull() ?: return Parsed.Invalid("That is not a valid address.")
        var segments = url.pathSegments.filter { it.isNotEmpty() }
        if (segments.size >= 2 && segments.takeLast(2) == listOf("api", "v1")) segments = segments.dropLast(2)
        val builder = url.newBuilder().query(null).fragment(null).encodedPath("/")
        segments.forEach { builder.addPathSegment(it) }
        return Parsed.Valid(builder.build())
    }

    /** Canonical string form stored on a panel: no trailing slash. */
    fun canonical(url: HttpUrl): String = url.toString().trimEnd('/')

    fun isEncrypted(baseUrl: String): Boolean = baseUrl.startsWith("https://", ignoreCase = true)

    /** `<base>/api/v1/<path>`; [path] may start with a slash and may not contain a query. */
    fun api(base: HttpUrl, path: String): HttpUrl {
        val builder = base.newBuilder()
        API_PREFIX.split('/').forEach { builder.addPathSegment(it) }
        path.trim('/').split('/').filter { it.isNotEmpty() }.forEach { builder.addPathSegment(it) }
        return builder.build()
    }

    /**
     * The terminal socket URL for [ticket], rebuilt from the panel's own base
     * URL rather than trusting `ws_url` from the server: that one comes from
     * KANAME_CLIENT_API_URL, which may name a host the phone cannot reach.
     *
     * `http://10.0.0.5:4000` + ticket → `ws://10.0.0.5:4000/api/v1/terminal/<ticket>?cols=80&rows=24`.
     */
    fun terminalWebSocketUrl(baseUrl: String, ticket: String, cols: Int, rows: Int): String {
        val base = baseUrl.toHttpUrlOrNull() ?: error("Invalid panel base URL: $baseUrl")
        val http = api(base, "terminal").newBuilder()
            .addPathSegment(ticket)
            .addQueryParameter("cols", cols.toString())
            .addQueryParameter("rows", rows.toString())
            .build()
        val asString = http.toString()
        // OkHttp's WebSocket API accepts ws(s):// and maps it back to http(s); we
        // return the ws form so it is also correct for any other client.
        return if (http.isHttps) "wss://" + asString.removePrefix("https://") else "ws://" + asString.removePrefix("http://")
    }
}
