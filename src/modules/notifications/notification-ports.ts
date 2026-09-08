import type {
  DispatchRequest,
  DispatchResponse,
  Category,
  DeliveryEnvelope,
  NotificationResult,
} from "./notification-contract.js";
export interface NotificationAuthorization {
  authorize(request: DispatchRequest): Promise<DispatchResponse | undefined>;
}
export interface NotificationInbox {
  receive(
    bytes: Buffer,
    envelope: DeliveryEnvelope,
    category: Category,
  ): Promise<NotificationResult | undefined>;
}
