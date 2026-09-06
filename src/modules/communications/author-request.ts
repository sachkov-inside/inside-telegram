import { randomUUID } from "node:crypto";
import {
  COMMUNICATIONS_VERSION,
  type CommunicationsRequest,
} from "./communications-contract.js";
export function authorRequest(
  accountRef: string,
  operation: string,
  payload: CommunicationsRequest["payload"],
  expectedRevision = 0,
): CommunicationsRequest {
  return {
    contractVersion: COMMUNICATIONS_VERSION,
    operationId: randomUUID(),
    operation,
    actor: { accountRef },
    expectedRevision,
    payload,
  };
}
