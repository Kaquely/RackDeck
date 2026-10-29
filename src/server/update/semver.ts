/**
 * Minimal semantic-version comparison.
 *
 * The update check only needs to answer "is this release newer than the one I am running?".
 * A full semver library would add a dependency for that single question, so this module
 * accepts the strict `MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]` shape and returns `null` for
 * anything else. An unparseable tag is treated as "not a usable release" by the caller.
 */

export type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
};

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(input.trim());
  if (!match) return null;

  const prerelease = match[4] === undefined ? [] : match[4].split(".");

  return {
    major: Number.parseInt(match[1] as string, 10),
    minor: Number.parseInt(match[2] as string, 10),
    patch: Number.parseInt(match[3] as string, 10),
    prerelease: prerelease.map((identifier) =>
      /^\d+$/.test(identifier) ? Number.parseInt(identifier, 10) : identifier,
    ),
  };
}

/** Compare two versions. Returns a positive number when `a` is newer than `b`. */
export function compareSemver(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;

  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }

  // A release without a prerelease suffix outranks every prerelease of the same version.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];

    // A shorter prerelease list has lower precedence when all preceding identifiers match.
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    if (typeof leftPart === "number" && typeof rightPart === "number") {
      return leftPart - rightPart;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (typeof leftPart === "number") return -1;
    if (typeof rightPart === "number") return 1;
    return leftPart < rightPart ? -1 : 1;
  }

  return 0;
}

/** True when `version` is a parseable semantic version, with or without a leading `v`. */
export function isSemver(version: string): boolean {
  return parseVersion(version) !== null;
}

/** Strip the conventional release-tag prefix so the value compares as a version. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}
