import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownMessage from './MarkdownMessage.js';

test('lazy markdown renderer preserves headings, emphasis, and fenced code', () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownMessage, { content: '# Hello\n\n**safe** text\n\n```js\nconst x = 1;\n```' }));
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.match(html, /<strong>safe<\/strong>/);
  assert.match(html, /language-js/);
  assert.match(html.replace(/<[^>]*>/g, ''), /const x = 1;/);
});
