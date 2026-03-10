import { markdownToHtml } from './markdown-to-html.js';
import { sanitizeHtml } from './sanitize-html.js';
import { rewriteImages } from './image-rewriter.js';

export interface ContentPipelineInput {
  content: string;
  content_format: 'markdown' | 'html';
}

export interface ContentPipelineResult {
  content_html: string;
  replaced_count: number;
  failed_images: Array<{ source: string; reason: string }>;
}

export async function runContentPipeline(input: ContentPipelineInput): Promise<ContentPipelineResult> {
  const html = input.content_format === 'markdown' ? (await markdownToHtml({ markdown: input.content })).html : input.content;
  const sanitized = await sanitizeHtml({ html });
  const rewritten = await rewriteImages(sanitized.html);

  return {
    content_html: rewritten.html,
    replaced_count: rewritten.replaced_count,
    failed_images: rewritten.failed_images
  };
}
