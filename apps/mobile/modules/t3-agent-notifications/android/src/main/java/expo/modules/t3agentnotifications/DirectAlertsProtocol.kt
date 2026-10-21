package expo.modules.t3agentnotifications

import org.json.JSONObject
import java.net.URI
import android.net.Uri

object DirectAlertsProtocol {
  const val PATH = "/api/direct-agent-activity"
  private val phases = setOf("waiting_for_approval", "waiting_for_input", "completed", "failed")

  fun validateTarget(target: JSONObject) {
    val url = URI(target.getString("url"))
    require(url.scheme in setOf("http", "https") && !url.host.isNullOrBlank())
    require(url.rawUserInfo == null && url.rawQuery == null && url.rawFragment == null && url.path == PATH)
    require(target.getString("token").isNotBlank() && target.getString("token").length <= 16384)
    require(target.getString("environmentId").isNotBlank())
  }

  fun parse(body: String, environmentId: String): JSONObject {
    val batch = JSONObject(body)
    require(batch.getString("environmentId") == environmentId) { "Environment identity mismatch" }
    batch.getBoolean("reset")
    batch.getBoolean("more")
    require(batch.getString("cursor").matches(Regex("[\\w-]+:[0-9]+")))
    val events = batch.getJSONArray("events")
    require(events.length() <= 100)
    for (index in 0 until events.length()) {
      val event = events.getJSONObject(index)
      require(event.getString("environmentId") == environmentId)
      require(event.getString("phase") in phases)
      require(event.getString("id").length in 1..256)
      require(event.getString("title").length <= 120 && event.getString("headline").length <= 120)
      val path = Uri.parse(event.getString("path"))
      require(path.scheme == null && path.authority == null && path.query == null && path.fragment == null)
      require(path.pathSegments == listOf("threads", environmentId, event.getString("threadId")))
    }
    return batch
  }

  fun alert(event: JSONObject) = mapOf(
    "alert_id" to event.getString("id"),
    "alert_title" to event.getString("headline"),
    "alert_body" to event.getString("title"),
    "alert_path" to event.getString("path"),
    "alert_group" to "direct:${event.getString("environmentId")}",
  )
}
