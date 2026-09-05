/**
 * A row of bars, one per core.
 *
 * Plain elements rather than a charting library: it is a handful of divs, and
 * a library would be another dependency to inline into the single-document
 * bundle for no gain. The whole group carries one accessible label, because
 * announcing sixteen changing percentages every second would be unusable.
 */
export interface BarsProps {
  readonly values: readonly number[];
  readonly label: string;
}

export function Bars({ values, label }: BarsProps): React.ReactElement {
  return (
    <div className="bars" role="img" aria-label={`${label}: ${values.length} cores`}>
      {values.map((value, index) => (
        <div className="bars__slot" key={index} title={`Core ${String(index)}: ${Math.round(value * 100)}%`}>
          <div className="bars__fill" style={{ height: `${String(Math.max(2, value * 100))}%` }} />
        </div>
      ))}
    </div>
  );
}
