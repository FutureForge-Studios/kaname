package io.ffstudios.kaname.feature.fleet

import io.ffstudios.kaname.Fixtures
import io.ffstudios.kaname.core.api.KanameJson
import io.ffstudios.kaname.core.api.Paged
import io.ffstudios.kaname.core.api.Server
import org.junit.Assert.assertEquals
import org.junit.Test

class FleetFilterTest {
    private val servers = KanameJson.decodeFromString(Paged.serializer(Server.serializer()), Fixtures.read("servers_list.json")).data

    @Test
    fun `filters by name, ip, label and multiple terms`() {
        assertEquals(4, filterServers(servers, "  ").size)
        assertEquals(listOf("mail-01"), filterServers(servers, "MAIL").map { it.name })
        assertEquals(listOf("mail-01"), filterServers(servers, "198.51.100.42").map { it.name })
        assertEquals(listOf("mail-01"), filterServers(servers, "role=mail").map { it.name })
        assertEquals(4, filterServers(servers, "simulated connected").size)
        assertEquals(0, filterServers(servers, "mail nonexistent").size)
    }
}
