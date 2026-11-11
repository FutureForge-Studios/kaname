package io.ffstudios.kaname.core.api

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.encodeToJsonElement
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * A REST client bound to one panel. Every request in the app goes through
 * [request], which maps the control plane's envelopes:
 *
 * - `{data}` → [ApiResult.Success] with `data` decoded
 * - `{data, meta}` → use [getPage] to keep `meta`
 * - `{error:{code,message,remediation?,fields?,request_id}}` → [ApiResult.Failure]
 * - 401 on anything but an auth probe → [onSessionExpired] (routes back to login)
 *
 * Feature code should not build URLs by hand; add a small typed API class
 * next to [AuthApi] / [FleetApi] that calls [get] / [post].
 */
class KanameApiClient(
    val baseUrl: HttpUrl,
    /** Carries this panel's cookie jar. Reuse it for WebSockets (terminal). */
    val okHttp: OkHttpClient,
    private val onSessionExpired: () -> Unit = {},
    val json: Json = KanameJson,
) {
    enum class Method { GET, POST, PUT, PATCH, DELETE }

    /** Decodes the `data` member of a `{data}` envelope. */
    suspend fun <T> request(
        method: Method,
        path: String,
        deserializer: DeserializationStrategy<T>,
        query: Map<String, Any?> = emptyMap(),
        body: JsonElement? = null,
        allowUnauthenticated: Boolean = false,
    ): ApiResult<T> = execute(method, path, query, body, allowUnauthenticated) { root ->
        val data = (root as? JsonObject)?.get("data") ?: JsonNull
        json.decodeFromJsonElement(deserializer, data)
    }

    /** For calls that answer 204 or whose body does not matter. */
    suspend fun requestUnit(
        method: Method,
        path: String,
        query: Map<String, Any?> = emptyMap(),
        body: JsonElement? = null,
        allowUnauthenticated: Boolean = false,
    ): ApiResult<Unit> = execute(method, path, query, body, allowUnauthenticated) { }

    suspend fun <T> get(
        path: String,
        deserializer: DeserializationStrategy<T>,
        query: Map<String, Any?> = emptyMap(),
        allowUnauthenticated: Boolean = false,
    ): ApiResult<T> = request(Method.GET, path, deserializer, query, null, allowUnauthenticated)

    /** `{data: T[], meta}` list endpoints. */
    suspend fun <T> getPage(
        path: String,
        itemSerializer: KSerializer<T>,
        query: Map<String, Any?> = emptyMap(),
    ): ApiResult<Paged<T>> = execute(Method.GET, path, query, null, false) { root ->
        json.decodeFromJsonElement(Paged.serializer(itemSerializer), root ?: JsonNull)
    }

    suspend fun <T> post(
        path: String,
        deserializer: DeserializationStrategy<T>,
        body: JsonElement? = null,
        allowUnauthenticated: Boolean = false,
    ): ApiResult<T> = request(Method.POST, path, deserializer, emptyMap(), body, allowUnauthenticated)

    /** A host-reaching mutation: `202 {data:{job}}`. */
    suspend fun postForJob(path: String, body: JsonElement? = null): ApiResult<Job> =
        post(path, JobAccepted.serializer(), body).map { it.job }

    inline fun <reified B> encode(body: B): JsonElement = json.encodeToJsonElement(body)

    /* ------------------------------------------------------------------ */

    private suspend fun <T> execute(
        method: Method,
        path: String,
        query: Map<String, Any?>,
        body: JsonElement?,
        allowUnauthenticated: Boolean,
        decode: (JsonElement?) -> T,
    ): ApiResult<T> {
        val url = PanelUrls.api(baseUrl, path).newBuilder().apply {
            query.forEach { (k, v) -> if (v != null && v.toString().isNotEmpty()) addQueryParameter(k, v.toString()) }
        }.build()

        val requestBody = when {
            body != null -> json.encodeToString(JsonElement.serializer(), body).toRequestBody(JSON_MEDIA)
            method == Method.GET || method == Method.DELETE -> null
            // Fastify rejects a JSON content-type with an empty body, so send {}.
            else -> "{}".toRequestBody(JSON_MEDIA)
        }
        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .method(method.name, requestBody)
            .build()

        val response = try {
            okHttp.newCall(request).await()
        } catch (e: IOException) {
            return ApiResult.Failure(networkError(e))
        }

        return response.use { res ->
            val text = try {
                res.body?.string().orEmpty()
            } catch (e: IOException) {
                return ApiResult.Failure(networkError(e))
            }
            if (!res.isSuccessful) {
                val error = parseError(res, text)
                if (res.code == 401 && !allowUnauthenticated) onSessionExpired()
                return ApiResult.Failure(error)
            }
            if (res.code == 204 || res.code == 205 || text.isEmpty()) {
                return try {
                    ApiResult.Success(decode(null))
                } catch (e: SerializationException) {
                    ApiResult.Failure(malformed(res.code, e))
                } catch (e: IllegalArgumentException) {
                    ApiResult.Failure(malformed(res.code, e))
                }
            }
            try {
                val root = json.parseToJsonElement(text)
                ApiResult.Success(decode(root))
            } catch (e: SerializationException) {
                ApiResult.Failure(malformed(res.code, e))
            } catch (e: IllegalArgumentException) {
                ApiResult.Failure(malformed(res.code, e))
            }
        }
    }

    private fun parseError(res: Response, text: String): ApiException {
        val body = try {
            if (text.isNotEmpty()) json.decodeFromString(ErrorEnvelope.serializer(), text).error else null
        } catch (_: SerializationException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
        val retryAfter = res.header("Retry-After")?.trim()?.toLongOrNull()
        return ApiException(
            code = body?.code ?: fallbackCode(res.code),
            message = body?.message ?: fallbackMessage(res.code),
            status = res.code,
            remediation = body?.remediation,
            fields = body?.fields.orEmpty(),
            requestId = body?.requestId ?: res.header("x-request-id"),
            retryAfterSeconds = retryAfter,
            detail = body?.detail,
        )
    }

    private fun malformed(status: Int, cause: Throwable) = ApiException(
        code = ClientErrorCodes.MALFORMED_RESPONSE,
        message = "The control plane returned something this app could not read.",
        status = status,
        remediation = Remediation(
            "The panel may be running a version this app does not understand, or something in front of it " +
                "is answering instead. Check the address points at a Kaname panel.",
        ),
        cause = cause,
    )

    private fun networkError(e: IOException): ApiException = when (e) {
        is SSLException -> ApiException(
            code = ClientErrorCodes.TLS_ERROR,
            message = "The panel's certificate could not be verified.",
            status = 0,
            remediation = Remediation(
                "Kaname keeps TLS strict. Give the panel a certificate from a trusted CA (the panel can issue " +
                    "one with Let's Encrypt once a domain points at it), or use its plain http:// address on a trusted network.",
            ),
            cause = e,
        )
        is UnknownHostException -> ApiException(
            code = ClientErrorCodes.NETWORK_ERROR,
            message = "Could not find ${baseUrl.host}.",
            status = 0,
            remediation = Remediation("Check the panel address and that this phone has a network connection."),
            cause = e,
        )
        is ConnectException, is SocketTimeoutException -> ApiException(
            code = ClientErrorCodes.NETWORK_ERROR,
            message = "The control plane did not answer.",
            status = 0,
            remediation = Remediation(
                "Check that the panel is running and reachable from this phone — a LAN address only works on the same network or a VPN.",
            ),
            cause = e,
        )
        else -> ApiException(
            code = ClientErrorCodes.NETWORK_ERROR,
            message = "The connection to the control plane failed.",
            status = 0,
            remediation = Remediation("Check your connection and try again."),
            cause = e,
        )
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        /** For endpoints whose `data` you do not need. */
        val IgnoreData: DeserializationStrategy<Unit> = Unit.serializer()
    }
}

/** Cancellable suspend wrapper around OkHttp's async call. */
internal suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) {
            cont.resume(response) { _, value, _ -> value.close() }
        }

        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}
