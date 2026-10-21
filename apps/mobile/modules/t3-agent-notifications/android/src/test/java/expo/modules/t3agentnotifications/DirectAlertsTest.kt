package expo.modules.t3agentnotifications

import android.app.Application
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ProcessLifecycleOwner
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import javax.crypto.spec.SecretKeySpec
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 33, 34, 36], manifest = Config.NONE)
class DirectAlertsTest {
  private lateinit var context: Application

  @Before fun setup() {
    context = RuntimeEnvironment.getApplication()
    DirectAlertsStore.preferences(context).edit().clear().commit()
    shadowOf(context.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(true)
    (ProcessLifecycleOwner.get().lifecycle as LifecycleRegistry).currentState = Lifecycle.State.CREATED
  }

  @Test fun credentialCipherAuthenticatesContentsAndUsesFreshNonces() {
    val key = SecretKeySpec(ByteArray(32) { it.toByte() }, "AES")
    val credential = "paired-secret-not-plaintext"
    val first = DirectAlertsCipher.seal(key, credential)
    val second = DirectAlertsCipher.seal(key, credential)
    assertFalse(first.contentEquals(second))
    assertFalse(String(first, Charsets.UTF_8).contains(credential))
    assertEquals(credential, DirectAlertsCipher.open(key, first))
    first[first.lastIndex] = (first.last().toInt() xor 1).toByte()
    assertThrows(Exception::class.java) { DirectAlertsCipher.open(key, first) }
    assertThrows(Exception::class.java) { DirectAlertsCipher.open(SecretKeySpec(ByteArray(32), "AES"), second) }
  }

  @Test fun deselectionRejectsLateDeliveryAndPreservesTheOtherEnvironment() {
    DirectAlertsStore.select(context, true, JSONArray(listOf("a", "b")))
    DirectAlertsStore.preferences(context).edit().putString("cursor:a", "epoch:1").putString("seen:a", "event").commit()
    AgentNotifications.receiveDirect(context, "t3code-imaorise", mapOf("alert_id" to "event", "alert_group" to "direct:a", "alert_title" to "Done", "alert_body" to "Task", "alert_path" to "/threads/a/thread"))
    DirectAlertsStore.select(context, true, JSONArray(listOf("b")))
    var delivered = false
    assertFalse(DirectAlertsStore.deliver(context, "a") { delivered = true })
    assertFalse(delivered)
    assertTrue(DirectAlertsStore.deliver(context, "b") { delivered = true })
    assertTrue(delivered)
    assertTrue(DirectAlertsStore.enabled(context))
    assertFalse(DirectAlertsStore.preferences(context).contains("cursor:a"))
    assertFalse(DirectAlertsStore.preferences(context).contains("seen:a"))
    assertTrue(context.getSystemService(NotificationManager::class.java).activeNotifications.none { it.notification.group == "direct:a" })
  }

  @Test fun stopSerializesWithDeliveryAndRejectsSubsequentAlerts() {
    DirectAlertsStore.select(context, true, JSONArray(listOf("environment")))
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val stopping = CountDownLatch(1)
    val pool = Executors.newFixedThreadPool(2)
    try {
      val delivery = pool.submit<Boolean> {
        DirectAlertsStore.deliver(context, "environment") {
          entered.countDown()
          check(release.await(5, TimeUnit.SECONDS))
        }
      }
      assertTrue(entered.await(5, TimeUnit.SECONDS))
      val stop = pool.submit {
        stopping.countDown()
        DirectAlertsStore.disable(context)
      }
      assertTrue(stopping.await(5, TimeUnit.SECONDS))
      assertFalse(stop.isDone)
      release.countDown()
      assertTrue(delivery.get(5, TimeUnit.SECONDS))
      stop.get(5, TimeUnit.SECONDS)
      assertFalse(DirectAlertsStore.deliver(context, "environment") { fail("Alert after stop") })
      assertFalse(DirectAlertsStore.enabled(context))
    } finally {
      release.countDown()
      pool.shutdownNow()
    }
  }

  @Test fun explicitStopRemainsStoppedOnServiceRecreation() {
    DirectAlertsStore.select(context, true, JSONArray(listOf("environment")))
    val controller = Robolectric.buildService(DirectAlertsService::class.java).create()
    val service = controller.get()
    assertEquals(Service.START_STICKY, service.onStartCommand(Intent(), 0, 1))
    assertTrue(DirectAlertsService.running)
    assertEquals(Service.START_NOT_STICKY, service.onStartCommand(Intent().setAction(DirectAlertsService.STOP), 0, 2))
    controller.destroy()
    assertFalse(DirectAlertsService.running)
    assertFalse(DirectAlertsStore.enabled(context))
    val next = Robolectric.buildService(DirectAlertsService::class.java).create()
    assertEquals(Service.START_NOT_STICKY, next.get().onStartCommand(null, 0, 1))
    next.destroy()
  }

  @Test fun transportPausesAuthorizationAndUnsupportedServersWithoutReadingTheirBodies() {
    for (code in listOf(401, 403, 404)) {
      val connection = object : java.net.HttpURLConnection(java.net.URL("http://localhost/")) {
        override fun getResponseCode() = code
        override fun getInputStream(): java.io.InputStream = throw AssertionError("Must not read error body")
        override fun disconnect() {}
        override fun usingProxy() = false
        override fun connect() {}
      }
      assertThrows(DirectAlertsTransport.Pause::class.java) { DirectAlertsTransport.read(connection, "env") }
    }
  }

  @Test fun transportBoundsResponsesAndDoesNotExposeInvalidServerContent() {
    fun connection(body: String, code: Int = 200) = object : java.net.HttpURLConnection(java.net.URL("http://localhost/")) {
      override fun getResponseCode() = code
      override fun getInputStream() = body.byteInputStream()
      override fun disconnect() {}
      override fun usingProxy() = false
      override fun connect() {}
    }
    assertThrows(DirectAlertsTransport.Pause::class.java) { DirectAlertsTransport.read(connection(" ".repeat(131073)), "env") }
    val invalid = assertThrows(DirectAlertsTransport.Pause::class.java) { DirectAlertsTransport.read(connection("secret-invalid-body"), "env") }
    assertFalse(invalid.message.orEmpty().contains("secret-invalid-body"))
    assertThrows(java.io.IOException::class.java) { DirectAlertsTransport.read(connection("redirect", 302), "env") }
    val batch = """{"environmentId":"env","cursor":"epoch:1","reset":true,"more":false,"events":[]}"""
    assertEquals("epoch:1", DirectAlertsTransport.read(connection(batch), "env").getString("cursor"))
  }

  @Test fun protocolBindsIdentityAndRejectsCrossEnvironmentNavigation() {
    val event = JSONObject().put("id", "event").put("environmentId", "env").put("threadId", "thread")
      .put("phase", "completed").put("title", "Task").put("headline", "Done").put("path", "/threads/env/thread")
    val batch = JSONObject().put("environmentId", "env").put("cursor", "epoch:1")
      .put("reset", false).put("more", false).put("events", JSONArray().put(event))
    assertEquals("epoch:1", DirectAlertsProtocol.parse(batch.toString(), "env").getString("cursor"))
    assertThrows(IllegalArgumentException::class.java) { DirectAlertsProtocol.parse(batch.toString(), "other") }
    event.put("path", "/threads/other/thread")
    assertThrows(IllegalArgumentException::class.java) { DirectAlertsProtocol.parse(batch.toString(), "env") }
    val target = JSONObject().put("environmentId", "env").put("token", "secret").put("url", "http://100.64.0.1:4777/api/direct-agent-activity")
    DirectAlertsProtocol.validateTarget(target)
    target.put("url", "https://user:secret@host/api/direct-agent-activity")
    assertThrows(IllegalArgumentException::class.java) { DirectAlertsProtocol.validateTarget(target) }
  }
}
