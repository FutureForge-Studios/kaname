package io.ffstudios.kaname

/** JSON captured from the dev stack (`pnpm dev` + `pnpm dev:fleet`) on 2026-11-11. */
object Fixtures {
    fun read(name: String): String =
        checkNotNull(Fixtures::class.java.classLoader!!.getResource("fixtures/$name")) { "missing fixture $name" }.readText()
}
