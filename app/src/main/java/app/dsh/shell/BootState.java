package app.dsh.shell;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * The one place that knows how the local dsh is coming up.
 *
 * Broadcasts alone were the wrong carrier: an Activity that starts a moment
 * late (or returns from the background) misses the events it needed and has
 * no way to ask what happened. This holder is a process-wide singleton the
 * service writes and the UI reads, so the current state is always available
 * on demand and every later change is pushed to whoever is listening.
 *
 * It also appends every line to a rolling log file, so a crash or a failed
 * start can be inspected afterwards instead of leaving no trace.
 */
final class BootState {

    /** What the local server is doing right now. */
    enum Phase {
        /** Nothing has started yet. */
        IDLE,
        /** Unpacking the runtime bundle. */
        EXTRACTING,
        /** Starting the dsh process. */
        STARTING,
        /** Waiting for the loopback port to answer. */
        WAITING,
        /** The server is up; the WebView can load it. */
        READY,
        /** Boot failed; {@link #detail} carries the reason. */
        FAILED
    }

    /** How many log lines are kept in memory for the panel. */
    private static final int MEMORY_LINES = 500;

    /** How many lines the on-disk log keeps before it is trimmed. */
    private static final int FILE_LINES = 2000;

    /** The process-wide instance. */
    private static final BootState INSTANCE = new BootState();

    /** Current phase. */
    private volatile Phase phase = Phase.IDLE;
    /** One-line progress text for the current phase. */
    private volatile String status = "";
    /** Failure detail, when {@link #phase} is FAILED. */
    private volatile String detail = "";
    /**
     * The authenticated URL dsh printed once it was ready.
     *
     * dsh's Web server requires a launch token: a bare "/" request is answered
     * with 401. The token is random per process and only appears in the
     * "dsh web: http://127.0.0.1:PORT/?token=..." line, so the UI must load
     * that exact URL rather than a hardcoded address.
     */
    private volatile String webUrl = "";
    /** Log lines, oldest first. */
    private final Deque<String> lines = new ArrayDeque<>();
    /** UI listeners, notified after every change. */
    private final List<Runnable> listeners = new ArrayList<>();
    /** Rolling log file, created lazily. */
    private File logFile;

    private BootState() {
    }

    /** The singleton. */
    static BootState get() {
        return INSTANCE;
    }

    /** Point the log file at the app's private directory. */
    synchronized void attachLogFile(File file) {
        this.logFile = file;
    }

    /** The current phase. */
    Phase phase() {
        return phase;
    }

    /** The current one-line status. */
    String status() {
        return status;
    }

    /** The failure detail, or an empty string. */
    String detail() {
        return detail;
    }

    /** The authenticated URL dsh printed, or an empty string before then. */
    String webUrl() {
        return webUrl;
    }

    /** Record the authenticated URL parsed from dsh's output. */
    void webUrl(String url) {
        this.webUrl = url;
        notifyListeners();
    }

    /** A snapshot of the log lines. */
    synchronized List<String> lines() {
        return new ArrayList<>(lines);
    }

    /** The whole log as text. */
    synchronized String logText() {
        if (lines.isEmpty()) {
            return "";
        }
        StringBuilder text = new StringBuilder();
        for (String line : lines) {
            if (text.length() > 0) {
                text.append('\n');
            }
            text.append(line);
        }
        return text.toString();
    }

    /** Subscribe for change notifications; returns the unsubscribe handle. */
    synchronized Runnable subscribe(Runnable listener) {
        listeners.add(listener);
        return () -> {
            synchronized (BootState.this) {
                listeners.remove(listener);
            }
        };
    }

    /** Move to a new phase with its one-line status. */
    void phase(Phase next, String status) {
        this.phase = next;
        this.status = status;
        if (next != Phase.FAILED) {
            this.detail = "";
        }
        notifyListeners();
    }

    /** Move to FAILED with a detail block. */
    void fail(String detail) {
        this.phase = Phase.FAILED;
        this.detail = detail;
        notifyListeners();
    }

    /** Append one log line and refresh listeners. */
    void log(String line) {
        synchronized (this) {
            lines.addLast(line);
            while (lines.size() > MEMORY_LINES) {
                lines.removeFirst();
            }
        }
        appendToFile(line);
        notifyListeners();
    }

    /** Reset to a clean slate, for a user-requested restart. */
    void reset() {
        synchronized (this) {
            lines.clear();
        }
        phase = Phase.IDLE;
        status = "";
        detail = "";
        webUrl = "";
        notifyListeners();
    }

    private void notifyListeners() {
        List<Runnable> snapshot;
        synchronized (this) {
            snapshot = new ArrayList<>(listeners);
        }
        for (Runnable listener : snapshot) {
            listener.run();
        }
    }

    /** Append one line to the rolling log file, trimming it when it grows. */
    private void appendToFile(String line) {
        File file = logFile;
        if (file == null) {
            return;
        }
        try {
            // Trim before appending so the file cannot grow without bound.
            if (file.length() > 256 * 1024) {
                List<String> keep = new ArrayList<>();
                synchronized (this) {
                    keep.addAll(lines);
                }
                int from = Math.max(0, keep.size() - FILE_LINES);
                try (Writer writer = new OutputStreamWriter(
                        new FileOutputStream(file, false), StandardCharsets.UTF_8)) {
                    for (int i = from; i < keep.size(); i++) {
                        writer.write(keep.get(i));
                        writer.write('\n');
                    }
                }
                return;
            }
            try (Writer writer = new OutputStreamWriter(
                    new FileOutputStream(file, true), StandardCharsets.UTF_8)) {
                writer.write(line);
                writer.write('\n');
            }
        } catch (IOException ignored) {
            // Logging must never take the boot down with it.
        }
    }
}
