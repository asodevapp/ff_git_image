#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GitHub token is required}"
: "${GH_REPO:?GitHub repository is required}"
: "${RELEASE_TAG:?Release tag is required}"
: "${VSIX:?VSIX filename is required}"

if [[ ! "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
   [[ "$VSIX" != "ff-git-image-${RELEASE_TAG#v}.vsix" ]]; then
  echo "Tag and VSIX filename must identify the same stable version." >&2
  exit 1
fi

cd dist
test -s "$VSIX"
test -s release-notes.md
sha256sum "$VSIX" | diff - SHA256SUMS

if draft=$(gh release view "$RELEASE_TAG" --json isDraft --jq '.isDraft'); then
  if [[ "$draft" != true ]]; then
    echo "Release $RELEASE_TAG is already published. Its assets are preserved; use a new version for changes." >&2
    exit 1
  fi
else
  gh release create "$RELEASE_TAG" --verify-tag --draft \
    --title "FF Git Image $RELEASE_TAG" --notes-file release-notes.md
fi

# A failed upload leaves a draft; retrying repairs it before publication.
gh release upload "$RELEASE_TAG" "$VSIX" SHA256SUMS --clobber
gh release edit "$RELEASE_TAG" --draft=false --notes-file release-notes.md
