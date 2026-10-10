package expo.modules.t3nativecontrols

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.net.Uri
import java.security.MessageDigest
import java.util.zip.ZipFile
import android.text.format.DateFormat
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI

class T3NativeControlsModule : Module() {
  private var filePreviewPromise: Promise? = null
  private fun versionCode(info: android.content.pm.PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

  @Suppress("TooGenericExceptionCaught") // Clear the pending promise before rethrowing.
  override fun definition() = ModuleDefinition {
    Name("T3NativeControls")

    AsyncFunction("verifyPersonalApk") { uri: String, expectedSha: String, expectedCode: Long, expectedCertificate: String, expectedSize: Long ->
      val context = appContext.reactContext ?: error("The app is not active.")
      val file = File(URI(uri)).canonicalFile
      require(file.path.startsWith(context.cacheDir.canonicalPath + File.separator)) { "Updates must be in private cache." }
      require(file.isFile && file.length() == expectedSize) { "APK size mismatch." }
      val digest = MessageDigest.getInstance("SHA-256")
      file.inputStream().use { input ->
        val buffer = ByteArray(65536)
        while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
      }
      fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
      require(hex(digest.digest()).equals(expectedSha, true)) { "APK checksum mismatch." }
      val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
      val archive = context.packageManager.getPackageArchiveInfo(file.path, flags) ?: error("Invalid APK.")
      val installed = context.packageManager.getPackageInfo(context.packageName, flags)
      require(context.packageName == "com.imaorise.t3code" && archive.packageName == context.packageName) { "APK package mismatch." }
      require(versionCode(archive) == expectedCode && versionCode(archive) > versionCode(installed)) { "Update would not advance the installed version." }
      require((archive.applicationInfo?.minSdkVersion ?: Int.MAX_VALUE) <= Build.VERSION.SDK_INT) { "This update requires a newer Android version." }
      fun certificates(info: android.content.pm.PackageInfo): Set<String> {
        val signers = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
        return signers?.map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }?.toSet() ?: emptySet()
      }
      val trusted = certificates(installed)
      val candidate = certificates(archive)
      require(trusted.isNotEmpty() && candidate == trusted && candidate == setOf(expectedCertificate.lowercase().replace(":", ""))) { "APK signing certificate mismatch." }
      require(Build.SUPPORTED_ABIS.contains("arm64-v8a")) { "This release requires ARM64." }
      ZipFile(file).use { zip ->
        val abis = zip.entries().asSequence().filter { it.name.startsWith("lib/") && it.name.endsWith(".so") }.map { it.name.split('/')[1] }.toSet()
        require(abis == setOf("arm64-v8a")) { "APK architecture mismatch." }
      }
      true
    }

    Function("getInstalledPersonalVersionCode") {
      val context = appContext.reactContext ?: error("The app is not active.")
      versionCode(context.packageManager.getPackageInfo(context.packageName, 0)).toDouble()
    }
    Function("canInstallPersonalApk") {
      val context = appContext.reactContext ?: error("The app is not active.")
      Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()
    }
    AsyncFunction("openPersonalInstallPermission") {
      val activity = appContext.currentActivity ?: error("The app is not active.")
      activity.startActivity(if (Build.VERSION.SDK_INT >= 26)
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
        else Intent(Settings.ACTION_SECURITY_SETTINGS))
    }
    AsyncFunction("installPersonalApk") { uri: String ->
      val activity = appContext.currentActivity ?: error("The app is not active.")
      require(Build.VERSION.SDK_INT < 26 || activity.packageManager.canRequestPackageInstalls()) { "Allow this app to install updates in Android Settings first." }
      val file = File(URI(uri)).canonicalFile
      require(file.path.startsWith(activity.cacheDir.canonicalPath + File.separator) && file.isFile) { "Update file is unavailable." }
      val contentUri = FileProvider.getUriForFile(activity, "${activity.packageName}.FileSystemFileProvider", file)
      activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      })
    }

    Function("is24HourFormat") {
      val context = appContext.reactContext ?: error("The app is not active.")
      DateFormat.is24HourFormat(context)
    }

    AsyncFunction("openFile") { uri: String, mimeType: String, promise: Promise ->
      check(filePreviewPromise == null) { "A document viewer is already open." }
      val activity = appContext.currentActivity ?: error("The app is not active.")
      val file = File(URI(uri)).canonicalFile
      require(file.isFile) { "The file is no longer available." }
      val contentUri = FileProvider.getUriForFile(
        activity,
        "${activity.packageName}.FileSystemFileProvider",
        file
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, mimeType)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      filePreviewPromise = promise
      try {
        activity.startActivityForResult(intent, 7343)
      } catch (error: Exception) {
        filePreviewPromise = null
        throw error
      }
    }

    OnActivityResult { _, (requestCode) ->
      if (requestCode == 7343) {
        filePreviewPromise?.resolve(null)
        filePreviewPromise = null
      }
    }

    Function("getShowcasePairingUrl") {
      appContext.currentActivity?.intent?.getStringExtra("showcasePairingUrl")
    }

    Function("getShowcaseScene") {
      val storedScene = appContext.reactContext
        ?.filesDir
        ?.resolve("t3-showcase-scene")
        ?.takeIf { it.isFile }
        ?.readText()
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
      storedScene ?: appContext.currentActivity?.intent?.getStringExtra("showcaseScene")
    }

    // The palette is fixed for the whole capture, so it only ever arrives as a
    // launch extra — unlike the scene, which the runner rewrites in place.
    Function("getShowcaseTheme") {
      appContext.currentActivity?.intent?.getStringExtra("showcaseTheme")
    }

    Function("prepareShowcaseCapture") {
      // Android app data is cleared by the host runner before launch.
    }

    Function("markShowcaseReady") { scene: String ->
      appContext.reactContext
        ?.filesDir
        ?.resolve("t3-showcase-ready")
        ?.writeText(scene)
    }
  }
}
