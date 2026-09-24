# Deployments

- CLI distribution: [GitHub releases](https://github.com/actuallymentor/babysit/releases), four compiled Linux/macOS architecture binaries and checksums.
- Agent image: `actuallymentor/babysit:<version>` and `actuallymentor/babysit:latest` on Docker Hub, amd64/arm64.
- Web companion: separate image published by the repository's web Docker workflow.
- `main` pushes with an untagged package version trigger `.github/workflows/publish.yml`: tests, binaries, release, then versioned agent/web images. Docker asset pushes also refresh `latest` independently.
- No specific production Ubuntu host or SSH deployment target has been recorded. Deploying this repository means publishing the release artifacts/images; boot service installation is performed on a user's Ubuntu host with `babysit recover init`.

- 2026-09-20: Available GitHub token has `repo` and `workflow` scopes. The configured Git remote uses SSH; this container can instead use HTTPS with `gh auth git-credential`.
- Host diagnosed through the Docker socket: `cubini`, session registry `/mnt/internalnvme/.babysit/sessions`, workspace `/mnt/internalnvme/dev/babysit`. Inspect targeted state via read-only mounts; the container’s own HOME does not contain the host registry.

- 2026-09-24: Published [v1.4.0](https://github.com/actuallymentor/babysit/releases/tag/v1.4.0) from `6a89642`, including numbered resume/recovery actions. Four binaries and checksums published; downloaded Linux x64 binary verified and smoke-tested. Agent `1.4.0` manifest: `sha256:519c8afb35428871a4bd33b63bb119290c2656c9536f285aad5e7eb174b97798`. Web `1.4.0`/`latest` manifest: `sha256:4b5e8a09521dc231aec6c367fc0c3430fe87f0a8bcddb9c426bb353b412a7efc`. Both images contain amd64/arm64; release publication intentionally leaves agent `latest` to the separate nightly workflow.
