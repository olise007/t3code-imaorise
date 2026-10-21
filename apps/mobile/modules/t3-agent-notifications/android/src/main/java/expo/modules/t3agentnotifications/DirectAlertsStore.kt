package expo.modules.t3agentnotifications

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** Credentials stay in this app's storage, encrypted with a non-exportable Android key. */
object DirectAlertsStore {
  private const val KEY = "t3-direct-alerts-v1"
  fun preferences(context: Context) = context.getSharedPreferences(KEY, Context.MODE_PRIVATE)

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(KEY, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }

  @Synchronized fun targets(context: Context): JSONArray {
    val encoded = preferences(context).getString("targets", null) ?: return JSONArray()
    val bytes = Base64.decode(encoded, Base64.NO_WRAP)
    return JSONArray(DirectAlertsCipher.open(key(), bytes))
  }

  @Synchronized fun saveTargets(context: Context, targets: JSONArray) {
    val bytes = DirectAlertsCipher.seal(key(), targets.toString())
    check(preferences(context).edit().putString("targets", Base64.encodeToString(bytes, Base64.NO_WRAP)).commit())
  }

  fun selected(context: Context): Set<String> = preferences(context).getStringSet("selected", emptySet()).orEmpty().toSet()
  fun enabled(context: Context) = preferences(context).getBoolean("enabled", false)

  @Synchronized fun select(context: Context, enabled: Boolean, ids: JSONArray) {
    require(ids.length() <= 8) { "Select up to eight environments." }
    val selected = (0 until ids.length()).map { ids.getString(it) }.toSet()
    require(!enabled || selected.isNotEmpty()) { "Select an environment first." }
    val removed = selected(context) - selected
    if (enabled && removed.isNotEmpty()) {
      val old = targets(context)
      val remaining = JSONArray((0 until old.length()).map { old.getJSONObject(it) }
        .filter { it.getString("environmentId") in selected })
      if (remaining.length() > 0) saveTargets(context, remaining)
      else check(preferences(context).edit().remove("targets").commit())
    }
    val editor = preferences(context).edit().putBoolean("enabled", enabled).putStringSet("selected", selected)
    if (!enabled) editor.remove("targets")
    for (id in removed) editor.remove("cursor:$id").remove("seen:$id")
    check(editor.commit())
    for (id in removed) AgentNotifications.clearDirectEnvironment(context, id)
  }

  @Synchronized fun disable(context: Context) {
    check(preferences(context).edit().putBoolean("enabled", false).remove("targets").commit())
  }

  /** Selection changes and delivery share this lock, including notification cleanup. */
  @Synchronized fun deliver(context: Context, environmentId: String, block: () -> Unit): Boolean {
    if (!enabled(context) || environmentId !in selected(context)) return false
    block()
    return true
  }

  @Synchronized fun reconcile(context: Context, allowed: JSONArray, updates: JSONArray): Boolean {
    val allowedIds = (0 until allowed.length()).map { allowed.getString(it) }.toSet()
    val selected = selected(context).intersect(allowedIds)
    val removed = selected(context) - selected
    val old = targets(context)
    val merged = mutableMapOf<String, JSONObject>()
    for (index in 0 until old.length()) {
      val target = old.getJSONObject(index)
      if (target.getString("environmentId") in selected) merged[target.getString("environmentId")] = target
    }
    for (index in 0 until updates.length()) {
      val target = updates.getJSONObject(index)
      val id = target.getString("environmentId")
      if (id in selected) {
        DirectAlertsProtocol.validateTarget(target)
        merged[id] = target
      }
    }
    val result = JSONArray(merged.toSortedMap().values.toList())
    val changed = result.toString() != old.toString()
    if (changed) saveTargets(context, result)
    val editor = preferences(context).edit().putStringSet("selected", selected)
    if (selected.isEmpty()) editor.putBoolean("enabled", false)
    for (id in removed) {
      editor.remove("cursor:$id").remove("seen:$id")
      AgentNotifications.clearDirectEnvironment(context, id)
    }
    check(editor.commit())
    return changed
  }
}
