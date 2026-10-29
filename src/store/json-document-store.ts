import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { MigrationResult } from "./document-migrations.ts";

/**
 * A single JSON document persisted atomically.
 *
 * The layout is the only durable state in the product, and losing it is not acceptable, so a
 * crash during a write must never leave a truncated document. Writes therefore go to a
 * temporary file that is flushed to disk and then renamed over the target. `rename` is atomic
 * on POSIX and replaces an existing file on Windows, so a reader observes either the complete
 * previous version or the complete new one.
 *
 * A document that cannot be parsed is not fatal. The store degrades to its default and
 * reports the error, because refusing to start would leave the operator with no dashboard
 * and no way to see why. A document that fails a configured migration is the deliberate
 * exception: the readable file is left untouched and the store fails closed rather than
 * serving the default layout as if it were the operator's data.
 */

export type StoreStatus = {
  status: "ok" | "degraded";
  error?: string;
};

export type Validator<T> = (
  input: unknown,
) => { ok: true; value: T } | { ok: false; errors: string[] };

export type Migrator<T> = (input: unknown) => MigrationResult<T>;

export type JsonDocumentStoreOptions<T> = {
  filePath: string;
  fallback: () => T;
  validate: Validator<T>;
  /**
   * Creation mode for the document. Peer tokens use `0o600`; the layout keeps the platform
   * default because it contains no secrets.
   */
  fileMode?: number;
  /**
   * When true, an unreadable or invalid document throws instead of degrading to the fallback.
   * The peer store uses this: dropping peers silently would stop monitoring and hide a file
   * that may need repair.
   */
  strict?: boolean;
  /** Called after every successful write, for logging. */
  onWrite?: (document: T) => void;
  /**
   * Optional forward-migration pipeline. When validation fails, the store asks the migrator
   * to upgrade the document, backs up the readable source, and only then replaces it.
   */
  migrate?: Migrator<T>;
};

export class JsonDocumentStore<T> {
  readonly filePath: string;

  #fallback: () => T;
  #validate: Validator<T>;
  #onWrite: ((document: T) => void) | undefined;
  #migrate: Migrator<T> | undefined;
  #fileMode: number | undefined;
  #strict: boolean;
  #document: T;
  #status: StoreStatus = { status: "ok" };
  /**
   * False only after a failed migration. The readable document is still on disk but the
   * in-memory copy is not a trustworthy replacement, so reads fail instead of serving the
   * default layout as if it were the user's data.
   */
  #available = true;
  /** Serialises writes so two concurrent callers cannot interleave two temp-file writes. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: JsonDocumentStoreOptions<T>) {
    this.filePath = options.filePath;
    this.#fallback = options.fallback;
    this.#validate = options.validate;
    this.#onWrite = options.onWrite;
    this.#migrate = options.migrate;
    this.#fileMode = options.fileMode;
    this.#strict = options.strict ?? false;
    this.#document = options.fallback();
  }

  status(): StoreStatus {
    return this.#status;
  }

  /**
   * Load the document from disk, degrading to the fallback when it is missing or invalid.
   * Returns the resolved status so a caller can log the outcome at startup.
   *
   * A strict store throws `StoreLoadError` instead of degrading. The missing-file case is
   * always healthy: a first start has no document yet.
   */
  async load(): Promise<StoreStatus> {
    this.#available = true;

    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        this.#document = this.#fallback();
        this.#status = { status: "ok" };
        return this.#status;
      }
      const detail = `could not read ${this.filePath}: ${describe(error)}`;
      if (this.#strict) throw new StoreLoadError(this.filePath, detail);
      this.#document = this.#fallback();
      this.#status = { status: "degraded", error: detail };
      return this.#status;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const detail = `${this.filePath} is not valid JSON (${describe(error)})`;
      if (this.#strict) throw new StoreLoadError(this.filePath, detail);
      this.#document = this.#fallback();
      this.#status = { status: "degraded", error: `${detail}; using the default document` };
      return this.#status;
    }

    const result = this.#validate(parsed);
    if (!result.ok) {
      if (this.#migrate !== undefined) {
        return this.#loadMigrated(parsed, raw);
      }

      const detail = `${this.filePath} failed validation (${result.errors.join("; ")})`;
      if (this.#strict) throw new StoreLoadError(this.filePath, detail);
      this.#document = this.#fallback();
      this.#status = { status: "degraded", error: `${detail}; using the default document` };
      return this.#status;
    }

    this.#document = result.value;
    this.#status = { status: "ok" };
    return this.#status;
  }

  /**
   * Upgrade an older document without destroying the readable source.
   *
   * The backup is flushed before the migrated document replaces it. If the migration, the
   * backup, validation, or the write fails, the source stays exactly as it was and the status
   * names the failure (and the backup when one exists).
   */
  async #loadMigrated(parsed: unknown, raw: string): Promise<StoreStatus> {
    const migration = this.#migrate?.(parsed);
    if (migration === undefined) {
      return this.#migrationFailure(["no migration pipeline is configured"], null);
    }
    if (!migration.ok) {
      return this.#migrationFailure(migration.errors, migration.fromVersion);
    }

    const validated = this.#validate(migration.value);
    if (!validated.ok) {
      return this.#migrationFailure(
        [`migrated document failed validation (${validated.errors.join("; ")})`],
        migration.fromVersion,
      );
    }

    let backupPath: string | null = null;
    if (migration.fromVersion !== null) {
      try {
        backupPath = await this.#writeBackup(raw, migration.fromVersion);
      } catch (error) {
        return this.#migrationFailure(
          [`could not write the pre-migration backup: ${describe(error)}`],
          migration.fromVersion,
        );
      }
    }

    try {
      await this.#writeAtomically(`${JSON.stringify(validated.value, null, 2)}\n`);
    } catch (error) {
      return this.#migrationFailure(
        [
          `could not write the migrated document: ${describe(error)}` +
            (backupPath === null ? "" : `; backup at ${backupPath}`),
        ],
        migration.fromVersion,
      );
    }

    this.#document = validated.value;
    this.#status = { status: "ok" };
    this.#onWrite?.(validated.value);
    return this.#status;
  }

  #migrationFailure(errors: string[], fromVersion: number | null): StoreStatus {
    const version = fromVersion === null ? "" : ` from version ${fromVersion}`;
    const detail =
      `${this.filePath} could not be migrated${version} (${errors.join("; ")}); ` +
      "the readable document was left unchanged";
    if (this.#strict) throw new StoreLoadError(this.filePath, detail);
    this.#available = false;
    this.#status = { status: "degraded", error: detail };
    return this.#status;
  }

  async #writeBackup(raw: string, fromVersion: number): Promise<string> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });

    const extension = path.extname(this.filePath);
    const base = path.basename(this.filePath, extension);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(directory, `${base}.pre-v${fromVersion}-${stamp}${extension}`);

    const handle = await open(backupPath, "w", this.#fileMode);
    try {
      await handle.writeFile(raw, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    return backupPath;
  }

  /** The current in-memory document. Callers receive a copy so it cannot be mutated. */
  get(): T {
    this.#assertAvailable();
    return structuredClone(this.#document);
  }

  #assertAvailable(): void {
    if (this.#available) return;
    throw new StoreUnavailableError(
      this.filePath,
      `${this.filePath} could not be migrated; the readable document is unchanged but is not ` +
        "being served as the default layout",
    );
  }

  /**
   * Replace the document and persist it.
   *
   * The in-memory value is updated only after the write succeeds, so a failed write leaves
   * the process consistent with what is on disk.
   */
  async set(document: T): Promise<void> {
    this.#assertAvailable();
    const serialised = `${JSON.stringify(document, null, 2)}\n`;
    const result = this.#validate(JSON.parse(serialised));
    if (!result.ok) {
      throw new StoreValidationError(result.errors);
    }

    const write = this.#queue.then(
      () => this.#writeAtomically(serialised),
      () => this.#writeAtomically(serialised),
    );

    // Keep the chain alive even when a write fails, so one failure does not poison the queue.
    this.#queue = write.catch(() => undefined);

    await write;

    this.#document = result.value;
    this.#status = { status: "ok" };
    this.#onWrite?.(result.value);
  }

  async #writeAtomically(serialised: string): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });

    // The temp name includes the pid so two processes pointed at the same file cannot
    // clobber each other's temp file mid-write.
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;

    try {
      const handle = await open(temporaryPath, "w", this.#fileMode);
      try {
        await handle.writeFile(serialised, "utf8");
        // Flush before the rename: without this, a power loss can leave a renamed but empty
        // file, which is the exact corruption the temp-file dance exists to prevent.
        await handle.sync();
      } finally {
        await handle.close();
      }

      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

export class StoreValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`document failed validation: ${errors.join("; ")}`);
    this.name = "StoreValidationError";
    this.errors = errors;
  }
}

/**
 * A failed migration left the readable document on disk but no trustworthy in-memory copy.
 * Reads and writes fail until the operator repairs the file and restarts.
 */
export class StoreUnavailableError extends Error {
  readonly filePath: string;

  constructor(filePath: string, detail: string) {
    super(detail);
    this.name = "StoreUnavailableError";
    this.filePath = filePath;
  }
}

/** A strict store could not load its document. Startup should stop and name the file. */
export class StoreLoadError extends Error {
  readonly filePath: string;

  constructor(filePath: string, detail: string) {
    super(detail);
    this.name = "StoreLoadError";
    this.filePath = filePath;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
