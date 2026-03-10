import type { Element, Root } from 'hast';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';
import { SKIP, visit } from 'unist-util-visit';
import { validateImageUrl } from './validators.js';

export interface ImageRewriteIssue {
  source: string;
  reason: string;
}

export interface ImageRewriteResult {
  html: string;
  replaced_count: number;
  failed_images: ImageRewriteIssue[];
}

function getImageSource(node: Element): string {
  const rawSrc = node.properties.src;
  if (typeof rawSrc === 'string') {
    return rawSrc.trim();
  }

  if (Array.isArray(rawSrc) && typeof rawSrc[0] === 'string') {
    return rawSrc[0].trim();
  }

  return '';
}

export async function rewriteImages(html: string): Promise<ImageRewriteResult> {
  const failed_images: ImageRewriteIssue[] = [];
  let replaced_count = 0;

  const file = await unified()
    .use(rehypeParse, { fragment: true })
    .use(() => {
      return (tree: Root): void => {
        visit(tree, 'element', (node, index, parent) => {
          if (node.tagName !== 'img' || !parent || typeof index !== 'number') {
            return;
          }

          const source = getImageSource(node);
          const validation = validateImageUrl(source);
          if (validation.ok) {
            node.properties.src = validation.normalized_url;
            return;
          }

          failed_images.push({
            source,
            reason: validation.reason ?? 'image URL is invalid'
          });
          parent.children.splice(index, 1);
          replaced_count += 1;
          return [SKIP, index];
        });
      };
    })
    .use(rehypeStringify)
    .process(html);

  return {
    html: String(file),
    replaced_count,
    failed_images
  };
}
