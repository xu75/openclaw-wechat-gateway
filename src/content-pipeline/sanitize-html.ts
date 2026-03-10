import rehypeParse from 'rehype-parse';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';
import type { Schema } from 'hast-util-sanitize';

export interface SanitizeHtmlInput {
  html: string;
}

export interface SanitizeHtmlResult {
  html: string;
}

const sanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'img',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td'
  ],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    a: [...(defaultSchema.attributes?.a ?? []), 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading']
  },
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    href: ['http', 'https', 'mailto'],
    // Keep candidate image URLs for policy checks in the rewrite stage.
    src: ['https', 'http', 'data']
  }
};

export async function sanitizeHtml(input: SanitizeHtmlInput): Promise<SanitizeHtmlResult> {
  const file = await unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeStringify)
    .process(input.html);

  return { html: String(file) };
}
