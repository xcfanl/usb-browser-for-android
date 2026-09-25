# Plugin class is instantiated from Rust via JNI and its @Command methods via reflection.
-keep class com.usbfile.usbstorage.** { *; }
# File-system drivers are selected at runtime; keep them intact.
-keep class me.jahnen.libaums.** { *; }
-keep class org.jnode.** { *; }
-dontwarn org.jnode.**
-dontwarn org.apache.log4j.**
-dontwarn javax.**
-dontwarn java.awt.**
# java-fs logs through log4j 1.2; keep it intact (no log4j config is shipped, only the API is used)
-keep class org.apache.log4j.** { *; }
