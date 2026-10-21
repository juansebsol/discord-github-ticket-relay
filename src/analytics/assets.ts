/**
 * Analytics: what a release file is, from its name ("photocraft-0.11.1-windows-x64.msi"): the
 * platform, the processor architecture, the package format, and whether it's the app, its command
 * line tool, a web build, or not a download at all (checksums, signatures, update metadata).
 */

export type Platform = 'windows' | 'macos' | 'linux' | 'freebsd' | 'web' | 'other';
export type AssetKind = 'app' | 'cli' | 'web' | 'meta';

export interface AssetInfo {
  platform: Platform;
  arch: string | null;
  format: string | null;
  kind: AssetKind;
}

export const PLATFORM_NAMES: Record<Platform, string> = {
  windows: 'Windows', macos: 'macOS', linux: 'Linux', freebsd: 'FreeBSD', web: 'Web', other: 'Other',
};

export const ARCH_NAMES: Record<string, string> = {
  x64: 'x64 (Intel, AMD)', x86: 'x86 (32-bit)', arm64: 'ARM64', riscv64: 'RISC-V', universal: 'Universal (Mac)',
};

const META = /(^sha\d*sums|^checksums|\.(sha\d+|sha\d+sum|sig|asc|minisig|zsync|blockmap|json|ya?ml|txt|intoto\.jsonl|sbom|spdx)$)/i;

/** Longest first: "pkg.tar.zst" before "tar.gz" before "zip". */
const FORMATS: [RegExp, string][] = [
  [/\.pkg\.tar\.zst$/i, 'pkg.tar.zst'], [/\.app\.tar\.gz$/i, 'app.tar.gz'], [/\.tar\.gz$|\.tgz$/i, 'tar.gz'], [/\.tar\.xz$/i, 'tar.xz'],
  [/\.appimage$/i, 'AppImage'], [/\.flatpak(ref)?$/i, 'Flatpak'], [/\.snap$/i, 'Snap'], [/\.deb$/i, 'deb'], [/\.rpm$/i, 'rpm'],
  [/\.msi$/i, 'MSI'], [/\.msix(bundle)?$/i, 'MSIX'], [/\.exe$/i, 'EXE'], [/\.dmg$/i, 'DMG'], [/\.pkg$/i, 'PKG'], [/\.zip$/i, 'zip'], [/\.7z$/i, '7z'],
];

export function classifyAsset(name: string): AssetInfo {
  const n = name.toLowerCase();
  const format = FORMATS.find(([re]) => re.test(n))?.[1] ?? null;
  if (META.test(n)) return { platform: 'other', arch: null, format, kind: 'meta' };
  const kind: AssetKind = /(^|[-_.])web([-_.]|$)/.test(n) ? 'web' : /(^|[-_.])cli([-_.]|$)/.test(n) ? 'cli' : 'app';
  const platform: Platform = kind === 'web' ? 'web'
    : /(windows|win32|win64|[-_.]win[-_.])/.test(n) || format === 'MSI' || format === 'MSIX' || format === 'EXE' ? 'windows'
      : /(macos|darwin|[-_.]mac[-_.]|osx|apple)/.test(n) || format === 'DMG' || format === 'PKG' || format === 'app.tar.gz' ? 'macos'
        : /freebsd/.test(n) ? 'freebsd'
          : /linux/.test(n) || ['AppImage', 'Flatpak', 'Snap', 'deb', 'rpm', 'pkg.tar.zst'].includes(format ?? '') ? 'linux'
            : 'other';
  const arch = /(aarch64|arm64)/.test(n) ? 'arm64'
    : /(x86_64|amd64|x64|win64)/.test(n) ? 'x64'
      : /riscv64/.test(n) ? 'riscv64'
        : /universal/.test(n) ? 'universal'
          : /(^|[-_.])(x86|i[36]86|win32)([-_.]|$)/.test(n) ? 'x86'
            : null;
  return { platform, arch, format: format === 'zip' && /portable/.test(n) ? 'Portable zip' : format, kind };
}
