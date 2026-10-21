# Mobile notifications

Sign in to T3 Connect, link your environments, and enable **Device Notifications** in **Settings → Notifications** to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Your environment must have agent activity publishing enabled.

Enable **Ongoing Agent Activity** on Android or **Live Activity Updates** on iOS to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off ongoing activity in Settings to stop future cards.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

T3 Connect notifications on Android require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. Cloud push delivery requires T3 Connect. Direct background alerts are available separately on Android as described below. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.

## Direct Android alerts over Tailscale

Pair your Android app with an updated environment using its direct Tailscale DNS or IP address. In **Settings → Notifications**, select environments under **Direct connection alerts**, then enable **Background alerts over direct connections**. This does not require T3 Connect, cloud sign-in, or Google Play services. The paired connection needs orchestration read permission.

A persistent notification shows listening status and offers **Stop alerts**. Alerts open the corresponding thread; approvals remain inside T3. Turning listening off leaves agents and terminals running. If authorization expires, reconnect explicitly in T3.

Keep Tailscale connected. Android and device-specific battery restrictions can delay delivery, including while locked; this is not a push-delivery guarantee. Notification and battery settings are linked from the notification settings page. After reboot or force-stop, reopen T3 to resume listening. iOS does not support this direct background listener.
