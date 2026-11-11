package io.ffstudios.kaname.core.api

import kotlinx.serialization.json.JsonObject

/*
 * Typed endpoint groups. Each is a thin, stateless wrapper over one panel's
 * [KanameApiClient]. Add new groups here (ServicesApi, ContainersApi, ...)
 * rather than calling the client with raw paths from screens.
 */

/** apps/control-plane/src/routes/auth.ts */
class AuthApi(private val client: KanameApiClient) {
    suspend fun login(email: String, password: String, remember: Boolean): ApiResult<LoginResponse> =
        client.post(
            "auth/login",
            LoginResponse.serializer(),
            client.encode(LoginRequest(email.trim(), password, remember)),
            allowUnauthenticated = true,
        )

    /** Second leg. [code] may be a 6-digit TOTP or a recovery code. */
    suspend fun submitTotp(challenge: String, code: String): ApiResult<LoginResponse> =
        client.post(
            "auth/totp",
            LoginResponse.serializer(),
            client.encode(TotpRequest(challenge, code.trim().replace(" ", ""))),
            allowUnauthenticated = true,
        )

    /** 401 here means "signed out", not "expired", so it never fires the expiry event. */
    suspend fun session(): ApiResult<SessionInfo> =
        client.get("auth/session", SessionInfo.serializer(), allowUnauthenticated = true)

    suspend fun logout(): ApiResult<Unit> =
        client.requestUnit(KanameApiClient.Method.POST, "auth/logout", allowUnauthenticated = true)
}

/** apps/control-plane/src/routes/servers.ts + dashboard.ts */
class FleetApi(private val client: KanameApiClient) {
    suspend fun listServers(
        page: Int = 1,
        perPage: Int = 100,
        q: String? = null,
        connection: String? = null,
        health: String? = null,
    ): ApiResult<Paged<Server>> = client.getPage(
        "servers",
        Server.serializer(),
        mapOf("page" to page, "per_page" to perPage, "q" to q, "connection" to connection, "health" to health),
    )

    /** Walks every page (bounded) so the fleet list is complete. */
    suspend fun listAllServers(maxPages: Int = 20): ApiResult<List<Server>> {
        val all = mutableListOf<Server>()
        var page = 1
        while (page <= maxPages) {
            when (val r = listServers(page = page)) {
                is ApiResult.Failure -> return r
                is ApiResult.Success -> {
                    all += r.value.data
                    if (!r.value.meta.hasMore) return ApiResult.Success(all)
                }
            }
            page++
        }
        return ApiResult.Success(all)
    }

    suspend fun getServer(id: String): ApiResult<Server> = client.get("servers/$id", Server.serializer())

    /** Shape not modelled yet (samples + range); decode it when a screen needs it. */
    suspend fun serverMetrics(id: String, range: String = "24h"): ApiResult<JsonObject> =
        client.get("servers/$id/metrics", JsonObject.serializer(), mapOf("range" to range))

    suspend fun syncServer(id: String): ApiResult<Job> = client.postForJob("servers/$id/sync")

    suspend fun dashboard(): ApiResult<JsonObject> = client.get("dashboard", JsonObject.serializer())
}

/** apps/control-plane/src/routes/jobs.ts */
class JobsApi(private val client: KanameApiClient) {
    suspend fun list(serverId: String? = null, page: Int = 1, perPage: Int = 50): ApiResult<Paged<Job>> =
        client.getPage("jobs", Job.serializer(), mapOf("server_id" to serverId, "page" to page, "per_page" to perPage))

    suspend fun get(id: String): ApiResult<Job> = client.get("jobs/$id", Job.serializer())

    suspend fun cancel(id: String): ApiResult<Job> = client.post("jobs/$id/cancel", Job.serializer())
}

/** apps/control-plane/src/routes/terminal.ts — needs a cookie session, not an API key. */
class TerminalApi(private val client: KanameApiClient) {
    data class Opened(val ticket: TerminalTicket, val webSocketUrl: String)

    /**
     * Mints a 30 s single-use ticket and returns the socket URL rebuilt from
     * this panel's base URL. Connect with `client.okHttp.newWebSocket(...)`
     * immediately: the ticket is IP-bound and expires fast.
     */
    suspend fun openSession(
        serverId: String,
        cols: Int,
        rows: Int,
        user: String? = null,
        containerId: String? = null,
    ): ApiResult<Opened> = client.post(
        "terminal/sessions",
        TerminalTicket.serializer(),
        client.encode(TerminalSessionRequest(serverId, cols, rows, user, containerId)),
    ).map { t ->
        Opened(t, PanelUrls.terminalWebSocketUrl(client.baseUrl.toString(), t.ticket, cols, rows))
    }
}
