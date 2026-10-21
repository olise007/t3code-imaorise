package expo.modules.t3agentnotifications

import java.net.HttpURLConnection
import org.json.JSONObject

/** No response body or server-provided error is exposed in status text. */
object DirectAlertsTransport {
  class Pause(val reason: String) : Exception(reason)

  fun read(connection: HttpURLConnection, environmentId: String): JSONObject {
    when (connection.responseCode) {
      401, 403 -> throw Pause("Authentication required — reconnect in T3")
      404 -> throw Pause("Update this environment to support direct alerts")
      200 -> Unit
      else -> throw java.io.IOException("Activity request failed")
    }
    val text = connection.inputStream.bufferedReader().use { reader ->
      val result = StringBuilder()
      val buffer = CharArray(2048)
      while (true) {
        if (Thread.currentThread().isInterrupted) throw InterruptedException()
        val count = reader.read(buffer)
        if (count < 0) break
        if (result.length + count > 131072) throw Pause("Activity response too large — reconnect in T3")
        result.append(buffer, 0, count)
      }
      result.toString()
    }
    return try { DirectAlertsProtocol.parse(text, environmentId) } catch (_: Exception) {
      throw Pause("Invalid activity response — reconnect in T3")
    }
  }
}
