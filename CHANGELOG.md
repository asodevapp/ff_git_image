# Changelog

## 1.0.0

First public release of FF Git Image: review image changes directly in VS Code, with no runtime npm dependencies or external image tools.

- Compare images in Side by side, Swipe, Overlay, Pixel diff, Blink, Before, and After views, with synchronized pan and zoom.
- Use Logical scaling for screenshots with different dimensions, and the Color threshold slider to filter small pixel differences.
- Browse staged and unstaged changes in a native folder tree, search by path, and review cached file and folder pixel percentages.
- Stage, unstage, discard, or ignore selected images and folders through queued actions that verify the selected file revisions.
- Hide images with `.image_ignore`, preserve the tree and comparison during background updates, and recover Git index locks explicitly.
- Download the VSIX and SHA-256 checksum from GitHub Releases, built and tested by GitHub Actions.

## 0.1.14

- Add tag-triggered GitHub Releases with a tested VSIX, SHA-256 checksum, changelog notes, version checks, and recovery of incomplete drafts.
- Add a README screenshot gallery and links to ASO.dev and Flutter Files.
- Replace the Tolerance number field with a Color threshold slider, Exact/Ignore more labels, a value readout and a plain-language tooltip.
- Coalesce drag updates, cancel outdated pixel work, support keyboard adjustment and preserve the saved threshold.

## 0.1.13

- Move background percentages to independent native file decorations, so pixel results never refresh tree handles or dismiss context menus. Show a compact percentage badge and exact value on hover.
- Reconcile structural changes with stable nodes; retain surviving file revisions and selection handles.
- Share a bounded preview byte cache between fingerprints, the viewer, and pixel statistics. Validate working-file metadata/events and exact Git blob identities; unchanged status events perform no image reads or pixel work.
- Invalidate exact source data after completed Git writes so immediate Stage/Unstage operations use the updated index while queued commands retain their clicked revisions.
- Deduplicate in-flight reads, retain small fingerprints after byte eviction, and revalidate identities when a file or index changes during a read. Git mutations continue to read and verify fresh bytes.
- Update folder aggregates from affected files only. Suppress duplicate result events, snapshots, badge assignments and viewer loads.
- Add regressions and a real VS Code context-menu test, including unchanged status bursts and editing one of 32 PNGs.

## 0.1.12

- Avoid repeated comparison reads and repository-wide list scans for stage/unstage; refresh only repositories involved in an action.
- Prioritize action revision reads and defer background fingerprints and pixel statistics while an action runs.
- Hash raw image bytes and skip base64 encoding for fingerprint-only and unchanged comparisons.
- Reuse verified single-image discard bytes; preserve cross-repository preflight and checks before bulk discard writes.
- Detect a deleted image recreated after selection or during discard confirmation.
- Add reproducible benchmarks through VS Code's Git API and filesystem provider.

## 0.1.11

- Queue image actions in click order instead of rejecting overlapping commands; share one progress notification with a waiting count.
- Deduplicate identical outstanding actions and preserve selected paths and revisions while waiting.
- Continue the queue after Git errors, stale selections, and cancelled discard confirmations.
- Keep comparison navigation and actions on other images available, with completion messages matched to their requests.

## 0.1.10

- Preserve tree nodes and image revisions across unchanged Git status notifications.
- Batch changed diff labels instead of refreshing the entire tree for each result.
- Keep stage, unstage, and discard available during background calculation; wait for initial revision reads inside the action with progress.

## 0.1.9

- Validate selected and displayed image revisions before staging, unstaging, or discarding; report progress for bulk operations.
- Add explicit Git index-lock recovery with Retry, Git Log, confirmed removal, worktree path resolution, and replacement detection.
- Add native multi-selection, Ignore/Stop ignoring, and a remembered Show Ignored toggle with literal path rules and parent exceptions.
- Add actions and previous/next navigation above the current image, with selection synchronization to the tree.
- Add numeric zoom, Fit Width, double-click Fit/100%, keyboard shortcuts, and adjustable highlight intensity.
- Compute per-file and pixel-weighted folder differences in a local background worker and cache results by revision.
- Preserve escaped question marks in the bundled ignore matcher.

## 0.1.8

- Add context-menu actions on image files, folders, and scope headings: accept (stage), unstage, and discard.
- Restrict bulk actions to visible image descendants, respecting `.image_ignore` and staged/working scopes.
- Confirm the exact discard list, preserve staged versions, move untracked images to Trash, and cancel when selected contents change during confirmation.
- Address Git paths literally, including brackets and Unicode; unstage both sides of a rename.

## 0.1.7

- Support a repository-root `.image_ignore` with Git-style patterns, directory rules, comments, and `!` exceptions.
- Apply exclusions consistently to the sidebar, search, counts, and comparison tab, including staged and tracked images.
- Reload rules automatically on create, save, or delete; isolate repositories and retain the last rules if the file temporarily becomes unreadable.

## 0.1.6

- Group image changes into compact folder trees, making repeated filenames distinguishable by theme, locale, and directory.
- Add Find Changed Image in the sidebar header with full-path, repository, and staged/unstaged search; reveal the chosen file in the tree.
- Preserve sidebar focus when opening comparisons so keyboard navigation remains available, and keep stable tree identities across refreshes.

## 0.1.5

- Add a Logical scaling checkbox directly above the images in Side by side; compare different resolutions at equal visual width while preserving proportions and top alignment.
- Replace the separate Layout view with this checkbox, remember its selection, and migrate previously saved Layout settings.
- Keep the normal pixel scale and diagnostics available by unchecking Logical scaling.

## 0.1.4

- Stop clearing and reloading the comparison on unrelated Git status, file watcher, and focus events.
- Check both image contents before sending them to the webview; unchanged comparisons preserve canvases, pixel results, zoom, and scrolling.
- Keep the current view visible while changed image versions are loaded and decoded; continue detecting working-tree, index, and HEAD changes automatically.

## 0.1.3

- Add Layout (equal width) for screenshots captured at different dimensions, with separate canvases, preserved proportions, and top alignment.
- Synchronize zoom and scrolling in shared visual coordinates; show each original size and actual scale.
- Offer Compare layout when dimensions differ, and hide raw pixel diagnostics in this mode.

## 0.1.2

- Use the native sidebar as the only image list and give the comparison the full editor width.
- Remove duplicate webview filters and navigation; add an Images button to reveal the sidebar.
- Preserve the selected comparison and display settings when restoring an older tab.

## 0.1.1

- Add a dedicated FF Git Image Activity Bar icon and native sidebar showing Git image changes.
- Group images by repository and staged/unstaged/conflict state; preserve the selected comparison scope when opening from the sidebar.
- Add sidebar refresh/open actions, change count, and an empty-state guide.

## 0.1.0

- Independent Git image review tab with side by side, swipe, overlay, pixel diff, blink, before, and after views.
- Separate staged and unstaged comparisons, renames, additions, deletions, conflicts, and multiple repositories.
- Highlight masks, pixel tolerance, difference bounds, synchronized zoom/pan, transparency backgrounds, and automatic refresh.
- Binary-safe Git reads using VS Code's built-in Git integration, with no additional runtime tools or dependencies.
