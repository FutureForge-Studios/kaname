package io.ffstudios.kaname.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.CreationExtras
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.ffstudios.kaname.AppContainer
import io.ffstudios.kaname.KanameApp

@Composable
fun appContainer(): AppContainer = (LocalContext.current.applicationContext as KanameApp).container

/**
 * `val vm = kanameViewModel { container, handle -> FleetViewModel(container, handle) }`
 * — manual DI for ViewModels, with the nav arguments in the SavedStateHandle.
 */
@Composable
inline fun <reified VM : ViewModel> kanameViewModel(
    crossinline create: CreationExtras.(AppContainer) -> VM,
): VM {
    val container = appContainer()
    return viewModel(factory = viewModelFactory { initializer { create(container) } })
}
