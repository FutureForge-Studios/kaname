package io.ffstudios.kaname.core.storage

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.nio.ByteBuffer
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypts small secrets at rest. [aad] binds a blob to its owner (e.g. a panel id). */
interface SecretCipher {
    fun encrypt(plaintext: ByteArray, aad: ByteArray): ByteArray

    /** @throws GeneralSecurityException if the blob was tampered with or the key is gone. */
    fun decrypt(blob: ByteArray, aad: ByteArray): ByteArray
}

/**
 * AES-256-GCM. Blob layout: `[version=1][ivLen][iv][ciphertext+tag]`.
 *
 * The cipher generates the IV itself, which Android Keystore requires for
 * keys created with randomized encryption (the default).
 */
class AesGcmCipher(private val keyProvider: () -> SecretKey) : SecretCipher {
    override fun encrypt(plaintext: ByteArray, aad: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, keyProvider())
        cipher.updateAAD(aad)
        val iv = cipher.iv
        val ct = cipher.doFinal(plaintext)
        return ByteBuffer.allocate(2 + iv.size + ct.size)
            .put(VERSION).put(iv.size.toByte()).put(iv).put(ct)
            .array()
    }

    override fun decrypt(blob: ByteArray, aad: ByteArray): ByteArray {
        if (blob.size < 2 || blob[0] != VERSION) throw GeneralSecurityException("Unknown blob version")
        val ivLen = blob[1].toInt()
        if (ivLen !in 12..16 || blob.size < 2 + ivLen + 16) throw GeneralSecurityException("Truncated blob")
        val iv = blob.copyOfRange(2, 2 + ivLen)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, keyProvider(), GCMParameterSpec(TAG_BITS, iv))
        cipher.updateAAD(aad)
        return cipher.doFinal(blob, 2 + ivLen, blob.size - 2 - ivLen)
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
        const val VERSION: Byte = 1
    }
}

/**
 * A non-exportable AES key in the Android Keystore. Created on first use;
 * if the app's data is restored onto another device the key will not exist
 * there, decryption fails, and stored sessions are simply dropped.
 */
object AndroidKeystoreKey {
    private const val PROVIDER = "AndroidKeyStore"
    private const val ALIAS = "kaname.session-store.v1"

    @Synchronized
    fun getOrCreate(): SecretKey {
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }
}
