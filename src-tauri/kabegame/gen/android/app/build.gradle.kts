import java.util.Properties
import java.io.FileInputStream
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// applicationId 与 tauri.conf.json 的 identifier 一致(构建系统按 --mode 渲染:
// dev=app.kabegame.dev / prod=app.kabegame),提供设备上 dev/prod 并存隔离与
// `am start -n {identifier}/...` 拉起目标。
// namespace(Java 包:源码/生成 Kotlin/BuildConfig/R)固定 app.kabegame,不随 mode 变——
// fork 的 cargo-tauri 按 TAURI_ANDROID_PACKAGE 与 identifier 解耦,见 cocs/tauri/TAURI_CLI_FORK.md。
val tauriIdentifier: String = run {
    val confFile = file("../../../tauri.conf.json")
    if (confFile.exists()) {
        @Suppress("UNCHECKED_CAST")
        val conf = JsonSlurper().parse(confFile) as Map<String, Any?>
        // 只接受合法反向域名式 identifier;桌面渲染残留的 "Kabegame"(无点)时回退。
        (conf["identifier"] as? String)?.takeIf { it.contains('.') } ?: "app.kabegame"
    } else "app.kabegame"
}

android {
    compileSdk = 36
    namespace = "app.kabegame"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = tauriIdentifier
        minSdk = 26  // Android 8.0+ (API 26+)
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            if (keystorePropertiesFile.exists()) {
                val keystoreProperties = Properties()
                keystoreProperties.load(FileInputStream(keystorePropertiesFile))
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["password"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["password"] as String
            } else {
                // Fallback: sign release with default Android debug keystore so APK can be installed.
                // Create ~/.android/debug.keystore by running a debug build once, or add keystore.properties for Play Store.
                val debugKeystore = file("${System.getProperty("user.home")}/.android/debug.keystore")
                storeFile = debugKeystore
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
    }
    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("release")
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
