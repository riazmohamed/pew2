package expo.modules.pewring

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat

/**
 * Keeps the app alive while it rings, with the call notification as its own.
 * `shortService` (Android 14+): a few minutes at most, no extra grant, and a
 * high-priority push is allowed to start it from the background. The ring
 * ends itself after 30 seconds anyway.
 */
class PewRingService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val ringId = intent?.getStringExtra("ringId")
    if (ringId == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    val ring = PewRing(
      ringId = ringId,
      title = intent.getStringExtra("title") ?: "pew2 needs you",
      text = intent.getStringExtra("text") ?: "",
      focus = intent.getStringExtra("focus"),
    )
    val notification = PewRinger.notification(this, ring)
    try {
      val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE else 0
      ServiceCompat.startForeground(this, PewRinger.NOTIFICATION_ID, notification, type)
    } catch (_: Exception) {
      // Not allowed to run in front: the notification and the sound still ring.
      try {
        androidx.core.app.NotificationManagerCompat.from(this).notify(PewRinger.NOTIFICATION_ID, notification)
      } catch (_: SecurityException) {
        // Notifications not allowed.
      }
    }
    PewRinger.start(this, ring)
    return START_NOT_STICKY
  }

  /** `shortService` ran out of time: end the ring rather than be stopped for it. */
  override fun onTimeout(startId: Int) {
    PewRinger.finish(applicationContext, "missed")
  }
}
