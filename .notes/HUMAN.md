# Human Review

- Before publishing v0.34.0, run `npm run test:e2e` on a Docker host. The
  current agent session exposed no Docker daemon socket, so it could not build
  the edited image. Direct verification in the current Debian image installed
  the exact ten-package set and passed the new pkgconf, process, socket, ACL,
  inotify, entr, shfmt, git-filter-repo, Universal Ctags, and qpdf workflows;
  the existing Xvfb/headful Chrome and Poppler image flows still need the
  Docker-host release gate.
