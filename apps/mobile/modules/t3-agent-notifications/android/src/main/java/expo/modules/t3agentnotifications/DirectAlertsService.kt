package expo.modules.t3agentnotifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future

/** Owns only notification polling, independently of React Native and chat sockets. */
class DirectAlertsService : Service() {
  companion object {
    const val CHANNEL = "direct-background-alerts"
    const val ID = 73002
    const val STOP = "t3.direct-alerts.STOP"
    const val SYNC = "t3.direct-alerts.SYNC"
    val statuses = ConcurrentHashMap<String, String>()
    @Volatile var running = false
    @Volatile private var instance: DirectAlertsService? = null
    fun synchronizeRunning() { instance?.syncWorkers() }
    fun stop(context: Context) {
      DirectAlertsStore.disable(context)
      context.stopService(Intent(context, DirectAlertsService::class.java))
    }
  }

  private val executor = Executors.newFixedThreadPool(8)
  private val workers = mutableMapOf<String, Future<*>>()
  private val connections = ConcurrentHashMap<String, HttpURLConnection>()
  @Volatile private var generation = 0
  override fun onBind(intent: Intent?): IBinder? = null

  private fun notification() = NotificationCompat.Builder(this, CHANNEL)
    .setSmallIcon(android.R.drawable.ic_dialog_info)
    .setContentTitle("T3 background alerts")
    .setContentText(if (statuses.values.any { it == "Connected" }) "Listening over direct connections" else "Connecting or disconnected — open T3 for details")
    .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
    .setContentIntent(packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, ID, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    })
    .addAction(0, "Stop alerts", PendingIntent.getService(this, ID,
      Intent(this, DirectAlertsService::class.java).setAction(STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build()

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == STOP) { stop(this); return START_NOT_STICKY }
    if (!DirectAlertsStore.enabled(this)) { stopSelf(); return START_NOT_STICKY }
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
      NotificationChannel(CHANNEL, "Background alert connection", NotificationManager.IMPORTANCE_LOW))
    if (Build.VERSION.SDK_INT >= 34) startForeground(ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    else startForeground(ID, notification())
    running = true
    instance = this
    syncWorkers()
    return START_STICKY
  }

  @Synchronized private fun status(id: String, value: String, epoch: Int) {
    if (epoch != generation || !running || !DirectAlertsStore.enabled(this)) return
    if (statuses[id] == value) return
    statuses[id] = value
    getSystemService(NotificationManager::class.java).notify(ID, notification())
  }

  @Synchronized private fun syncWorkers() {
    if (!running) return
    val epoch = ++generation
    connections.values.forEach { it.disconnect() }
    workers.values.forEach { it.cancel(true) }
    workers.clear()
    statuses.clear()
    val targets = try { DirectAlertsStore.targets(this) } catch (_: Exception) {
      statuses["storage"] = "Secure storage unavailable — reopen settings"
      return
    }
    for (index in 0 until targets.length()) {
      val target = targets.getJSONObject(index)
      val id = target.getString("environmentId")
      workers[id] = executor.submit { listen(target, epoch) }
    }
  }

  private fun listen(target: JSONObject, epoch: Int) {
    val id = target.getString("environmentId")
    val prefs = DirectAlertsStore.preferences(this)
    var retry = 1000L
    while (epoch == generation && !Thread.currentThread().isInterrupted) {
      var connection: HttpURLConnection? = null
      val pollStartedAt = android.os.SystemClock.elapsedRealtime()
      try {
        if (!statuses.containsKey(id)) status(id, "Connecting", epoch)
        val cursor = prefs.getString("cursor:$id", null)
        val suffix = cursor?.let { "?cursor=" + java.net.URLEncoder.encode(it, "UTF-8") }.orEmpty()
        connection = URL(target.getString("url") + suffix).openConnection() as HttpURLConnection
        connections[id] = connection
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 10000
        connection.readTimeout = 35000
        connection.setRequestProperty("Authorization", "Bearer " + target.getString("token"))
        connection.setRequestProperty("Accept", "application/json")
        val batch = DirectAlertsTransport.read(connection, id)
        if (epoch != generation) return
        synchronized(this) {
          if (epoch != generation || !DirectAlertsStore.enabled(this)) return
          val delivered = DirectAlertsStore.deliver(this, id) {
          val events = batch.getJSONArray("events")
          for (index in 0 until events.length()) {
            val event = events.getJSONObject(index)
            val seen = prefs.getString("seen:$id", "").orEmpty().split('\n').filter { it.isNotEmpty() }
            if (event.getString("id") !in seen) {
              AgentNotifications.receiveDirect(this, target.getString("scheme"), DirectAlertsProtocol.alert(event))
              check(prefs.edit().putString("seen:$id", (seen.takeLast(255) + event.getString("id")).joinToString("\n")).commit())
            }
          }
          check(prefs.edit().putString("cursor:$id", batch.getString("cursor")).commit())
          }
          if (!delivered) return
        }
        retry = 1000L
        status(id, "Connected", epoch)
        val remaining = 1000L - (android.os.SystemClock.elapsedRealtime() - pollStartedAt)
        if (!batch.getBoolean("more") && remaining > 0) Thread.sleep(remaining)
      } catch (pause: DirectAlertsTransport.Pause) {
        status(id, pause.reason, epoch)
        return
      } catch (_: Exception) {
        if (epoch != generation || Thread.currentThread().isInterrupted) return
        status(id, "Disconnected — retrying", epoch)
        try { Thread.sleep(retry) } catch (_: InterruptedException) { return }
        retry = (retry * 2).coerceAtMost(30000L)
      } finally {
        connection?.disconnect()
        if (connection != null) connections.remove(id, connection)
      }
    }
  }

  @Synchronized override fun onDestroy() {
    ++generation
    connections.values.forEach { it.disconnect() }
    workers.values.forEach { it.cancel(true) }
    executor.shutdownNow()
    running = false
    instance = null
    statuses.clear()
    super.onDestroy()
  }
}
