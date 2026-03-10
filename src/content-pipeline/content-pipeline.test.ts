import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml } from './markdown-to-html.js';
import { sanitizeHtml } from './sanitize-html.js';
import { rewriteImages } from './image-rewriter.js';
import { runContentPipeline } from './index.js';

test('markdownToHtml converts markdown into html blocks', async () => {
  const result = await markdownToHtml({
    markdown: '# Title\n\n- one\n- two\n\n`code`'
  });

  assert.match(result.html, /<h1>Title<\/h1>/);
  assert.match(result.html, /<ul>/);
  assert.match(result.html, /<li>one<\/li>/);
  assert.match(result.html, /<code>code<\/code>/);
});

test('sanitizeHtml removes dangerous tags and attributes', async () => {
  const result = await sanitizeHtml({
    html: '<p onclick="alert(1)">ok</p><script>alert(1)</script><img src="javascript:alert(1)" onerror="boom" />'
  });

  assert.doesNotMatch(result.html, /<script/i);
  assert.doesNotMatch(result.html, /onclick=/i);
  assert.doesNotMatch(result.html, /onerror=/i);
  assert.doesNotMatch(result.html, /javascript:/i);
});

test('rewriteImages keeps absolute HTTPS image URLs', async () => {
  const result = await rewriteImages('<p>safe</p><img src="https://example.com/a.png" alt="a" />');

  assert.equal(result.replaced_count, 0);
  assert.deepEqual(result.failed_images, []);
  assert.match(result.html, /<img[^>]*src="https:\/\/example\.com\/a\.png"/);
});

test('runContentPipeline blocks illegal image URLs and reports failures', async () => {
  const result = await runContentPipeline({
    content_format: 'html',
    content: '<img src="./foo.png" /><img src="data:image/png;base64,AAAA" /><img src="http://example.com/a.png" />'
  });

  assert.equal(result.replaced_count, 3);
  assert.equal(result.failed_images.length, 3);
  assert.ok(result.failed_images.some((item) => item.source === './foo.png'));
  assert.ok(result.failed_images.some((item) => item.source.startsWith('data:image/png;base64')));
  assert.ok(result.failed_images.some((item) => item.source === 'http://example.com/a.png'));
  assert.doesNotMatch(result.content_html, /<img/i);
});
