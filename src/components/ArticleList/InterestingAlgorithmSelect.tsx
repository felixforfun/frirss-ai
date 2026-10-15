import { INTERESTING_ALGORITHMS, type InterestingAlgorithm } from '../../lib/intelligenceRanking';

interface InterestingAlgorithmSelectProps {
  value: InterestingAlgorithm;
  onChange: (value: string) => void;
  /** `toolbar`: the compact desktop control (unchanged look). `sheet`: a row of the mobile View options sheet. */
  variant?: 'toolbar' | 'sheet';
}

/** Choice of ranking for the Interesting view. Shared by the desktop toolbars and the mobile sheet. */
export default function InterestingAlgorithmSelect({ value, onChange, variant = 'toolbar' }: InterestingAlgorithmSelectProps) {
  const options = INTERESTING_ALGORITHMS.map((algorithm) => (
    <option key={algorithm.value} value={algorithm.value}>{algorithm.label}</option>
  ));

  if (variant === 'sheet') {
    return (
      <label className="px-4 py-3 flex items-center justify-between gap-3">
        <span className="text-[15px] font-medium" style={{ color: 'var(--list-title)' }}>Ranking algorithm</span>
        <select
          aria-label="Interesting ranking algorithm"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 max-w-[60%] rounded-lg px-3 py-2 text-sm outline-none"
          style={{ background: 'var(--panel-bg)', color: 'var(--list-title)', border: '1px solid var(--panel-border)' }}
        >
          {options}
        </select>
      </label>
    );
  }

  return (
    <label className="flex items-center gap-1.5 px-1 flex-shrink-0" title="Choose the Interesting ranking algorithm">
      <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--list-summary)' }}>Algorithm</span>
      <select
        aria-label="Interesting ranking algorithm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-[170px] rounded-md px-2 py-1 text-[11px] outline-none"
        style={{ background: 'var(--panel-bg)', color: 'var(--list-title)', border: '1px solid var(--panel-border)' }}
      >
        {options}
      </select>
    </label>
  );
}
