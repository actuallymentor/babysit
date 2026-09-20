# Deployments

- CLI distribution: [GitHub releases](https://github.com/actuallymentor/babysit/releases), four compiled Linux/macOS architecture binaries and checksums.
- Agent image: `actuallymentor/babysit:<version>` and `actuallymentor/babysit:latest` on Docker Hub, amd64/arm64.
- Web companion: separate image published by the repository's web Docker workflow.
- `main` pushes with an untagged package version trigger `.github/workflows/publish.yml`: tests, binaries, release, then versioned agent/web images. Docker asset pushes also refresh `latest` independently.
- No specific production Ubuntu host or SSH deployment target has been recorded. Deploying this repository means publishing the release artifacts/images; boot service installation is performed on a user's Ubuntu host with `babysit recover init`.

- 2026-09-20: Available GitHub token has `repo` and `workflow` scopes. The configured Git remote uses SSH; this container can instead use HTTPS with `gh auth git-credential`.
- Host diagnosed through the Docker socket: `cubini`, session registry `/mnt/internalnvme/.babysit/sessions`, workspace `/mnt/internalnvme/dev/babysit`. Inspect targeted state via read-only mounts; the container’s own HOME does not contain the host registry.
