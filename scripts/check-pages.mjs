import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const outputDirectory = path.join(repositoryRoot, '_site');
const indexPath = path.join(outputDirectory, 'index.html');

await Promise.all([
  access(indexPath),
  access(path.join(outputDirectory, '404.html')),
  access(path.join(outputDirectory, 'assets/styles.css')),
  access(path.join(outputDirectory, 'assets/site.js')),
  access(path.join(outputDirectory, 'assets/favicon.svg')),
]);

const html = await readFile(indexPath, 'utf8');
const failures = [];

for (const requiredText of [
  'Build a BYOVA connector over WebSocket',
  'a38a10b7-43e4-4676-a076-a7d6dce9387d',
  'id="create-the-service-app"',
  'id="implement-v1va-connection-and-envelope-lifecycle"',
  'id="prepare-for-production"',
  'class="toc-link"',
]) {
  if (!html.includes(requiredText)) {
    failures.push(`Missing expected output: ${requiredText}`);
  }
}

const localAssetReferences = [...html.matchAll(/(?:href|src)="(\.\/assets\/[^"#?]+)"/g)]
  .map((match) => match[1]);

for (const reference of new Set(localAssetReferences)) {
  await access(path.join(outputDirectory, reference.replace(/^\.\//, ''))).catch(() => {
    failures.push(`Missing local asset: ${reference}`);
  });
}

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicateIds.length > 0) {
  failures.push(`Duplicate IDs: ${[...new Set(duplicateIds)].join(', ')}`);
}

const fragmentLinks = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
for (const fragment of new Set(fragmentLinks)) {
  if (!ids.includes(fragment)) {
    failures.push(`Broken fragment link: #${fragment}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Pages output check passed: ${ids.length} unique IDs, ${fragmentLinks.length} fragment links, ${localAssetReferences.length} local asset references.`);
