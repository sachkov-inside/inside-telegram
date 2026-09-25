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
        const first = await externalRead("a", async () => {
          calls.push(`load a open=${database.open}`);
          return 1;
        });
        const second = await externalRead("b", async () => {
          calls.push(`load b open=${database.open}`);
          return 2;
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
    await expect(externalRead("a", async () => "direct")).resolves.toBe(
      "direct",
    );
  });

  it("does not hide a failure of the work", async () => {
    const database = new RecordingDatabase();
    await expect(
      transactionWithExternalReads(database.asDatabase(), async () => {
        throw new RangeError("synthetic");
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
    return { transaction: () => ({ execute }) } as unknown as Database;
  }
}
