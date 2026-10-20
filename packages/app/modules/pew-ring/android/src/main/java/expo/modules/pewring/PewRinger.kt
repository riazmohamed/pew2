package expo.modules.pewring

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/** One ring, as the daemon's data-only push carries it. */
data class PewRing(val ringId: String, val title: String, val text: String, val focus: String?)

/**
 * Rings the phone like a call: the phone's own ringtone on repeat, a call
 * buzz, and a call notification with Answer and Decline, for up to
 * [RING_MS]. Everything here is best effort: a ring that cannot play its
 * sound still shows, and one that cannot show still times out.
 */
object PewRinger {
  const val CHANNEL = "pew-ring"
  const val MISSED_CHANNEL = "pew-ring-missed"
  const val NOTIFICATION_ID = 7301
  const val MISSED_ID = 7302
  const val RING_MS = 30_000L
  const val ACTION_DECLINE = "expo.modules.pewring.DECLINE"
  const val EXTRA_RING = "ring"

  private const val PREFS = "pew_ring"
  private const val KEY_CLAIMED = "claimed"
  private const val KEY_ENDED = "ended"

  private val handler = Handler(Looper.getMainLooper())
  private var ringtone: Ringtone? = null
  private var vibrator: Vibrator? = null
  private var current: PewRing? = null
  private var timeout: Runnable? = null

  /** The ring in a push's data, or null for every other push. */
  fun readRing(data: Map<String, String>): PewRing? {
    // Expo puts the message's `data` in "body" as JSON; read the top level too.
    val fields = HashMap<String, String>(data)
    data["body"]?.let { raw ->
      try {
        val json = JSONObject(raw)
        for (key in json.keys()) fields[key] = json.opt(key)?.toString() ?: ""
      } catch (_: Exception) {
        // Not JSON: not ours.
      }
    }
    if (fields["pewRing"] != "true" && fields["pewRing"] != "1") return null
    val ringId = fields["ring"]?.takeIf { it.isNotEmpty() } ?: return null
    return PewRing(
      ringId = ringId,
      title = fields["title"]?.takeIf { it.isNotEmpty() } ?: "pew2 needs you",
      text = fields["text"] ?: "",
      focus = fields["focus"]?.takeIf { it.isNotEmpty() },
    )
  }

  /** The app is on screen: its own incoming-call card rings instead. */
  fun appInFront(): Boolean {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  /**
   * Take a ring, once: the push and the app's open socket both deliver it,
   * and only the first to claim it rings. Remembers the last few ids.
   */
  @Synchronized
  fun claim(context: Context, ringId: String): Boolean {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val list = JSONArray(prefs.getString(KEY_CLAIMED, "[]"))
    for (i in 0 until list.length()) if (list.optString(i) == ringId) return false
    val next = JSONArray()
    val start = maxOf(0, list.length() - 19)
    for (i in start until list.length()) next.put(list.optString(i))
    next.put(ringId)
    prefs.edit().putString(KEY_CLAIMED, next.toString()).apply()
    return true
  }

  @Synchronized
  fun claimed(context: Context, ringId: String): Boolean {
    val list = JSONArray(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_CLAIMED, "[]"))
    for (i in 0 until list.length()) if (list.optString(i) == ringId) return true
    return false
  }

  /** Declines and misses for the app to tell the daemon (it holds the next ring off). */
  @Synchronized
  fun takeEnded(context: Context): List<Map<String, String>> {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val list = JSONArray(prefs.getString(KEY_ENDED, "[]"))
    prefs.edit().putString(KEY_ENDED, "[]").apply()
    val out = ArrayList<Map<String, String>>()
    for (i in 0 until list.length()) {
      val item = list.optJSONObject(i) ?: continue
      out.add(mapOf("ring" to item.optString("ring"), "reason" to item.optString("reason")))
    }
    return out
  }

  @Synchronized
  private fun recordEnded(context: Context, ringId: String, reason: String) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val list = JSONArray(prefs.getString(KEY_ENDED, "[]"))
    if (list.length() < 20) list.put(JSONObject().put("ring", ringId).put("reason", reason))
    prefs.edit().putString(KEY_ENDED, list.toString()).apply()
  }

  /** A ring from the push: through the foreground service, or straight here if that is refused. */
  fun incoming(context: Context, ring: PewRing) {
    if (appInFront()) return
    if (!claim(context, ring.ringId)) return
    val intent = Intent(context, PewRingService::class.java)
      .putExtra("ringId", ring.ringId)
      .putExtra("title", ring.title)
      .putExtra("text", ring.text)
      .putExtra("focus", ring.focus)
    try {
      ContextCompat.startForegroundService(context, intent)
    } catch (_: Exception) {
      // Refused (a background start the system would not allow): ring without it.
      handler.post {
        try {
          NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification(context, ring))
        } catch (_: SecurityException) {
          // Notifications not allowed: the sound still says it.
        }
        start(context, ring)
      }
    }
  }

  /** Sound, buzz and the timeout. Main thread. */
  fun start(context: Context, ring: PewRing) {
    stopSound()
    current = ring
    playSound(context)
    val app = context.applicationContext
    val missed = Runnable { finish(app, "missed") }
    timeout = missed
    handler.postDelayed(missed, RING_MS)
  }

  /**
   * End the ring: `answered` (the app opened it), `declined`, `missed`, or
   * null for "stopped by the app" (nothing to report).
   */
  fun finish(context: Context, reason: String?) {
    handler.post {
      val ring = current
      stopSound()
      current = null
      timeout?.let { handler.removeCallbacks(it) }
      timeout = null
      NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
      context.stopService(Intent(context, PewRingService::class.java))
      if (ring != null && (reason == "declined" || reason == "missed")) recordEnded(context, ring.ringId, reason)
      if (ring != null && reason == "missed") notifyMissed(context, ring)
    }
  }

  private fun playSound(context: Context) {
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    val mode = audio?.ringerMode ?: AudioManager.RINGER_MODE_NORMAL
    if (mode == AudioManager.RINGER_MODE_NORMAL) {
      try {
        val uri: Uri = RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_RINGTONE)
          ?: Settings.System.DEFAULT_RINGTONE_URI
        val tone = RingtoneManager.getRingtone(context, uri)
        if (tone != null) {
          tone.audioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) tone.isLooping = true
          tone.play()
          ringtone = tone
        }
      } catch (_: Exception) {
        // No ringtone to play: the buzz and the notification still ring.
      }
    }
    if (mode != AudioManager.RINGER_MODE_SILENT) {
      try {
        val buzz = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
          @Suppress("DEPRECATION")
          context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build()
        @Suppress("DEPRECATION")
        buzz.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 1000, 1000), 0), attributes)
        vibrator = buzz
      } catch (_: Exception) {
        // No vibrator.
      }
    }
  }

  private fun stopSound() {
    try { ringtone?.stop() } catch (_: Exception) {}
    ringtone = null
    try { vibrator?.cancel() } catch (_: Exception) {}
    vibrator = null
  }

  private fun channel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL) == null) {
      val channel = NotificationChannel(CHANNEL, "Calls from Pew", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Pew ringing you when something needs you"
        // The ring plays its own sound and buzz, on repeat; the channel's would play once on top.
        setSound(null, null)
        enableVibration(false)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      }
      manager.createNotificationChannel(channel)
    }
    if (manager.getNotificationChannel(MISSED_CHANNEL) == null) {
      manager.createNotificationChannel(
        NotificationChannel(MISSED_CHANNEL, "Missed calls from Pew", NotificationManager.IMPORTANCE_DEFAULT),
      )
    }
  }

  private fun icon(context: Context): Int {
    val res = context.resources
    val named = res.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (named != 0) named else context.applicationInfo.icon
  }

  /** Opens the app on `pew2://ring/answer`, which starts the call. */
  private fun answerIntent(context: Context, ring: PewRing): PendingIntent {
    val uri = Uri.Builder().scheme("pew2").authority("ring").appendPath("answer")
      .appendQueryParameter("ring", ring.ringId)
      .apply { ring.focus?.let { appendQueryParameter("focus", it) } }
      .build()
    val intent = Intent(Intent.ACTION_VIEW, uri)
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      ring.ringId.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  fun notification(context: Context, ring: PewRing): Notification {
    channel(context)
    val decline = PendingIntent.getBroadcast(
      context,
      ring.ringId.hashCode() + 1,
      Intent(context, PewRingReceiver::class.java).setAction(ACTION_DECLINE).putExtra(EXTRA_RING, ring.ringId),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val answer = answerIntent(context, ring)
    return NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(icon(context))
      .setContentTitle(ring.title)
      .setContentText(ring.text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(ring.text))
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      .setOnlyAlertOnce(true)
      .setContentIntent(answer)
      .addAction(0, "Decline", decline)
      .addAction(0, "Answer", answer)
      .setTimeoutAfter(RING_MS + 2_000)
      .build()
  }

  private fun notifyMissed(context: Context, ring: PewRing) {
    try {
      channel(context)
      val missed = NotificationCompat.Builder(context, MISSED_CHANNEL)
        .setSmallIcon(icon(context))
        .setContentTitle("Missed call from Pew")
        .setContentText(ring.text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(ring.text))
        .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
        .setAutoCancel(true)
        .setContentIntent(answerIntent(context, ring))
        .build()
      NotificationManagerCompat.from(context).notify(MISSED_ID, missed)
    } catch (_: SecurityException) {
      // Notifications not allowed.
    }
  }
}
