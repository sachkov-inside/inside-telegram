# Community entitlement v2

Platform produces only v2 effects when TELEGRAM_COMMUNITY_CONTRACT_VERSION explicitly equals inside.community-entitlement.v2. No downgrade. Historical v1 receipts remain readable, but pending v1 effects are superseded.

admissionRestriction is mandatory: none, moderation, external_unknown. A content grant never clears either restriction. Checking is shown until a result matches the current binding. Delivery status alone is not moderation evidence.

Dispatch envelope stays inside.billing-dispatch.v1. The target version and SHA-256 of the complete canonical set command must match the stored operation. Keys sort lexically, array order is preserved. Each effect requires a fresh permit, valid for at most five seconds. Retry uses the same operation identity and digest.

This portable bundle is consumed by Platform provider doubles and is the consumer contract for Telegram #64. It does not enable a real integration. The immutable billing-v1 bundle remains unchanged.
