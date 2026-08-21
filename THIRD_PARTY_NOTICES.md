# Third-party notices

## Moby seccomp profile

`src/docker/chrome-seccomp.json` derives from Moby's default seccomp profile
at commit `b612274c5489b546ff8b4a4f93f25a0b8952713a`. Babysit adds an
unconditional allow rule for `clone` and `unshare` so Chrome can establish
its nested sandbox without `CAP_SYS_ADMIN`.

Copyright 2012-2017 Docker, Inc. Licensed under the Apache License 2.0;
see `LICENSES/Moby-Apache-2.0.txt` and `LICENSES/Moby-NOTICE.txt`.
