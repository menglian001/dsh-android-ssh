/**
 * Re-export the dsh-fs type vocabulary. The published @deepseek-ai/dsh-fs
 * package does not export './lib/types/*' as a subpath, so this shim imports
 * the declaration file relatively — type-only, erased at compile time.
 */
export type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsObservation,
  FsPathInfo,
  FsTarget,
  FsTargetKey,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
  FsErrorCode,
} from '@deepseek-ai/dsh-fs'
