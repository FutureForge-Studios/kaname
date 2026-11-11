package io.ffstudios.kaname.core.storage

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import io.ffstudios.kaname.core.api.KanameJson
import io.ffstudios.kaname.core.model.Panel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer

/** Saved panels. Not secret (no credentials), so plain DataStore is fine. */
class PanelRepository(private val store: DataStore<Preferences>) {
    private val key = stringPreferencesKey("panels.v1")
    private val serializer = ListSerializer(Panel.serializer())

    val panels: Flow<List<Panel>> = store.data.map { decode(it[key]) }

    suspend fun get(id: String): Panel? = panels.first().firstOrNull { it.id == id }

    suspend fun upsert(panel: Panel) {
        store.edit { prefs ->
            val list = decode(prefs[key]).toMutableList()
            val i = list.indexOfFirst { it.id == panel.id }
            if (i >= 0) list[i] = panel else list += panel
            prefs[key] = KanameJson.encodeToString(serializer, list)
        }
    }

    suspend fun delete(id: String) {
        store.edit { prefs ->
            prefs[key] = KanameJson.encodeToString(serializer, decode(prefs[key]).filterNot { it.id == id })
        }
    }

    suspend fun rememberEmail(id: String, email: String) {
        get(id)?.let { upsert(it.copy(lastEmail = email)) }
    }

    private fun decode(raw: String?): List<Panel> = if (raw.isNullOrEmpty()) {
        emptyList()
    } else {
        try {
            KanameJson.decodeFromString(serializer, raw)
        } catch (_: SerializationException) {
            emptyList()
        }
    }
}

/** App-wide preferences (Settings screen). */
class SettingsRepository(private val store: DataStore<Preferences>) {
    private val appLockKey = booleanPreferencesKey("app_lock.enabled")

    val appLockEnabled: Flow<Boolean> = store.data.map { it[appLockKey] ?: false }

    suspend fun setAppLock(enabled: Boolean) {
        store.edit { it[appLockKey] = enabled }
    }
}
