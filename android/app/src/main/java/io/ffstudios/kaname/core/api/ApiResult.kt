package io.ffstudios.kaname.core.api

/**
 * The outcome of one API call. Screens `when` over it; nothing in the API
 * layer throws for an expected failure (HTTP error, network, bad JSON).
 */
sealed interface ApiResult<out T> {
    data class Success<out T>(val value: T) : ApiResult<T>
    data class Failure(val error: ApiException) : ApiResult<Nothing>
}

inline fun <T, R> ApiResult<T>.map(transform: (T) -> R): ApiResult<R> = when (this) {
    is ApiResult.Success -> ApiResult.Success(transform(value))
    is ApiResult.Failure -> this
}

inline fun <T> ApiResult<T>.onSuccess(block: (T) -> Unit): ApiResult<T> {
    if (this is ApiResult.Success) block(value)
    return this
}

inline fun <T> ApiResult<T>.onFailure(block: (ApiException) -> Unit): ApiResult<T> {
    if (this is ApiResult.Failure) block(error)
    return this
}

fun <T> ApiResult<T>.getOrNull(): T? = (this as? ApiResult.Success)?.value

fun <T> ApiResult<T>.getOrThrow(): T = when (this) {
    is ApiResult.Success -> value
    is ApiResult.Failure -> throw error
}

fun <T> ApiResult<T>.errorOrNull(): ApiException? = (this as? ApiResult.Failure)?.error
