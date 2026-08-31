# Owner-only TelegramIdentity recovery

This procedure transfers one already verified TelegramIdentity from its current opaque Platform
Principal to a different Principal only after the normal link flow has produced a typed
`recovery-required` conflict. It is an exceptional owner operation, not an HTTP endpoint, unlink,
or user self-service path.

## Safety contract

- Work from a trusted host with direct access to the intended Telegram application database.
- Take and retain the normal database backup before an actual non-proof recovery.
- Obtain the current TelegramIdentity reference, current source Principal reference, target
  Principal reference, and exact target conflict transaction through trusted operator tooling.
  Never paste them into GitHub, chat, a terminal transcript, or the durable proof report.
- The target transaction must already name the same verified bot identity and Telegram user and be
  in `conflict`; the interface will not fabricate or broaden a target.
- Dry-run is read-only. Execute requires the source and target Principal references to be entered a
  second time exactly. There is no direct SQL recovery path.
- A successful transfer keeps the stable TelegramIdentity reference, moves the current Principal
  mapping to the target conflict transaction, schedules a fresh Membership check, and appends one
  immutable before/after audit row. The recovery reference is idempotent and cannot be reused for
  different facts.
- Existing positive Platform evidence is finite and fails closed at its normal five-minute bound;
  the fresh check emits evidence for the newly mapped Principal. Validate both Accounts after the
  operation.

## Dry-run

Use an issue/change reference that contains no PII. Values below are placeholders; pass real
references only in the local interactive terminal:

```bash
DATABASE_URL=<trusted-database-url> pnpm owner:recover-identity -- --dry-run \
  --recovery-ref <unique-recovery-ref> \
  --operator-ref <owner-operator-ref> \
  --reason-ref <issue-or-change-ref> \
  --telegram-identity-ref <telegram-identity-ref> \
  --source-account-ref <current-principal-ref> \
  --target-account-ref <target-principal-ref> \
  --target-link-transaction-ref <target-conflict-transaction-ref>
```

The command returns only twelve-character SHA-256 fingerprints. Compare every fingerprint with a
separately calculated trusted value. A `ready` outcome means the database was not changed.

## Execute

Execute only after a successful dry-run and an independent owner comparison. The two confirmation
arguments must repeat the source and target values exactly:

```bash
DATABASE_URL=<trusted-database-url> pnpm owner:recover-identity -- --execute \
  --recovery-ref <same-unique-recovery-ref> \
  --operator-ref <same-owner-operator-ref> \
  --reason-ref <same-issue-or-change-ref> \
  --telegram-identity-ref <telegram-identity-ref> \
  --source-account-ref <current-principal-ref> \
  --target-account-ref <target-principal-ref> \
  --target-link-transaction-ref <target-conflict-transaction-ref> \
  --confirm-source-account-ref <re-enter-current-principal-ref> \
  --confirm-target-account-ref <re-enter-target-principal-ref>
```

`transferred` is the first successful execution; repeating the exact command returns `idempotent`.
Any mismatch returns a typed rejection and performs no transfer. Do not retry by editing data.

## Post-operation verification

1. Confirm the target link transaction now returns the linked/idempotent outcome.
2. Allow the scheduled initial Membership check and evidence delivery to complete.
3. Confirm target access follows new bounded evidence and source access does not receive newer
   positive evidence.
4. Verify exactly one immutable audit row exists for the recovery reference through trusted
   aggregate/operator tooling; do not export its raw facts.
5. Record only outcome, fingerprints, operator/change reference, time window, and verification
   booleans in the incident or credentialed proof report.

If any check fails, stop. Preserve the database and audit row, disable external processing if
needed, and investigate through a new owner-approved recovery plan; never delete or rewrite the
audit record.
