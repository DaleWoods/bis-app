import { useEffect, useState } from 'react';
import { api, formatDateTime } from '../api';

/** §14 auditability: who did what, when. Append-only, coordinator/admin only. */
export function AuditPage() {
  const [entries, setEntries] = useState<Array<{ id: string; at: string; actorEmail: string; action: string; entityType: string; entityId: string; detail: unknown }>>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .audit(300)
      .then(({ entries }) => setEntries(entries))
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="status error">{error}</p>;

  return (
    <>
      <h1>Audit log</h1>
      <p className="lede">Every submission, edit, calculation snapshot, email and JIRA write-back, with who and when.</p>
      <div className="card table-scroll">
        <table>
          <caption className="visually-hidden">Audit entries</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">Action</th>
              <th scope="col">Entity</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{formatDateTime(entry.at)}</td>
                <td>{entry.actorEmail || 'system'}</td>
                <td>{entry.action}</td>
                <td>
                  {entry.entityType}
                  {entry.entityId ? ` ${entry.entityId.slice(0, 8)}` : ''}
                </td>
                <td>
                  <code style={{ fontSize: '0.78rem' }}>{JSON.stringify(entry.detail).slice(0, 160)}</code>
                </td>
              </tr>
            ))}
            {!entries.length ? (
              <tr>
                <td colSpan={5}>Nothing logged yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
