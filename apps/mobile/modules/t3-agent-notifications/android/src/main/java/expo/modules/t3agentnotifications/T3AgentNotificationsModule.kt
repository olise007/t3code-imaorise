package expo.modules.t3agentnotifications

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.net.Uri
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AgentNotificationsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3AgentNotifications")

    Function("getDirectState") {
      val context = requireNotNull(appContext.reactContext)
      JSONObject().put("enabled", DirectAlertsStore.enabled(context))
        .put("selectedIds", JSONArray(DirectAlertsStore.selected(context).sorted()))
        .put("running", DirectAlertsService.running)
        .put("statuses", JSONObject(DirectAlertsService.statuses.toMap())).toString()
    }

    Function("setDirectSelection") { enabled: Boolean, ids: String ->
      val context = requireNotNull(appContext.reactContext)
      DirectAlertsStore.select(context, enabled, JSONArray(ids))
      DirectAlertsService.synchronizeRunning()
      if (!enabled) context.stopService(Intent(context, DirectAlertsService::class.java))
    }

    Function("syncDirectTargets") { allowed: String, updates: String ->
      val context = requireNotNull(appContext.reactContext)
      val changed = DirectAlertsStore.reconcile(context, JSONArray(allowed), JSONArray(updates))
      if (DirectAlertsStore.enabled(context) && (changed || !DirectAlertsService.running)) {
        check(appContext.currentActivity != null) { "Open T3 to start background alerts." }
        ContextCompat.startForegroundService(context, Intent(context, DirectAlertsService::class.java).setAction(DirectAlertsService.SYNC))
      }
      if (!DirectAlertsStore.enabled(context)) context.stopService(Intent(context, DirectAlertsService::class.java))
    }

    Function("openDirectBatterySettings") {
      val context = requireNotNull(appContext.reactContext)
      context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    Function("configure") {
        deviceId: String,
        userId: String,
        scheme: String,
        ongoingEnabled: Boolean
      ->
      appContext.reactContext?.let {
        AgentNotifications.configure(it, deviceId, userId, scheme, ongoingEnabled)
      }
    }

    Function("clear") {
      appContext.reactContext?.let { AgentNotifications.clear(it) }
    }

    Function("showShowcaseActivity") { scheme: String, data: Map<String, String> ->
      appContext.reactContext?.let { AgentNotifications.showcase(it, scheme, data) }
    }

    Function("setThreadOnScreen") { path: String? ->
      AgentNotifications.setThreadOnScreen(path)
    }

    Function("openLiveUpdateSettings") {
      val context = appContext.reactContext
      if (context == null || Build.VERSION.SDK_INT < 36) {
        false
      } else {
        try {
          context.startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
              .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          )
          true
        } catch (_: ActivityNotFoundException) {
          false
        }
      }
    }
  }
}
