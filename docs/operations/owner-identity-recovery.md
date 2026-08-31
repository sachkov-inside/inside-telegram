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
  Never paste them into GitHub, chat, argv, a terminal transcript, or the durable proof report.
- The target transaction must already name the same verified bot identity and Telegram user and be
  in `conflict`; the interface will not fabricate or broaden a target.
- Dry-run is read-only. Execute requires the source and target Principal references to be entered a
  second time exactly. There is no direct SQL recovery path.
- A successful transfer keeps the stable TelegramIdentity reference, moves the current Principal
  mapping to the target conflict transaction, schedules a fresh Membership check, and appends one
  immutable before/after audit row. The recovery reference is idempotent and cannot be reused for
  different facts.
- Link creation is serialized per target Account across ordinary confirmation and owner recovery,
  so concurrent operations have a deterministic order and recovery rechecks its empty-target
  safety gate after waiting. This does not invent reverse uniqueness: ordinary linking may still
  map multiple distinct TelegramIdentity values to one Platform Account.
- Existing positive Platform evidence is finite and fails closed at its normal five-minute bound;
  the fresh check emits evidence for the newly mapped Principal. Validate both Accounts after the
  operation.

## Dry-run

The credentialed proof wizard collects these values with hidden prompts and removes its ignored,
mode-0600 stdin file immediately after use and on exit. For a standalone recovery, create the same
protected input file with a trusted local editor; never put the values in a command line:

```bash
mkdir -p .credentialed-proof
install -m 600 /dev/null .credentialed-proof/recovery-input.env
${EDITOR:?Set a trusted local editor} .credentialed-proof/recovery-input.env
pnpm owner:recover-identity --dry-run < .credentialed-proof/recovery-input.env
```

The file uses one `KEY=value` per line: `RECOVERY_REF`, `OPERATOR_REF`, `REASON_REF`,
`TELEGRAM_IDENTITY_REF`, `SOURCE_ACCOUNT_REF`, `TARGET_ACCOUNT_REF`, and
`TARGET_LINK_TRANSACTION_REF`. Use an issue/change reference that contains no PII. The trusted
database URL belongs in the existing ignored `.env`, not argv.

The command returns only twelve-character SHA-256 fingerprints. Compare every fingerprint with a
separately calculated trusted value. A `ready` outcome means the database was not changed.

## Execute

Execute only after a successful dry-run and an independent owner comparison. Add
`CONFIRMED_SOURCE_ACCOUNT_REF` and `CONFIRMED_TARGET_ACCOUNT_REF` to the protected file by
re-entering the values exactly, then run:

```bash
pnpm owner:recover-identity --execute < .credentialed-proof/recovery-input.env
rm -f -- .credentialed-proof/recovery-input.env
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
