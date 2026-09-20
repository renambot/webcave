#!/usr/bin/env node
/**
 * Build the GitHub wiki from the repository's documentation.
 *
 *   node scripts/build-wiki.mjs [outDir=.wiki]
 *
 * README.md becomes Home.md; every docs/*.md becomes a page named after the
 * file (running.md -> Running.md, SPECIFICATION.md -> Specification.md);
 * docs/images/ is copied so pictures keep working. Links are rewritten for
 * the wiki: links between pages point at page names, links into the source
 * tree point at the file on GitHub, and image paths drop the docs/ prefix.
 * A _Sidebar.md lists the pages. The workflow in .github/workflows/wiki.yml
 * runs this and pushes the result to the wiki repository.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, process.argv[2] ?? ".wiki");
const repo = process.env.GITHUB_REPOSITORY ?? "renambot/webcave";
const blob = `https://github.com/${repo}/blob/main/`;

/** docs file name -> wiki page name. */
const pageName = (file) => {
  const base = basename(file, ".md");
  return base === "SPECIFICATION" ? "Specification" : base[0].toUpperCase() + base.slice(1).toLowerCase();
};
const docs = readdirSync(resolve(root, "docs")).filter((f) => f.endsWith(".md"));
const pages = new Map(docs.map((f) => [f, pageName(f)]));

/** Rewrite a markdown link target for a page living in `where` ("root" for README, "docs" for docs pages). */
function rewrite(target, where) {
  if (/^(https?:|mailto:|#)/.test(target)) return target;
  const [path, hash = ""] = target.split("#");
  const anchor = hash ? `#${hash}` : "";
  const clean = path.replace(/^\.\//, "");
  if (where === "root") {
    if (clean === "README.md") return `Home${anchor}`;
    const m = clean.match(/^docs\/(.+\.md)$/);
    if (m && pages.has(m[1])) return `${pages.get(m[1])}${anchor}`;
    if (clean.startsWith("docs/images/")) return clean.replace(/^docs\//, "");
    return `${blob}${clean}${anchor}`;
  }
  if (clean === "../README.md") return `Home${anchor}`;
  if (pages.has(clean)) return `${pages.get(clean)}${anchor}`;
  if (clean.startsWith("images/")) return clean;
  if (clean.startsWith("../")) return `${blob}${clean.replace(/^\.\.\//, "")}${anchor}`;
  return `${blob}docs/${clean}${anchor}`;
}

function convert(markdown, where) {
  return markdown.replace(/(!?\[[^\]]*\]\()([^)\s]+)(\))/g, (_, pre, target, post) => `${pre}${rewrite(target, where)}${post}`).replace(/<(https?:\/\/[^>]+)>/g, "<$1>");
}

rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, "images"), { recursive: true });

const readme = readFileSync(resolve(root, "README.md"), "utf8");
writeFileSync(resolve(out, "Home.md"), convert(readme, "root"));
for (const f of docs) writeFileSync(resolve(out, `${pages.get(f)}.md`), convert(readFileSync(resolve(root, "docs", f), "utf8"), "docs"));
if (existsSync(resolve(root, "docs/images"))) {
  for (const img of readdirSync(resolve(root, "docs/images"))) copyFileSync(resolve(root, "docs/images", img), resolve(out, "images", img));
}

// Sidebar: Home first, then the pages in reading order, the specification last.
const order = ["running", "deployment", "configuration", "input", "tracking", "applications", "development", "SPECIFICATION"];
const listed = [...order.filter((n) => pages.has(`${n}.md`)).map((n) => `${n}.md`), ...docs.filter((f) => !order.includes(basename(f, ".md")))];
const sidebar = ["**WebCAVE**", "", "- [Home](Home)", ...listed.map((f) => `- [${pages.get(f)}](${pages.get(f)})`), "", `[Repository](https://github.com/${repo})`].join("\n");
writeFileSync(resolve(out, "_Sidebar.md"), sidebar + "\n");
writeFileSync(resolve(out, "_Footer.md"), `Generated from the repository's docs/ folder by scripts/build-wiki.mjs. Edit the files in the repository, not here.\n`);

console.log(`wiki: ${1 + docs.length} pages -> ${out}`);
for (const f of docs) console.log(`  ${f.padEnd(18)} -> ${pages.get(f)}.md`);
