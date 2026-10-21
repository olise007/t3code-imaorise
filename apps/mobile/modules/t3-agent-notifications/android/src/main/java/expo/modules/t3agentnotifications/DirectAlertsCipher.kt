package expo.modules.t3agentnotifications

import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object DirectAlertsCipher {
  fun seal(key: SecretKey, text: String): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key)
    return cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8))
  }

  fun open(key: SecretKey, bytes: ByteArray): String {
    require(bytes.size >= 28)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
    return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
  }
}
