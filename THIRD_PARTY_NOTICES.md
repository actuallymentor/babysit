# Third-party notices

## Moby seccomp profile

`src/docker/chrome-seccomp.json` derives from Moby's vendored default seccomp
profile at commit `b612274c5489b546ff8b4a4f93f25a0b8952713a`, file
`vendor/github.com/moby/profiles/seccomp/default.json`, raw SHA-256
`536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`.
Babysit adds an
allow rule for Chrome's `clone` and `unshare` sandbox calls, excluding mount,
UTS, IPC, and cgroup namespaces, without requiring `CAP_SYS_ADMIN`.

Reproduce the upstream hash:

```bash
curl -fsSL 'https://raw.githubusercontent.com/moby/moby/b612274c5489b546ff8b4a4f93f25a0b8952713a/vendor/github.com/moby/profiles/seccomp/default.json' | sha256sum
```

Copyright 2012-2017 Docker, Inc. Licensed under the Apache License 2.0;
see `LICENSES/Moby-Apache-2.0.txt` and `LICENSES/Moby-NOTICE.txt`.
