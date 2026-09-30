import { createServer, type Server } from "node:http";
import { isDeepStrictEqual } from "node:util";

import Ajv from "ajv";
import addFormats from "ajv-formats";

import { list, record } from "./json.js";
import schema from "../../src/contracts/inside-sales-funnel-events-v1/schema.json" with { type: "json" };

/**
 * A local stand-in for Platform's `inside.sales-funnel-events.v1` ingress. It validates the
 * body against the vendored Platform OpenAPI schema and applies Platform's documented rules:
 * a repeated `eventId` with the same content is a duplicate, with other content a `409`.
 */
export interface SalesFunnelPlatform {
  readonly url: string;
  readonly secret: string;
  /** Stored events by id, as Platform keeps them. */
  readonly events: Map<string, Record<string, unknown>>;
  /** Every HTTP answer in order. */
  readonly answers: { status: number; body: unknown }[];
  /** While set, every request answers this status, as an unavailable Platform does. */
  failWith: number | undefined;
  close(): Promise<void>;
}

export const SALES_FUNNEL_TEST_SECRET =
  "synthetic_sales_funnel_secret_for_tests";

export async function startSalesFunnelPlatform(): Promise<SalesFunnelPlatform> {
  const ajv = new Ajv.default({ strict: false });
  addFormats.default(ajv);
  const validRequest = ajv.compile(schema.request);
  const events = new Map<string, Record<string, unknown>>();
  const answers: { status: number; body: unknown }[] = [];
  const state: Pick<SalesFunnelPlatform, "failWith"> = { failWith: undefined };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const answer = (status: number, body: unknown) => {
        answers.push({ status, body });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (state.failWith) return answer(state.failWith, {});
      if (
        request.headers.authorization !== `Bearer ${SALES_FUNNEL_TEST_SECRET}`
      )
        return answer(401, { code: "unauthorized" });
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return answer(400, { code: "invalid_request" });
      }
      if (!validRequest(body)) return answer(400, { code: "invalid_request" });
      const delivered = list(record(body).events);
      for (const event of delivered) {
        const stored = events.get(String(event.eventId));
        if (stored && !isDeepStrictEqual(stored, event))
          return answer(409, { code: "event_conflict" });
      }
      let accepted = 0;
      for (const event of delivered)
        if (!events.has(String(event.eventId))) {
          events.set(String(event.eventId), event);
          accepted += 1;
        }
      return answer(200, {
        contractVersion: "inside.sales-funnel-events.v1",
        accepted,
        duplicates: delivered.length - accepted,
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fake Platform has no port");
  return Object.assign(state, {
    url: `http://127.0.0.1:${address.port}/integrations/telegram/v1/sales-funnel/events`,
    secret: SALES_FUNNEL_TEST_SECRET,
    events,
    answers,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  });
}
