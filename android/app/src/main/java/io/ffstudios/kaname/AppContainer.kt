package io.ffstudios.kaname

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStore
import io.ffstudios.kaname.core.auth.AuthRepository
import io.ffstudios.kaname.core.auth.PanelSessions
import io.ffstudios.kaname.core.storage.AesGcmCipher
import io.ffstudios.kaname.core.storage.AndroidKeystoreKey
import io.ffstudios.kaname.core.storage.EncryptedFileCookieStorage
import io.ffstudios.kaname.core.storage.PanelRepository
import io.ffstudios.kaname.core.storage.SettingsRepository
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

private val Context.appDataStore: DataStore<Preferences> by preferencesDataStore(name = "kaname")

/**
 * Manual DI. One instance lives on [KanameApp]; screens reach it through
 * `LocalAppContainer` / `appContainer()`. Add new singletons here.
 */
class AppContainer(context: Context) {
    private val appContext = context.applicationContext

    /** Base HTTP client; per-panel clients are derived from it in [PanelSessions]. */
    val baseHttpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        // WebSocket keepalive for the terminal; harmless for REST.
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    private val cookieStorage = EncryptedFileCookieStorage(
        dir = File(appContext.noBackupFilesDir, "sessions"),
        cipher = AesGcmCipher(AndroidKeystoreKey::getOrCreate),
    )

    val panelRepository = PanelRepository(appContext.appDataStore)
    val settingsRepository = SettingsRepository(appContext.appDataStore)
    val panelSessions = PanelSessions(baseHttpClient, cookieStorage)
    val authRepository = AuthRepository(panelSessions, panelRepository)
}
