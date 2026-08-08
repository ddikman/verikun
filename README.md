# PR evidence — `vk device set`

Screenshots backing the manual-testing section of
[#60](https://github.com/ddikman/verikun/pull/60). They live on this orphan branch rather
than in the source tree so they never enter the PR's diff or `main`'s history.

Captured with `scripts/capture-device-screens.sh` (on the PR branch), which drives the
Flutter fixture's `@vk_device` screen through each setting. Every value shown is read from
`MediaQuery` — the platform, not app state — so it moved because the device did.

| prefix | target |
|---|---|
| `pixel6-` | Pixel 6 emulator, API 34 |
| `samsung-` | Samsung SM-A415F, physical, API 31 |
| `ios-` | iPhone 17 Pro simulator, iOS 26.5 |

**Delete this branch once #60 is merged.**
