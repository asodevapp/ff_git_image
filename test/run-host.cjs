// Uses the locally installed VS Code. Git is invoked only to make isolated test fixtures.
const {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  existsSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const extension = path.resolve(__dirname, "..");
const temp = mkdtempSync(path.join(tmpdir(), "ff-git-image-host-"));
const fixture = path.join(temp, "repo");
mkdirSync(fixture);
// Keep the isolated test app from downloading updates or delaying its shutdown.
const testSettings = path.join(temp, "user", "User");
mkdirSync(testSettings, { recursive: true });
writeFileSync(
  path.join(testSettings, "settings.json"),
  JSON.stringify({
    "update.mode": "none",
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "telemetry.telemetryLevel": "off",
    ...(process.env.FF_GIT_IMAGE_CDP_PORT
      ? { "window.menuStyle": "custom" }
      : {}),
  }),
);
const git = (...args) => execFileSync("git", args, { cwd: fixture });
const svg = (color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="${color}"/></svg>`;
git("init", "-q");
const nested = ["dark/en", "dark/ru", "light/en", "light/ru"].map(
  (folder) => `src/assets/images/feature/${folder}`,
);
for (const folder of nested) {
  mkdirSync(path.join(fixture, folder), { recursive: true });
  for (const file of [
    "measurements-metrics.svg",
    "measurements-metrics@2x.svg",
    "measurements-a_b.svg",
  ])
    writeFileSync(path.join(fixture, folder, file), svg("red"));
}
for (const file of ["partial.svg", "deleted.svg", "old # ü.svg"])
  writeFileSync(path.join(fixture, file), svg("red"));
git("add", ".");
git(
  "-c",
  "user.name=FF Git Image Test",
  "-c",
  "user.email=test@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-qm",
  "Fixture",
);
writeFileSync(path.join(fixture, "partial.svg"), svg("blue"));
for (const folder of nested) {
  for (const file of [
    "measurements-metrics.svg",
    "measurements-metrics@2x.svg",
  ]) {
    writeFileSync(path.join(fixture, folder, file), svg("blue"));
    git("add", "--", `${folder}/${file}`);
  }
  writeFileSync(
    path.join(fixture, folder, "measurements-a_b.svg"),
    svg("green"),
  );
}
git("add", "partial.svg");
writeFileSync(path.join(fixture, "partial.svg"), svg("green"));
renameSync(
  path.join(fixture, "old # ü.svg"),
  path.join(fixture, "renamed # ü.svg"),
);
git("add", "-A", "--", "old # ü.svg", "renamed # ü.svg");
rmSync(path.join(fixture, "deleted.svg"));
writeFileSync(path.join(fixture, "untracked.svg"), svg("orange"));
const macExecutable = [
  "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
  "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
].find(existsSync);
const executable =
  process.env.VSCODE_EXECUTABLE ??
  (process.platform === "darwin" ? macExecutable : "code");
if (!executable)
  throw new Error("Set VSCODE_EXECUTABLE to the VS Code executable.");
const resultFile = path.join(temp, "passed");
const env = { ...process.env, FF_GIT_IMAGE_TEST_RESULT: resultFile };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  executable,
  [
    "--new-window",
    ...(process.env.FF_GIT_IMAGE_CDP_PORT
      ? [`--remote-debugging-port=${process.env.FF_GIT_IMAGE_CDP_PORT}`]
      : []),
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    "--disable-extensions",
    "--user-data-dir",
    path.join(temp, "user"),
    "--extensions-dir",
    path.join(temp, "extensions"),
    `--extensionDevelopmentPath=${extension}`,
    `--extensionTestsPath=${process.env.FF_GIT_IMAGE_HOST_TEST ?? path.join(__dirname, "host.cjs")}`,
    fixture,
  ],
  { stdio: "inherit", env },
);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  const passed = existsSync(resultFile);
  if (!passed)
    console.error("VS Code exited before the extension host tests completed.");
  rmSync(temp, { recursive: true, force: true });
  process.exitCode = passed ? (code ?? 1) : 1;
});
