import type { DocumentMigration, MigrationResult } from "../store/document-migrations.ts";
import { migrateDocument } from "../store/document-migrations.ts";
import { LAYOUT_VERSION, validateLayout } from "./layout.ts";
import type { Layout } from "./layout.ts";

/**
 * The layout's migration registry.
 *
 * Version 1 is the only shape that has shipped, so the registry is empty. The first schema
 * change adds a pure `{ from: 1, to: 2, migrate }` entry, bumps `LAYOUT_VERSION`, and ships a
 * fixture for every prior version. Keeping the empty registry explicit makes that expectation
 * visible instead of leaving a future contributor to invent a migration convention.
 */
export const LAYOUT_MIGRATIONS: readonly DocumentMigration[] = [];

export function migrateLayout(input: unknown): MigrationResult<Layout> {
  return migrateDocument(input, {
    currentVersion: LAYOUT_VERSION,
    migrations: LAYOUT_MIGRATIONS,
    validate: validateLayout,
  });
}
