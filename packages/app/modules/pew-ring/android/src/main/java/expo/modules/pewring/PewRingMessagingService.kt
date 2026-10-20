package expo.modules.pewring

import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService

/**
 * In front of expo-notifications' own push service (see the manifest): a ring
 * rings here, and every other push goes on to Expo exactly as before, as do
 * new push tokens (inherited).
 */
class PewRingMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    val ring = try {
      PewRinger.readRing(remoteMessage.data)
    } catch (_: Exception) {
      null
    }
    if (ring == null) {
      super.onMessageReceived(remoteMessage)
      return
    }
    PewRinger.incoming(applicationContext, ring)
  }
}
