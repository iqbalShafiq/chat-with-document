#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_VERSION = "1.0.1";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCKFILE_PATH = join(REPOSITORY_ROOT, "pnpm-lock.yaml");
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const REQUIRED_DIRECT_DEPENDENCIES = {
  "packages/agent/package.json": [
    "@anvia/core",
    "@anvia/langfuse",
    "@anvia/mcp",
    "@anvia/mistral",
    "@anvia/openai",
    "@anvia/qdrant",
  ],
  "apps/api/package.json": [
    "@anvia/client",
    "@anvia/core",
    "@anvia/memory-prisma",
    "@anvia/server",
  ],
  "apps/platform/package.json": [
    "@anvia/client",
    "@anvia/react",
    "@anvia/react-ui",
  ],
};

function normalizePath(path) {
  return path.split("\\").join("/");
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function findPackageJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const packageJsonFiles = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      packageJsonFiles.push(...(await findPackageJsonFiles(entryPath)));
    } else if (entry.isFile() && entry.name === "package.json") {
      packageJsonFiles.push(entryPath);
    }
  }

  return packageJsonFiles;
}

async function getWorkspaceManifestPaths() {
  const paths = [join(REPOSITORY_ROOT, "package.json")];

  for (const workspaceRoot of ["apps", "packages"]) {
    paths.push(
      ...(await findPackageJsonFiles(join(REPOSITORY_ROOT, workspaceRoot))),
    );
  }

  return paths.sort((left, right) => left.localeCompare(right));
}

function parseImporterAnviaDependencies(lockfile) {
  const importers = new Map();
  let inImporters = false;
  let importer;
  let dependencyField;
  let dependency;

  for (const line of lockfile.split(/\r?\n/u)) {
    if (line === "importers:") {
      inImporters = true;
      continue;
    }
    if (inImporters && /^\S/u.test(line)) {
      break;
    }
    if (!inImporters || line.trim() === "") {
      continue;
    }

    const indentation = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indentation === 2 && trimmed.endsWith(":")) {
      importer = unquote(trimmed.slice(0, -1));
      importers.set(importer, new Map());
      dependencyField = undefined;
      dependency = undefined;
      continue;
    }

    if (indentation === 4 && trimmed.endsWith(":")) {
      const candidate = unquote(trimmed.slice(0, -1));
      dependencyField = DEPENDENCY_FIELDS.includes(candidate)
        ? candidate
        : undefined;
      dependency = undefined;
      continue;
    }

    if (
      indentation === 6 &&
      dependencyField !== undefined &&
      trimmed.endsWith(":")
    ) {
      const packageName = unquote(trimmed.slice(0, -1));
      dependency = packageName.startsWith("@anvia/")
        ? { packageName, dependencyField }
        : undefined;
      if (dependency !== undefined) {
        importers.get(importer).set(packageName, dependency);
      }
      continue;
    }

    if (indentation === 8 && dependency !== undefined) {
      const separatorIndex = trimmed.indexOf(":");
      if (separatorIndex === -1) {
        continue;
      }
      const key = trimmed.slice(0, separatorIndex);
      if (key === "specifier" || key === "version") {
        dependency[key] = unquote(trimmed.slice(separatorIndex + 1));
      }
    }
  }

  return importers;
}

function versionFromResolution(resolution) {
  return resolution.match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u)?.[1];
}

const errors = [];
const manifestPaths = await getWorkspaceManifestPaths();
const manifests = new Map();
const referencedAnviaPackages = new Set();

for (const manifestPath of manifestPaths) {
  const manifestName = normalizePath(relative(REPOSITORY_ROOT, manifestPath));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifests.set(manifestName, manifest);

  for (const field of DEPENDENCY_FIELDS) {
    for (const [packageName, specifier] of Object.entries(
      manifest[field] ?? {},
    )) {
      if (!packageName.startsWith("@anvia/")) {
        continue;
      }
      referencedAnviaPackages.add(packageName);
      if (specifier !== TARGET_VERSION) {
        errors.push(
          `${manifestName}: ${field}.${packageName} must be exactly ${TARGET_VERSION}; found ${specifier}`,
        );
      }
    }
  }
}

for (const [manifestName, packageNames] of Object.entries(
  REQUIRED_DIRECT_DEPENDENCIES,
)) {
  const dependencies = manifests.get(manifestName)?.dependencies ?? {};
  for (const packageName of packageNames) {
    if (!(packageName in dependencies)) {
      errors.push(
        `${manifestName}: dependencies.${packageName} is required at ${TARGET_VERSION}`,
      );
    }
  }
}

const rootManifest = manifests.get("package.json");
const patchedDependencies = rootManifest?.pnpm?.patchedDependencies ?? {};
const configuredAnviaPatchKeys = Object.keys(patchedDependencies).filter(
  (key) => key.startsWith("@anvia/"),
);
if (configuredAnviaPatchKeys.length > 0) {
  errors.push(
    `package.json: Anvia packages must not be patched after the v1 cutover; found ${configuredAnviaPatchKeys.join(", ")}`,
  );
}

const lockfile = await readFile(LOCKFILE_PATH, "utf8");
const importerDependencies = parseImporterAnviaDependencies(lockfile);

for (const [manifestName, manifest] of manifests) {
  const importerName = manifestName === "package.json"
    ? "."
    : manifestName.slice(0, -"/package.json".length);
  const lockDependencies = importerDependencies.get(importerName);

  for (const field of DEPENDENCY_FIELDS) {
    for (const [packageName, specifier] of Object.entries(
      manifest[field] ?? {},
    )) {
      if (!packageName.startsWith("@anvia/")) {
        continue;
      }

      const lockedDependency = lockDependencies?.get(packageName);
      if (lockedDependency === undefined) {
        errors.push(
          `pnpm-lock.yaml: importer ${importerName} is missing ${packageName}`,
        );
        continue;
      }
      if (lockedDependency.specifier !== specifier) {
        errors.push(
          `pnpm-lock.yaml: importer ${importerName} has ${packageName} specifier ${lockedDependency.specifier ?? "missing"}; expected ${specifier}`,
        );
      }

      const resolvedVersion = versionFromResolution(
        lockedDependency.version ?? "",
      );
      if (resolvedVersion !== TARGET_VERSION) {
        errors.push(
          `pnpm-lock.yaml: importer ${importerName} resolves ${packageName} to ${resolvedVersion ?? "missing"}; expected ${TARGET_VERSION}`,
        );
      }
    }
  }
}

const resolutionPattern =
  /(@anvia\/[0-9A-Za-z._-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/gu;
const lockedResolutionVersions = new Map();

for (const match of lockfile.matchAll(resolutionPattern)) {
  const [, packageName, version] = match;
  const versions = lockedResolutionVersions.get(packageName) ?? new Set();
  versions.add(version);
  lockedResolutionVersions.set(packageName, versions);

  if (version !== TARGET_VERSION) {
    errors.push(
      `pnpm-lock.yaml: legacy resolution ${packageName}@${version} must be removed`,
    );
  }
}

for (const packageName of referencedAnviaPackages) {
  if (!lockedResolutionVersions.get(packageName)?.has(TARGET_VERSION)) {
    errors.push(
      `pnpm-lock.yaml: missing ${packageName}@${TARGET_VERSION} resolution`,
    );
  }
}

if (/^patchedDependencies:\s*$/mu.test(lockfile)) {
  errors.push(
    "pnpm-lock.yaml: Anvia v1 cutover must not retain patchedDependencies",
  );
}

const uniqueErrors = [...new Set(errors)].sort();

if (uniqueErrors.length > 0) {
  console.error(
    `Anvia v1 dependency guard failed with ${uniqueErrors.length} issue(s):`,
  );
  for (const error of uniqueErrors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Anvia v1 dependency guard passed: ${manifestPaths.length} workspace manifests and pnpm-lock.yaml use exact @anvia/* ${TARGET_VERSION} dependencies.`,
  );
}
