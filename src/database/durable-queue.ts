import {
  expressionBuilder,
  sql,
  type Expression,
  type ExpressionBuilder,
  type RawBuilder,
  type Selectable,
  type SqlBool,
  type Transaction,
  type Updateable,
} from "kysely";

import type { Database, DatabaseSchema } from "./database.js";

type Table = keyof DatabaseSchema;
type Row<T extends Table> = Selectable<DatabaseSchema[T]>;
type Column<T extends Table> = keyof Row<T> & string;
type State<T extends Table> = Row<T> extends { state: infer S } ? S : never;
type Executor = Database | Transaction<DatabaseSchema>;

/** Column values to write; a raw SQL expression may compute a value from the row. */
export type QueueValues<T extends Table> = {
  readonly [C in keyof Updateable<DatabaseSchema[T]>]?:
    Updateable<DatabaseSchema[T]>[C] | RawBuilder<unknown>;
};

/**
 * One kind of durable work in PostgreSQL: which rows are due, how a worker leases one,
 * when an abandoned lease expires and how retries back off. Every row has a `state`.
 *
 * With `lane`, rows that share the lane columns run one at a time and in queue order: a row
 * waits while its lane has a leased row or an earlier ready row, even one not yet due for a
 * retry. A settled row, whatever its outcome, no longer holds its lane. A null lane column puts
 * a row in no lane.
 */
export interface DurableQueue<T extends Table> {
  readonly table: T;
  readonly key: readonly Column<T>[];
  readonly order: readonly Column<T>[];
  readonly lane?: readonly Column<T>[];
  readonly ready: readonly State<T>[];
  readonly leased: State<T>;
  readonly due: Column<T>;
  readonly attempts: Column<T>;
  readonly leasedAt: Column<T>;
  readonly leaseMs: number;
  readonly retry: { readonly initialMs: number; readonly maxMs: number };
}

/**
 * The right to settle one row. Only the holder of the latest lease can settle it: a worker
 * whose lease expired and was taken over settles nothing.
 */
export interface Lease<T extends Table> {
  readonly key: Readonly<Partial<Record<Column<T>, unknown>>>;
  readonly attempt: number;
  readonly leasedAt: Date;
}

/** A lease that outlived `leaseMs`, with the attempt that was abandoned. */
export interface ExpiredLease<T extends Table> {
  readonly key: Readonly<Partial<Record<Column<T>, unknown>>>;
  readonly attempt: number;
}

export interface Claim<T extends Table, C extends Column<T>> extends Lease<T> {
  readonly row: Pick<Row<T>, C>;
}

export interface ClaimOptions<T extends Table, C extends Column<T>> {
  readonly select: readonly C[];
  readonly where?: (
    eb: ExpressionBuilder<DatabaseSchema, T>,
  ) => Expression<SqlBool>;
  /**
   * Runs with the candidate row locked. Returns extra values for the lease, or undefined to
   * leave the row untouched and claim nothing (for example, when a send slot is busy).
   */
  readonly prepare?: (
    transaction: Transaction<DatabaseSchema>,
    row: Pick<Row<T>, C>,
  ) => Promise<QueueValues<T> | undefined>;
}

/** Exponential retry delay for the attempt that has just failed, bounded by the queue. */
export function retryDelay<T extends Table>(
  queue: DurableQueue<T>,
  attempt: number,
): number {
  return Math.min(
    queue.retry.maxMs,
    queue.retry.initialMs * 2 ** Math.max(0, attempt - 1),
  );
}

/**
 * Returns rows whose lease outlived `leaseMs` to the caller's chosen state. Rows are
 * returned so the caller can record what an abandoned attempt means for its domain.
 */
export async function expireLeases<T extends Table>(
  transaction: Transaction<DatabaseSchema>,
  queue: DurableQueue<T>,
  now: Date,
  values: QueueValues<T>,
): Promise<readonly ExpiredLease<T>[]> {
  const table = sql.table(queue.table);
  const matches = sql.join(
    queue.key.map(
      (column) =>
        sql`${sql.ref(`${queue.table}.${column}`)} = ${sql.ref(`stale.${column}`)}`,
    ),
    sql` and `,
  );
  const result = await sql<Record<string, unknown>>`
    update ${table} set ${assignments(values)}
    from (
      select ${columns(queue.key)} from ${table}
      where ${sql.ref("state")} = ${queue.leased}
        and ${sql.ref(queue.leasedAt)} <= ${new Date(now.getTime() - queue.leaseMs)}
      for update skip locked
    ) as stale
    where ${matches}
    returning ${sql.join(
      [...queue.key, queue.attempts].map((column) =>
        sql.ref(`${queue.table}.${column}`),
      ),
    )}
  `.execute(transaction);
  return result.rows.map((row) => ({
    key: keyOf(queue, row),
    attempt: Number(row[queue.attempts]),
  }));
}

/** Leases the first due row in queue order, skipping rows other workers hold. */
export async function claim<T extends Table, C extends Column<T>>(
  transaction: Transaction<DatabaseSchema>,
  queue: DurableQueue<T>,
  now: Date,
  options: ClaimOptions<T, C>,
): Promise<Claim<T, C> | undefined> {
  const filter = options.where
    ? options.where(expressionBuilder<DatabaseSchema, T>())
    : sql<SqlBool>`true`;
  const selected = [
    ...new Set<Column<T>>([...queue.key, queue.attempts, ...options.select]),
  ];
  const found = await sql<Pick<Row<T>, C>>`
    select ${columns(selected)} from ${sql.table(queue.table)}
    where ${sql.ref("state")} in (${sql.join(queue.ready)})
      and ${sql.ref(queue.due)} <= ${now}
      and ${filter}
      and ${laneFree(queue)}
    order by ${columns(queue.order)}
    limit 1
    for update skip locked
  `.execute(transaction);
  const row = found.rows[0];
  if (!row) return undefined;
  const extra = options.prepare ? await options.prepare(transaction, row) : {};
  if (!extra) return undefined;
  const fields = row as Record<string, unknown>;
  const attempt = Number(fields[queue.attempts]) + 1;
  const leased = { key: keyOf(queue, fields), attempt, leasedAt: now };
  await sql`
    update ${sql.table(queue.table)}
    set ${assignments({
      ...extra,
      state: queue.leased,
      [queue.leasedAt]: now,
      [queue.attempts]: attempt,
    })}
    where ${keyMatch(queue, leased.key)}
  `.execute(transaction);
  return { ...leased, row };
}

/** Recovers expired leases, then claims the next due row, in one transaction. */
export async function claimNext<T extends Table, C extends Column<T>>(
  database: Database,
  queue: DurableQueue<T>,
  now: Date,
  expired: QueueValues<T>,
  options: ClaimOptions<T, C>,
): Promise<Claim<T, C> | undefined> {
  return database.transaction().execute(async (transaction) => {
    await expireLeases(transaction, queue, now, expired);
    return claim(transaction, queue, now, options);
  });
}

/**
 * Settles a leased row when the lease is still current. Returns false when the lease was
 * lost: the row expired and another worker took it, or it was already settled.
 */
export async function settle<T extends Table>(
  executor: Executor,
  queue: DurableQueue<T>,
  lease: Lease<T>,
  values: QueueValues<T>,
): Promise<boolean> {
  const result = await sql`
    update ${sql.table(queue.table)} set ${assignments(values)}
    where ${held(queue, lease)}
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0n) > 0;
}

/** Condition that the row is still held by this exact lease. */
export function held<T extends Table>(
  queue: DurableQueue<T>,
  lease: Lease<T>,
): RawBuilder<SqlBool> {
  return sql<SqlBool>`${keyMatch(queue, lease.key)}
    and ${sql.ref("state")} = ${queue.leased}
    and ${sql.ref(queue.attempts)} = ${lease.attempt}
    and ${sql.ref(queue.leasedAt)} = ${lease.leasedAt}`;
}

/** No other row of the candidate's lane is leased or ready ahead of it. */
function laneFree<T extends Table>(
  queue: DurableQueue<T>,
): RawBuilder<SqlBool> {
  if (!queue.lane?.length) return sql<SqlBool>`true`;
  const own = (column: string) => sql.ref(`${queue.table}.${column}`);
  const other = (column: string) => sql.ref(`other.${column}`);
  return sql<SqlBool>`not exists (
    select 1 from ${sql.table(queue.table)} as other
    where ${sql.join(
      queue.lane.map((column) => sql`${other(column)} = ${own(column)}`),
      sql` and `,
    )}
      and (${sql.join(queue.key.map(other))}) <> (${sql.join(queue.key.map(own))})
      and (
        ${other("state")} = ${queue.leased}
        or (
          ${other("state")} in (${sql.join(queue.ready)})
          and (${sql.join(queue.order.map(other))}) < (${sql.join(queue.order.map(own))})
        )
      )
  )`;
}

function keyOf<T extends Table>(
  queue: DurableQueue<T>,
  row: Record<string, unknown>,
): Readonly<Partial<Record<Column<T>, unknown>>> {
  const key: Partial<Record<Column<T>, unknown>> = {};
  for (const column of queue.key) key[column] = row[column];
  return key;
}

function keyMatch<T extends Table>(
  queue: DurableQueue<T>,
  key: Readonly<Partial<Record<Column<T>, unknown>>>,
): RawBuilder<SqlBool> {
  return sql<SqlBool>`${sql.join(
    queue.key.map((column) => sql`${sql.ref(column)} = ${key[column]}`),
    sql` and `,
  )}`;
}

function columns(names: readonly string[]): RawBuilder<unknown> {
  return sql.join(names.map((name) => sql.ref(name)));
}

function assignments(values: object): RawBuilder<unknown> {
  const entries = Object.entries(values).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) throw new Error("Queue update has no values");
  return sql.join(
    entries.map(([column, value]) => sql`${sql.id(column)} = ${value}`),
  );
}
