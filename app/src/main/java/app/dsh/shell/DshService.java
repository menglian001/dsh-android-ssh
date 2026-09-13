package app.dsh.shell;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Foreground service that keeps the dsh process alive.
 *
 * Boot order, every start: extract the runtime bundle on first run (one-time,
 * App-private), then launch dsh Web through proot and report readiness once
 * the loopback port answers. The service stays foregrounded so Android keeps
 * the process running with the screen off; the user stops it from the
 * notification, which tears dsh down cleanly.
 *
 * Everything the process touches — rootfs, dsh data, SSH trust store — lives
 * under this app's private storage, so uninstalling removes it all.
 */
public final class DshService extends Service {

    /** Broadcast when the loopback server answers. */
    public static final String ACTION_READY = "app.dsh.shell.READY";
    /** Broadcast when the server is down or failed to boot. */
    public static final String ACTION_DOWN = "app.dsh.shell.DOWN";

    private static final String CHANNEL_ID = "dsh";
    private static final int NOTIFICATION_ID = 1;
    private static final String TAG = "DshService";

    /** Single-threaded boot lane: extraction then process start, in order. */
    private final ExecutorService boot = Executors.newSingleThreadExecutor();

    /** The live dsh process, if any. */
    private final AtomicReference<Process> dsh = new AtomicReference<>();

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.notification_channel_desc));
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = buildNotification(getString(R.string.notification_starting));
        startForeground(NOTIFICATION_ID, notification);
        boot.submit(this::bootRuntime);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopDsh();
        boot.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** Extract the runtime on first run, start dsh, then announce readiness. */
    private void bootRuntime() {
        try {
            File root = RuntimeInstaller.ensureRuntime(this);
            Process process = launchDsh(root);
            dsh.set(process);

            // Watch the process; if it exits, tell the UI.
            new Thread(() -> {
                try {
                    int code = process.waitFor();
                    Log.w(TAG, "dsh exited with " + code);
                    sendBroadcast(new Intent(ACTION_DOWN));
                } catch (InterruptedException ignored) {
                    // Service shutdown; the process was destroyed alongside.
                }
            }, "dsh-watch").start();

            // Poll loopback until the server answers, then announce readiness.
            if (awaitServer()) {
                updateNotification(getString(R.string.notification_running));
                sendBroadcast(new Intent(ACTION_READY));
            } else {
                updateNotification(getString(R.string.notification_failed));
                sendBroadcast(new Intent(ACTION_DOWN));
            }
        } catch (Exception error) {
            Log.e(TAG, "runtime boot failed", error);
            updateNotification(getString(R.string.notification_failed));
            sendBroadcast(new Intent(ACTION_DOWN));
        }
    }

    /** Start the dsh Web process inside the proot rootfs. */
    private Process launchDsh(File runtimeRoot) throws IOException {
        File nativeDir = new File(getApplicationInfo().nativeLibraryDir);
        File proot = new File(nativeDir, "libproot.so");
        File rootfs = new File(runtimeRoot, "rootfs");
        File data = new File(runtimeRoot, "data");
        File tmp = new File(runtimeRoot, "tmp");
        //noinspection ResultOfMethodCallIgnored
        data.mkdirs();
        //noinspection ResultOfMethodCallIgnored
        tmp.mkdirs();

        // Termux's proot is a launcher: it execs the loader named by
        // PROOT_LOADER, so argv starts with the ordinary proot flags.
        List<String> argv = new ArrayList<>();
        argv.add(proot.getAbsolutePath());
        argv.add("-L");
        argv.add("--kill-on-exit");
        argv.add("-0");
        argv.add("--rootfs=" + rootfs.getAbsolutePath());
        argv.add("--cwd=/data");
        // The kernel-facing mounts a Node process needs inside the container.
        argv.add("-b");
        argv.add("/dev");
        argv.add("-b");
        argv.add("/proc");
        // dsh's whole world (history, plugins, SSH trust store) lives in
        // App-private storage; uninstalling the app removes it all. The
        // rootfs ships /data as an empty mountpoint for exactly this bind.
        argv.add("-b");
        argv.add(data.getAbsolutePath() + ":/data");
        argv.add("/usr/bin/node");
        argv.add("/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");
        argv.add("web");
        // SSH-only execution: an overlay on top of the official web profile;
        // the original UI, settings layout and permission chain stay exactly
        // as shipped. It lives under /opt/dsh because /data is bind-mounted
        // over by this very service, which would shadow a rootfs copy.
        argv.add("--patch");
        argv.add("/opt/dsh/ssh-only.yml");

        ProcessBuilder builder = new ProcessBuilder(argv).redirectErrorStream(true);
        Map<String, String> env = builder.environment();
        // proot's own bootstrap: the loader binary and its private temp dir.
        env.put("PROOT_LOADER", new File(nativeDir, "libprootloader.so").getAbsolutePath());
        env.put("PROOT_LOADER_32", new File(nativeDir, "libprootloader32.so").getAbsolutePath());
        env.put("PROOT_TMP_DIR", tmp.getAbsolutePath());
        // libtalloc and libandroid-shmem sit beside libproot.so; both are
        // linked by the launcher and the loader.
        env.put("LD_LIBRARY_PATH", nativeDir.getAbsolutePath());
        // Guest-side environment.
        env.put("HOME", "/root");
        env.put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        env.put("TMPDIR", "/tmp");
        // dsh locates its profiles under $DSH_HOME, not a --data flag.
        env.put("DSH_HOME", "/data");
        // Model API egress stays direct from the phone (user's own key);
        // no proxying is configured here.
        return builder.start();
    }

    /** Poll loopback until the server answers or the process dies. */
    private boolean awaitServer() {
        for (int attempt = 0; attempt < 150; attempt++) {
            if (dsh.get() != null && !dsh.get().isAlive()) {
                return false;
            }
            try {
                Thread.sleep(200);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
            try {
                // A connection refused means not yet up; any answer is up.
                java.net.Socket socket = new java.net.Socket();
                socket.connect(new java.net.InetSocketAddress("127.0.0.1", 3080), 200);
                socket.close();
                return true;
            } catch (IOException notYet) {
                // Retry.
            }
        }
        return false;
    }

    /** Stop the live dsh process, if any. */
    private void stopDsh() {
        Process process = dsh.getAndSet(null);
        if (process != null) {
            process.destroy();
        }
    }

    private Notification buildNotification(String text) {
        return buildBase(text).build();
    }

    private void updateNotification(String text) {
        getSystemService(NotificationManager.class)
                .notify(NOTIFICATION_ID, buildBase(text).build());
    }

    private Notification.Builder buildBase(String text) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setOngoing(true);
    }
}
