package expo.modules.pewring

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** What the app needs of the native ring: share ring ids, stop it, and hear how rings ended. */
class PewRingModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PewRing")

    /** Take a ring for the app's own card; false if the push already rang it. */
    Function("claim") { ringId: String ->
      val context = appContext.reactContext ?: return@Function true
      PewRinger.claim(context, ringId)
    }

    Function("claimed") { ringId: String ->
      val context = appContext.reactContext ?: return@Function false
      PewRinger.claimed(context, ringId)
    }

    /** Answered in the app (or a call started): stop ringing, nothing to report. */
    Function("stop") {
      val context = appContext.reactContext ?: return@Function null
      PewRinger.finish(context.applicationContext, null)
      null
    }

    /** Declines and misses since last asked, for the daemon. */
    Function("takeEnded") {
      val context = appContext.reactContext ?: return@Function emptyList<Map<String, String>>()
      PewRinger.takeEnded(context)
    }
  }
}
