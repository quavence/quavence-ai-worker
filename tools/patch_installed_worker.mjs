import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const targetAsar = 'C:\\Users\\Admin\\AppData\\Local\\Programs\\Quavence AI Worker\\resources\\app.asar';
const tempDir = path.resolve('./temp_asar');
const tempAsar = path.resolve('./app_patched.asar');

if (!fs.existsSync(targetAsar)) {
  console.error('Target asar not found at:', targetAsar);
  process.exit(1);
}

if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
fs.mkdirSync(tempDir, { recursive: true });

console.log('Extracting asar...');
execSync(`npx asar extract "${targetAsar}" "${tempDir}"`, { stdio: 'inherit' });

console.log('Copying fixed src/main.cjs...');
fs.copyFileSync(path.resolve('./src/main.cjs'), path.join(tempDir, 'src', 'main.cjs'));

console.log('Repacking asar...');
if (fs.existsSync(tempAsar)) fs.unlinkSync(tempAsar);
execSync(`npx asar pack "${tempDir}" "${tempAsar}"`, { stdio: 'inherit' });

const backupAsar = targetAsar + '.bak';
console.log('Backing up target asar to:', backupAsar);
fs.copyFileSync(targetAsar, backupAsar);

console.log('Overwriting target asar with patched bundle...');
fs.copyFileSync(tempAsar, targetAsar);

console.log('Cleaning up temporary files...');
fs.unlinkSync(tempAsar);
fs.rmSync(tempDir, { recursive: true, force: true });

console.log('🎉 SUCCESS: Installed Quavence AI Worker app.asar has been patched!');
