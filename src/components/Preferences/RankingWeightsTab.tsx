import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useUiStore } from '../../stores/uiStore';
import { useDiscoveryCoverageStore } from '../../stores/discoveryCoverageStore';
import {
  DEFAULT_CUSTOM_INTERESTING_WEIGHTS, EXTERNAL_SOURCE_ORDER, REGISTERED_EXTERNAL_SOURCES,
  type ExternalSignalSource,
} from '../../lib/intelligenceRanking';

const SOURCE_LABELS: Record<ExternalSignalSource, string> = {
  consensus: 'Publisher consensus',
  googleTrends: 'Google Trends',
  wikipedia: 'Wikipedia',
  github: 'GitHub',
  hackerNews: 'Hacker News',
  lobsters: 'Lobsters',
  gdelt: 'GDELT',
};

export default function RankingWeightsTab() {
  const { t } = useTranslation();
  const weights = useUiStore((s) => s.interestingRankingWeights);
  const setWeights = useUiStore((s) => s.setInterestingRankingWeights);
  const coverage = useDiscoveryCoverageStore(useShallow((s) => ({ measured: s.measured, candidates: s.candidates })));
  const fieldClass = 'w-20 rounded-lg px-2 py-1.5 text-sm text-right outline-none';
  const fieldStyle = { background: 'var(--panel-header-bg)', color: 'var(--list-title)', border: '1px solid var(--panel-border)' };

  function updateSource(source: ExternalSignalSource, value: number) {
    setWeights({ ...weights, sources: { ...weights.sources, [source]: Math.max(0, Math.min(100, Math.round(value))) } });
  }

  return (
    <div className="p-4 sm:p-5 space-y-6">
      <div>
        <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--list-title)' }}>
          {t('preferences.rankingWeights.title', 'Interesting ranking weights')}
        </h3>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--list-summary)' }}>
          {t('preferences.rankingWeights.intro', 'Tune how much external attention influences the Interesting view. These settings apply when the Custom algorithm is selected. Existing ranking presets are unchanged.')}
        </p>
      </div>

      <section className="rounded-xl p-4 space-y-3" style={{ border: '1px solid var(--panel-border)' }}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <label htmlFor="ranking-external-influence" className="text-sm font-medium" style={{ color: 'var(--list-title)' }}>
              {t('preferences.rankingWeights.discoveryInfluence', 'Discovery influence')}
            </label>
            <p className="text-xs mt-1" style={{ color: 'var(--list-summary)' }}>
              {t('preferences.rankingWeights.discoveryInfluenceHelp', 'The share of the final ranking score driven by discovery evidence. Absent evidence is neutral: an article never drops because a provider was unreachable.')}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <input id="ranking-external-influence-number" type="number" min={0} max={100} step={5} value={weights.externalInfluence}
              onChange={(e) => setWeights({ ...weights, externalInfluence: Number(e.target.value) })}
              aria-label={t('preferences.rankingWeights.discoveryInfluence', 'Discovery influence')}
              className={fieldClass} style={fieldStyle} />
            <span className="text-sm" style={{ color: 'var(--list-summary)' }}>%</span>
          </div>
        </div>
        <input id="ranking-external-influence" type="range" min={0} max={100} step={5} value={weights.externalInfluence}
          onChange={(e) => setWeights({ ...weights, externalInfluence: Number(e.target.value) })}
          aria-label={t('preferences.rankingWeights.discoveryInfluence', 'Discovery influence')}
          className="w-full accent-[var(--accent)]" />
        <div className="flex justify-between text-xs" style={{ color: 'var(--list-summary)' }}>
          <span>{t('preferences.rankingWeights.discoveryZero', '0% · Personal relevance only')}</span>
          <span>{t('preferences.rankingWeights.discoveryFull', '100% · Discovery only')}</span>
        </div>
      </section>

      <section className="rounded-xl p-4 space-y-3" style={{ border: '1px solid var(--panel-border)' }}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <label htmlFor="ranking-semantic-influence" className="text-sm font-medium" style={{ color: 'var(--list-title)' }}>
              {t('preferences.rankingWeights.semanticInfluence', 'Semantic influence')}
            </label>
            <p className="text-xs mt-1" style={{ color: 'var(--list-summary)' }}>
              {t('preferences.rankingWeights.semanticInfluenceHelp', 'The share of the final ranking score driven by semantic similarity to your votes. 0% keeps the ranking exactly as it is.')}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <input id="ranking-semantic-influence-number" type="number" min={0} max={100} step={5} value={weights.semanticInfluence}
              onChange={(e) => setWeights({ ...weights, semanticInfluence: Number(e.target.value) })}
              aria-label={t('preferences.rankingWeights.semanticInfluence', 'Semantic influence')}
              className={fieldClass} style={fieldStyle} />
            <span className="text-sm" style={{ color: 'var(--list-summary)' }}>%</span>
          </div>
        </div>
        <input id="ranking-semantic-influence" type="range" min={0} max={100} step={5} value={weights.semanticInfluence}
          onChange={(e) => setWeights({ ...weights, semanticInfluence: Number(e.target.value) })}
          aria-label={t('preferences.rankingWeights.semanticInfluence', 'Semantic influence')}
          className="w-full accent-[var(--accent)]" />
        <div className="flex justify-between text-xs" style={{ color: 'var(--list-summary)' }}>
          <span>{t('preferences.rankingWeights.semanticZero', '0% · No semantic influence')}</span>
          <span>{t('preferences.rankingWeights.semanticFull', '100% · Semantic scores only')}</span>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h4 className="text-sm font-semibold" style={{ color: 'var(--list-title)' }}>
            {t('preferences.rankingWeights.sourcesTitle', 'Discovery source weights')}
          </h4>
          <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--list-summary)' }}>
            {t('preferences.rankingWeights.sourcesHelp', 'These weights set the relative mix between sources. They are normalized automatically, so they do not need to add up to 100%. Set a source to 0% to exclude it.')}
          </p>
        </div>
        {EXTERNAL_SOURCE_ORDER.map((source) => {
          const registered = REGISTERED_EXTERNAL_SOURCES.has(source);
          const measuredCount = coverage.measured[source] ?? 0;
          return (
            <div key={source} className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <label htmlFor={`ranking-source-${source}`} className="text-sm font-medium" style={{ color: 'var(--list-title)' }}>
                    {t(`preferences.rankingWeights.source.${source}`, SOURCE_LABELS[source])}
                  </label>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--list-summary)' }}>
                    {t(`preferences.rankingWeights.sourceHelp.${source}`, '')}
                  </p>
                  {!registered && (
                    <p className="text-xs mt-0.5 italic" style={{ color: 'var(--list-summary)' }}>
                      {t('preferences.rankingWeights.sourceNotConnected', 'Not connected yet — ignored until it ships.')}
                    </p>
                  )}
                  {registered && coverage.candidates > 0 && (
                    <p className="text-xs mt-0.5" style={{ color: 'var(--list-summary)', ...(measuredCount === 0 ? { opacity: 0.7 } : {}) }}>
                      {measuredCount === 0
                        ? t('preferences.rankingWeights.coverageNone', 'No measured evidence in the current cohort yet.')
                        : t('preferences.rankingWeights.coverage', '{{measured}} of {{candidates}} candidates measured', { measured: measuredCount, candidates: coverage.candidates })}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <input type="number" min={0} max={100} step={5} value={weights.sources[source]}
                    onChange={(e) => updateSource(source, Number(e.target.value))}
                    aria-label={`${SOURCE_LABELS[source]} weight`} className={fieldClass} style={fieldStyle} />
                  <span className="text-sm" style={{ color: 'var(--list-summary)' }}>%</span>
                </div>
              </div>
              <input id={`ranking-source-${source}`} type="range" min={0} max={100} step={5} value={weights.sources[source]}
                onChange={(e) => updateSource(source, Number(e.target.value))}
                aria-label={`${SOURCE_LABELS[source]} weight`} className="w-full accent-[var(--accent)]" />
            </div>
          );
        })}
      </section>

      <div className="flex items-center justify-between gap-3 pt-3" style={{ borderTop: '1px solid var(--panel-border)' }}>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--list-summary)' }}>
          {t('preferences.rankingWeights.savedAutomatically', 'Changes save automatically to your account. Select Custom in the Interesting view to use them.')}
        </p>
        <button type="button" onClick={() => setWeights(DEFAULT_CUSTOM_INTERESTING_WEIGHTS)}
          className="rounded-lg px-3 py-2 text-xs font-medium shrink-0"
          style={{ color: 'var(--list-title)', border: '1px solid var(--panel-border)' }}>
          {t('preferences.rankingWeights.reset', 'Reset')}
        </button>
      </div>
    </div>
  );
}
