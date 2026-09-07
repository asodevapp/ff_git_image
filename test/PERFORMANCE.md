# Tree and cache performance: 0.1.13

Measured on 2026-09-06 in VS Code 1.135.0 on macOS. The actual extension, Git API, Git filesystem, webview worker and tree were exercised in a disposable profile with 32 PNGs (256×256, 262,548 bytes each). [Raw counters](model-performance-0.1.13.json) are included.

| After initial loading                               | Image reads | Pixel jobs | Webview snapshots | Tree refreshes |
| --------------------------------------------------- | ----------: | ---------: | ----------------: | -------------: |
| Four Git status calls and background result updates |           0 |          0 |                 0 |              0 |
| Change one working PNG                              |           1 |          1 |                 1 |              0 |

Background result updates repaint native decorations only. The real VS Code image context menu remained visible with the same Stage/Discard/Ignore actions throughout the four updates. Hover exposed the updated exact percentage. A folder context menu also remained open through a real image edit, viewer update and pixel calculation. The automated menu test uses VS Code's custom menu implementation in an isolated macOS profile; it does not control the user's window or claim coverage of every platform's OS-native popup implementation. A membership change may still require a tree refresh; surviving model objects and IDs are retained.

The status sequence includes deliberate 450 ms gaps to hold the menu open; its total wall time is not a command latency benchmark. Counters measure extension filesystem calls, not OS disk reads. Warm-cache behavior excludes initial decoding and is not a claim that all repositories have identical latency.

Run `npm run test:menu` for the actual menu check and counters, or `FF_GIT_IMAGE_HOST_TEST="$PWD/test/model-host.cjs" node test/run-host.cjs` for the native model/cache test alone. The menu harness enables a temporary local CDP endpoint on its disposable VS Code process. No debug endpoint or server is started by the installed extension.

## Command performance: 0.1.11 → 0.1.12

Measured on 2026-09-05 in the locally installed VS Code 1.135.0 on macOS, through its real Git API and Git filesystem provider. Each operation handled 16 deterministic 256×256 PNGs, 262548 bytes per image version, in a disposable repository. The benchmark alternated baseline and candidate versions for three rounds, resetting the fixture before every operation. Values below are medians; [raw samples](performance-0.1.12.json) are included.

| Command |  0.1.11 |  0.1.12 | Speedup | Image reads |
| ------- | ------: | ------: | ------: | ----------: |
| stage   | 2.667 s | 0.957 s |   2.79x |     96 → 32 |
| unstage | 2.682 s | 0.987 s |   2.72x |     96 → 32 |
| discard | 2.703 s | 2.659 s |   1.02x |    160 → 96 |

The tree's initial fingerprints were ready before timing. Queue waiting, pixel rendering, repository event-driven background scans, and real user workspace load are excluded. Image reads count calls to VS Code's filesystem API, not operating-system syscalls. The measurements are a reproducible fixture comparison, not a guarantee for every repository.

Stage/unstage now read one image pair per selected file rather than three. Explicit `repo.status()` requests fall from three to two and change-list constructions from 19 to 4 for this fixture. Hash-only checks and unchanged viewer responses no longer encode base64. Initial reads required by actions take priority over queued background reads; background revision sweeps and new pixel-statistics work pause during a mutation.

Bulk discard reads fewer image bytes (160 → 96 reads in this fixture), but its timing is effectively unchanged: repeated Git object metadata/content checks around confirmation and writes remain expensive. Those checks continue to guard against an image changing during review. Single-image discard reuses the bytes checked immediately after confirmation and needs only two pair reads.

Cross-repository actions retain a complete preflight before the first repository is modified, followed by checks for each repository. They are not covered by the single-repository timing figures above.

### Reproduce command timings

Install development dependencies and compile with `npm run compile`. Optionally extract a previous VSIX to a temporary directory and point `FF_GIT_IMAGE_BASELINE` at its `extension` directory. With no baseline available, only the current version is measured.

```sh
FF_GIT_IMAGE_HOST_TEST="$PWD/test/performance-host.cjs" \
FF_GIT_IMAGE_BASELINE=/tmp/ff-git-image-baseline/extension \
node test/run-host.cjs
```

Results are written to `.test-host/performance.json`. The harness creates and removes its own Git repository and VS Code profile; it disables update downloads in that temporary profile. Git CLI calls are confined to test fixture setup. The installed extension continues to use only the built-in Git API and local filesystem APIs.
