package com.boidbit.blobblaster;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Draw behind the system bars. Capacitor's SystemBars plugin then hides them and reports safe-area insets to the page.
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
    }
}
