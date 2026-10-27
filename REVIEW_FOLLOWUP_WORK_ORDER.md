# Work order: finish reliability fixes and remaining improvements

Status: ready for Muse; not complete.

Review baseline: `56ea566` (2026-10-27). All 52 existing tests passed on Node 25.9.0, but targeted offline checks reproduced the five failures below. No live posts or uploads were used for the review. Passing the existing suite does not close this work order.

## Order of work

1. Fix the five review findings below and add regression tests that fail against the review baseline.
2. Close the remaining acceptance gaps in `WORK_ORDER.md`, including the additional verification requirements below.
3. Then implement the outstanding `IMPROVEMENTS_WORK_ORDER.md`. The review baseline does not implement that second work order.

Keep the existing successful fixes: exclusive identity creation, ordinary offline media preparation, explicit state errors, atomic state replacement, notification failure reporting, and empty-metadata frontmatter handling. Change the faulty behavior without broad unrelated refactoring.

## 1. Restore valid media upload authorization — high priority

Location: `src/andfs.js`, particularly `uploadMedia()` near line 50 at the review baseline.

### Reproduced failure

`prepareMedia()` returns the manifest hash as `andfs`. `uploadMedia()` destructures `manifestHash`, which is undefined. JSON serialization then omits `andfs` from the signed authorization, and a correct server response containing the actual hash fails verification. Existing upload mocks echo the missing field, masking the defect.

### Required change

- Use the prepared AndFS hash consistently in authorization, response verification, and returned metadata.
- Retain strict verification of the server's hash, MIME, and byte count.
- Make mocks validate requests instead of constructing a successful response from potentially incorrect request values.

### Acceptance

- Test the complete post-with-media and profile-with-media paths through upload, relay confirmation, and state update.
- Use an independently computed or pinned known manifest hash. Assert that the authorization includes exactly that hash and that its signature verifies against the authorization bytes.
- Reject missing/incorrect hash, MIME, and size responses. Verify that failures do not advance history and preserve recoverable pending work.
- Exercise media resume as well as initial upload after fixing the underlying hash defect.

## 2. Keep pending recovery out of dry runs — high priority

Location: `src/publish.js`, pending handling in both post and profile operations (near lines 156 and 248).

### Reproduced failure

Both operations call `completePending()` before checking `dryRun`. With an earlier pending text post, a dry run makes three relay requests, advances saved history, and deletes the pending record while returning `dryRun: true`.

### Required change

- Ensure a dry run cannot invoke recovery, upload, relay publication, or notifications.
- When pending work exists, either produce a clearly labeled local preview or return an actionable pending-work error. Do not silently complete pending work.
- Preserve identity, state, and pending records byte-for-byte during preview. Temporary synchronization must not alter publishing history.
- Keep recovery before a new real publication so actual posts cannot chain from stale history.

### Acceptance

- Test post and profile dry runs with pending text, pending media, and relay-confirmed pending records.
- Replace all network paths with throwing stubs and assert zero calls; verify saved files are unchanged, including the pending record.
- Include a pending record whose post is already reflected in state: a dry run must not delete it as a cleanup side effect.
- Retain tests that a real publication recovers pending work before creating its successor.

## 3. Eliminate the abandoned-lock reclamation race — high priority

Location: `src/lock.js`, `tryReclaimAbandoned()` and lock release (near lines 39–75).

### Reproduced failure

Two reclaimers can both read the same dead owner's file. The first renames it away and claims a new live lock. The second then renames away that new lock based on its stale read, and also claims ownership. Controlled scheduling reproduced two simultaneous owners. Unconditional release can subsequently remove another owner's lock.

### Required change

- Replace the stale-read/unconditional-rename scheme with a locking and reclamation mechanism that preserves mutual exclusion under competing reclaimers.
- A read immediately before rename is not sufficient: it leaves another check/use race. Choose a defensible protocol or a narrowly scoped, maintained locking dependency and document its guarantees.
- Ensure release only relinquishes the releasing owner's lock.
- Keep bounded waiting and recovery from a genuinely abandoned owner; never steal from a live publisher.
- Document supported filesystem/process assumptions, including handling of incomplete lock creation and process identity reuse where applicable.

### Acceptance

- Add a deterministic scheduling test for two reclaimers observing one stale lock; hold the first winner active while the second continues. Assert at most one owner.
- Add a multi-process abandoned-lock contention test, in addition to ordinary multi-process publishing tests.
- Test that an old release cannot remove a newer owner's lock, active locks time out rather than being stolen, and a terminated owner's lock can be recovered.
- Verify that concurrent post and profile operations still produce one serial history.

## 4. Resume with the original media and transport parameters — medium priority

Location: `src/publish.js`, pending creation, `resumePending()`, and `completePending()` (near lines 75–134).

### Reproduced failure

An interrupted upload created with a custom origin is resumed against the default `wiredove.net` origin. Media replies also lose `reply` and `replyto` in the upload authorization. The wrong-origin upload is attempted before the resulting URL mismatch is rejected.

### Required change

- Persist and reuse the original media origin, MIME, name, size, hash, reply references, relay destination, and notification preference required to complete the exact signed post.
- Validate the supplied resume file and all signed attachment fields locally before uploading. Matching a byte hash alone is not enough if MIME or destination differs.
- Preserve explicitly disabled notifications during resume. Wire supported resume CLI options consistently; do not silently ignore `--no-ntfy`.
- Prefer the pending record's original parameters. If overrides are supported, make their effect explicit and reject any override incompatible with the signed post.
- Define how records created by the current version, which lack some fields, are handled. Recover values only from trustworthy saved/signed data; otherwise fail with an actionable explanation and preserve the record.

### Acceptance

- Interrupt an upload before success, then resume it with a custom origin and reply references. Assert the exact expected endpoint and authorization, plus the original post signature and ID.
- Test initial upload success followed by interruption before its completion flag is saved; retry must retain the same prepared attachment.
- Test a wrong file, conflicting MIME, and incompatible origin: no upload or relay request may occur.
- Test that a pending post originally created with notifications disabled stays disabled on resume, including through the CLI.
- Cover profile media and default-origin media as well as custom-origin replies.

## 5. Authenticate and validate pending records before using them — medium priority

Location: `src/pending.js` and all entry points into pending completion in `src/publish.js`.

### Reproduced failure

Current state is checked against the loaded identity, but pending data is not. Copying identity A's valid pending record into identity B's directory causes B to relay A's post and replace B's saved state with A's state.

### Required change

- Validate the pending record's supported version, kind, required fields, field types, and transport/media structure.
- Verify the saved signature against the saved content; recompute the ID and check the author against the loaded identity.
- Validate proposed next state and bind its public key and previous pointer to the verified pending post. Check the relationship to existing history so a stale record cannot silently roll history backward.
- Reconcile the already-saved case only after verification, not merely because a mutable `pending.id` equals `state.previous`.
- Validate pending attachment metadata against the signed content, including the different post/profile representations.
- Reject inconsistent records before any network request, state write, or deletion. Preserve invalid records for diagnosis without printing private material or full unpublished bodies in errors.

### Acceptance

- A foreign-identity pending record must produce zero requests and leave identity, state, and pending bytes unchanged.
- Test altered content, signature, ID, author, next-state public key, next-state history pointer, invalid version/kind, and conflicting media metadata.
- Test a valid same-identity recovery and an already-saved valid record to ensure legitimate recovery still works.
- Test a stale record against a later confirmed history; do not overwrite the later history with the older record.

## Close the original work order's remaining verification gaps

- Key validation currently compares two stored copies of the public key without verifying that the seed derives that public key. The review confirmed that an unrelated seed with matching copied public-key segments passes `validateKeypair()`. Derive and compare the public key, or use an equivalent cryptographic consistency check. Add a negative test for this exact case without logging secrets.
- Exercise actual interruption and filesystem failures in publishing/recovery tests. Setting `relayConfirmed: true` manually is useful fixture setup, but does not establish that failures at the real write boundaries are handled correctly.
- Check failures when saving a pending update after relay confirmation and when deleting pending data after state completion. Preserve a recoverable outcome and report confirmed versus uncertain publication accurately.
- Replace the recovery test's self-comparison of the resumed signature with a comparison to the captured original signature. Assert exact original content, signature, and ID across retries.
- Keep interoperability fixtures pinned to identifiable upstream revisions. Test serialization with the actual upstream reader where practical, and document what was and was not verified.
- Run the suite on Node 22 and a newer supported runtime. If Node 22 cannot be tested, explicitly leave that acceptance item unverified.

## Finish the improvements work order after reliability is accepted

`IMPROVEMENTS_WORK_ORDER.md` remains the detailed specification and acceptance checklist for:

1. Strict CLI/API validation and complete help.
2. Text-file and explicit stdin input.
3. Consistent endpoint and timeout configuration.
4. General media options, bounded reads, MIME handling, and image-only profile photos.
5. A supported package API and shared publishing logic.
6. Stable automation outcomes, error codes, and offline status diagnostics.
7. Explicit profile update/clearing semantics verified against Wiredove.
8. CI, compatibility maintenance, documentation, and licensing.

Do not mark that document complete because reliability fixes overlap a few requirements. Implement and test its remaining acceptance conditions separately. If the reliability changes are delivered first, clearly report the improvements work as still pending.

## Delivery and safety boundaries

- Use temporary identities, bounded local fault injection, and mocked transports. No live Wiredove publication, production uploads, public notifications, modifications to real identities, or package releases.
- Keep regression tests reproducible and isolated from inherited identity environment variables. Clean up temporary test resources.
- Deliver focused commits with a summary of the affected behavior, regression coverage, runtime results, and remaining limitations.
- Run the complete suite and inspect the final diff. A green test count alone is not completion evidence: map each finding to the regression that proves it fixed.
- Update the three work orders' status only to reflect completed, verified work. Leave unmet criteria visible. Request a fresh review of the final commit before describing the reliability work as signed off.
