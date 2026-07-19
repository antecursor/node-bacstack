'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const docsRoot = path.resolve(__dirname, '..', 'docs');
const htmlFiles = [];
const markdownFiles = [];

function collect(directory) {
  fs.readdirSync(directory, {withFileTypes: true}).forEach((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(target);
    else if (entry.isFile() && entry.name.endsWith('.html')) htmlFiles.push(target);
    else if (entry.isFile() && entry.name.endsWith('.md')) markdownFiles.push(target);
  });
}

function localTarget(source, href) {
  if (!href || href[0] === '#' || href.startsWith('/') ||
      /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const withoutFragment = href.split('#', 1)[0].split('?', 1)[0];
  if (!withoutFragment) return null;
  try {
    return path.resolve(path.dirname(source), decodeURIComponent(withoutFragment));
  } catch (err) {
    return {decodeError: err};
  }
}

assert(fs.existsSync(docsRoot), 'generated docs directory is missing');
collect(docsRoot);
assert(htmlFiles.length > 0, 'generated docs contain no HTML files');

const missing = [];
htmlFiles.forEach((source) => {
  const html = fs.readFileSync(source, 'utf8');
  const links = html.matchAll(/(?:href|src)=["']([^"']+)["']/gi);
  for (const match of links) {
    const target = localTarget(source, match[1]);
    if (target && (target.decodeError || !fs.existsSync(target))) {
      missing.push(path.relative(docsRoot, source) + ' -> ' + match[1]);
    }
  }
});

markdownFiles.forEach((source) => {
  const markdown = fs.readFileSync(source, 'utf8');
  const links = markdown.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g);
  for (const match of links) {
    const target = localTarget(source, match[1]);
    if (target && (target.decodeError || !fs.existsSync(target))) {
      missing.push(path.relative(docsRoot, source) + ' -> ' + match[1]);
    }
  }
});

assert.deepStrictEqual(missing, [], 'generated docs contain broken local links');
process.stdout.write(JSON.stringify({
  htmlFiles: htmlFiles.length,
  markdownFiles: markdownFiles.length,
  localLinks: 'ok'
}) + '\n');
