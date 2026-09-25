import { AsyncLocalStorage } from "node:async_hooks";

import type { Transaction } from "kysely";

import type { Database, DatabaseSchema } from "./database.js";

const MAX_ROUNDS = 8;

interface ReadScope {
  readonly results: Map<string, unknown>;
}

const scope = new AsyncLocalStorage<ReadScope>();

class ExternalReadRequired extends Error {
  constructor(
    readonly key: string,
    readonly load: () => Promise<unknown>,
  ) {
    super("External read must run outside the transaction");
    this.name = "ExternalReadRequired";
  }
}

/**
 * Runs a transaction whose decisions need side-effect-free answers from another service,
 * such as a Platform authorization or content validation, without holding the transaction
 * open while that service answers.
 *
 * The first time the work asks for an answer it does not have yet, the transaction rolls
 * back, the answer is fetched with no connection held, and the work runs again from the
 * start with that answer. The work must therefore depend only on the database and on the
 * answers it received: it re-reads and re-locks the rows the answer applies to, so a stale
 * answer is never applied to changed data.
 */
export async function transactionWithExternalReads<Result>(
  database: Database,
  work: (transaction: Transaction<DatabaseSchema>) => Promise<Result>,
): Promise<Result> {
  const reads: ReadScope = { results: new Map() };
  for (let round = 1; ; round += 1) {
    try {
      return await scope.run(reads, () => database.transaction().execute(work));
    } catch (error) {
      if (!(error instanceof ExternalReadRequired) || round >= MAX_ROUNDS)
        throw error;
      reads.results.set(error.key, await error.load());
    }
  }
}

/**
 * Answers an external read. Inside {@link transactionWithExternalReads} the answer comes
 * from that transaction's earlier rounds; outside it, the service is called directly.
 */
export async function externalRead<Value>(
  key: string,
  load: () => Promise<Value>,
): Promise<Value> {
  const reads = scope.getStore();
  if (!reads) return load();
  if (reads.results.has(key)) return reads.results.get(key) as Value;
  throw new ExternalReadRequired(key, load);
}
