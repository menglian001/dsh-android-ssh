package app.dsh.shell;

import android.content.Context;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.zip.GZIPInputStream;

/**
 * One-time extraction of the packaged runtime into App-private storage.
 *
 * The APK ships a single gzipped tar of the whole runtime — minimal Ubuntu
 * rootfs with Node 24, official dsh 0.1.5-rc.2, and the SSH-only execution
 * bundle — assembled on the build machine by scripts/stage-runtime.sh.
 * Extracting it locally keeps every byte under the app's private directory,
 * so uninstall deletes everything, per the product rules.
 */
final class RuntimeInstaller {

    private static final String TAG = "RuntimeInstaller";

    /** Asset name of the staged runtime archive. */
    private static final String ASSET = "dsh-runtime.bin";

    /** Marker written next to the extracted tree to skip re-extraction. */
    private static final String MARKER = ".extracted";

    private RuntimeInstaller() {
    }

    /** Reports extraction progress so the UI can show something truthful. */
    interface Progress {
        /**
         * @param consumed - compressed bytes read so far, or 0 when unknown.
         * @param total - compressed asset size, or 0 when unknown.
         * @param entries - archive entries finished so far.
         */
        void onExtract(long consumed, long total, long entries);
    }

    /**
     * Return the extracted runtime root, extracting it on first call.
     *
     * The layout on disk:
     * <pre>
     *   filesDir/dsh-runtime/
     *     rootfs/   (Ubuntu + Node + dsh, read-only after extraction)
     *     data/     (dsh's world: history, plugins, SSH trust store)
     * </pre>
     *
     * @param context - App context.
     * @param progress - extraction progress sink; may be null.
     */
    static File ensureRuntime(Context context, Progress progress) throws IOException {
        File root = new File(context.getFilesDir(), "dsh-runtime");
        File rootfs = new File(root, "rootfs");
        File marker = new File(root, MARKER);

        if (marker.isFile() && rootfs.isDirectory()) {
            return root;
        }

        long started = System.currentTimeMillis();
        Log.i(TAG, "extracting runtime bundle");
        long total = assetSize(context, ASSET);
        try (InputStream raw = context.getAssets().open(ASSET);
             CountingInputStream counting = new CountingInputStream(raw);
             InputStream gunzip = new GZIPInputStream(counting, 1 << 16)) {
            untar(gunzip, root, progress, counting, total);
        }
        touch(marker);
        Log.i(TAG, "runtime extracted in "
                + (System.currentTimeMillis() - started) + " ms");
        return root;
    }

    /** The stored size of one asset, or 0 when it cannot be read. */
    private static long assetSize(Context context, String name) {
        try {
            return context.getAssets().openFd(name).getLength();
        } catch (IOException unknown) {
            return 0;
        }
    }

    /**
     * Whether the runtime has already been extracted.
     *
     * The UI shows a longer, honest "first run" message only when the bundle
     * still has to be unpacked; every later launch is a plain server start.
     */
    static boolean isPrepared(Context context) {
        File root = new File(context.getFilesDir(), "dsh-runtime");
        return new File(root, MARKER).isFile() && new File(root, "rootfs").isDirectory();
    }

    /** Minimal tar reader: dirs, files, symlinks, hardlinks, and GNU
     * LongLink ('L'/'K') entries — node_modules paths exceed 100 chars. */
    private static void untar(
            InputStream in, File root, Progress progress,
            CountingInputStream counting, long total) throws IOException {
        byte[] header = new byte[512];
        String pendingLongName = null;
        String pendingLongLink = null;
        long entries = 0;
        // Absolute entry names are anchored at the extraction root.
        while (readFully(in, header) == 512) {
            String name = cstring(header, 0, 100);
            if (name.isEmpty()) {
                break; // end-of-archive marker
            }
            long size = parseOctal(header, 124, 12);
            int type = header[156] == 0 ? '0' : header[156];
            long mode = parseOctal(header, 100, 8);
            String linkName = pendingLongLink != null
                    ? pendingLongLink : cstring(header, 157, 100);
            String entryName = pendingLongName != null
                    ? pendingLongName : name;
            pendingLongName = null;
            pendingLongLink = null;

            if (type == 'L' || type == 'K') {
                // GNU LongLink: the payload is the next entry's name/target.
                byte[] payload = new byte[(int) size];
                if (readFully(in, payload) != size) {
                    throw new IOException("truncated LongLink entry");
                }
                skipExactly(in, (-size) & 511L);
                String value = cstring(payload, 0, payload.length);
                if (type == 'L') {
                    pendingLongName = value;
                } else {
                    pendingLongLink = value;
                }
                continue;
            }
            if (type == 'x' || type == 'g') {
                // PAX extended headers: not produced by our GNU-format
                // staging tar; skip defensively if one ever appears.
                skipExactly(in, (size + 511) & ~511L);
                continue;
            }

            // Count only real entries: LongLink/PAX metadata above is skipped
            // before reaching here, so the number matches what a user sees in
            // a file manager rather than the archive's internal bookkeeping.
            entries++;
            if (progress != null && entries % 200 == 0) {
                progress.onExtract(counting.consumed(), total, entries);
            }

            File target = safeTarget(root, entryName);
            if (type == '5') {
                //noinspection ResultOfMethodCallIgnored
                target.mkdirs();
            } else if (type == '2' || type == '1') {
                // Symlink targets are taken verbatim (relative to the link's
                // own directory, as tar records them). Hardlink targets are
                // archive-rooted, so resolve them to the extracted absolute
                // path — app-private paths contain no spaces, so this is safe.
                //noinspection ResultOfMethodCallIgnored
                target.getParentFile().mkdirs();
                String destination;
                if (type == '2') {
                    destination = linkName;
                } else {
                    File linked = safeTarget(root, linkName);
                    destination = linked.getAbsolutePath();
                }
                try {
                    Os.symlink(destination, target.getAbsolutePath());
                } catch (ErrnoException unsupported) {
                    // A filesystem without symlink support cannot host the
                    // rootfs; surface it instead of extracting a broken tree.
                    throw new IOException("symlink failed for " + entryName, unsupported);
                }
            } else if (type == '0') {
                //noinspection ResultOfMethodCallIgnored
                target.getParentFile().mkdirs();
                try (OutputStream out = new FileOutputStream(target)) {
                    copyExactly(in, size, out);
                }
                if ((mode & 0111) != 0) {
                    // Executable bit, per the octal mode field.
                    //noinspection ResultOfMethodCallIgnored
                    target.setExecutable(true, false);
                }
            } else {
                // Skip unknown entry types, but still consume their bytes.
                skipExactly(in, size);
            }
            // Entries are padded to 512-byte blocks.
            long padded = (size + 511) & ~511L;
            long remainder = padded - size;
            skipExactly(in, remainder);
        }
        if (progress != null) {
            progress.onExtract(counting.consumed(), total, entries);
        }
    }

    /**
     * Counts the bytes pulled through the decompressor.
     *
     * The gzip stream reads ahead of the tar parser, so the count is a
     * truthful "how far through the asset are we" figure without needing the
     * asset length to be exact.
     */
    private static final class CountingInputStream extends java.io.FilterInputStream {
        private long consumed;

        CountingInputStream(InputStream in) {
            super(in);
        }

        long consumed() {
            return consumed;
        }

        @Override
        public int read() throws IOException {
            int value = super.read();
            if (value >= 0) {
                consumed++;
            }
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            int read = super.read(buffer, offset, length);
            if (read > 0) {
                consumed += read;
            }
            return read;
        }

        @Override
        public long skip(long count) throws IOException {
            long skipped = super.skip(count);
            if (skipped > 0) {
                consumed += skipped;
            }
            return skipped;
        }
    }

    /** Resolve an entry name under root, refusing path escapes. */
    private static File safeTarget(File root, String name) throws IOException {
        File resolved = new File(root, name.startsWith("/") ? name.substring(1) : name);
        String canonical = resolved.getCanonicalPath();
        if (!canonical.startsWith(root.getCanonicalPath() + File.separator)
                && !canonical.equals(root.getCanonicalPath())) {
            throw new IOException("tar entry escapes root: " + name);
        }
        return resolved;
    }

    private static void touch(File file) throws IOException {
        //noinspection ResultOfMethodCallIgnored
        new FileOutputStream(file).close();
    }

    private static String cstring(byte[] block, int offset, int length) {
        int end = offset;
        int limit = Math.min(offset + length, block.length);
        while (end < limit && block[end] != 0) {
            end++;
        }
        return new String(block, offset, end - offset);
    }

    private static long parseOctal(byte[] block, int offset, int length) {
        String text = cstring(block, offset, length).trim();
        if (text.isEmpty()) {
            return 0;
        }
        return Long.parseLong(text, 8);
    }

    private static int readFully(InputStream in, byte[] buffer) throws IOException {
        int done = 0;
        while (done < buffer.length) {
            int read = in.read(buffer, done, buffer.length - done);
            if (read < 0) {
                return done;
            }
            done += read;
        }
        return done;
    }

    private static void copyExactly(InputStream in, long count, OutputStream out)
            throws IOException {
        byte[] buffer = new byte[1 << 16];
        long done = 0;
        while (done < count) {
            int chunk = (int) Math.min(buffer.length, count - done);
            int read = in.read(buffer, 0, chunk);
            if (read < 0) {
                throw new IOException("archive truncated");
            }
            out.write(buffer, 0, read);
            done += read;
        }
    }

    private static void skipExactly(InputStream in, long count) throws IOException {
        long done = 0;
        while (done < count) {
            long skipped = in.skip(count - done);
            if (skipped <= 0) {
                if (in.read() < 0) {
                    throw new IOException("archive truncated");
                }
                skipped = 1;
            }
            done += skipped;
        }
    }
}
