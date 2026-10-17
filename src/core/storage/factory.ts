/**
 * Fábrica do provider de persistência (biblioteca).
 *
 * Default: SQLite no diretório global. `storage.provider: "file"` mantém o
 * backend em arquivos sob o mesmo home — útil para debug ou rollback.
 */

import type { HoundsmanConfig } from "../config";
import { FileStorageProvider } from "./file/file-storage";
import { databasePath, fileRoot } from "./paths";
import { SQLiteStorageProvider } from "./sqlite/sqlite-storage";
import type { StorageProvider } from "./types";

/** Cria o provider configurado pelo projeto. */
export function createStorage(config: HoundsmanConfig): StorageProvider {
	return config.storage?.provider === "file"
		? new FileStorageProvider(fileRoot(config))
		: new SQLiteStorageProvider(databasePath(config));
}

/** Provider SQLite em memória (testes). */
export function createMemoryStorage(): StorageProvider {
	return new SQLiteStorageProvider(":memory:");
}
