/**
 * Ordered, pure document migrations.
 *
 * A durable JSON document carries its own version. When the code supports a newer version,
 * an older document is transformed step by step and validated against the new shape before
 * anything is written. The pipeline is deliberately independent of the layout schema so it
 * can be tested with a synthetic version bump while the product itself is still at version 1.
 */

export type DocumentMigration = {
  from: number;
  to: number;
  migrate: (input: unknown) => unknown;
};

export type MigrationValidation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export type MigrationResult<T> =
  | { ok: true; value: T; fromVersion: number | null }
  | { ok: false; errors: string[]; fromVersion: number | null };

export type MigrateOptions<T> = {
  currentVersion: number;
  migrations: readonly DocumentMigration[];
  validate: (input: unknown) => MigrationValidation<T>;
};

export function readDocumentVersion(input: unknown): number | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const version = (input as Record<string, unknown>).version;
  return typeof version === "number" && Number.isInteger(version) ? version : null;
}

/**
 * Apply the minimum set of migrations needed to reach `currentVersion`.
 *
 * A document that is already current is validated but not rewritten. A missing path, a
 * migration that throws, or a result that fails validation is a failure; the caller must keep
 * the readable source and report the failure rather than substituting defaults.
 */
export function migrateDocument<T>(input: unknown, options: MigrateOptions<T>): MigrationResult<T> {
  const fromVersion = readDocumentVersion(input);
  if (fromVersion === null) {
    return { ok: false, errors: ["document has no integer version"], fromVersion: null };
  }

  if (fromVersion === options.currentVersion) {
    const validated = options.validate(input);
    return validated.ok
      ? { ok: true, value: validated.value, fromVersion: null }
      : { ok: false, errors: validated.errors, fromVersion: null };
  }

  if (fromVersion > options.currentVersion) {
    return {
      ok: false,
      errors: [
        `document version ${fromVersion} is newer than the supported version ${options.currentVersion}`,
      ],
      fromVersion,
    };
  }

  let current = input;
  let version = fromVersion;

  while (version < options.currentVersion) {
    const migration = options.migrations.find((candidate) => candidate.from === version);
    if (migration === undefined) {
      return {
        ok: false,
        errors: [`no migration from version ${version} to ${options.currentVersion}`],
        fromVersion,
      };
    }

    try {
      current = migration.migrate(current);
    } catch (error) {
      return {
        ok: false,
        errors: [`migration from version ${version} failed: ${describe(error)}`],
        fromVersion,
      };
    }
    version = migration.to;
  }

  const validated = options.validate(current);
  if (!validated.ok) {
    return {
      ok: false,
      errors: [`migrated document failed validation: ${validated.errors.join("; ")}`],
      fromVersion,
    };
  }

  return { ok: true, value: validated.value, fromVersion };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
