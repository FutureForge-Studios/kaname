package io.ffstudios.kaname.core.storage

import io.ffstudios.kaname.core.api.KanameJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import okhttp3.Cookie
import java.io.File
import java.io.IOException
import java.security.GeneralSecurityException

/** A cookie as stored at rest. Only persistent cookies are ever written. */
@Serializable
data class StoredCookie(
    val name: String,
    val value: String,
    val expiresAt: Long,
    val domain: String,
    val path: String,
    val secure: Boolean,
    val httpOnly: Boolean,
    val hostOnly: Boolean,
) {
    fun toOkHttp(): Cookie = Cookie.Builder()
        .name(name)
        .value(value)
        .expiresAt(expiresAt)
        .path(path)
        .apply {
            if (hostOnly) hostOnlyDomain(domain) else domain(domain)
            if (secure) secure()
            if (httpOnly) httpOnly()
        }
        .build()

    companion object {
        fun from(c: Cookie) = StoredCookie(c.name, c.value, c.expiresAt, c.domain, c.path, c.secure, c.httpOnly, c.hostOnly)
    }
}

/** Per-panel cookie persistence. Implementations must be thread-safe. */
interface CookieStorage {
    fun read(panelId: String): List<StoredCookie>
    fun write(panelId: String, cookies: List<StoredCookie>)
    fun clear(panelId: String)
}

/**
 * One encrypted file per panel under [dir]. The panel id is the AES-GCM AAD,
 * so a blob copied onto another panel's file fails to decrypt.
 */
class EncryptedFileCookieStorage(
    private val dir: File,
    private val cipher: SecretCipher,
) : CookieStorage {
    private val serializer = ListSerializer(StoredCookie.serializer())

    private fun fileFor(panelId: String): File {
        require(panelId.matches(SAFE_ID)) { "Unsafe panel id" }
        return File(dir, "$panelId.cookies")
    }

    @Synchronized
    override fun read(panelId: String): List<StoredCookie> {
        val file = fileFor(panelId)
        if (!file.exists()) return emptyList()
        return try {
            val plain = cipher.decrypt(file.readBytes(), panelId.toByteArray())
            KanameJson.decodeFromString(serializer, plain.decodeToString())
        } catch (_: GeneralSecurityException) {
            file.delete() // key gone (restore to a new device) or tampered: drop it, user signs in again
            emptyList()
        } catch (_: SerializationException) {
            file.delete()
            emptyList()
        } catch (_: IOException) {
            emptyList()
        }
    }

    @Synchronized
    override fun write(panelId: String, cookies: List<StoredCookie>) {
        val file = fileFor(panelId)
        if (cookies.isEmpty()) {
            file.delete()
            return
        }
        dir.mkdirs()
        val blob = cipher.encrypt(KanameJson.encodeToString(serializer, cookies).encodeToByteArray(), panelId.toByteArray())
        val tmp = File(dir, "${file.name}.tmp")
        tmp.writeBytes(blob)
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
    }

    @Synchronized
    override fun clear(panelId: String) {
        fileFor(panelId).delete()
    }

    private companion object {
        val SAFE_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
    }
}

/** For tests and previews. */
class InMemoryCookieStorage : CookieStorage {
    private val map = mutableMapOf<String, List<StoredCookie>>()

    @Synchronized override fun read(panelId: String) = map[panelId].orEmpty()

    @Synchronized override fun write(panelId: String, cookies: List<StoredCookie>) {
        if (cookies.isEmpty()) map.remove(panelId) else map[panelId] = cookies
    }

    @Synchronized override fun clear(panelId: String) {
        map.remove(panelId)
    }
}
