import type { ReactNode } from 'react';

type Block =
  | { type: 'paragraph' | 'heading'; text: string; level?: number }
  | { type: 'ul' | 'ol'; items: string[] }
  | { type: 'hr' }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string; language?: string };

const INLINE_TOKEN = /(\*\*.+?\*\*|__.+?__|~~.+?~~|`[^`\n]+`|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|\*[^*\n]+\*|_[^_\n]+_)/g;
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const UL_ITEM = /^ {0,3}[-+*]\s+(.+)$/;
const OL_ITEM = /^ {0,3}\d+[.)]\s+(.+)$/;
const HR = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w-]*)\s*$/;

function safeHref(raw: string): string | null {
  const href = raw.trim().replace(/^<|>$/g, '');
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
}

function inline(markdown: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  for (const match of markdown.matchAll(INLINE_TOKEN)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(markdown.slice(cursor, start));
    let node: ReactNode;
    if (token.startsWith('**') || token.startsWith('__')) {
      node = <strong className="font-semibold">{inline(token.slice(2, -2))}</strong>;
    } else if (token.startsWith('~~')) {
      node = <del>{inline(token.slice(2, -2))}</del>;
    } else if (token.startsWith('`')) {
      node = <code className="rounded px-1 py-0.5 text-[0.92em]" style={{ background: 'var(--panel-border)' }}>{token.slice(1, -1)}</code>;
    } else if (token.startsWith('![')) {
      const image = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      node = image ? image[1] : token;
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\((\S+?)(?:\s+["'][^)]*["'])?\)$/);
      const href = link ? safeHref(link[2]) : null;
      node = link && href
        ? <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2" style={{ color: 'var(--accent)' }}>{inline(link[1])}</a>
        : link ? inline(link[1]) : token;
    } else {
      node = <em>{inline(token.slice(1, -1))}</em>;
    }
    nodes.push(<span key={`inline-${index++}`}>{node}</span>);
    cursor = start + token.length;
  }

  if (cursor < markdown.length) nodes.push(markdown.slice(cursor));
  return nodes;
}

function isBlockStart(line: string): boolean {
  return Boolean(
    HEADING.test(line) || UL_ITEM.test(line) || OL_ITEM.test(line) || HR.test(line)
    || /^ {0,3}>/.test(line) || FENCE.test(line)
  );
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1][0];
      const codeLines: string[] = [];
      const minLength = fence[1].length;
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${minLength},}\\s*$`).test(lines[i])) {
        codeLines.push(lines[i++]);
      }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', text: codeLines.join('\n'), language: fence[2] });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i++; continue;
    }
    if (HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    if (/^ {0,3}>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        quote.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      }
      blocks.push({ type: 'quote', text: quote.join('\n') });
      continue;
    }

    const unordered = line.match(UL_ITEM);
    const ordered = line.match(OL_ITEM);
    if (unordered || ordered) {
      const type = unordered ? 'ul' : 'ol';
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i].match(type === 'ul' ? UL_ITEM : OL_ITEM);
        if (current) {
          items.push(current[1]);
          i++;
          while (i < lines.length && /^ {2,}\S/.test(lines[i]) && !UL_ITEM.test(lines[i]) && !OL_ITEM.test(lines[i])) {
            items[items.length - 1] += ` ${lines[i].trim()}`;
            i++;
          }
          continue;
        }
        if (!lines[i].trim()) break;
        break;
      }
      blocks.push({ type, items });
      continue;
    }

    const paragraph = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      paragraph.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks;
}

function renderBlocks(markdown: string): ReactNode[] {
  return parseBlocks(markdown).map((block, index) => {
    const key = `block-${index}`;
    if (block.type === 'hr') {
      return <hr key={key} className="my-4" style={{ borderColor: 'var(--panel-border)' }} />;
    }
    if (block.type === 'heading') {
      const content = inline(block.text);
      const className = 'font-semibold leading-snug mt-4 mb-2 first:mt-0';
      switch (block.level) {
        case 1: return <h2 key={key} className={`${className} text-lg`}>{content}</h2>;
        case 2: return <h3 key={key} className={`${className} text-base`}>{content}</h3>;
        case 3: return <h4 key={key} className={`${className} text-sm`}>{content}</h4>;
        default: return <h5 key={key} className={`${className} text-sm`}>{content}</h5>;
      }
    }
    if (block.type === 'ul' || block.type === 'ol') {
      const Tag = block.type;
      return (
        <Tag key={key} className={`${block.type === 'ul' ? 'list-disc' : 'list-decimal'} pl-5 my-3 space-y-1.5`}>
          {block.items.map((item, itemIndex) => <li key={itemIndex} className="pl-0.5">{inline(item)}</li>)}
        </Tag>
      );
    }
    if (block.type === 'quote') {
      return (
        <blockquote key={key} className="my-3 border-l-2 pl-3 opacity-90" style={{ borderColor: 'var(--accent)' }}>
          {renderBlocks(block.text)}
        </blockquote>
      );
    }
    if (block.type === 'code') {
      return (
        <pre key={key} className="my-3 overflow-x-auto rounded-lg p-3 text-xs" style={{ background: 'var(--panel-border)' }}>
          <code>{block.text}</code>
        </pre>
      );
    }
    return <p key={key} className="my-2 first:mt-0 last:mb-0">{inline(block.text)}</p>;
  });
}

/**
 * Render the common Markdown emitted by summary models without injecting HTML.
 * Raw HTML is treated as text, links are limited to http(s)/mailto, and unsafe
 * URL schemes such as javascript: are never made clickable.
 */
export default function MarkdownSummary({ markdown }: { markdown: string }) {
  return <div className="text-sm leading-relaxed">{renderBlocks(markdown)}</div>;
}
