package io.ffstudios.kaname.core.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/*
 * Wire DTOs, mirroring the Zod schemas in packages/contract/src. Field names
 * use the wire's snake_case via @SerialName. Enum-like fields stay Strings on
 * the wire and are interpreted through the typed accessors (e.g.
 * [Server.connectionState]) so a value added server-side never breaks parsing.
 *
 * Verified against live JSON from the dev stack; fixtures live in
 * app/src/test/resources/fixtures.
 */

/* ------------------------------ envelopes ------------------------------ */

@Serializable
data class DataEnvelope<T>(val data: T)

@Serializable
data class ListMeta(
    val page: Int = 1,
    @SerialName("per_page") val perPage: Int = 0,
    val total: Int = 0,
    @SerialName("has_more") val hasMore: Boolean = false,
)

@Serializable
data class Paged<T>(val data: List<T>, val meta: ListMeta = ListMeta())

/* --------------------------------- auth -------------------------------- */

@Serializable
data class Role(val id: String, val name: String, val slug: String)

@Serializable
data class User(
    val id: String,
    val email: String,
    val name: String,
    val status: String = "active",
    @SerialName("totp_enabled") val totpEnabled: Boolean = false,
    val roles: List<Role> = emptyList(),
    @SerialName("last_login_at") val lastLoginAt: String? = null,
    val audience: String? = null,
)

@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
    val remember: Boolean,
    @SerialName("totp_code") val totpCode: String? = null,
)

@Serializable
data class TotpRequest(val challenge: String, val code: String)

/** `POST /auth/login` and `POST /auth/totp` both answer with this. */
@Serializable
data class LoginResponse(
    /** "ok" or "totp_required". */
    val status: String,
    val user: User? = null,
    val challenge: String? = null,
)

@Serializable
data class PermissionGrant(val permission: String, val scope: JsonElement? = null)

/** `GET /auth/session`. */
@Serializable
data class SessionInfo(
    val user: User? = null,
    val permissions: List<PermissionGrant> = emptyList(),
    @SerialName("totp_required") val totpRequired: Boolean = false,
) {
    fun can(permission: String): Boolean = permissions.any { it.permission == permission }
}

/* -------------------------------- fleet -------------------------------- */

/** "Can we reach the box." Never collapse with [HealthState]. */
enum class ConnectionState(val wire: String) {
    Connected("connected"),
    Degraded("degraded"),
    Disconnected("disconnected"),
    NeverEnrolled("never_enrolled"),
    Revoked("revoked"),
    Unknown("unknown");

    companion object {
        fun from(wire: String?): ConnectionState = entries.firstOrNull { it.wire == wire } ?: Unknown
    }
}

/** "Is the box OK." Independent of [ConnectionState]. */
enum class HealthState(val wire: String) {
    Healthy("healthy"),
    Warning("warning"),
    Critical("critical"),
    Unknown("unknown");

    companion object {
        fun from(wire: String?): HealthState = entries.firstOrNull { it.wire == wire } ?: Unknown
    }
}

@Serializable
data class DiskUsage(
    val mount: String,
    val device: String = "",
    val fstype: String = "",
    val total: Long = 0,
    val used: Long = 0,
    val available: Long = 0,
    @SerialName("used_percent") val usedPercent: Double = 0.0,
)

@Serializable
data class ServerLatest(
    @SerialName("cpu_percent") val cpuPercent: Double = 0.0,
    @SerialName("memory_used") val memoryUsed: Long = 0,
    @SerialName("memory_total") val memoryTotal: Long = 0,
    @SerialName("swap_used") val swapUsed: Long = 0,
    val load1: Double = 0.0,
    val disks: List<DiskUsage> = emptyList(),
    @SerialName("net_rx_rate") val netRxRate: Double = 0.0,
    @SerialName("net_tx_rate") val netTxRate: Double = 0.0,
    @SerialName("sampled_at") val sampledAt: String? = null,
) {
    val memoryPercent: Double
        get() = if (memoryTotal > 0) memoryUsed.toDouble() * 100.0 / memoryTotal else 0.0
}

@Serializable
data class ServerCounts(
    val sites: Int = 0,
    val containers: Int = 0,
    @SerialName("services_failed") val servicesFailed: Int = 0,
    val mailboxes: Int = 0,
    val databases: Int = 0,
    @SerialName("open_alerts") val openAlerts: Int = 0,
)

/** `server` in packages/contract/src/resources/fleet.ts. */
@Serializable
data class Server(
    val id: String,
    val name: String,
    val hostname: String,
    val address: String? = null,
    val provider: String? = null,
    val os: String? = null,
    @SerialName("os_family") val osFamily: String? = null,
    @SerialName("os_version") val osVersion: String? = null,
    val arch: String? = null,
    val kernel: String? = null,
    @SerialName("cpu_model") val cpuModel: String? = null,
    @SerialName("cpu_cores") val cpuCores: Int? = null,
    @SerialName("memory_total") val memoryTotal: Long? = null,
    val timezone: String? = null,
    @SerialName("agent_version") val agentVersion: String? = null,
    val capabilities: List<String> = emptyList(),
    val connection: String = "unknown",
    val health: String = "unknown",
    @SerialName("health_reasons") val healthReasons: List<String> = emptyList(),
    /** Simulated hosts must be labelled unmistakably (README "Running it from source"). */
    val simulated: Boolean = false,
    @SerialName("last_seen_at") val lastSeenAt: String? = null,
    @SerialName("enrolled_at") val enrolledAt: String? = null,
    @SerialName("cert_expires_at") val certExpiresAt: String? = null,
    @SerialName("boot_time") val bootTime: String? = null,
    @SerialName("uptime_seconds") val uptimeSeconds: Long? = null,
    val labels: Map<String, String> = emptyMap(),
    val notes: String? = null,
    val latest: ServerLatest? = null,
    val counts: ServerCounts? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
) {
    val connectionState: ConnectionState get() = ConnectionState.from(connection)
    val healthState: HealthState get() = HealthState.from(health)

    /** "Ubuntu 22.04.4 LTS · amd64", or whatever subset is known. */
    val platformLine: String
        get() = listOfNotNull(os ?: osFamily, arch).joinToString(" · ")

    /** A terminal needs a live agent (the server checks this too). */
    val canOpenTerminal: Boolean
        get() = connectionState == ConnectionState.Connected || connectionState == ConnectionState.Degraded
}

/* --------------------------------- jobs -------------------------------- */

@Serializable
data class JobError(val code: String, val message: String, val detail: JsonElement? = null)

/** `job` in packages/contract/src/jobs.ts. */
@Serializable
data class Job(
    val id: String,
    val type: String,
    val label: String,
    /** queued | blocked | running | succeeded | failed | cancelled ... */
    val status: String,
    @SerialName("server_id") val serverId: String? = null,
    @SerialName("server_name") val serverName: String? = null,
    @SerialName("target_type") val targetType: String? = null,
    @SerialName("target_id") val targetId: String? = null,
    @SerialName("target_label") val targetLabel: String? = null,
    val progress: Double? = null,
    @SerialName("blocked_reason") val blockedReason: String? = null,
    val attempt: Int = 0,
    @SerialName("max_attempts") val maxAttempts: Int = 0,
    @SerialName("child_count") val childCount: Int = 0,
    val error: JobError? = null,
    val result: JsonElement? = null,
    @SerialName("created_by_name") val createdByName: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("finished_at") val finishedAt: String? = null,
    @SerialName("duration_ms") val durationMs: Long? = null,
)

/** Mutations that reach a host answer `202 {data:{job}}`. */
@Serializable
data class JobAccepted(val job: Job)

/* ------------------------------- terminal ------------------------------ */

@Serializable
data class TerminalSessionRequest(
    @SerialName("server_id") val serverId: String,
    val cols: Int,
    val rows: Int,
    val user: String? = null,
    @SerialName("container_id") val containerId: String? = null,
)

/** Single-use, 30 s, IP-bound ticket. Prefer [PanelUrls.terminalWebSocketUrl] over [wsUrl]. */
@Serializable
data class TerminalTicket(
    val ticket: String,
    /** Built from the server's KANAME_CLIENT_API_URL; may not be reachable from the phone. */
    @SerialName("ws_url") val wsUrl: String,
    @SerialName("expires_at") val expiresAt: String,
    @SerialName("server_id") val serverId: String,
    @SerialName("server_name") val serverName: String,
    val recorded: Boolean = false,
    @SerialName("container_name") val containerName: String? = null,
)
