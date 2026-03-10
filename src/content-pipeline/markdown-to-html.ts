import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

export interface MarkdownToHtmlInput {
  markdown: string;
}

export interface MarkdownToHtmlResult {
  html: string;
}

export async function markdownToHtml(input: MarkdownToHtmlInput): Promise<MarkdownToHtmlResult> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeStringify)
    .process(input.markdown);

  return {
    html: String(file)
  };
}
