package io.ffstudios.kaname.core.api

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PanelUrlsTest {
    private fun canonical(input: String): String =
        PanelUrls.canonical((PanelUrls.parse(input) as PanelUrls.Parsed.Valid).url)

    @Test
    fun `parse normalises what people type`() {
        assertEquals("https://panel.example.com", canonical("panel.example.com"))
        assertEquals("https://panel.example.com", canonical("  https://panel.example.com/ "))
        assertEquals("http://203.0.113.10", canonical("http://203.0.113.10"))
        assertEquals("http://10.0.0.5:4000", canonical("HTTP://10.0.0.5:4000/"))
        assertEquals("https://ops.example.com/kaname", canonical("https://ops.example.com/kaname/"))
        assertEquals("https://panel.example.com", canonical("https://panel.example.com/api/v1/"))
        assertEquals("https://panel.example.com", canonical("https://panel.example.com/?next=/x#frag"))
    }

    @Test
    fun `parse rejects garbage`() {
        assertTrue(PanelUrls.parse("") is PanelUrls.Parsed.Invalid)
        assertTrue(PanelUrls.parse("ftp://x") is PanelUrls.Parsed.Invalid)
        assertTrue(PanelUrls.parse("http://") is PanelUrls.Parsed.Invalid)
    }

    @Test
    fun `encryption is decided by scheme`() {
        assertTrue(PanelUrls.isEncrypted("https://a.b"))
        assertFalse(PanelUrls.isEncrypted("http://1.2.3.4"))
    }

    @Test
    fun `api joins under api v1`() {
        assertEquals("http://1.2.3.4/api/v1/servers/abc", PanelUrls.api("http://1.2.3.4".toHttpUrl(), "/servers/abc").toString())
        assertEquals(
            "https://h.example/kaname/api/v1/auth/login",
            PanelUrls.api("https://h.example/kaname".toHttpUrl(), "auth/login").toString(),
        )
    }

    @Test
    fun `terminal ws url over http`() {
        assertEquals(
            "ws://203.0.113.10/api/v1/terminal/kn_tty_abc?cols=80&rows=24",
            PanelUrls.terminalWebSocketUrl("http://203.0.113.10", "kn_tty_abc", 80, 24),
        )
    }

    @Test
    fun `terminal ws url over https keeps port and prefix`() {
        assertEquals(
            "wss://ops.example.com:8443/kaname/api/v1/terminal/kn_tty_abc?cols=132&rows=40",
            PanelUrls.terminalWebSocketUrl("https://ops.example.com:8443/kaname", "kn_tty_abc", 132, 40),
        )
    }

    @Test
    fun `terminal ws url ignores the server's own ws_url host`() {
        // The control plane built ws_url from KANAME_CLIENT_API_URL=http://localhost:4000,
        // which a phone cannot reach; the panel's own address wins.
        assertEquals(
            "wss://panel.example.com/api/v1/terminal/kn_tty_x?cols=1&rows=1",
            PanelUrls.terminalWebSocketUrl("https://panel.example.com", "kn_tty_x", 1, 1),
        )
    }
}
