package io.ffstudios.kaname

import io.ffstudios.kaname.core.api.ApiResult
import io.ffstudios.kaname.core.api.AuthApi
import io.ffstudios.kaname.core.api.ConnectionState
import io.ffstudios.kaname.core.api.FleetApi
import io.ffstudios.kaname.core.api.KanameApiClient
import io.ffstudios.kaname.core.api.TerminalApi
import io.ffstudios.kaname.core.api.getOrThrow
import io.ffstudios.kaname.core.storage.InMemoryCookieStorage
import io.ffstudios.kaname.core.storage.PersistentCookieJar
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.time.Duration.Companion.seconds

/**
 * Opt-in end-to-end check against a running dev stack. Skipped unless
 * KANAME_LIVE_URL is set, e.g.:
 *
 *   KANAME_LIVE_URL=http://localhost:4000 ./gradlew testDebugUnitTest --tests '*LiveStackTest*'
 *
 * Uses KANAME_LIVE_EMAIL / KANAME_LIVE_PASSWORD, defaulting to the dev seed owner.
 */
class LiveStackTest {
    private val base = System.getenv("KANAME_LIVE_URL")

    @Test
    fun `sign in, list the fleet and open a terminal socket`() = runTest(timeout = 60.seconds) {
        assumeTrue("set KANAME_LIVE_URL to run", !base.isNullOrBlank())
        val storage = InMemoryCookieStorage()
        val client = KanameApiClient(
            base!!.toHttpUrl(),
            OkHttpClient.Builder().cookieJar(PersistentCookieJar("live", storage)).build(),
        )
        val email = System.getenv("KANAME_LIVE_EMAIL") ?: "owner@kaname.local"
        val password = System.getenv("KANAME_LIVE_PASSWORD") ?: "kaname-development-only"

        val login = AuthApi(client).login(email, password, remember = true).getOrThrow()
        assertEquals("ok", login.status)
        assertTrue("session cookie persisted", storage.read("live").isNotEmpty())
        assertEquals(email, AuthApi(client).session().getOrThrow().user?.email)

        val servers = FleetApi(client).listAllServers().getOrThrow()
        println("live: ${servers.size} servers: " + servers.joinToString { "${it.name}[${it.connection}/${it.health}]" })
        assertTrue(servers.isNotEmpty())

        val target = servers.firstOrNull { it.connectionState == ConnectionState.Connected }
        if (target != null) {
            val opened = TerminalApi(client).openSession(target.id, 80, 24).getOrThrow()
            println("live: ws ${opened.webSocketUrl.substringBefore("kn_tty_")}… (server said ${opened.ticket.wsUrl.substringBefore("kn_tty_")}…)")
            val gotBytes = CountDownLatch(1)
            var failure: Throwable? = null
            val ws = client.okHttp.newWebSocket(
                Request.Builder().url(opened.webSocketUrl).build(),
                object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, bytes: ByteString) = gotBytes.countDown()
                    override fun onMessage(webSocket: WebSocket, text: String) = gotBytes.countDown()
                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        failure = t
                        gotBytes.countDown()
                    }
                },
            )
            val arrived = gotBytes.await(15, TimeUnit.SECONDS)
            ws.close(1000, "test done")
            assertTrue("terminal socket failed: $failure", arrived && failure == null)
        }

        assertTrue(AuthApi(client).logout() is ApiResult.Success)
        assertTrue("logout cleared the cookie", storage.read("live").isEmpty())
    }
}
