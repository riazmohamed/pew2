package expo.modules.voicecallservice

import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Starts and stops [VoiceCallService] for the length of a live voice call.
 *
 * `start` must be called while the app is on screen and after the microphone
 * permission is granted: Android 14 refuses a microphone-type foreground
 * service started from the background, which is exactly why it cannot wait
 * until the screen locks.
 */
class VoiceCallServiceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VoiceCallService")

    Function("start") { title: String, text: String ->
      val context = appContext.reactContext ?: return@Function false
      val intent = Intent(context, VoiceCallService::class.java)
        .putExtra(VoiceCallService.EXTRA_TITLE, title)
        .putExtra(VoiceCallService.EXTRA_TEXT, text)
      try {
        ContextCompat.startForegroundService(context, intent)
        true
      } catch (error: Exception) {
        // A refused start (backgrounded, permission missing) must not take the
        // call down with it: the conversation still works while on screen.
        false
      }
    }

    Function("stop") {
      val context = appContext.reactContext ?: return@Function false
      context.stopService(Intent(context, VoiceCallService::class.java))
    }
  }
}
