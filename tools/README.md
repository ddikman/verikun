# Tools

Packaged applications and utilities that **`vk` itself uses at runtime** — shipped with
the npm package and invoked while a test runs, not while the repo is built.

Everything else in this repo is TypeScript that shells out to `adb` / `xcrun` / `idb`.
This directory is the exception, and it is kept apart deliberately so that stays obvious:
its own language, its own toolchain, its own build, and a **committed build output**,
because `npm install verikun` must never require an Android SDK or Xcode.

```
tools/
  verikun-companion/    Android. Pushed to the device and run there; serves UI-hierarchy reads.
```

Two neighbours it is easy to confuse this with:

- **`scripts/`** — developer and CI scripts (`gen-version.mjs`, `check-package-contents.mjs`). Plain Node, build-time only, never shipped and never run by `vk`.
- **`example/flutter-app/`** — the Flutter fixture the e2e suite drives. An app under *test*, not one verikun uses.

The line is *when it runs*: a tool runs during a `vk` invocation; a script runs when you
build or release the repo.

## Each tool owns its build

```
<tool>/
  README.md      what it is, how it runs, and the measured numbers
  build.sh       produces prebuilt/
  src/           source
  prebuilt/      COMMITTED build output — the only part shipped to npm
```

The output is committed for the same reason scrcpy commits its server: a user installing
the CLI has a phone, not a build environment.

**If you change the source, rebuild and commit the artifact in the same commit.** It is a
binary, so a reviewer cannot see the drift and nothing else will tell you.

## Shipping

Only `prebuilt/` directories ship. Sources and build scripts are repo infrastructure, like
`example/flutter-app/`, and stay out of the npm tarball. Name each one in `package.json`'s
`files` as a flat glob — `tools/verikun-companion/prebuilt/*.jar` — because
`tests/package-files.test.ts` only understands the `<dir>/*.<ext>` shape (the directory may
be nested; the *pattern* may not). Then update `scripts/check-package-contents.mjs`, which
asserts the packed tarball's actual contents rather than the intent.
