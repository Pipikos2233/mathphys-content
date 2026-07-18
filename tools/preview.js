#!/usr/bin/env node
// Рендерит lesson.md в самодостаточный HTML с KaTeX — предпросмотр того,
// что покажет WebView в приложении. Запуск: npm run preview [id-темы]
const fs = require('fs');
const path = require('path');
const katex = require('katex');
const MarkdownIt = require('markdown-it');

const ROOT = path.join(__dirname, '..');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8'));

const topicId = process.argv[2];
const topics = index.sections.flatMap((s) => s.topics);
const topic = topicId ? topics.find((t) => t.id === topicId) : topics[0];
if (!topic) {
  console.error(`Тема "${topicId}" не найдена. Есть: ${topics.map((t) => t.id).join(', ')}`);
  process.exit(1);
}

let src = fs.readFileSync(path.join(ROOT, topic.lesson), 'utf8');

// Формулы рендерим ДО markdown, чтобы markdown-it не съел спецсимволы LaTeX
src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, f) =>
  katex.renderToString(f, { displayMode: true, throwOnError: true })
);
src = src.replace(/\$([^$\n]+?)\$/g, (_, f) =>
  katex.renderToString(f, { displayMode: false, throwOnError: true })
);

const md = new MarkdownIt({ html: true });
const katexCss = fs.readFileSync(require.resolve('katex/dist/katex.min.css'), 'utf8');

const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${topic.title}</title>
<style>${katexCss}</style>
<style>
  body { font-family: Georgia, serif; max-width: 720px; margin: 0 auto; padding: 16px; line-height: 1.6; }
  h1, h2 { font-family: system-ui, sans-serif; }
  .katex-display { overflow-x: auto; padding: 4px 0; }
</style>
</head><body>${md.render(src)}</body></html>`;

const out = path.join(ROOT, 'preview.html');
fs.writeFileSync(out, html);
console.log(`Готово: ${out} (${topic.title}). Откройте в браузере.`);
