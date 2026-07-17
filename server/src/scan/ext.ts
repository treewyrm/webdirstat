/**
 * The single extension-split rule, shared by the type rollup (feature 0005) and
 * search (feature 0004) so they always agree. Only meaningful for files.
 *
 * Rule: lowercased substring after the LAST dot, when that dot is not the first
 * character. So `Report.PDF` → `pdf`, `archive.tar.gz` → `gz`, `.bashrc` → null
 * (dotfile, no extension), `Makefile` → null.
 */
export function splitExt(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}
