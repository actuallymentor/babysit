# Human Review

- 2026-09-10: Push deferred at the user’s request. The configured GitHub token has `repo` but lacks `workflow`; updating the newly added CI workflow requires that scope or an authorized SSH key. Finish pushing the committed fixes when credentials are updated.

- 2026-09-20: Prior push restriction superseded: user explicitly requested pushing the resume fixes; current GitHub token includes workflow scope.

- 2026-10-02: Boot speed follow-ups needing a decision. (a) `docker create` takes 8-10s on this host even idle (alpine too; ZFS-backed overlay2, 991 volumes, 51 containers) — outside Babysit; consider `babysit prune` / `docker system prune` or testing on another daemon. (b) The first upload into a stopped container pays a ~5s rootfs mount; eliminating it needs an image change (entrypoint waits for a sentinel so credentials can be `docker cp`'d into the *running* container) with version gating for older images. (c) Requested "persistent auth check loop" was planned as a monitor-side warmer and dropped after review: shared credential staging with the live sync could overwrite rotated tokens, the global auth lease would block the next launch for the whole probe, and monitor shutdown had no ownership of in-flight probes. Safe version needs its own staging files, a lease that yields to foreground launches, and awaited cancellation at teardown.

