# Third-party notices

## Moby seccomp profile

`src/docker/chrome-seccomp.json` derives from Moby's default seccomp profile
at commit `b612274c5489b546ff8b4a4f93f25a0b8952713a`. Babysit adds an
allow rule for Chrome's `clone` and `unshare` sandbox calls, excluding mount,
UTS, IPC, and cgroup namespaces, without requiring `CAP_SYS_ADMIN`.

Copyright 2012-2017 Docker, Inc. Licensed under the Apache License 2.0;
see `LICENSES/Moby-Apache-2.0.txt` and `LICENSES/Moby-NOTICE.txt`.
