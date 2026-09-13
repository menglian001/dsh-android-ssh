package app.dsh.shell;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
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
import android.widget.Button;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

/**
 * The whole visible app: one full-screen WebView over the local dsh Web UI.
 *
 * The dsh process (official dsh 0.1.5-rc.2, booted with the SSH-only bundle)
 * serves on loopback; this activity renders it and nothing else. There is no
 * workbench, no navigation, no settings page of our own — dsh's own UI is the
 * product, per the project's "keep the original UI untouched" rule.
 *
 * While the local server boots, a startup card covers the screen with real
 * progress and an expandable log, so a slow or failed start is diagnosable
 * from the phone instead of being an opaque wait.
 */
public final class MainActivity extends Activity {

    /** Where the local dsh Web server listens (fixed by the boot profile). */
    private static final String DSH_URL = "http://127.0.0.1:3080/";

    /** How many log lines the panel keeps. */
    private static final int LOG_LIMIT = 400;

    /** The renderer. */
    private WebView web;

    /** Startup card and its parts. */
    private View startup;
    private TextView progress;
    private View spinner;
    private View actions;
    private ScrollView logPanel;
    private TextView logText;
    private TextView logToggle;

    /** Captured log lines, oldest first. */
    private final List<String> logLines = new ArrayList<>();

    /** True once the UI is live; the startup card must not come back. */
    private boolean uiLive;

    /** Loads the UI once the service reports the server is up. */
    private final BroadcastReceiver ready = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            uiLive = true;
            startup.setVisibility(View.GONE);
            if (web != null && web.getUrl() == null) {
                web.loadUrl(DSH_URL);
            }
        }
    };

    /** Marks the UI unreachable, showing whatever detail the service sent. */
    private final BroadcastReceiver down = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (uiLive) return;
            String detail = intent.getStringExtra(DshService.EXTRA_TEXT);
            progress.setText(detail == null ? getString(R.string.status_down) : detail);
            spinner.setVisibility(View.GONE);
            actions.setVisibility(View.VISIBLE);
            // A failure is exactly when the log matters, so reveal it.
            setLogVisible(true);
        }
    };

    /** Replaces the progress line. */
    private final BroadcastReceiver progressUpdate = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (uiLive) return;
            String text = intent.getStringExtra(DshService.EXTRA_TEXT);
            if (text != null) {
                progress.setText(text);
            }
        }
    };

    /** Appends one captured output line to the log panel. */
    private final BroadcastReceiver logUpdate = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (uiLive) return;
            String line = intent.getStringExtra(DshService.EXTRA_TEXT);
            if (line == null) {
                return;
            }
            logLines.add(line);
            while (logLines.size() > LOG_LIMIT) {
                logLines.remove(0);
            }
            renderLog();
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
        startup = findViewById(R.id.startup);
        progress = findViewById(R.id.progress);
        spinner = findViewById(R.id.spinner);
        actions = findViewById(R.id.actions);
        logPanel = findViewById(R.id.logPanel);
        logText = findViewById(R.id.logText);
        logToggle = findViewById(R.id.logToggle);

        ((Button) findViewById(R.id.restart)).setOnClickListener(v -> restart());
        ((Button) findViewById(R.id.copyLog)).setOnClickListener(v -> copyLog());
        logToggle.setOnClickListener(v -> setLogVisible(logPanel.getVisibility() != View.VISIBLE));

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

        // The foreground service posts a status notification; Android 13+ hides
        // it unless the user grants POST_NOTIFICATIONS at runtime.
        requestNotificationPermission();

        // Boot the runtime: on a fresh install this extracts the bundle (slow),
        // then the service starts dsh and broadcasts ACTION_READY, which loads
        // the URL above. Later launches only wait for the server to come up.
        startDshService();
        progress.setText(RuntimeInstaller.isPrepared(this)
                ? getString(R.string.progress_starting)
                : getString(R.string.progress_prepare));    }

    @Override
    protected void onDestroy() {
        unregisterReceiver(ready);
        unregisterReceiver(down);
        unregisterReceiver(progressUpdate);
        unregisterReceiver(logUpdate);
        super.onDestroy();
    }

    /** Ask the service to start dsh. */
    private void startDshService() {
        startForegroundService(new Intent(this, DshService.class));
    }

    /**
     * Request the notification permission on Android 13+.
     *
     * Without it the foreground service's status notification is silently
     * suppressed, which is exactly the "I cannot see what it is doing" problem
     * this screen exists to fix.
     */
    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                    new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    /** Stop and start the service again, from a clean slate. */
    private void restart() {
        uiLive = false;
        logLines.clear();
        renderLog();
        actions.setVisibility(View.GONE);
        spinner.setVisibility(View.VISIBLE);
        progress.setText(getString(R.string.progress_prepare));
        // Tear the old service down (its onDestroy stops the process and
        // interrupts the boot lane), then bring a fresh one up.
        stopService(new Intent(this, DshService.class));
        progress.postDelayed(this::startDshService, 500);
    }

    /** Copy the whole captured log to the clipboard. */
    private void copyLog() {
        String text = logLines.isEmpty() ? getString(R.string.log_empty) : join(logLines);
        ((ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE))
                .setPrimaryClip(ClipData.newPlainText("dsh log", text));
        Toast.makeText(this, R.string.log_copied, Toast.LENGTH_SHORT).show();
    }

    /** Show or hide the log panel, updating the toggle label. */
    private void setLogVisible(boolean visible) {
        logPanel.setVisibility(visible ? View.VISIBLE : View.GONE);
        logToggle.setText(visible ? R.string.action_hide_log : R.string.action_show_log);
    }

    /** Redraw the log panel from the captured lines. */
    private void renderLog() {
        logText.setText(logLines.isEmpty() ? getString(R.string.log_empty) : join(logLines));
        if (logPanel.getVisibility() == View.VISIBLE) {
            logPanel.post(() -> logPanel.fullScroll(View.FOCUS_DOWN));
        }
    }

    /** Join log lines with newlines. */
    private static String join(List<String> lines) {
        StringBuilder text = new StringBuilder();
        for (String line : lines) {
            if (text.length() > 0) {
                text.append('\n');
            }
            text.append(line);
        }
        return text.toString();
    }

    /**
     * Register the service broadcasts.
     *
     * API 33 added the mandatory export flag; on older releases the plain
     * overload is the only one, and an app-private broadcast was never
     * exported by default anyway.
     */
    private void registerReceivers() {
        IntentFilter filter = new IntentFilter();
        filter.addAction(DshService.ACTION_READY);
        filter.addAction(DshService.ACTION_DOWN);
        filter.addAction(DshService.ACTION_PROGRESS);
        filter.addAction(DshService.ACTION_LOG);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(ready, filter, Context.RECEIVER_NOT_EXPORTED);
            registerReceiver(down, filter, Context.RECEIVER_NOT_EXPORTED);
            registerReceiver(progressUpdate, filter, Context.RECEIVER_NOT_EXPORTED);
            registerReceiver(logUpdate, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(ready, filter);
            registerReceiver(down, filter);
            registerReceiver(progressUpdate, filter);
            registerReceiver(logUpdate, filter);
        }
    }
}
