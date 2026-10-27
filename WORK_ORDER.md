# Work order: reliable, safe adapter publishing

Status: ready for implementation by Muse.

## Objective

Fix the six issues identified in the adapter review. Preserve the small Node.js architecture and existing ANProto, AndFS, and Wiredove wire formats. Prioritize identity protection, offline previews, and recoverable publishing over new features.

The review ran all six existing tests successfully and reproduced identity overwrite, media uploads during dry runs, concurrent history forks, silently discarded corrupt state, notification transport bypass, and the empty-metadata YAML round-trip failure. Passing the current suite is not sufficient acceptance evidence.

## 1. Protect existing identities — high priority

Location: `src/identity.js`, `bin/muse-wiredove.js`.

- Create identity files exclusively; never overwrite an existing identity. Avoid a check-then-write race. Keep new secret files mode 0600.
- If the identity already exists, exit with an actionable error and preserve both identity and state byte-for-byte.
- Do not add an implicit reset or replacement path. Identity replacement is outside this work order.
- Validate loaded keypairs, including consistency of the public key and private key material, without printing secrets in errors.
- Verify that persisted state belongs to the loaded identity; reject mismatches rather than chaining onto another identity's history.

Acceptance: repeat and concurrent identity creation cannot replace the winning key; unsuccessful creation does not reset state; malformed keys and mismatched state are rejected. Tests must use isolated temporary paths and override inherited identity environment settings.

## 2. Make dry runs completely offline — high priority

Location: `src/publish.js`, `src/andfs.js`.

- Separate local media validation, manifest calculation, and metadata preparation from network upload.
- Both post and profile dry runs must compose and verify locally without uploading, contacting a relay, or sending notifications.
- Dry runs must not advance history or create pending publish records. Clearly label any calculated media URL as not uploaded.
- Validate inputs and the final composed post before uploading media during real publishing, so known-invalid posts do not upload attachments first.

Acceptance: text, image, and profile dry runs succeed with every network path replaced by a throwing stub; identity and state remain unchanged. Invalid or oversized media and oversized posts are rejected before any network request.

## 3. Preserve history and state — high priority

Location: `src/identity.js`, `src/publish.js`.

- Serialize the complete read/compose/publish/state-update operation for each identity across processes, including post and profile operations.
- Define bounded lock waiting and safe handling of abandoned locks. Do not steal a lock from an active publisher.
- Write state atomically using a temporary file and rename in the same directory.
- Treat only a genuinely missing state file as missing. Surface malformed JSON, invalid state shape, permission failures, and other read errors.
- Validate saved history references. Do not silently discard an existing history on recovery errors.

Acceptance: simultaneous publishers produce a serial chain, where the second post references the first; state ends at the final confirmed post. Corrupt or unreadable state blocks publication. Interrupted writes do not leave truncated state. Exercise separate processes, not only concurrent promises.

## 4. Recover partial publishing without duplicates — medium priority

Location: `src/publish.js`, `src/relay.js`, identity/state storage.

- Persist the exact prepared content, signature, post ID, author, and required transport/media information before the first publishing side effect. Never include the private key in pending records or logs.
- Provide a documented resume/retry mechanism that reuses the saved signature and content rather than signing a new post.
- Track relay confirmation separately from local state completion and notification delivery.
- If the relay may have accepted a post but confirmation failed, expose an uncertain/pending outcome with its ID and URL. Preserve sufficient information to reconcile it.
- If state saving fails after relay confirmation, retain a recoverable pending record. Recover pending work before allowing a later post to chain from stale state.
- Remove or finalize pending records only after the confirmed history is durably saved. Coordinate recovery with the identity lock.

Acceptance: simulate relay acceptance followed by confirmation timeout, process interruption, and a state-write failure after confirmation. Recovery uses the original signature and ID, does not create a second signed post, and advances history exactly once. Media retries use the same prepared attachment metadata.

## 5. Isolate and bound notification failures — medium priority

Location: `src/publish.js`, `src/andfs.js`.

- Route all HTTP requests, including ntfy, through the supplied network handler.
- Add explicit configurable timeouts/cancellation to media uploads and notifications; preserve relay timeouts.
- Persist confirmed publishing state before attempting optional notifications.
- Check notification HTTP status and return a structured warning or delivery status on failure. A notification failure must not turn a confirmed post into an apparent publishing failure.
- Keep `sendNtfy: false` effective and prevent real network access from leaking out of tests.

Acceptance: ntfy HTTP errors, thrown errors, and timeouts leave confirmed state intact and return a published result with notification failure details. Disabling notifications results in zero ntfy requests. Stalled uploads and notifications terminate within the configured bound.

## 6. Fix empty-metadata frontmatter — medium priority

Location: `src/yaml.js`, `src/protocol.js`.

- Ensure `yaml.parse(yaml.create({}, "hello")).body === "hello"`.
- Preserve supported string and number metadata, escaping, multiline body text, and metadata-only profile posts.
- Verify serialized documents against Wiredove's actual YAML reader. Do not broaden the parser into a full YAML implementation unless needed for interoperability.

Acceptance: an unnamed identity's first text post and an empty-metadata document round-trip correctly. Add compatibility fixtures for empty and populated metadata, escaped strings, numeric fields, and empty bodies.

## Tests and completion requirements

- Replace the misleading relay test with tests that actually call `relay.publish` and verify content → signature → ID confirmation, including missing confirmation and HTTP failures.
- Add regression tests for every acceptance condition above using temporary files and mocked transports. Do not publish to Wiredove or upload real media while testing.
- Add independent ANProto signature and AndFS manifest fixtures from a pinned upstream implementation. Record their provenance; self-round-trips alone do not prove interoperability. Cover single- and multi-chunk media, including chunk boundaries.
- Keep tests dependency-light and runnable through `npm test`. Verify the documented minimum supported Node.js version (22), or explicitly report if that runtime is unavailable.
- Update README usage and API documentation for dry runs, existing-identity errors, pending recovery, locking, and notification outcomes. Keep supported return fields compatible where possible and document any necessary changes.
- Run the complete suite, inspect the final diff for accidental secrets or unrelated changes, and report results plus any remaining limitations.
- Mark this work order complete only when all acceptance criteria are met. Summarize the implementation and tests in the commit/PR description; do not claim live feed verification based on mocked relay tests.

## Scope boundaries

No feed reader, UI, new gossip transports, identity rotation, or unrelated refactoring. Do not modify an existing real identity, publish live posts, or send public notifications as part of this work. Keep the work focused on these correctness and reliability fixes.
