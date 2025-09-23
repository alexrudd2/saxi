import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inc } from 'semver'

const repositoryRoot = join(__dirname, '..')
const packageJsonPath = join(repositoryRoot, 'package.json')
const packageParsed = JSON.parse(readFileSync(packageJsonPath))

const args = require('yargs')
  .strict()
  .option("level", {
    type: "string",
    choices: ["major", "premajor", "minor", "preminor", "patch", "prepatch", "prerelease"],
    demandOption: true
  })
  .parse()

const newVersion = inc(packageParsed.version, args.level)

const newPackageJson = {...packageParsed, version: newVersion}
writeFileSync(packageJsonPath, `${JSON.stringify(newPackageJson, null, 2)}\n`)

const packageLockJsonPath = join(repositoryRoot, 'package-lock.json')
const packageLock = JSON.parse(readFileSync(packageLockJsonPath))
const newPackageLockJson = {...packageLock, version: newVersion}
writeFileSync(packageLockJsonPath, `${JSON.stringify(newPackageLockJson, null, 2)}\n`)

function git(args) {
  const r = spawnSync("git", args, {cwd: repositoryRoot})
  if (r.status !== 0) {
    console.error(r.stderr)
    throw new Error(`Command failed: git ${args.join(" ")}`)
  }
}
git(["add", "package.json", "package-lock.json"])
git(["commit", "-m", `bump to ${newVersion}`])
git(["tag", `v${newVersion}`])

console.log(`Bumped version from ${packageParsed.version} -> ${newVersion}`)
