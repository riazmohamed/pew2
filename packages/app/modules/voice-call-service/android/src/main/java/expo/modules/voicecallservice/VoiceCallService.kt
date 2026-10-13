package expo.modules.voicecallservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Holds the app in the foreground, as far as Android is concerned, while a
 * voice conversation is live, so the microphone keeps working with the screen
 * locked. It does no audio work itself: WebRTC owns the audio. The ongoing
 * notification is the price Android asks for that, and tapping it returns to
 * the call.
 */
class VoiceCallService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Voice conversation"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Listening"
    ensureChannel()

    val launch = packageManager.getLaunchIntentForPackage(packageName)?.also {
      it.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
    }
    val content = launch?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setContentIntent(content)
      .build()

    try {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        notification,
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        } else {
          0
        },
      )
    } catch (error: Exception) {
      // Refused (started from the background, or no microphone grant). Stop
      // rather than crash: the call carries on while the app is on screen.
      stopSelf()
      return START_NOT_STICKY
    }
    // Not sticky: if the process dies, the call is gone, and a restarted
    // service would only show a notification for a conversation that ended.
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Swiping the app away ends the conversation; the notification goes too.
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Voice conversations", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while a live voice conversation is using the microphone."
        setShowBadge(false)
      },
    )
  }

  companion object {
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    private const val CHANNEL_ID = "voice-call"
    private const val NOTIFICATION_ID = 7341
  }
}
