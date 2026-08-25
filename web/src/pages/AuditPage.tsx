import { useEffect, useMemo, useState } from 'react';
import { api, formatDateTime, type Member } from '../api';

interface AuditEntry {
  id: string;
  at: string;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string;
  detail: Record<string, unknown> | unknown;
}

interface Participation {
  memberId: string;
  memberName: string;
  team: string;
  roundsCompleted: number;
  roundsConsidered: number;
}

function detailOf(entry: AuditEntry): Record<string, unknown> {
  return entry.detail && typeof entry.detail === 'object' ? (entry.detail as Record<string, unknown>) : {};
}

/**
 * A sentence a coordinator can actually read, not an action code. Falls back
 * to the raw code (de-slugged) for anything not written below, so a new
 * action type never disappears - it just reads a little flatter until someone
 * adds it here.
 */
function describe(entry: AuditEntry): string {
  const d = detailOf(entry);
  const s = (v: unknown) => (typeof v === 'string' && v ? v : '');
  switch (entry.action) {
    case 'auth.login':
      return 'Signed in';
    case 'auth.logout':
      return 'Signed out';
    case 'member.self-register':
      return 'Added themselves to the committee';
    case 'submission.save':
      return `Scored ${s(d.jiraId) || 'a ticket'}`;
    case 'submission.archive':
      return 'Withdrew a score';
    case 'submission.restore':
      return 'Restored a withdrawn score';
    case 'round.create':
      return `Created round "${s(d.weekLabel) || entry.entityId.slice(0, 8)}"`;
    case 'round.update':
      return 'Edited round settings';
    case 'round.distribute':
      return `Distributed the round to ${typeof d.recipients === 'number' ? d.recipients : 'the'} committee member(s)`;
    case 'round.remind':
      return `Chased ${typeof d.targets === 'number' ? d.targets : ''} non-responder(s)`.replace('  ', ' ');
    case 'round.escalate':
      return `Sent a final reminder to ${typeof d.targets === 'number' ? d.targets : ''} member(s)`.replace('  ', ' ');
    case 'round.closed':
      return 'Closed scoring';
    case 'round.finalise':
      return `Finalised the round${typeof d.tickets === 'number' ? ` (${d.tickets} ticket(s))` : ''}`;
    case 'round.rollover':
      return 'Rolled a ticket over into this round';
    case 'round.recalculate':
      return 'Recalculated results';
    case 'round.discussion':
      return 'Resolved a discussion ticket';
    case 'round.ticket.add':
      return 'Added a ticket to the round';
    case 'round.ticket.remove':
      return 'Removed a ticket from the round';
    case 'round.ticket.release':
      return 'Released a held ticket to the committee';
    case 'round.export.csv':
      return 'Exported results as CSV';
    case 'jira.import':
      return `Imported tickets from JIRA${typeof d.imported === 'number' ? ` (${d.imported})` : ''}`;
    case 'jira.writeback':
      return `Wrote the score for ${s(d.jiraId) || 'a ticket'} to JIRA`;
    case 'jira.writeback.failed':
      return `JIRA write-back failed for ${s(d.jiraId) || 'a ticket'}`;
    case 'member.create':
      return `Added ${s(d.name) || 'a'} member`;
    case 'member.update':
      return `Updated ${s(d.name) || 'a'} member's details`;
    case 'member.delete':
      return `Removed ${s(d.email) || 'a member'} from the committee`;
    case 'category.create':
      return `Added the "${s(d.name)}" category`;
    case 'category.update':
      return `Edited the "${s(d.name)}" category`;
    case 'category.deactivate':
      return 'Retired a category';
    case 'category.restore-defaults':
      return 'Restored the default seven categories';
    case 'config.update':
      return `Updated ${s(entry.entityId).replace(/[-_]/g, ' ') || 'the'} settings`;
    case 'automation.run':
      return `Automation ran${typeof d.steps === 'number' ? ` (${d.steps} step(s))` : ''}`;
    case 'admin.round.delete':
      return 'Deleted a round';
    case 'admin.reset-data':
      return 'Cleared all rounds, tickets and scores';
    case 'email.test':
      return `Sent a test email to ${s(d.to) || 'themselves'}`;
    case 'ticket.save':
      return `Edited card ${s(d.jiraId) || 'a ticket'}`;
    case 'ticket.delete':
      return 'Deleted a ticket';
    case 'ticket.refresh':
      return `Refreshed ${s(d.jiraId) || 'a ticket'} from JIRA`;
    case 'ticket.redraft':
      return `Redrafted the card for ${s(d.jiraId) || 'a ticket'}`;
    case 'ticket.import.csv':
      return `Imported tickets from a CSV file${typeof d.imported === 'number' ? ` (${d.imported})` : ''}`;
    default:
      return entry.action.replace(/[._]/g, ' ');
  }
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDateTime(iso);
}

/** §14 auditability: who did what, when. Append-only, coordinator/admin only. */
export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [participation, setParticipation] = useState<Participation[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.audit(400), api.members(), api.roundParticipation(8)])
      .then(([auditRes, membersRes, participationRes]) => {
        setEntries(auditRes.entries as AuditEntry[]);
        setMembers(membersRes.members);
        setParticipation(participationRes.participation);
      })
      .catch((err) => setError(err.message));
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) => e.actorEmail.toLowerCase().includes(q) || describe(e).toLowerCase().includes(q) || e.action.toLowerCase().includes(q),
    );
  }, [entries, filter]);

  if (error) return <p className="status error">{error}</p>;

  const committee = members.filter((m) => m.active && m.role === 'COMMITTEE');
  const participationByMember = new Map(participation.map((p) => [p.memberId, p]));

  return (
    <>
      <h1>Engagement &amp; audit</h1>
      <p className="lede">Who is signing in, scoring and taking part - and, below it, the full append-only record of every change.</p>

      <div className="card table-scroll">
        <h2 style={{ marginTop: 0 }}>Committee engagement</h2>
        <p className="hint" style={{ marginBottom: '0.75rem' }}>
          Last sign-in from their account, and completion rate over the last {participation[0]?.roundsConsidered ?? 0} finalised rounds.
        </p>
        <table>
          <caption className="visually-hidden">Committee engagement</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Team</th>
              <th scope="col">Last signed in</th>
              <th scope="col">Completion</th>
            </tr>
          </thead>
          <tbody>
            {committee.map((member) => {
              const p = participationByMember.get(member.id);
              return (
                <tr key={member.id}>
                  <td>{member.name}</td>
                  <td>{member.team}</td>
                  <td>{member.lastLoginAt ? timeAgo(member.lastLoginAt) : 'Never signed in'}</td>
                  <td>
                    {p && p.roundsConsidered > 0 ? (
                      <>
                        <span className="bar" style={{ display: 'inline-block', width: 70, verticalAlign: 'middle', marginRight: '0.5rem' }}>
                          <span style={{ width: `${Math.round((p.roundsCompleted / p.roundsConsidered) * 100)}%` }} />
                        </span>
                        {p.roundsCompleted} of {p.roundsConsidered}
                      </>
                    ) : (
                      <span className="hint">Not enough finalised rounds yet</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!committee.length ? (
              <tr>
                <td colSpan={4}>No active committee members yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Activity</h2>
          <input
            type="text"
            placeholder="Filter by person or action…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ maxWidth: 260 }}
            aria-label="Filter activity"
          />
        </div>
        <div className="table-scroll" style={{ marginTop: '0.75rem' }}>
          <table>
            <caption className="visually-hidden">Audit entries</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What happened</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <tr key={entry.id}>
                  <td title={formatDateTime(entry.at)}>{timeAgo(entry.at)}</td>
                  <td>{entry.actorEmail || 'Automation'}</td>
                  <td>
                    {describe(entry)}
                    <details style={{ marginTop: '0.15rem' }}>
                      <summary className="hint" style={{ cursor: 'pointer', display: 'inline' }}>
                        details
                      </summary>
                      <code style={{ fontSize: '0.78rem', display: 'block', marginTop: '0.2rem' }}>
                        {JSON.stringify(entry.detail).slice(0, 300)}
                      </code>
                    </details>
                  </td>
                </tr>
              ))}
              {!filtered.length ? (
                <tr>
                  <td colSpan={3}>{entries.length ? 'Nothing matches that filter.' : 'Nothing logged yet.'}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
