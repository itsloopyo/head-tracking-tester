// Cuts a release. Checks the tree is actually releasable, runs the same
// verification CI runs, bumps the version in package.json, package-lock.json
// and pixi.toml, dates the changelog's unreleased section, then commits, tags
// and pushes.
//
// Pushing the tag is the trigger: .github/workflows/release.yml builds
// linux/amd64 + linux/arm64 and publishes to Docker Hub and GHCR.
//
// Run via `pixi run release major|minor|patch`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUMPS = ['major', 'minor', 'patch'];
const RELEASE_BRANCH = 'main';

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function step(msg) {
  console.log(`\n→ ${msg}`);
}

function abort(msg) {
  console.error(`\nrelease aborted: ${msg}`);
  process.exit(1);
}

// ---------- what are we cutting ----------
const bump = process.argv[2];
if (!BUMPS.includes(bump)) {
  abort(`expected one of ${BUMPS.join(' | ')}, got ${JSON.stringify(process.argv[2] ?? '')}`);
}

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!parsed) abort(`package.json version "${pkg.version}" is not a plain x.y.z`);

let [major, minor, patch] = parsed.slice(1).map(Number);
if (bump === 'major') { major += 1; minor = 0; patch = 0; }
else if (bump === 'minor') { minor += 1; patch = 0; }
else { patch += 1; }

const version = `${major}.${minor}.${patch}`;
const tag = `v${version}`;
const today = new Date().toISOString().slice(0, 10);

// Mirrors DOCKERHUB_IMAGE in release.yml, derived so it can't drift if the
// repository moves.
const owner = /github\.com\/([^/]+)\//.exec(pkg.repository?.url ?? '')?.[1];
if (!owner) abort('package.json repository.url is not a github.com URL — cannot name the published image');
const image = `${owner}/${pkg.name}`;

console.log(`cutting ${pkg.version} -> ${version}  (${bump})`);

// ---------- preflight ----------
step('checking the working tree');
const dirty = git('status', '--porcelain');
if (dirty) abort(`working tree is not clean:\n${dirty}`);

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== RELEASE_BRANCH) abort(`on branch "${branch}", releases are cut from "${RELEASE_BRANCH}"`);

step(`fetching origin`);
git('fetch', 'origin', '--tags', '--prune');

const local = git('rev-parse', 'HEAD');
const remote = git('rev-parse', `origin/${RELEASE_BRANCH}`);
if (local !== remote) {
  const ahead = git('rev-list', '--count', `origin/${RELEASE_BRANCH}..HEAD`);
  const behind = git('rev-list', '--count', `HEAD..origin/${RELEASE_BRANCH}`);
  abort(`local ${RELEASE_BRANCH} is ${ahead} ahead / ${behind} behind origin — push or pull first`);
}

if (git('tag', '--list', tag)) {
  abort(`tag ${tag} already exists locally — "git tag -d ${tag}" if a previous run failed after tagging`);
}
if (git('ls-remote', '--tags', 'origin', tag)) abort(`tag ${tag} already exists on origin`);

// The changelog gate is deliberate: every release names its changes, or it
// doesn't go out.
const changelogPath = path.join(ROOT, 'CHANGELOG.md');
const changelog = fs.readFileSync(changelogPath, 'utf8');
const unreleasedHeading = /^##[^\n]*unreleased[^\n]*$/im;
if (!unreleasedHeading.test(changelog)) {
  abort('CHANGELOG.md has no "## … unreleased" heading — write this release\'s notes under one first');
}

// ---------- verify ----------
step('running pixi run verify (test suite + container smoke test)');
try {
  execFileSync('pixi', ['run', 'verify'], { cwd: ROOT, stdio: 'inherit' });
} catch {
  abort('verification failed — nothing was changed');
}

// ---------- bump ----------
step(`writing version ${version}`);
// Written directly rather than via `npm version`: npm is a .cmd on Windows and
// Node refuses to spawn those without a shell. Both files round-trip through
// JSON.stringify byte-for-byte, so this is a one-field edit either way.
function writeJson(file, mutate) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(json);
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

writeJson(pkgPath, (json) => { json.version = version; });
writeJson(path.join(ROOT, 'package-lock.json'), (json) => {
  // The lockfile carries the project's own version twice and both have to move.
  if (!json.packages?.['']) abort('package-lock.json has no root packages[""] entry');
  json.version = version;
  json.packages[''].version = version;
});

const pixiPath = path.join(ROOT, 'pixi.toml');
const pixiToml = fs.readFileSync(pixiPath, 'utf8');
const pixiVersion = /^version = "[^"]*"$/m;
if (!pixiVersion.test(pixiToml)) abort('pixi.toml has no [workspace] version line to update');
fs.writeFileSync(pixiPath, pixiToml.replace(pixiVersion, `version = "${version}"`));

fs.writeFileSync(changelogPath, changelog.replace(unreleasedHeading, `## ${version} — ${today}`));
console.log(`  package.json, package-lock.json, pixi.toml, CHANGELOG.md`);

// ---------- commit, tag, push ----------
step(`committing and tagging ${tag}`);
git('add', 'package.json', 'package-lock.json', 'pixi.toml', 'CHANGELOG.md');
git('commit', '-m', `Release ${version}`);
git('tag', '-a', tag, '-m', version);

step(`pushing ${RELEASE_BRANCH} and ${tag} to origin`);
git('push', 'origin', RELEASE_BRANCH);
git('push', 'origin', tag);

console.log(`
released ${tag}

  .github/workflows/release.yml is now building linux/amd64 + linux/arm64 and
  publishing these tags to Docker Hub and GHCR:

    ${version}   ${major}.${minor}   ${major}   latest

  watch it:   gh run watch
  then check: docker run --rm --network=host ${image}
`);
