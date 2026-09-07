# Publishing FF Git Image

Use **GitHub Releases** for downloadable VSIX files and version history. Use the **VS Code Marketplace** for discovery and automatic extension updates. Publish the same tested VSIX to both channels.

| Channel          | Trigger                             | Result                                                                                    |
| ---------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Actions artifact | Branch push or pull request         | Tested VSIX, checksum, and release notes; retained for 14 days                            |
| GitHub Release   | Push a tag such as `v1.0.0`         | Public release with `ff-git-image-1.0.0.vsix`, `SHA256SUMS`, and notes from the changelog |
| Marketplace      | Separate publisher setup and upload | Installation from VS Code and updates under `gornivv.ff-git-image`                        |

GitHub publication is implemented by [release.yml](../.github/workflows/release.yml), which calls the same [check.yml](../.github/workflows/check.yml) used by branch and PR checks. Marketplace publication is not enabled by these workflows.

## What a tag release does

1. Check that the tag, `package.json`, both version fields in `package-lock.json`, and the first released section of `CHANGELOG.md` agree. An optional `Unreleased` section is skipped. Tags use `vMAJOR.MINOR.PATCH`; prerelease suffixes are rejected.
2. Install the locked development dependencies with `npm ci`.
3. Compile TypeScript, run the unit tests, and run the real comparison webview checks in Chromium.
4. Build one universal VSIX. The extension has no native platform binaries, so separate Windows, macOS, and Linux packages are unnecessary.
5. Save the package, its SHA-256 checksum, and release notes as a workflow artifact.
6. Download that exact artifact in the publication job and verify the package checksum.
7. Create a GitHub draft, attach the VSIX and checksum, then publish it. A failed upload leaves a draft that can be retried.

README links and screenshots inside the VSIX point to the **source commit** used by the build, so a later edit on `main` does not change an older package's documentation. The CI scripts and `dist/` build files are excluded from the VSIX; the screenshot gallery remains included.

The release job uses the repository's automatic `GITHUB_TOKEN` with `contents: write`. No personal GitHub token or repository secret is required. Build and PR jobs have read access only. Official Actions are pinned to commit hashes.

## First release

Commit and push the extension source, lockfile, README images, tests, scripts, and both workflows to `main` first. A local untracked file is not included in an Actions checkout.

The current initial version is `1.0.0`. Once that source is on GitHub, create its tag:

```sh
git tag -a v1.0.0 -m "FF Git Image 1.0.0"
git push origin v1.0.0
```

Watch **Actions → Release extension**. The finished package appears on [GitHub Releases](https://github.com/asodevapp/ff_git_image/releases). Download the `.vsix` from **Assets**, then use **Extensions → … → Install from VSIX…** in VS Code.

Pushing the tag is the publication trigger. There is no manual draft approval step on a successful run.

## Subsequent releases

Land the intended changes on `main`, then update the version and changelog. For example, the next patch after `1.0.0` is `1.0.1`:

```sh
npm version patch --no-git-tag-version
# Add a matching "## 1.0.1" entry to CHANGELOG.md.
npm test
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release 1.0.1"
git push origin main
git tag -a v1.0.1 -m "FF Git Image 1.0.1"
git push origin v1.0.1
```

Use the actual version in your manifest for the commit and tag. `npm version ... --no-git-tag-version` updates both manifests without publishing a tag before the changelog is ready.

The workflow does not overwrite a published release. To ship a correction, increment the version and create a new tag. If publication failed while the release was still a draft, use **Re-run failed jobs**; it repairs the draft's attachments before making it public. If the 14-day build artifact has expired, re-run all jobs to rebuild it.

## Marketplace

The package already declares publisher **`gornivv`**, the publisher used by [FF Flutter Files](https://marketplace.visualstudio.com/items?itemName=gornivv.vscode-flutter-files). Keep the publisher and extension name stable so updates continue using **`gornivv.ff-git-image`**.

For the first Marketplace release:

1. Sign in to the [publisher management page](https://marketplace.visualstudio.com/manage/publishers/) with access to `gornivv`.
2. Download the tested VSIX from GitHub Releases.
3. Create a Visual Studio Code extension in the publisher portal and upload that VSIX. For later versions, update the same extension.
4. Check the listing, images, installation, and update behavior before adding unattended Marketplace publication.

For automation, follow Microsoft's [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace) and configure Microsoft Entra ID authentication with workload identity federation. After that one-time setup, publish the existing package with the installed `vsce`:

```sh
npx --no-install vsce publish --packagePath dist/ff-git-image-1.0.0.vsix --azure-credential
```

The command requires configured publisher access and Azure credentials; GitHub's `GITHUB_TOKEN` cannot publish to the Marketplace.

When adding this automation, use a later job in `release.yml` that downloads the same artifact. Do not rely on a separate `release: published` workflow: events produced with `GITHUB_TOKEN` generally do not start another workflow. See [GitHub's trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

## Local verification

```sh
node scripts/release-metadata.mjs
npm test
npm run test:ui
npm run package -- --out dist/ff-git-image-1.0.0.vsix
```

Use the current version for the output filename. To exercise the tag check locally, set `GITHUB_REF_TYPE=tag` and `GITHUB_REF_NAME=v1.0.0` when running the metadata script. Native VS Code host and menu tests remain available separately via `npm run test:host` and `npm run test:menu`.
