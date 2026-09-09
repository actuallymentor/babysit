# Deployments

- CLI distribution: [GitHub releases](https://github.com/actuallymentor/babysit/releases), four compiled Linux/macOS architecture binaries and checksums.
- Agent image: `actuallymentor/babysit:<version>` and `actuallymentor/babysit:latest` on Docker Hub, amd64/arm64.
- Web companion: separate image published by the repository's web Docker workflow.
- `main` pushes with an untagged package version trigger `.github/workflows/publish.yml`: tests, binaries, release, then versioned agent/web images. Docker asset pushes also refresh `latest` independently.
- No specific production Ubuntu host or SSH deployment target has been recorded. Deploying this repository means publishing the release artifacts/images; boot service installation is performed on a user's Ubuntu host with `babysit recover init`.
