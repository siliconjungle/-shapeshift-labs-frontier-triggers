import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoScript = path.resolve(here, '..', '..', '..', 'benchmarks', 'package-readme-sections.js');

if (fs.existsSync(monorepoScript)) {
  await import(pathToFileURL(monorepoScript).href);
} else {
  const rootDir = path.resolve(here, '..');
  const check = process.argv.slice(2).includes('--check');
  const readmePath = path.join(rootDir, 'README.md');
  const text = fs.readFileSync(readmePath, 'utf8');
  if (!text.includes('## Related Packages\n') || !text.includes('\n## Install\n')) {
    throw new Error('README.md is missing generated package-family headings');
  }
  if (check) process.exit(0);
}
