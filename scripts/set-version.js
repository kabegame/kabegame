/**
 * scripts/set-version.js
 * 
 * 用于统一管理项目版本号。
 * 
 * 用法:
 *   1. 设置新版本并同步: bun set-version 3.0.1
 *   2. 从 Cargo.toml 同步: bun set-version (需先手动修改 Cargo.toml)
 */

const fs = require('fs');
const path = require('path');

let newVersion = process.argv[2];
const rootDir = path.resolve(__dirname, '..');

// 1. 读取/更新 Cargo.toml (Workspace Root)
const cargoTomlPath = path.join(rootDir, 'Cargo.toml');
if (!fs.existsSync(cargoTomlPath)) {
    console.error('Error: Cargo.toml not found');
    process.exit(1);
}

let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
const workspacePackageRegex = /(\[workspace\.package\][^\[]*?version\s*=\s*")([^"]+)(")/s;

if (!newVersion) {
    // Mode: Sync from Cargo.toml
    const match = cargoToml.match(workspacePackageRegex);
    if (match) {
        newVersion = match[2];
        console.log(`Syncing version ${newVersion} from Cargo.toml...`);
    } else {
        console.error('Error: Could not find version in Cargo.toml and no argument provided.');
        process.exit(1);
    }
} else {
    // Mode: Set version
    if (!/^\d+\.\d+\.\d+/.test(newVersion)) {
        console.error('Error: Version must be in format x.y.z');
        process.exit(1);
    }

    if (workspacePackageRegex.test(cargoToml)) {
        cargoToml = cargoToml.replace(workspacePackageRegex, `$1${newVersion}$3`);
        fs.writeFileSync(cargoTomlPath, cargoToml);
        console.log(`Updated Cargo.toml to ${newVersion}`);
    } else {
        console.error('Error: Could not find [workspace.package] version in Cargo.toml');
    }
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

console.log(`\nVersion synced to ${newVersion} successfully!`);