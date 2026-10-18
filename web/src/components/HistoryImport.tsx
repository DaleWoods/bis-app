import { useState } from 'react';
import { api, type HistoryImportPreview, type HistoryImportResult } from '../api';

function day(iso: string): string {
  return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}

/**
 * Bring the manual process's history in, for Trends, the league table and
 * streaks. Two steps on purpose - preview, then import - because the
 * spreadsheet's ticket IDs were typed by hand and some have to be guessed,
 * and the coordinator should see those before anything is written.
 */
export function HistoryImport() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<HistoryImportPreview | null>(null);
  const [active, setActive] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<HistoryImportResult | null>(null);
  const [showRounds, setShowRounds] = useState(false);
  const [showAllGuesses, setShowAllGuesses] = useState(false);

  async function choose(f: File | null) {
    setFile(f);
    setPreview(null);
    setResult(null);
    setError('');
    if (!f) return;
    setBusy('preview');
    try {
      const { preview } = await api.previewHistoryImport(f);
      setPreview(preview);
      setActive(new Set(preview.newMembers.filter((m) => m.suggestedActive).map((m) => m.email)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that file');
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    if (!file) return;
    setBusy('import');
    setError('');
    try {
      const { result } = await api.commitHistoryImport(file, [...active]);
      setResult(result);
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The import failed - nothing was changed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>Import the manual history</h2>
      <p className="hint">
        Bring in everything the committee scored before the app, from the manual scoring workbook (the one with the
        Forms “Responses” sheet). It is history only: those tickets were already decided and written to JIRA by hand,
        so imported rounds are never written to JIRA, never emailed about, never rolled over and cannot be reopened.
        They do count in Trends, the league table and streaks.
      </p>
      <label htmlFor="history-file">Scoring workbook (.xlsx)</label>
      <input
        id="history-file"
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(e) => {
          setShowAllGuesses(false);
          void choose(e.target.files?.[0] ?? null);
        }}
        disabled={busy !== null}
      />
      {busy === 'preview' ? <p className="hint">Reading the workbook…</p> : null}
      {error ? <p className="status error">{error}</p> : null}

      {result ? (
        <div className="notice" role="status" style={{ marginTop: '0.75rem' }}>
          <strong>Imported.</strong> {result.rounds} rounds, {result.tickets} tickets and {result.submissions} responses
          {result.membersCreated ? `, and ${result.membersCreated} people added to the committee list` : ''}.
          {result.replacedRounds ? ` The ${result.replacedRounds} rounds from the previous import were replaced.` : ''}
        </div>
      ) : null}

      {preview ? (
        <div className="import-preview">
          <h3>What this will import</h3>
          <ul className="import-stats">
            <li>
              <strong>{preview.rounds.length}</strong> rounds, {day(preview.from)} to {day(preview.to)}
            </li>
            <li>
              <strong>{preview.tickets}</strong> tickets
            </li>
            <li>
              <strong>{preview.responses.used}</strong> responses that count
            </li>
            <li>
              <strong>{preview.responses.archived}</strong> archived (kept, never counted)
            </li>
          </ul>
          <p className="hint">
            Each ticket goes into the week it was first scored, with all its responses — so its average is the same
            as the spreadsheet's. Where someone answered the same ticket twice, the later answer is used (
            {preview.responses.duplicates} {preview.responses.duplicates === 1 ? 'case' : 'cases'}). Scores are matched
            to categories by column name:{' '}
            {preview.categoryColumns.map((c) => c.category).join(', ')}.
          </p>
          <button type="button" className="link-button" onClick={() => setShowRounds((v) => !v)} aria-expanded={showRounds}>
            {showRounds ? '▾' : '▸'} The {preview.rounds.length} rounds
          </button>
          {showRounds ? (
            <div className="table-scroll" style={{ marginTop: '0.4rem' }}>
              <table>
                <caption className="visually-hidden">Rounds to import</caption>
                <thead>
                  <tr>
                    <th scope="col">Round</th>
                    <th scope="col" className="num">
                      Tickets
                    </th>
                    <th scope="col" className="num">
                      Responses
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rounds.map((r) => (
                    <tr key={`${r.stream}-${r.cutOffAt}`}>
                      <td>{r.label}</td>
                      <td className="num">{r.tickets}</td>
                      <td className="num">{r.responses}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {preview.guessedKeys.length ? (
            <>
              <h3>Ticket IDs typed without a project</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                These were typed as a bare number (or a mistyped prefix). Each takes the project it was typed with
                elsewhere in the sheet, or ECOM. Check any that look wrong — correct them in the workbook and choose it
                again.
              </p>
              <ul className="matrix-chips">
                {(showAllGuesses ? preview.guessedKeys : preview.guessedKeys.slice(0, 12)).map((g) => (
                  <li key={g.typed}>
                    <span className="matrix-chip is-static">
                      “{g.typed}” → <strong>{g.key}</strong>
                      {g.rows > 1 ? ` ×${g.rows}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              {preview.guessedKeys.length > 12 ? (
                <button type="button" className="link-button" onClick={() => setShowAllGuesses((v) => !v)}>
                  {showAllGuesses ? 'Show fewer' : `Show all ${preview.guessedKeys.length}`}
                </button>
              ) : null}
            </>
          ) : null}

          {preview.responses.skipped.length ? (
            <>
              <h3>Rows that will be left out</h3>
              <ul>
                {preview.responses.skipped.map((s) => (
                  <li key={s.row}>
                    Row {s.row}: {s.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {preview.newMembers.length ? (
            <>
              <h3>People not in the app yet</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                They are added so their scores count. Tick the ones still on the committee — they will be emailed and
                expected to score. Unticked people are added inactive: in the history, but nothing more. Ticked to
                begin with: anyone who scored in the last eight weeks of the sheet.
              </p>
              <ul className="import-people">
                {preview.newMembers.map((m) => (
                  <li key={m.email}>
                    <label>
                      <input
                        type="checkbox"
                        checked={active.has(m.email)}
                        onChange={(e) =>
                          setActive((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(m.email);
                            else next.delete(m.email);
                            return next;
                          })
                        }
                      />{' '}
                      {m.name} <span className="hint">{m.email} · last scored {day(m.lastResponse)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {preview.existingMembers.length ? (
            <p className="hint">
              Already in the app, left exactly as they are: {preview.existingMembers.map((m) => m.name).join(', ')}.
            </p>
          ) : null}

          {preview.previouslyImportedRounds ? (
            <div className="notice warn">
              {preview.previouslyImportedRounds} rounds were imported before. Importing again replaces them with this
              workbook's — rounds run in the app are not touched.
            </div>
          ) : null}

          <div className="row" style={{ gap: '0.5rem', marginTop: '0.75rem' }}>
            <button type="button" onClick={runImport} disabled={busy !== null}>
              {busy === 'import'
                ? 'Importing…'
                : `Import ${preview.rounds.length} rounds${preview.previouslyImportedRounds ? ' (replacing the last import)' : ''}`}
            </button>
            <button type="button" className="secondary" onClick={() => choose(null)} disabled={busy !== null}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
