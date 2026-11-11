package io.ffstudios.kaname.core.api

import kotlinx.serialization.json.Json

/**
 * The one Json configuration for everything that talks to a control plane.
 *
 * `ignoreUnknownKeys` because the contract grows additively: a newer panel
 * adding a field must never break an older app. `coerceInputValues` turns a
 * null where a default exists into that default instead of failing.
 */
val KanameJson: Json = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    explicitNulls = false
    encodeDefaults = true
    isLenient = false
}
