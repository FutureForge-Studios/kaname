# kotlinx.serialization: keep generated serializers for @Serializable DTOs.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers @kotlinx.serialization.Serializable class io.ffstudios.kaname.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class io.ffstudios.kaname.** {
    kotlinx.serialization.KSerializer serializer(...);
}
# OkHttp ships its own consumer rules.
