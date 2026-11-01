import { useTranslation } from 'react-i18next';
import type { SyntheticEvent } from 'react';
import type { Article } from '../types';
import { hackerNewsDiscussionUrl } from '../lib/hackerNews';

interface HackerNewsDiscussionLinkProps {
  article: Article;
  className: string;
  style?: React.CSSProperties;
}

/**
 * Lien de discussion Hacker News, rendu SOUS le titre d'un article du flux HN
 * — jamais pour un autre flux, et jamais sans identifiant fiable : un lien
 * absent vaut mieux qu'un lien faux. Le libellé reste statique, aucun appel
 * réseau supplémentaire.
 *
 * La propagation est coupée sur pointer/touch/click, à l'image de
 * `PublisherSourceButton` : le lien vit dans des rangées et cartes portées
 * par `onClick` (ouvrir l'article) — une impulsion dessus ne doit JAMAIS
 * ouvrir l'article ni déclencher menu d'appui long ou glisser de rangée.
 */
export function HackerNewsDiscussionLink({ article, className, style }: HackerNewsDiscussionLinkProps) {
  const { t } = useTranslation();
  const discussionUrl = hackerNewsDiscussionUrl(article);
  if (!discussionUrl) return null;
  const stop = (event: SyntheticEvent) => { event.stopPropagation(); };
  return (
    <a
      href={discussionUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`${className} hover:underline`}
      style={style}
      onClick={stop}
      onAuxClick={stop}
      onPointerDown={stop}
      onPointerUp={stop}
      onPointerMove={stop}
      onTouchStart={stop}
      onTouchEnd={stop}
    >
      {/* L'identifiant officiel : https://news.ycombinator.com/item?id=<id> */}
      <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        {/* Heroicons « chat-bubble-oval-left-ellipsis » — même famille que les autres glyphes de l'app */}
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 9.75a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
      </svg>
      <span>{t('hackerNews.viewComments')}</span>
      {/* Indicateur de lien externe — même glyphe que « ouvrir à la source ». */}
      <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
      </svg>
    </a>
  );
}

export default HackerNewsDiscussionLink;
