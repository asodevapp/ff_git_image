const test = require("node:test");
const assert = require("node:assert/strict");
const ignore = require("../vendor/ignore");
const { updateIgnorePatterns } = require("../out/ignore-patterns");

test("menu ignore writes literal brackets, wildcards, spaces, and Unicode without broadening scope", () => {
  const paths = [
    "golden/FullHd[dark].png",
    "golden/a*b?.png",
    "golden/#name ü .png",
  ];
  const content = updateIgnorePatterns(
    "# Keep this comment\r\nexisting/\r\n",
    paths,
    true,
  );
  const rules = ignore().add(content);
  for (const path of paths) assert.equal(rules.ignores(path), true);
  for (const path of ["golden/FullHdd.png", "golden/axby.png", "other.png"])
    assert.equal(rules.ignores(path), false);
  assert.ok(content.startsWith("# Keep this comment\r\nexisting/\r\n"));
  assert.equal(updateIgnorePatterns(content, paths, true), content);
});

test("unignore can reopen one file beneath excluded parents while preserving hidden siblings", () => {
  for (const initial of ["golden/\n", "*\n", "**/*.png\n", "/golden/dark/\n"]) {
    const content = updateIgnorePatterns(
      initial,
      ["golden/dark/FullHd[dark].png"],
      false,
    );
    const before = ignore().add(initial),
      after = ignore().add(content);
    assert.equal(after.ignores("golden/dark/FullHd[dark].png"), false);
    for (const path of [
      "golden/dark/FullHdd.png",
      "golden/light/image.png",
      "other/image.png",
      "golden/notes.txt",
    ])
      assert.equal(after.ignores(path), before.ignores(path), path + initial);
    assert.equal(
      updateIgnorePatterns(content, ["golden/dark/FullHd[dark].png"], false),
      content,
    );
    assert.equal(
      ignore()
        .add(
          updateIgnorePatterns(content, ["golden/dark/FullHd[dark].png"], true),
        )
        .ignores("golden/dark/FullHd[dark].png"),
      true,
    );
  }
});

test("ignore rejects paths that cannot be represented as one repository-relative rule", () => {
  for (const path of ["../outside.png", "a\nb.png", "/absolute.png", ""])
    assert.throws(() => updateIgnorePatterns("", [path], true));
});
