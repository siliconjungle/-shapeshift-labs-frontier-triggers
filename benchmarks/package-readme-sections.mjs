import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoScript = path.resolve(here, '..', '..', '..', 'benchmarks', 'package-readme-sections.js');
const args = process.argv.slice(2);
const useFamilyCheck = args.includes('--family') || process.env.FRONTIER_PACKAGE_README_FAMILY_CHECK === '1';

if (useFamilyCheck && fs.existsSync(monorepoScript)) {
  await import(pathToFileURL(monorepoScript).href);
} else {
  const rootDir = path.resolve(here, '..');
  const check = args.includes('--check');
  const readmePath = path.join(rootDir, 'README.md');
  const text = fs.readFileSync(readmePath, 'utf8');
  if (!text.includes('## Related Packages\n') || !text.includes('\n## Install\n')) {
    throw new Error('README.md is missing generated package-family headings');
  }
  if (!text.includes('## App And Game Use\n') || !text.includes('result.records')) {
    throw new Error('README.md is missing trigger cascade usage notes');
  }
  if (check) process.exit(0);
  console.log('frontier-triggers README package sections are present');
}
