import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const outputDirectory = path.join(repositoryRoot, '_site');
const sourceDirectory = path.join(repositoryRoot, 'site');
const guidePath = path.join(
  repositoryRoot,
  'bring-your-own/virtual-agent/web-socket-interface/README.md',
);

if (path.basename(outputDirectory) !== '_site') {
  throw new Error(`Refusing to clean unexpected output directory: ${outputDirectory}`);
}

const [markdown, template] = await Promise.all([
  readFile(guidePath, 'utf8'),
  readFile(path.join(sourceDirectory, 'template.html'), 'utf8'),
]);

const titleMatch = markdown.match(/^#\s+(.+)$/m);
if (!titleMatch) {
  throw new Error('The BYOVA guide must begin with an H1 title.');
}

const title = titleMatch[1].trim();
const markdownWithoutTitle = markdown.replace(/^#\s+.+\r?\n+/, '');
const leadBoundary = markdownWithoutTitle.search(/\r?\n\r?\n/);
const leadMarkdown = leadBoundary >= 0
  ? markdownWithoutTitle.slice(0, leadBoundary)
  : markdownWithoutTitle;
const bodyMarkdown = leadBoundary >= 0
  ? markdownWithoutTitle.slice(leadBoundary).trimStart()
  : '';

marked.setOptions({
  gfm: true,
  breaks: false,
});

const leadHtml = marked.parse(leadMarkdown);
let articleHtml = marked.parse(bodyMarkdown);
const headings = [];
const usedSlugs = new Map();

function decodeHeading(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function slugify(value) {
  const base = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  const count = usedSlugs.get(base) ?? 0;
  usedSlugs.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

articleHtml = articleHtml.replace(
  /<h([23])>([\s\S]*?)<\/h\1>/g,
  (_match, depthValue, innerHtml) => {
    const depth = Number(depthValue);
    const label = decodeHeading(innerHtml);
    const slug = slugify(label);
    headings.push({ depth, label, slug });
    return `<h${depth} id="${slug}">${innerHtml}<a class="heading-anchor" href="#${slug}" aria-label="Link to ${escapeHtml(label)}">#</a></h${depth}>`;
  },
);

articleHtml = articleHtml
  .replace(/<table>/g, '<div class="table-scroll" role="region" aria-label="Scrollable documentation table" tabindex="0"><table>')
  .replace(/<\/table>/g, '</table></div>');

const tableOfContents = headings
  .map(({ depth, label, slug }) => (
    `<li class="toc-depth-${depth}"><a class="toc-link" href="#${slug}">${escapeHtml(label)}</a></li>`
  ))
  .join('\n');

const renderedPage = template
  .replaceAll('{{TITLE}}', escapeHtml(title))
  .replace('{{LEAD}}', leadHtml)
  .replace('{{TABLE_OF_CONTENTS}}', tableOfContents)
  .replace('{{ARTICLE}}', articleHtml);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(path.join(outputDirectory, 'assets'), { recursive: true });
await Promise.all([
  writeFile(path.join(outputDirectory, 'index.html'), renderedPage),
  cp(path.join(sourceDirectory, 'styles.css'), path.join(outputDirectory, 'assets/styles.css')),
  cp(path.join(sourceDirectory, 'site.js'), path.join(outputDirectory, 'assets/site.js')),
  cp(path.join(sourceDirectory, 'favicon.svg'), path.join(outputDirectory, 'assets/favicon.svg')),
  writeFile(path.join(outputDirectory, 'robots.txt'), 'User-agent: *\nAllow: /\n'),
  writeFile(
    path.join(outputDirectory, '404.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found · BYOVA over WebSocket</title><link rel="icon" href="./assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="./assets/styles.css"></head><body><main class="not-found"><p class="brand-line">Webex Contact Center provider guides</p><h1>Page not found</h1><p>The guide may have moved, or the address may be incomplete.</p><a class="button button-primary" href="./">Return to the BYOVA guide</a></main></body></html>`,
  ),
]);

console.log(`Built ${path.relative(repositoryRoot, outputDirectory)}/index.html from ${path.relative(repositoryRoot, guidePath)}`);
console.log(`Included ${headings.filter(({ depth }) => depth === 2).length} sections and ${headings.length} navigable headings.`);
