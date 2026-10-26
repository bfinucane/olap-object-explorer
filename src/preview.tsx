import { useEffect, useState } from 'react';
import { engineApi } from './api';
import { ErrorNotice } from './errorNotice';
import { formatCount } from './format';
import type { Cell, SampleResponse } from './types';

interface PreviewPaneProps {
  datasetName: string | null;
  onOpenDetails: () => void;
}

const PAGE_SIZES = [10, 25, 50, 100];

/**
 * Data preview: `GET /v1/{dataset}/sample`. Shows raw engine rows — no
 * client-side formatting beyond nulls, so what you see is what the engine
 * returned (absent measure cells are `null`, handoff §5.6).
 */
export function PreviewPane({ datasetName, onOpenDetails }: PreviewPaneProps) {
  const [limit, setLimit] = useState(10);
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState<SampleResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  // A new dataset starts at row 0.
  useEffect(() => {
    setOffset(0);
    setData(null);
    setError(null);
  }, [datasetName]);

  useEffect(() => {
    if (datasetName === null) return;
    let alive = true;
    setLoading(true);
    setError(null);
    engineApi.sample(datasetName, { limit, offset }).then(
      (response) => {
        if (!alive) return;
        setData(response);
        setLoading(false);
      },
      (sampleError: unknown) => {
        if (!alive) return;
        setError(sampleError);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [datasetName, limit, offset, reloadKey]);

  if (datasetName === null) {
    return (
      <div className="preview">
        <p className="muted">Select a cube in the tree to preview its rows.</p>
      </div>
    );
  }

  const rowCount = data?.rowCount ?? 0;
  const rows = data?.rows ?? [];
  const first = rows.length === 0 ? 0 : offset + 1;
  const last = offset + rows.length;
  const hasNext = last < rowCount;
  const hasPrev = offset > 0;

  return (
    <div className="preview">
      <div className="preview-toolbar">
        <div className="preview-title">
          <h2>{datasetName}</h2>
          <span className="muted">
            <code>GET /v1/{'{dataset}'}/sample</code>
          </span>
        </div>
        <div className="preview-controls">
          <label className="control">
            Rows
            <select
              value={limit}
              onChange={(event) => {
                setLimit(Number(event.target.value));
                setOffset(0);
              }}
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn" disabled={!hasPrev || loading} onClick={() => setOffset(0)}>
            ⏮
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hasPrev || loading}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            ← Prev
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hasNext || loading}
            onClick={() => setOffset(offset + limit)}
          >
            Next →
          </button>
          <button type="button" className="btn" disabled={loading} onClick={() => setReloadKey((key) => key + 1)}>
            Refresh
          </button>
          <button type="button" className="btn" onClick={onOpenDetails}>
            Details
          </button>
        </div>
      </div>

      {error !== null && (
        <ErrorNotice
          error={error}
          title={`Could not sample ${datasetName}`}
          onRetry={() => setReloadKey((key) => key + 1)}
        />
      )}

      {error === null && (
        <div className="preview-grid-wrap">
          <table className="grid preview-grid" data-testid="preview-grid">
            <thead>
              <tr>
                <th className="row-number-head">#</th>
                {(data?.columns ?? []).map((column, index) => (
                  <th key={`${column}-${index}`}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={offset + rowIndex}>
                  <td className="row-number">{offset + rowIndex + 1}</td>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderCell(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {!loading && rows.length === 0 && (
            <p className="muted preview-empty">
              No rows returned — the cube is empty (or the database is fresh). This is 0 rows, not
              an error.
            </p>
          )}
          {loading && data === null && <p className="muted preview-empty">Loading rows…</p>}
        </div>
      )}

      <div className="preview-footer">
        <span>
          Showing {first}–{last} of {formatCount(rowCount)} row{rowCount === 1 ? '' : 's'}
        </span>
        {data !== null && data.columns.length > 0 && (
          <span className="muted">{data.columns.length} columns</span>
        )}
      </div>

      <p className="preview-note">
        Engine note: <code>/sample</code> returns the cube&apos;s dimension columns only — measure
        cells (<code>value</code>) are not included. Use the SQL console for measures.
      </p>
    </div>
  );
}

function renderCell(cell: Cell) {
  if (cell === null) return <span className="cell-null">null</span>;
  return String(cell);
}
