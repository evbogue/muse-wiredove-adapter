# Work order: adapter usability and maintainability improvements

Status: ready for Muse after the reliability work order.

## Objective and dependencies

Make the adapter easier for people and agents to use correctly, easier to integrate into other Node.js programs, and easier to maintain as Wiredove evolves.

Complete `WORK_ORDER.md` first. This document builds on its identity protection, offline preparation, durable pending records, publishing lock, and structured outcomes. Do not create a second implementation of those mechanisms. These are proposed improvements, not claims that every item is an existing defect.

Keep the adapter small. Prefer Node's built-in facilities and focused modules over a framework. Implement the sections below in order, with a reviewable commit for each coherent change.

## 1. Make CLI input strict and predictable

Locations: `bin/muse-wiredove.js`, shared input validation.

- Replace the permissive hand-written flag scanner with command-specific argument definitions, using `node:util.parseArgs` where practical.
- Support top-level and per-command `--help`, plus `--version`. Include `pubkey` and supported directory options in help.
- Reject unknown commands, unknown options, unexpected positional arguments, missing option values, and conflicting options before any publishing side effect.
- Validate argument types in the programmatic API too; do not rely on CLI validation alone.
- Validate `previous`, reply IDs, and author public-key encodings against the actual protocol contract. Require paired `reply` and `replyto` for text replies as well as media replies. Clearly document whether `--reply` accepts a message hash or a signature; do not silently guess.
- Keep validation messages actionable and free of secret material.

Acceptance: subprocess tests cover valid commands, help, typos such as `--dryrun`, missing values, boolean flags, malformed references, and incomplete replies. Invalid input produces a nonzero exit code with no upload, relay, or notification request.

## 2. Support reliable text input for scripts and agents

- Add `post --text-file PATH` and `post --stdin` alongside `--text`.
- Make the three text sources mutually exclusive. Read stdin only when explicitly requested, so ordinary invocations cannot unexpectedly hang waiting for input.
- Read UTF-8 text without invoking a shell or interpolating its contents. Preserve multiline text and Unicode; document any newline normalization.
- Bound input reads and enforce the final serialized post's byte limit, including metadata and appended media URLs. Account for UTF-8 bytes rather than JavaScript character count.
- Keep empty-text media posts supported and reject empty text-only posts with a clear error.

Acceptance: tests cover multiline Markdown, quotes, shell metacharacters, emoji, empty input, unreadable files, mutually exclusive sources, and oversized stdin. Input text is preserved and never executed.

## 3. Make endpoint configuration consistent

Locations: CLI configuration, `src/publish.js`, `src/relay.js`, `src/andfs.js`.

- Introduce one configuration resolver shared by CLI and API. Define and document precedence: explicit options, documented environment variables, then defaults.
- Support the application/media origin, relay URL, notification destination or disable switch, and network timeouts. Preserve existing defaults and existing identity environment variables.
- Construct returned post URLs using the configured application origin instead of a hard-coded `wiredove.net` URL.
- Explicitly document whether each URL accepts a path prefix. Preserve supported prefixes consistently or reject unsupported ones instead of silently dropping them.
- Validate HTTP(S) URLs and reject embedded credentials. Permit HTTP localhost endpoints for testing and self-hosted development.
- Make notification configuration equally available to post and profile APIs. Determine profile notification behavior from the referenced Wiredove flow and document the chosen default.

Acceptance: a test with custom endpoints routes every request and returned link to the configured destinations, with no accidental request to public defaults. Tests cover trailing slashes, invalid URLs, precedence, disabled notifications, and the documented path-prefix behavior.

## 4. Improve media handling

- Introduce `--media PATH` and `mediaPath` as general attachment names; preserve `--image` and `imagePath` as compatible aliases. Reject conflicting aliases.
- Add explicit MIME selection for ambiguous audio/video containers and support useful extensions already covered by the server's allowlist, such as `.m4a` where compatible.
- Check file type and size before reading the full file. Keep reads bounded if the file grows after the initial check; handle directories and unreadable files clearly.
- Validate common file signatures where feasible. Reject clear extension/content mismatches. Do not claim full codec validation from a filename or a few magic bytes.
- Restrict profile-photo uploads to supported image formats; a video must not become a profile image merely because ordinary posts support video.
- Reuse the offline media preparation introduced by the reliability work order.

Acceptance: tests cover supported image/audio/video inputs, explicit MIME overrides, incompatible content, oversized files, aliases, and non-image profile photos. Preserve AndFS manifest and authorization compatibility. No transcoding or new storage backend is required.

## 5. Define a supported programmatic API

Locations: package entry point, `package.json`, API documentation.

- Add an intentional public entry point and package exports so consumers do not need to import undocumented `src/` files.
- Export the supported post/profile operations and preparation/recovery operations delivered by the reliability work, with clearly documented options and results.
- Keep existing direct imports working where practical. Avoid exposing low-level secret-bearing helpers merely to fill out the API.
- Consolidate duplicated post/profile identity loading, media preparation, transport, and state handling while preserving their different metadata semantics.
- Add useful JSDoc types or declaration files for public options, results, and errors without requiring a TypeScript rewrite.
- Document which calls have network or filesystem side effects, and which results mean prepared, pending, confirmed, or confirmed with notification warnings.

Acceptance: a smoke test imports the package through its public entry point and exercises preparation and mocked publishing. CLI and API use the same validation and publishing logic. Verify a local package archive contains the required files and no temporary identities or secrets; do not publish to npm.

## 6. Give automation stable results and useful diagnostics

- Build on the structured outcomes from `WORK_ORDER.md`. Give expected errors stable codes so callers do not have to parse English error messages.
- Preserve JSON success output. Add a documented machine-readable error mode and keep diagnostics on stderr so stdout remains parseable.
- Define exit-code behavior for invalid usage, local identity/state failures, and uncertain network outcomes. A confirmed post with a notification warning must still be distinguishable from a failed publication.
- Add an offline `status` command showing the public author, configured endpoints, last confirmed post, and pending publication summary. Reuse state and lock handling; do not repair or reset files implicitly.
- Never display private keys, complete keypairs, pending post bodies, or attachment contents in status output. Do not add a secret-printing debug mode.

Acceptance: tests parse CLI output for each outcome, verify documented codes, and prove `status` makes no network requests or state changes. Error and status output must not contain temporary test secret values.

## 7. Clarify profile update semantics

- Distinguish an omitted name/bio from an explicitly empty value. Document supported clear operations based on how Wiredove consumes profile metadata; do not invent a wire-level deletion marker.
- Reject a profile invocation that requests no effective change, unless a documented use case requires republishing.
- Preserve unrelated local profile state when applying a partial update.
- Make a profile dry run show exactly which metadata would be published, using the same preparation path as a real update.

Acceptance: tests cover name-only, bio-only, photo-only, no-op, and supported clearing cases. Confirm expected interpretation against a pinned Wiredove reader or fixture, not only this adapter's parser.

## 8. Make compatibility and maintenance repeatable

- Add CI running the offline test suite on the documented minimum Node.js version and a newer supported LTS release. Do not require account secrets or external publishing services.
- Keep upstream compatibility fixtures and their source revisions together. Document the procedure for updating fixtures when Wiredove, ANProto, or AndFS changes.
- Document installation, public API imports, stdin/file input, custom endpoints, reply identifiers, profile semantics, pending recovery, and structured outcomes with executable examples.
- Explain that relay confirmation and actual feed rendering are different checks. Do not advertise live interoperability based only on mocks.
- Add a license file consistent with the package's existing MIT declaration, confirming the appropriate copyright attribution from repository context.

Acceptance: CI passes; documented examples are exercised where feasible using isolated state and fake transports; package contents and public exports are checked; README claims match implemented behavior.

## Definition of done and boundaries

- Complete each section's acceptance criteria and run the full regression suite from both work orders.
- Report changes, tests, compatibility evidence, and any remaining limitations. Identify unavailable runtime checks explicitly rather than claiming they ran.
- Keep changes focused. No feed reader, UI, scheduler, bulk posting, new gossip transport, account rotation, or automatic deletion of user state.
- Use temporary identities and mocked transports for testing. Do not publish real posts, upload to production, send public notifications, modify a real identity, or release a package as part of this work order.
- Mark this document complete only when the implemented behavior and acceptance evidence support that status.
