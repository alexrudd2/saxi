import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inc } from 'semver';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const repositoryRoot = join(__dirname, '..');
const packageJsonPath = join(repositoryRoot, 'package.json');
const packageParsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

const args = yargs(hideBin(process.argv))
  .strict()
  .option("level", {
    type: "string",
    choices: ["major", "premajor", "minor", "preminor", "patch", "prepatch", "prerelease"],
    demandOption: true
  })
  .parseSync();

const newVersion = inc(packageParsed.version, args.level);

const newPackageJson = { ...packageParsed, version: newVersion };
writeFileSync(packageJsonPath, `${JSON.stringify(newPackageJson, null, 2)}\n`);

const packageLockJsonPath = join(repositoryRoot, 'package-lock.json');
const packageLock = JSON.parse(readFileSync(packageLockJsonPath, 'utf8'));
const newPackageLockJson = { ...packageLock, version: newVersion };
writeFileSync(packageLockJsonPath, `${JSON.stringify(newPackageLockJson, null, 2)}\n`);

function git(args) {
  const r = spawnSync("git", args, { cwd: repositoryRoot, stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`Command failed: git ${args.join(" ")}`);
  }
}
git(["add", "package.json", "package-lock.json"]);
git(["commit", "-m", `bump to ${newVersion}`]);
git(["tag", `v${newVersion}`]);

console.log(`Bumped version from ${packageParsed.version} -> ${newVersion}`);
