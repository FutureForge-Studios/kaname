package io.ffstudios.kaname.core.api

import io.ffstudios.kaname.Fixtures
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Parses JSON captured from the live dev stack. */
class DtoParsingTest {
    @Test
    fun `server list from the dev fleet`() {
        val page = KanameJson.decodeFromString(Paged.serializer(Server.serializer()), Fixtures.read("servers_list.json"))
        assertEquals(4, page.data.size)
        assertEquals(4, page.meta.total)
        assertFalse(page.meta.hasMore)

        val mail = page.data.first { it.name == "mail-01" }
        assertEquals("mail-01.kaname.internal", mail.hostname)
        assertEquals("198.51.100.42", mail.address)
        assertEquals("ubuntu · amd64", mail.platformLine)
        assertTrue(mail.simulated)
        assertTrue("simulated" in mail.capabilities)
        assertEquals("mail", mail.labels["role"])
        // Two independent axes.
        assertEquals(ConnectionState.Connected, mail.connectionState)
        assertEquals(HealthState.Warning, mail.healthState)
        assertTrue(mail.healthReasons.first().startsWith("warning:"))
        assertTrue(mail.canOpenTerminal)
        val latest = assertNotNullAnd(mail.latest)
        assertTrue(latest.cpuPercent in 0.0..100.0)
        assertTrue(latest.disks.isNotEmpty())
        assertNotNull(mail.counts)
    }

    @Test
    fun `server detail`() {
        val s = KanameJson.decodeFromString(DataEnvelope.serializer(Server.serializer()), Fixtures.read("server_detail.json")).data
        assertEquals("mail-01", s.name)
        assertNotNull(s.uptimeSeconds)
    }

    @Test
    fun `unknown enum values degrade to Unknown instead of failing`() {
        val json = """{"id":"x","name":"n","hostname":"h","connection":"teleporting","health":"vibes","future_field":{"a":1}}"""
        val s = KanameJson.decodeFromString(Server.serializer(), json)
        assertEquals(ConnectionState.Unknown, s.connectionState)
        assertEquals(HealthState.Unknown, s.healthState)
        assertFalse(s.canOpenTerminal)
    }

    @Test
    fun `session, job, ticket and totp payloads`() {
        val session = KanameJson.decodeFromString(DataEnvelope.serializer(SessionInfo.serializer()), Fixtures.read("auth_session.json")).data
        assertEquals("owner@kaname.local", session.user?.email)
        assertTrue(session.can("infra.servers:read"))
        assertEquals("owner", session.user?.roles?.first()?.slug)

        val job = KanameJson.decodeFromString(DataEnvelope.serializer(JobAccepted.serializer()), Fixtures.read("job_accepted.json")).data.job
        assertEquals("Sync inventory", job.label)
        assertEquals(3, job.maxAttempts)

        val ticket = KanameJson.decodeFromString(DataEnvelope.serializer(TerminalTicket.serializer()), Fixtures.read("terminal_ticket.json")).data
        assertTrue(ticket.ticket.startsWith("kn_tty_"))
        assertTrue(ticket.wsUrl.startsWith("ws://localhost:4000/"))

        val totp = KanameJson.decodeFromString(DataEnvelope.serializer(LoginResponse.serializer()), Fixtures.read("login_totp_required.json")).data
        assertEquals("totp_required", totp.status)
    }

    private fun <T> assertNotNullAnd(v: T?): T {
        assertNotNull(v)
        return v!!
    }
}
