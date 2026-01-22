/**
 * scripts/set-version.js
 *
 * Usage:
 *   bun scripts/set-version.js <new-version>
 *
 * Example:
 *   bun scripts/set-version.js 3.0.1
 *
 * This script updates the version number in:
 * - Cargo.toml (workspace.package.version)
 * - packages/core/package.json
 * - src-tauri/app-main/tauri.conf.json
 * - src-tauri/app-cli/tauri.conf.json
 * - src-tauri/app-plugin-editor/tauri.conf.json
 */

const fs = require('fs');
const path = require('path');

const newVersion = process.argv[2];

if (!newVersion) {
  console.error('Usage: bun scripts/set-version.js <new-version>');
  process.exit(1);
}

// Basic semantic version validation (x.y.z)
if (!/^\d+\.\d+\.\d+/.test(newVersion)) {
  console.error('Error: Version must be in format x.y.z');
  process.exit(1);
}

const rootDir = path.resolve(__dirname, '..');

// 1. Update Cargo.toml (Workspace Root)
const cargoTomlPath = path.join(rootDir, 'Cargo.toml');
if (fs.existsSync(cargoTomlPath)) {
    let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
    // Replace version = "x.y.z" inside [workspace.package]
    const workspacePackageRegex = /(\[workspace\.package\][^\[]*?version\s*=\s*")([^"]+)(")/s;

    if (workspacePackageRegex.test(cargoToml)) {
        cargoToml = cargoToml.replace(workspacePackageRegex, `$1${newVersion}$3`);
        fs.writeFileSync(cargoTomlPath, cargoToml);
        console.log(`Updated Cargo.toml to ${newVersion}`);
    } else {
        console.error('Error: Could not find [workspace.package] version in Cargo.toml');
    }
} else {
    console.error('Error: Cargo.toml not found');
}

// 2. Update packages/core/package.json
const corePkgPath = path.join(rootDir, 'packages', 'core', 'package.json');
if (fs.existsSync(corePkgPath)) {
    try {
        const pkg = JSON.parse(fs.readFileSync(corePkgPath, 'utf8'));
        pkg.version = newVersion;
        fs.writeFileSync(corePkgPath, JSON.stringify(pkg, null, 2) + '\n');
        console.log(`Updated packages/core/package.json to ${newVersion}`);
    } catch (e) {
        console.error(`Error updating ${corePkgPath}:`, e);
    }
} else {
    console.warn(`Warning: ${corePkgPath} not found`);
}

// 3. Update tauri.conf.json files
const tauriConfPaths = [
    'src-tauri/app-main/tauri.conf.json',
    'src-tauri/app-cli/tauri.conf.json',
    'src-tauri/app-plugin-editor/tauri.conf.json'
];

tauriConfPaths.forEach(relPath => {
    const fullPath = path.join(rootDir, relPath);
    if (fs.existsSync(fullPath)) {
        try {
            const conf = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            conf.version = newVersion;
            fs.writeFileSync(fullPath, JSON.stringify(conf, null, 2));
            console.log(`Updated ${relPath} to ${newVersion}`);
        } catch (e) {
            console.error(`Error updating ${relPath}:`, e);
        }
    } else {
        console.warn(`Warning: ${relPath} not found`);
    }
});

// 4. Update src-tauri/app-main/tauri.linux.conf.json if exists
const linuxConfPath = path.join(rootDir, 'src-tauri/app-main/tauri.linux.conf.json');
if (fs.existsSync(linuxConfPath)) {
     try {
        const conf = JSON.parse(fs.readFileSync(linuxConfPath, 'utf8'));
        if (conf.version) {
            conf.version = newVersion;
            fs.writeFileSync(linuxConfPath, JSON.stringify(conf, null, 2));
            console.log(`Updated src-tauri/app-main/tauri.linux.conf.json to ${newVersion}`);
        }
    } catch (e) {
        console.error(`Error updating ${linuxConfPath}:`, e);
    }
}

console.log(`\nVersion set to ${newVersion} successfully!`);