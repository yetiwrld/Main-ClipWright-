/**
 * SPEC 15 §6.3 — portable build behaviour.
 *
 * The portable exe stores its data next to itself **only** when an empty
 * `portable.flag` sits beside it. With no flag (the default) it behaves exactly
 * like an installed copy and uses `%APPDATA%`, which is the safer choice: moving
 * the exe does not orphan the user's workspace.
 *
 * Secrets still go through `safeStorage`, which is bound to the Windows user, so
 * moving the exe to another PC means re-entering API keys. That is documented
 * rather than worked around.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PortableInfo {
  /** True when running from a portable build (electron-builder sets PORTABLE_EXECUTABLE_DIR). */
  isPortable: boolean;
  /** True when the user opted into data-next-to-the-exe with `portable.flag`. */
  usesLocalData: boolean;
  /** Directory the app data lives in, when `usesLocalData`. */
  dataDir: string | null;
}

/**
 * Detect portable mode and decide where app data belongs.
 *
 * @param execDir    directory of the running exe (electron's `path.dirname(process.execPath)`)
 * @param env        `process.env`, injected so this is testable
 */
export function detectPortableMode(
  execDir: string,
  env: Record<string, string | undefined> = process.env,
): PortableInfo {
  const portableDir = env.PORTABLE_EXECUTABLE_DIR?.trim();
  const isPortable = Boolean(portableDir);
  if (!isPortable) {
    return { isPortable: false, usesLocalData: false, dataDir: null };
  }

  const baseDir = portableDir || execDir;
  const flagPath = join(baseDir, 'portable.flag');
  const usesLocalData = existsSync(flagPath);
  return {
    isPortable: true,
    usesLocalData,
    dataDir: usesLocalData ? join(baseDir, 'ClipwrightData') : null,
  };
}

/**
 * Where the portable build keeps downloads it is told to fetch. §6.3: the
 * portable build can *check* and *download* an update but never self-replaces;
 * the user is told to swap the file themselves.
 */
export function portableUpdateFolder(baseDir: string): string {
  return join(baseDir, 'Updates');
}

/** The exe a portable user should replace, for the "download, then swap" message. */
export function portableExeName(version: string): string {
  return `Clipwright-Studio-${version}-x64-portable.exe`;
}

/** Directory holding the running exe, guarding against a missing `process.execPath`. */
export function executableDir(execPath: string): string {
  return dirname(execPath);
}
