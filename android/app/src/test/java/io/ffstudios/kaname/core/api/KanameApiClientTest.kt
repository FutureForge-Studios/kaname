package io.ffstudios.kaname.core.api

import io.ffstudios.kaname.Fixtures
import io.ffstudios.kaname.core.storage.InMemoryCookieStorage
import io.ffstudios.kaname.core.storage.PersistentCookieJar
import io.ffstudios.kaname.ui.components.errorHeadline
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class KanameApiClientTest {
    private lateinit var server: MockWebServer
    private lateinit var storage: InMemoryCookieStorage
    private var expiredEvents = 0

    @Before
    fun setUp() {
        server = MockWebServer().apply { start() }
        storage = InMemoryCookieStorage()
        expiredEvents = 0
    }

    @After
    fun tearDown() {
        runCatching { server.shutdown() }
    }

    private fun client(base: HttpUrl = server.url("/")): KanameApiClient {
        val ok = OkHttpClient.Builder().cookieJar(PersistentCookieJar("p1", storage)).build()
        return KanameApiClient(base, ok, onSessionExpired = { expiredEvents++ })
    }

    private fun json(code: Int, body: String) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json; charset=utf-8").setBody(body)

    private val sessionCookie =
        "kaname_session=kns_test; Path=/; Expires=Wed, 25 Nov 2099 11:10:19 GMT; HttpOnly; SameSite=Lax"

    @Test
    fun `login ok stores the session cookie and sends it on later requests`() = runTest {
        server.enqueue(json(200, Fixtures.read("login_ok.json")).addHeader("Set-Cookie", sessionCookie))
        server.enqueue(json(200, Fixtures.read("servers_list.json")))
        val c = client()

        val login = AuthApi(c).login(" owner@kaname.local ", "pw", remember = true)
        val res = (login as ApiResult.Success).value
        assertEquals("ok", res.status)
        assertEquals("owner@kaname.local", res.user?.email)

        val req = server.takeRequest()
        assertEquals("/api/v1/auth/login", req.path)
        assertEquals("POST", req.method)
        val body = KanameJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("owner@kaname.local", body["email"]!!.jsonPrimitive.content)
        assertEquals("true", body["remember"]!!.jsonPrimitive.content)
        assertNull("totp_code omitted when not given", body["totp_code"])

        val servers = FleetApi(c).listServers().getOrThrow()
        assertEquals(4, servers.data.size)
        val listReq = server.takeRequest()
        assertEquals("kaname_session=kns_test", listReq.getHeader("Cookie"))
        assertTrue(listReq.path!!.startsWith("/api/v1/servers?"))
        assertEquals(1, storage.read("p1").size)
    }

    @Test
    fun `totp required then code completes the login`() = runTest {
        server.enqueue(json(200, Fixtures.read("login_totp_required.json")))
        server.enqueue(json(200, Fixtures.read("login_ok.json")).addHeader("Set-Cookie", sessionCookie))
        val auth = AuthApi(client())

        val first = auth.login("owner@kaname.local", "pw", remember = false).getOrThrow()
        assertEquals("totp_required", first.status)
        assertEquals("CHALLENGE-TOKEN", first.challenge)
        assertNull(first.user)

        // Recovery codes are alphanumeric; whitespace is stripped.
        val second = auth.submitTotp(first.challenge!!, " LBZD YDVYZR ").getOrThrow()
        assertEquals("ok", second.status)

        server.takeRequest()
        val totpReq = server.takeRequest()
        assertEquals("/api/v1/auth/totp", totpReq.path)
        val body = KanameJson.parseToJsonElement(totpReq.body.readUtf8()).jsonObject
        assertEquals("CHALLENGE-TOKEN", body["challenge"]!!.jsonPrimitive.content)
        assertEquals("LBZDYDVYZR", body["code"]!!.jsonPrimitive.content)
        assertEquals(0, expiredEvents)
    }

    @Test
    fun `error envelope maps code, message, remediation and request id`() = runTest {
        server.enqueue(json(401, Fixtures.read("error_bad_password.json")))
        val r = AuthApi(client()).login("owner@kaname.local", "wrong", false)

        val e = (r as ApiResult.Failure).error
        assertEquals(401, e.status)
        assertEquals(ErrorCodes.UNAUTHENTICATED, e.code)
        assertEquals("That email and password do not match an account.", e.message)
        assertTrue(e.remediation!!.summary.startsWith("Check the address and try again."))
        assertNotNull(e.requestId)
        assertEquals("a failed login is not an expired session", 0, expiredEvents)
    }

    @Test
    fun `validation errors carry per-field messages`() = runTest {
        server.enqueue(json(400, Fixtures.read("error_validation.json")))
        val e = AuthApi(client()).login("x", "", false).errorOrNull()!!
        assertEquals(ErrorCodes.VALIDATION_FAILED, e.code)
        assertEquals("Enter a valid email address.", e.fields["email"])
        assertEquals("This field is required.", e.fields["password"])
    }

    @Test
    fun `429 surfaces retry-after`() = runTest {
        server.enqueue(
            json(429, """{"error":{"code":"rate_limited","message":"Rate limit exceeded, retry in 25 seconds","request_id":"r1"}}""")
                .addHeader("Retry-After", "25"),
        )
        val e = AuthApi(client()).login("a@b.co", "x", false).errorOrNull()!!
        assertEquals(ErrorCodes.RATE_LIMITED, e.code)
        assertEquals(25L, e.retryAfterSeconds)
        assertTrue(e.retryable)
        assertEquals("Too many attempts. Try again in 25s.", errorHeadline(e))
    }

    @Test
    fun `401 on an authenticated call fires session expired`() = runTest {
        server.enqueue(json(401, Fixtures.read("error_unauthenticated.json")))
        val e = FleetApi(client()).listServers().errorOrNull()!!
        assertTrue(e.isUnauthenticated)
        assertEquals("Your session has expired.", e.remediation?.summary)
        assertEquals(1, expiredEvents)
    }

    @Test
    fun `401 on the session probe does not fire session expired`() = runTest {
        server.enqueue(json(401, Fixtures.read("error_unauthenticated.json")))
        assertTrue(AuthApi(client()).session() is ApiResult.Failure)
        assertEquals(0, expiredEvents)
    }

    @Test
    fun `non-json error body falls back to status-derived code`() = runTest {
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>Bad gateway</html>"))
        val e = FleetApi(client()).listServers().errorOrNull()!!
        assertEquals(502, e.status)
        assertEquals(ErrorCodes.INTERNAL_ERROR, e.code)
        assertTrue(e.retryable)
    }

    @Test
    fun `non-json success body is a malformed response`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("<html>captive portal</html>"))
        val e = FleetApi(client()).listServers().errorOrNull()!!
        assertEquals(ClientErrorCodes.MALFORMED_RESPONSE, e.code)
    }

    @Test
    fun `unreachable panel is a network error with status 0`() = runTest {
        val base = server.url("/")
        server.shutdown()
        val e = FleetApi(client(base)).listServers().errorOrNull()!!
        assertEquals(ClientErrorCodes.NETWORK_ERROR, e.code)
        assertEquals(0, e.status)
        assertNotNull(e.remediation)
    }

    @Test
    fun `202 job envelope is unwrapped`() = runTest {
        server.enqueue(json(202, Fixtures.read("job_accepted.json")))
        val job = FleetApi(client()).syncServer("f49ece63-a46f-4591-afb0-4ec3e5b631cb").getOrThrow()
        assertEquals("system.sync", job.type)
        assertEquals("queued", job.status)
        val req = server.takeRequest()
        assertEquals("/api/v1/servers/f49ece63-a46f-4591-afb0-4ec3e5b631cb/sync", req.path)
        assertEquals("{}", req.body.readUtf8())
    }

    @Test
    fun `logout 204 is a success`() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        assertTrue(AuthApi(client()).logout() is ApiResult.Success)
    }

    @Test
    fun `base url path prefix is kept`() = runTest {
        server.enqueue(json(200, Fixtures.read("servers_list.json")))
        FleetApi(client(server.url("/kaname/"))).listServers(page = 2, perPage = 10)
        val path = server.takeRequest().path!!
        assertTrue(path, path.startsWith("/kaname/api/v1/servers?"))
        assertTrue(path.contains("page=2") && path.contains("per_page=10"))
        assertFalse("null query params are omitted", path.contains("q="))
    }

    @Test
    fun `terminal session uses the panel base url, not ws_url`() = runTest {
        server.enqueue(json(201, Fixtures.read("terminal_ticket.json")))
        val c = client(server.url("/"))
        val opened = TerminalApi(c).openSession("a46cd39a-5ad4-4b21-8708-4090f3b1e92f", 80, 24).getOrThrow()
        val expectedPrefix = "ws://${server.hostName}:${server.port}/api/v1/terminal/${opened.ticket.ticket}"
        assertEquals("$expectedPrefix?cols=80&rows=24", opened.webSocketUrl)
        val body = KanameJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(80, body["cols"]!!.jsonPrimitive.content.toInt())
        assertEquals("a46cd39a-5ad4-4b21-8708-4090f3b1e92f", body["server_id"]!!.jsonPrimitive.content)
    }
}
