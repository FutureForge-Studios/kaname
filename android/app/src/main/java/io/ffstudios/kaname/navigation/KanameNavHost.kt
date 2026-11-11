package io.ffstudios.kaname.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import io.ffstudios.kaname.feature.fleet.FleetScreen
import io.ffstudios.kaname.feature.login.LoginScreen
import io.ffstudios.kaname.feature.panels.PanelEditScreen
import io.ffstudios.kaname.feature.panels.PanelsScreen
import io.ffstudios.kaname.feature.server.ServerDetailScreen
import io.ffstudios.kaname.feature.settings.SettingsScreen
import io.ffstudios.kaname.feature.terminal.TerminalScreen
import io.ffstudios.kaname.ui.components.appContainer

@Composable
fun KanameNavHost(nav: NavHostController = rememberNavController()) {
    val container = appContainer()

    // Any 401 on an authenticated call, for any panel, lands here.
    LaunchedEffect(nav) {
        container.panelSessions.sessionExpired.collect { panelId ->
            val current = nav.currentBackStackEntry
            val alreadyThere = current?.destination?.route == Routes.LOGIN &&
                current.arguments?.getString(Routes.ARG_PANEL_ID) == panelId
            if (!alreadyThere) {
                nav.navigate(Routes.login(panelId, expired = true)) {
                    popUpTo(Routes.PANELS)
                    launchSingleTop = true
                }
            }
        }
    }

    val panelArg = navArgument(Routes.ARG_PANEL_ID) { type = NavType.StringType }
    val serverArg = navArgument(Routes.ARG_SERVER_ID) { type = NavType.StringType }

    NavHost(navController = nav, startDestination = Routes.PANELS) {
        composable(Routes.PANELS) {
            PanelsScreen(
                onAddPanel = { nav.navigate(Routes.panelEdit()) },
                onEditPanel = { nav.navigate(Routes.panelEdit(it)) },
                onOpenFleet = { nav.navigate(Routes.fleet(it)) },
                onSignIn = { nav.navigate(Routes.login(it)) },
                onOpenSettings = { nav.navigate(Routes.SETTINGS) },
            )
        }
        composable(
            Routes.PANEL_EDIT,
            arguments = listOf(
                navArgument(Routes.ARG_PANEL_ID) { type = NavType.StringType; nullable = true; defaultValue = null },
            ),
        ) {
            PanelEditScreen(
                onBack = { nav.popBackStack() },
                onSaved = { panelId, isNew ->
                    nav.popBackStack()
                    if (isNew) nav.navigate(Routes.login(panelId))
                },
            )
        }
        composable(
            Routes.LOGIN,
            arguments = listOf(panelArg, navArgument(Routes.ARG_EXPIRED) { type = NavType.BoolType; defaultValue = false }),
        ) {
            LoginScreen(
                onBack = { nav.popBackStack() },
                onSignedIn = { panelId ->
                    nav.navigate(Routes.fleet(panelId)) { popUpTo(Routes.PANELS) }
                },
            )
        }
        composable(Routes.FLEET, arguments = listOf(panelArg)) {
            FleetScreen(
                onBack = { nav.popBackStack() },
                onOpenServer = { panelId, serverId -> nav.navigate(Routes.server(panelId, serverId)) },
                onSignedOut = { nav.popBackStack(Routes.PANELS, inclusive = false) },
            )
        }
        composable(Routes.SERVER, arguments = listOf(panelArg, serverArg)) {
            ServerDetailScreen(
                onBack = { nav.popBackStack() },
                onOpenTerminal = { panelId, serverId -> nav.navigate(Routes.terminal(panelId, serverId)) },
            )
        }
        composable(Routes.TERMINAL, arguments = listOf(panelArg, serverArg)) {
            TerminalScreen(onBack = { nav.popBackStack() })
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(onBack = { nav.popBackStack() })
        }
    }
}
