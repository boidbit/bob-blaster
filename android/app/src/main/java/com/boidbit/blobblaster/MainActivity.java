package com.boidbit.blobblaster;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // super.onCreate must run first: it switches to AppTheme.NoActionBar. EdgeToEdge touches the window, and doing that while the
        // launch theme is still active builds the window with a title bar (on Android 12+ Theme.SplashScreen has one).
        super.onCreate(savedInstanceState);
        // Draw behind the system bars. Capacitor's SystemBars plugin then hides them and reports safe-area insets to the page.
        EdgeToEdge.enable(this);
    }
}
