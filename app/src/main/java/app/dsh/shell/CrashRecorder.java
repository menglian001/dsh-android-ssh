package app.dsh.shell;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;

/**
 * Records an uncaught exception so the next launch can show it.
 *
 * A crash inside the shell is otherwise invisible: the user sees the app
 * vanish, and there is nothing on the phone to read. Writing the stack trace
 * to a file next to the runtime turns "it crashes" into an exact cause that
 * can be copied out of the log panel.
 *
 * The previous crash is surfaced once and then cleared, so a fixed build does
 * not keep showing a stale report.
 */
final class CrashRecorder {

    /** File the stack trace is written to. */
    private static final String FILE_NAME = "last-crash.txt";

    private CrashRecorder() {
    }

    /**
     * Install the handler for this process.
     *
     * Chains to the previous handler so the platform still reports the crash.
     * Safe to call more than once; later calls replace the earlier handler.
     *
     * @param context - any context; only its files directory is used.
     */
    static void install(Context context) {
        final Context app = context.getApplicationContext();
        final Thread.UncaughtExceptionHandler previous =
                Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            write(app, thread, error);
            if (previous != null) {
                previous.uncaughtException(thread, error);
            }
        });
    }

    /**
     * Read and clear the previous crash report.
     *
     * @param context - any context; only its files directory is used.
     * @return the report text, or an empty string when there was no crash.
     */
    static String consume(Context context) {
        File file = new File(context.getFilesDir(), FILE_NAME);
        if (!file.isFile()) {
            return "";
        }
        try {
            byte[] bytes = new byte[(int) file.length()];
            try (java.io.FileInputStream in = new java.io.FileInputStream(file)) {
                int read = 0;
                while (read < bytes.length) {
                    int step = in.read(bytes, read, bytes.length - read);
                    if (step < 0) {
                        break;
                    }
                    read += step;
                }
            }
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            return new String(bytes, StandardCharsets.UTF_8);
        } catch (IOException unreadable) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            return "";
        }
    }

    /** Append one crash report to the file. */
    private static void write(Context context, Thread thread, Throwable error) {
        StringWriter trace = new StringWriter();
        trace.append("crash on thread \"").append(thread.getName()).append("\"\n");
        error.printStackTrace(new PrintWriter(trace));
        try (Writer writer = new OutputStreamWriter(
                new FileOutputStream(new File(context.getFilesDir(), FILE_NAME), false),
                StandardCharsets.UTF_8)) {
            writer.write(trace.toString());
        } catch (IOException ignored) {
            // Nothing more can be done while the process is already dying.
        }
    }
}
