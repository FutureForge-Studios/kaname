package io.ffstudios.kaname.core.storage

import io.ffstudios.kaname.Fixtures
import io.ffstudios.kaname.core.api.AuthApi
import io.ffstudios.kaname.core.api.FleetApi
import io.ffstudios.kaname.core.api.KanameApiClient
import kotlinx.coroutines.test.runTest
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.security.GeneralSecurityException
import javax.crypto.KeyGenerator

class CookiePersistenceTest {
    @get:Rule val tmp = TemporaryFolder()

    private lateinit var server: MockWebServer
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val cipher = AesGcmCipher { key }

    @Before fun setUp() {
        server = MockWebServer().apply { start() }
    }

    @After fun tearDown() {
        server.shutdown()
    }

    private fun clientWith(storage: CookieStorage, panelId: String = "panel-1"): KanameApiClient =
        KanameApiClient(server.url("/"), OkHttpClient.Builder().cookieJar(PersistentCookieJar(panelId, storage)).build())

    private fun ok(body: String) = MockResponse().setResponseCode(200).setBody(body)

    @Test
    fun `persistent session cookie survives an app restart, encrypted on disk`() = runTest {
        val dir = tmp.newFolder("sessions")
        val storage = EncryptedFileCookieStorage(dir, cipher)
        server.enqueue(
            ok(Fixtures.read("login_ok.json"))
                .addHeader("Set-Cookie", "kaname_session=kns_SECRETVALUE; Path=/; Expires=Wed, 25 Nov 2099 11:10:19 GMT; HttpOnly; SameSite=Lax"),
        )
        AuthApi(clientWith(storage)).login("owner@kaname.local", "pw", remember = true)

        val file = dir.resolve("panel-1.cookies")
        assertTrue(file.exists())
        assertFalse("cookie value must not be stored in plaintext", String(file.readBytes(), Charsets.ISO_8859_1).contains("kns_SECRETVALUE"))

        // "Restart": brand-new storage + jar + client over the same directory.
        val restarted = clientWith(EncryptedFileCookieStorage(dir, cipher))
        server.enqueue(ok(Fixtures.read("servers_list.json")))
        FleetApi(restarted).listServers()
        server.takeRequest()
        assertEquals("kaname_session=kns_SECRETVALUE", server.takeRequest().getHeader("Cookie"))
    }

    @Test
    fun `secure host-prefixed cookie name is kept as the server set it`() {
        val storage = InMemoryCookieStorage()
        val url = "https://panel.example.com/api/v1/auth/login".toHttpUrl()
        val jar = PersistentCookieJar("p", storage)
        val c = Cookie.parse(url, "__Host-kaname_session=kns_x; Path=/; Expires=Wed, 25 Nov 2099 11:10:19 GMT; Secure; HttpOnly; SameSite=Lax")!!
        jar.saveFromResponse(url, listOf(c))

        val restored = PersistentCookieJar("p", storage).loadForRequest("https://panel.example.com/api/v1/servers".toHttpUrl())
        assertEquals("__Host-kaname_session", restored.single().name)
        assertTrue(restored.single().secure)
        assertTrue("secure cookie never sent over http", PersistentCookieJar("p", storage).loadForRequest("http://panel.example.com/".toHttpUrl()).isEmpty())
    }

    @Test
    fun `session cookie without expiry stays in memory only`() {
        val storage = InMemoryCookieStorage()
        val url = "http://10.0.0.5/api/v1/auth/login".toHttpUrl()
        val jar = PersistentCookieJar("p", storage)
        jar.saveFromResponse(url, listOf(Cookie.parse(url, "kaname_session=kns_tmp; Path=/; HttpOnly")!!))

        assertEquals(1, jar.loadForRequest(url).size)
        assertTrue(storage.read("p").isEmpty())
        assertTrue(PersistentCookieJar("p", storage).loadForRequest(url).isEmpty())
    }

    @Test
    fun `server clearing the cookie on logout removes it from storage`() {
        val storage = InMemoryCookieStorage()
        val url = "http://10.0.0.5/api/v1/auth/logout".toHttpUrl()
        val jar = PersistentCookieJar("p", storage)
        jar.saveFromResponse(url, listOf(Cookie.parse(url, "kaname_session=a; Path=/; Expires=Wed, 25 Nov 2099 11:10:19 GMT")!!))
        assertEquals(1, storage.read("p").size)

        jar.saveFromResponse(url, listOf(Cookie.parse(url, "kaname_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")!!))
        assertTrue(jar.loadForRequest(url).isEmpty())
        assertTrue(storage.read("p").isEmpty())
    }

    @Test
    fun `panels never share cookies`() {
        val storage = InMemoryCookieStorage()
        val url = "http://10.0.0.5/".toHttpUrl()
        PersistentCookieJar("a", storage).saveFromResponse(
            url,
            listOf(Cookie.parse(url, "kaname_session=a; Path=/; Expires=Wed, 25 Nov 2099 11:10:19 GMT")!!),
        )
        assertTrue(PersistentCookieJar("b", storage).loadForRequest(url).isEmpty())
    }

    @Test
    fun `expired cookies are not restored`() {
        val storage = InMemoryCookieStorage()
        val url = "http://10.0.0.5/".toHttpUrl()
        val now = System.currentTimeMillis()
        storage.write("p", listOf(StoredCookie("kaname_session", "old", now - 1, "10.0.0.5", "/", false, true, true)))
        assertTrue(PersistentCookieJar("p", storage).loadForRequest(url).isEmpty())
    }

    @Test
    fun `clear wipes jar and storage`() {
        val storage = InMemoryCookieStorage()
        val url = "http://10.0.0.5/".toHttpUrl()
        val jar = PersistentCookieJar("p", storage)
        jar.saveFromResponse(url, listOf(Cookie.parse(url, "kaname_session=a; Path=/; Expires=Wed, 25 Nov 2099 11:10:19 GMT")!!))
        jar.clear()
        assertFalse(jar.hasCookies())
        assertTrue(storage.read("p").isEmpty())
    }

    @Test
    fun `blob bound to another panel or tampered with is dropped`() {
        val dir = tmp.newFolder("s2")
        val storage = EncryptedFileCookieStorage(dir, cipher)
        val c = StoredCookie("kaname_session", "v", Long.MAX_VALUE, "h", "/", false, true, true)
        storage.write("a", listOf(c))
        // Copy a's blob over b's file: AAD mismatch must fail closed.
        dir.resolve("a.cookies").copyTo(dir.resolve("b.cookies"))
        assertTrue(storage.read("b").isEmpty())
        assertFalse(dir.resolve("b.cookies").exists())

        val bytes = dir.resolve("a.cookies").readBytes()
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
        dir.resolve("a.cookies").writeBytes(bytes)
        assertTrue(storage.read("a").isEmpty())
    }

    @Test
    fun `cipher round trips and uses a fresh iv each time`() {
        val a = cipher.encrypt("hello".toByteArray(), "x".toByteArray())
        val b = cipher.encrypt("hello".toByteArray(), "x".toByteArray())
        assertFalse(a.contentEquals(b))
        assertArrayEquals("hello".toByteArray(), cipher.decrypt(a, "x".toByteArray()))
        val wrong = runCatching { cipher.decrypt(a, "y".toByteArray()) }.exceptionOrNull()
        assertTrue(wrong is GeneralSecurityException)
    }

    @Test
    fun `unsafe panel ids are refused`() {
        val storage = EncryptedFileCookieStorage(tmp.newFolder("s3"), cipher)
        assertNull(runCatching { storage.read("../evil") }.getOrNull())
    }
}
