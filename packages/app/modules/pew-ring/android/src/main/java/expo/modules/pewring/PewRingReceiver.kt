package expo.modules.pewring

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Decline, from the call notification. */
class PewRingReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == PewRinger.ACTION_DECLINE) PewRinger.finish(context.applicationContext, "declined")
  }
}
