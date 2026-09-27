import { describe, expect, it } from "vitest";

import type { Database } from "../../src/database/database.js";
import {
  externalRead,
  transactionWithExternalReads,
} from "../../src/database/external-reads.js";

describe("external reads", () => {
  it("answers each read with no transaction open and reruns the work with the answer", async () => {
    const database = new RecordingDatabase();
    const calls: string[] = [];

    const result = await transactionWithExternalReads(
      database.asDatabase(),
      async () => {
        const first = await externalRead("a", () => {
          calls.push(`load a open=${database.open}`);
          return Promise.resolve(1);
        });
        const second = await externalRead("b", () => {
          calls.push(`load b open=${database.open}`);
          return Promise.resolve(2);
        });
        return first + second;
      },
    );

    expect(result).toBe(3);
    expect(calls).toEqual(["load a open=false", "load b open=false"]);
    expect(database.transactions).toBe(3);
    expect(database.committed).toBe(1);
  });

  it("calls the service directly outside a managed transaction", async () => {
    await expect(
      externalRead("a", () => Promise.resolve("direct")),
    ).resolves.toBe("direct");
  });

  it("does not hide a failure of the work", async () => {
    const database = new RecordingDatabase();
    await expect(
      transactionWithExternalReads(database.asDatabase(), () => {
        return Promise.reject(new RangeError("synthetic"));
      }),
    ).rejects.toThrow(RangeError);
    expect(database.transactions).toBe(1);
  });
});

class RecordingDatabase {
  open = false;
  transactions = 0;
  committed = 0;

  asDatabase(): Database {
    const execute = async <T>(
      work: (tx: unknown) => Promise<T>,
    ): Promise<T> => {
      this.transactions += 1;
      this.open = true;
      try {
        const result = await work({});
        this.committed += 1;
        return result;
      } finally {
        this.open = false;
      }
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial Kysely double: externalRead only opens transactions.
    return { transaction: () => ({ execute }) } as unknown as Database;
  }
}
