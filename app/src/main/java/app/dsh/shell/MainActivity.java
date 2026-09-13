package app.dsh.shell;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;

/**
 * The whole visible app: one full-screen WebView over the local dsh Web UI.
 *
 * The dsh process (official dsh 0.1.5-rc.2, booted with the SSH-only bundle)
 * serves on loopback; this activity renders it and nothing else. There is no
 * workbench, no navigation, no settings page of our own — dsh's own UI is the
 * product, per the project's "keep the original UI untouched" rule.
 */
public final class MainActivity extends Activity {

    /** Where the local dsh Web server listens (fixed by the boot profile). */
    private static final String DSH_URL = "http://127.0.0.1:3080/";

    /** The renderer. */
    private WebView web;

    /** Status line shown while the runtime is being prepared or is down. */
    private TextView status;

    /** Loads the UI once the service reports the server is up. */
    private final BroadcastReceiver ready = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            setStatus(null);
            if (web != null && web.getUrl() == null) {
                web.loadUrl(DSH_URL);
            }
        }
    };

    /** Marks the UI unreachable when the service reports the server is down. */
    private final BroadcastReceiver down = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            setStatus(R.string.status_down);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Full-screen immersive shell: no title bar, keep the screen on while
        // the user is working, and let the layout reach the display cutouts.
        getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);

        setContentView(R.layout.activity_main);
        web = findViewById(R.id.web);
        status = findViewById(R.id.status);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Model API calls go out from the dsh process itself; the WebView only
        // talks to loopback, and nothing else is reachable anyway.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Everything dsh serves is on loopback; other targets (if any
                // ever appear) go to the browser app, not this shell.
                String host = request.getUrl().getHost();
                return !"127.0.0.1".equals(host);
            }
        });

        registerReceivers();

        // Boot the runtime: first run extracts it, then the service starts
        // dsh and broadcasts ACTION_READY, which loads the URL above.
        Intent service = new Intent(this, DshService.class);
        startForegroundService(service);
        setStatus(R.string.status_starting);
    }

    @Override
    protected void onDestroy() {
        unregisterReceiver(ready);
        unregisterReceiver(down);
        super.onDestroy();
    }

    /**
     * Register the two service broadcasts.
     *
     * API 33 added the mandatory export flag; on older releases the plain
     * overload is the only one, and an app-private broadcast was never
     * exported by default anyway.
     */
    private void registerReceivers() {
        IntentFilter readyFilter = new IntentFilter(DshService.ACTION_READY);
        IntentFilter downFilter = new IntentFilter(DshService.ACTION_DOWN);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(ready, readyFilter, Context.RECEIVER_NOT_EXPORTED);
            registerReceiver(down, downFilter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(ready, readyFilter);
            registerReceiver(down, downFilter);
        }
    }

    /** Show a status line, or hide it when the UI is live. */
    private void setStatus(Integer text) {
        if (text == null) {
            status.setVisibility(View.GONE);
        } else {
            status.setText(text);
            status.setVisibility(View.VISIBLE);
        }
    }
}
