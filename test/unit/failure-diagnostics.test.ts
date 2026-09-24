import { GrammyError, HttpError } from "grammy";
import { DatabaseError } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommunicationsError } from "../../src/modules/communications/communications-contract.js";
import {
  failureCode,
  reportFailure,
} from "../../src/operations/failure-diagnostics.js";

describe("failure diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the class of a failure without its message", () => {
    const deadlock = new DatabaseError("deadlock with secret row", 0, "error");
    deadlock.code = "40P01";
    deadlock.severity = "ERROR";
    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });

    expect(failureCode(deadlock)).toBe("pg_40P01");
    expect(failureCode(telegram(429))).toBe("telegram_429");
    expect(
      failureCode(new HttpError("Network request failed", new Error("x"))),
    ).toBe("telegram_network");
    expect(failureCode(AbortSignal.timeout(0).reason ?? timeout())).toBe(
      "timeout",
    );
    expect(failureCode(timeout())).toBe("timeout");
    expect(failureCode(refused)).toBe("network_ECONNREFUSED");
    expect(failureCode(new TypeError("fetch failed", { cause: refused }))).toBe(
      "network_ECONNREFUSED",
    );
    expect(
      failureCode(new CommunicationsError("authorization_unavailable")),
    ).toBe("communications_authorization_unavailable");
    expect(failureCode(new RangeError("bad value 42"))).toBe(
      "error_range_error",
    );
    expect(failureCode("plain string")).toBe("unknown");
  });

  it("writes one JSON line with the failure class and opaque references only", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const code = reportFailure(
      "worker.updates",
      new Error("token 123:ABC leaked"),
      { update_id: "41" },
    );

    expect(code).toBe("error_error");
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      level: "error",
      scope: "worker.updates",
      failure: "error_error",
      update_id: "41",
    });
    expect(line).not.toContain("123:ABC");
  });
});

function telegram(errorCode: number): GrammyError {
  return new GrammyError(
    "Synthetic",
    { description: "Synthetic", error_code: errorCode, ok: false },
    "sendMessage",
    {},
  );
}

function timeout(): Error {
  return new DOMException("The operation timed out", "TimeoutError");
}
