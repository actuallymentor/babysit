# Human Review

- Before publishing v0.33.0, run `npm run test:e2e` on a Docker host. The
  current agent session exposed no Docker daemon socket, so it could not build
  the edited image or exercise the new path through Docker's seccomp profile.
  Direct verification in the current Debian image installed the exact package
  set and passed non-root Xvfb/headful Chrome and Poppler PDF smoke flows.
