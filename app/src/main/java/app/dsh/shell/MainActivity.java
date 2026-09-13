package app.dsh.shell;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
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
 * from the phone instead of being an opaque wait. State comes from
 * {@link BootState}, read on demand and pushed on change — broadcasts alone
 * lost events whenever this Activity started after the service.
 */
public final class MainActivity extends Activity {

    /** Where the local dsh Web server listens (fixed by the boot profile). */
    private static final String DSH_URL = "http://127.0.0.1:3080/";

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

    /** Set while the card is visible, so READY only loads the URL once. */
    private boolean urlLoaded;

    /** Unsubscribe handle for the state listener. */
    private Runnable unsubscribe;

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

        // The foreground service posts a status notification; Android 13+ hides
        // it unless the user grants POST_NOTIFICATIONS at runtime.
        requestNotificationPermission();

        // Render the current state immediately, then follow every change.
        unsubscribe = BootState.get().subscribe(this::render);
        render();

        // Ask the service to come up. If it is already running, the duplicate
        // start is ignored, so the existing process is left alone.
        startForegroundService(new Intent(this, DshService.class));
    }

    @Override
    protected void onDestroy() {
        if (unsubscribe != null) {
            unsubscribe.run();
        }
        super.onDestroy();
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
        urlLoaded = false;
        setLogVisible(false);
        startService(new Intent(this, DshService.class)
                .setAction(DshService.ACTION_RESTART));
    }

    /** Copy the whole captured log to the clipboard. */
    private void copyLog() {
        String text = BootState.get().logText();
        if (text.isEmpty()) {
            text = getString(R.string.log_empty);
        }
        ((ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE))
                .setPrimaryClip(ClipData.newPlainText("dsh log", text));
        Toast.makeText(this, R.string.log_copied, Toast.LENGTH_SHORT).show();
    }

    /** Show or hide the log panel, updating the toggle label. */
    private void setLogVisible(boolean visible) {
        logPanel.setVisibility(visible ? View.VISIBLE : View.GONE);
        String label = getString(visible
                ? R.string.action_hide_log
                : R.string.action_show_log);
        logToggle.setText(label);
    }
    /** Paint the whole screen from the current {@link BootState}. */
    private void render() {
        BootState state = BootState.get();
        switch (state.phase()) {
            case READY:
                startup.setVisibility(View.GONE);
                if (!urlLoaded) {
                    urlLoaded = true;
                    web.loadUrl(DSH_URL);
                }
                return;
            case FAILED:
                progress.setText(state.detail().isEmpty()
                        ? getString(R.string.status_down) : state.detail());
                spinner.setVisibility(View.GONE);
                actions.setVisibility(View.VISIBLE);
                // A failure is exactly when the log matters, so reveal it once.
                if (logPanel.getVisibility() != View.VISIBLE) {
                    setLogVisible(true);
                }
                break;
            default:
                // IDLE / EXTRACTING / STARTING / WAITING
                progress.setText(state.status().isEmpty()
                        ? getString(R.string.progress_prepare) : state.status());
                spinner.setVisibility(View.VISIBLE);
                actions.setVisibility(View.GONE);
                break;
        }
        // Keep the log panel current whenever it is on screen.
        if (logPanel.getVisibility() == View.VISIBLE) {
            renderLog(state.lines());
        }
    }

    /** Redraw the log panel from the given lines, scrolled to the bottom. */
    private void renderLog(List<String> lines) {
        StringBuilder text = new StringBuilder();
        for (String line : lines) {
            if (text.length() > 0) {
                text.append('\n');
            }
            text.append(line);
        }
        logText.setText(text.length() == 0 ? getString(R.string.log_empty) : text.toString());
        logPanel.post(() -> logPanel.fullScroll(View.FOCUS_DOWN));
    }
}
