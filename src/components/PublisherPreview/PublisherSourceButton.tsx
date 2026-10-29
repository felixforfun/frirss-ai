import { usePreviewStore } from '../../stores/previewStore';
import type { Article } from '../../types';

interface PublisherSourceButtonProps {
  article: Article;
  className: string;
  style: React.CSSProperties;
  children: React.ReactNode;
}

/**
 * Clickable publisher name — same visuals as the previous static source
 * label (`data-theme="list-source"`, same classes, same styles), but a
 * dedicated button: the press never reaches the row that carries it.
 *
 * Propagation is cut on `pointerdown` BEFORE `click`: long-press and row
 * swipe listen to pointers on the whole row, and a press that lingers on
 * the label must not open the article.
 */
export function PublisherSourceButton({ article, className, style, children }: PublisherSourceButtonProps) {
  const openPublisher = usePreviewStore((s) => s.openPublisher);
  return (
    <button
      type="button"
      className={`${className} cursor-pointer hover:opacity-80 transition-opacity`}
      data-theme="list-source"
      style={style}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); void openPublisher(article); }}
      onAuxClick={(e) => { e.preventDefault(); e.stopPropagation(); void openPublisher(article); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); void openPublisher(article); } }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      title={undefined}
    >
      {children}
    </button>
  );
}

export default PublisherSourceButton;
