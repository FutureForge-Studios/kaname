package io.ffstudios.kaname.feature.settings

import android.os.SystemClock
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * Optional app lock: biometric or device credential (PIN/pattern) before the
 * app shows anything, and again after it has been in the background longer
 * than [GRACE_MS]. Sessions themselves stay encrypted with a Keystore key
 * whether or not the lock is on.
 */
class AppLockController(private val activity: FragmentActivity) {
    /** True once the user has authenticated in this foreground stretch. */
    var unlocked by mutableStateOf(false)
        private set

    private var backgroundedAt = 0L
    private var authenticating = false

    fun isAvailable(): Boolean =
        BiometricManager.from(activity).canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS

    fun authenticate(title: String, subtitle: String? = null, onResult: (Boolean) -> Unit = {}) {
        if (authenticating) return
        authenticating = true
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    authenticating = false
                    unlocked = true
                    onResult(true)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    authenticating = false
                    onResult(false)
                }
            },
        )
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .apply { subtitle?.let { setSubtitle(it) } }
            .setAllowedAuthenticators(AUTHENTICATORS)
            .build()
        prompt.authenticate(info)
    }

    fun onStop(changingConfigurations: Boolean) {
        // The device-credential screen on older Android stops this activity; don't count that.
        if (!changingConfigurations && !authenticating) backgroundedAt = SystemClock.elapsedRealtime()
    }

    fun onStart() {
        if (backgroundedAt != 0L && SystemClock.elapsedRealtime() - backgroundedAt > GRACE_MS) unlocked = false
        backgroundedAt = 0L
    }

    companion object {
        const val AUTHENTICATORS = BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        const val GRACE_MS = 30_000L
    }
}

val LocalAppLock = staticCompositionLocalOf<AppLockController?> { null }
