import { useEffect, useState } from 'react';
import { api, type AppConfig, type Category, type Member, type Role } from '../api';

/**
 * §14 config-driven: categories, weights, thresholds (16 / 5 / 6 / 1.8), cadence,
 * effort mapping, JIRA field ids and the committee are all editable settings.
 */
export function SettingsPage() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [integrations, setIntegrations] = useState<{
    jiraConfigured: boolean;
    graphConfigured: boolean;
    emailProvider: 'smtp' | 'graph' | 'none';
    emailProviderLabel: string;
    emailFrom: string;
    emailReplyTo: string;
    graphSendEnabled: boolean;
    authMode: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [newMember, setNewMember] = useState({ name: '', email: '', team: '', role: 'COMMITTEE' as Role });

  async function load() {
    try {
      const [{ config, categories, integrations }, { members }] = await Promise.all([api.config(), api.members()]);
      setConfig(config);
      setCategories(categories);
      setIntegrations(integrations);
      setMembers(members);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load settings');
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (error && !config) return <p className="status error">{error}</p>;
  if (!config) return <p>Loading…</p>;

  async function saveSection(section: keyof AppConfig, value: unknown, label: string) {
    setMessage('');
    setError('');
    try {
      const { config } = await api.saveConfig(section, value);
      setConfig(config);
      setMessage(`${label} saved.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  return (
    <>
      <h1>Settings</h1>
      <p className="lede">Thresholds, categories, cadence, integrations and the committee. Nothing here is hard-coded.</p>

      {message ? (
        <p className="status saved" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="status error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Scoring thresholds</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            saveSection(
              'scoring',
              {
                minSubmissions: Number(form.get('minSubmissions')),
                stdDevDiscussionThreshold: Number(form.get('stdDevDiscussionThreshold')),
                priorityHigh: Number(form.get('priorityHigh')),
                priorityMedium: Number(form.get('priorityMedium')),
                applyCategoryWeights: form.get('applyCategoryWeights') === 'on',
                effort: {
                  mode: String(form.get('effortMode')),
                  backendFieldId: String(form.get('backendFieldId') ?? ''),
                  frontendFieldId: String(form.get('frontendFieldId') ?? ''),
                },
              },
              'Scoring configuration',
            );
          }}
        >
          <div className="row">
            <div className="grow field">
              <label htmlFor="minSubmissions">Minimum responses</label>
              <input id="minSubmissions" name="minSubmissions" type="number" min={1} defaultValue={config.scoring.minSubmissions} />
              <p className="hint">Below this a ticket shows “Awaiting WOSG Responses” and rolls over.</p>
            </div>
            <div className="grow field">
              <label htmlFor="stdDevDiscussionThreshold">Discussion threshold (std dev &gt;)</label>
              <input id="stdDevDiscussionThreshold" name="stdDevDiscussionThreshold" type="number" step="0.1" defaultValue={config.scoring.stdDevDiscussionThreshold} />
            </div>
            <div className="grow field">
              <label htmlFor="priorityHigh">High priority ratio ≥</label>
              <input id="priorityHigh" name="priorityHigh" type="number" step="0.1" defaultValue={config.scoring.priorityHigh} />
            </div>
            <div className="grow field">
              <label htmlFor="priorityMedium">Medium priority ratio ≥</label>
              <input id="priorityMedium" name="priorityMedium" type="number" step="0.1" defaultValue={config.scoring.priorityMedium} />
            </div>
          </div>

          <div className="row">
            <div className="grow field">
              <label htmlFor="effortMode">Effort mapping</label>
              <select id="effortMode" name="effortMode" defaultValue={config.scoring.effort.mode}>
                <option value="BACKEND_PLUS_FRONTEND">Backend + Frontend poker total</option>
                <option value="BACKEND_ONLY">Backend poker only</option>
                <option value="FRONTEND_ONLY">Frontend poker only</option>
                <option value="MANUAL">Manual entry only</option>
              </select>
              <p className="hint">Residual question 1 in the requirements — switch this when RA confirms.</p>
            </div>
            <div className="grow field">
              <label htmlFor="backendFieldId">Backend Poker Score field id</label>
              <input id="backendFieldId" name="backendFieldId" type="text" defaultValue={config.scoring.effort.backendFieldId} placeholder="customfield_XXXXX" />
            </div>
            <div className="grow field">
              <label htmlFor="frontendFieldId">Frontend Poker Score field id</label>
              <input id="frontendFieldId" name="frontendFieldId" type="text" defaultValue={config.scoring.effort.frontendFieldId} placeholder="customfield_XXXXX" />
            </div>
          </div>

          <div className="field">
            <label htmlFor="applyCategoryWeights" style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
              <input id="applyCategoryWeights" name="applyCategoryWeights" type="checkbox" defaultChecked={config.scoring.applyCategoryWeights} />
              Apply category weights (currently a straight sum)
            </label>
          </div>

          <button type="submit">Save scoring configuration</button>
        </form>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Categories</h2>
        <p className="hint">
          Categories are data. Reword, reweight, reorder or retire them without a code change. Unticking
          &ldquo;Active&rdquo; removes a category from the scoring form for everyone.
        </p>
        {categories.filter((c) => c.active).length === 0 ? (
          <div className="notice warn">
            <strong>No categories are active, so the scoring form is empty</strong> — committee members cannot score
            anything. Restore the seven defaults to fix it.
          </div>
        ) : null}
        <div className="row" style={{ marginBottom: '0.75rem' }}>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              setError('');
              try {
                const { categories } = await api.restoreDefaultCategories();
                setMessage(`Restored the seven default categories (${categories.filter((c) => c.active).length} active).`);
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Could not restore the categories');
              }
            }}
          >
            Restore the seven default categories
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">Scoring categories</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Name</th>
                <th scope="col">Description</th>
                <th scope="col" className="num">
                  Weight
                </th>
                <th scope="col" className="num">
                  Scale
                </th>
                <th scope="col">Active</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => (
                <tr key={category.id}>
                  <td className="num">{category.position}</td>
                  <td>{category.name}</td>
                  <td>{category.description}</td>
                  <td className="num">{category.weight}</td>
                  <td className="num">
                    {category.scaleMin}–{category.scaleMax}
                  </td>
                  <td>
                    <label
                      htmlFor={`cat-active-${category.id}`}
                      style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center', fontWeight: 400, marginBottom: 0 }}
                    >
                      <input
                        id={`cat-active-${category.id}`}
                        type="checkbox"
                        checked={category.active}
                        onChange={async (event) => {
                          const next = event.target.checked;
                          if (!next && categories.filter((c) => c.active).length <= 1) {
                            setError('At least one category must stay active — otherwise there is nothing to score.');
                            return;
                          }
                          await api.saveCategory({ ...category, active: next });
                          await load();
                        }}
                      />
                      {category.active ? 'Active' : 'Inactive'}
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>JIRA</h2>
        <p className="hint">
          {integrations?.jiraConfigured
            ? 'Credentials configured.'
            : 'Not configured — set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN to enable import and write-back.'}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            saveSection(
              'jira',
              {
                queueJql: String(form.get('queueJql')),
                businessScoreFieldId: String(form.get('businessScoreFieldId')),
                transitionOnFinalise: form.get('transitionOnFinalise') === 'on',
                transitionName: String(form.get('transitionName')),
              },
              'JIRA configuration',
            );
          }}
        >
          <div className="field">
            <label htmlFor="queueJql">Business Scoring queue (JQL)</label>
            <input id="queueJql" name="queueJql" type="text" defaultValue={config.jira.queueJql} />
          </div>
          <div className="row">
            <div className="grow field">
              <label htmlFor="businessScoreFieldId">Business Score field id (write target)</label>
              <input id="businessScoreFieldId" name="businessScoreFieldId" type="text" defaultValue={config.jira.businessScoreFieldId} placeholder="customfield_XXXXX" />
            </div>
            <div className="grow field">
              <label htmlFor="transitionName">Transition on finalise</label>
              <input id="transitionName" name="transitionName" type="text" defaultValue={config.jira.transitionName} />
              <label htmlFor="transitionOnFinalise" style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.4rem' }}>
                <input id="transitionOnFinalise" name="transitionOnFinalise" type="checkbox" defaultChecked={config.jira.transitionOnFinalise} />
                Also transition the ticket (default: write the score only)
              </label>
            </div>
          </div>
          <div className="row">
            <button type="submit">Save JIRA configuration</button>
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                setError('');
                try {
                  const { suggestions } = await api.suggestJiraFields();
                  setMessage(`Resolved field ids: ${Object.entries(suggestions).map(([k, v]) => `${k}=${v || 'not found'}`).join(', ')}`);
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Could not reach JIRA');
                }
              }}
            >
              Resolve field ids from JIRA
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Email</h2>
        {integrations?.emailProvider === 'none' ? (
          <>
            <div className="notice warn">
              <strong>No email provider configured.</strong> Distribution and reminders are composed and logged, but
              nothing is sent.
            </div>
            <p>
              Any SMTP provider works and none of them need your IT department — sign up, verify the one address you
              will send from, then set these in your host&apos;s environment settings:
            </p>
            <pre style={{ background: 'var(--panel-alt)', padding: '0.75rem', borderRadius: 'var(--radius)', overflowX: 'auto', fontSize: '0.85rem' }}>
{`SMTP_HOST=smtp-relay.brevo.com     # or smtp.sendgrid.net, smtp.gmail.com, ...
SMTP_PORT=587
SMTP_USER=<your login>
SMTP_PASS=<api key or app password>
EMAIL_FROM=<the address you verified>
EMAIL_REPLY_TO=<where replies should go>`}
            </pre>
            <p className="hint">
              Sending <em>as</em> a company domain needs SPF/DKIM DNS records, which does need IT. Sending from an
              address you control, with replies routed back to you, does not.
            </p>
          </>
        ) : (
          <>
            <p className="lede" style={{ marginBottom: '0.75rem' }}>
              Sending via <strong>{integrations?.emailProviderLabel}</strong>
              {integrations?.emailFrom ? (
                <>
                  {' '}
                  as <strong>{integrations.emailFrom}</strong>
                </>
              ) : null}
              {integrations?.emailReplyTo ? <> · replies to {integrations.emailReplyTo}</> : null}
              {integrations?.graphSendEnabled ? null : ' — sending is currently disabled (EMAIL_SEND_ENABLED=false)'}
            </p>
          </>
        )}
        <button
          type="button"
          className="secondary"
          disabled={testing}
          onClick={async () => {
            setTesting(true);
            setMessage('');
            setError('');
            try {
              const result = await api.sendTestEmail();
              setMessage(
                result.status === 'SENT'
                  ? `Test email sent to ${result.to} via ${result.provider}. Check your inbox (and spam).`
                  : `Not sent: ${result.error ?? result.status}`,
              );
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Could not send the test email');
            } finally {
              setTesting(false);
            }
          }}
        >
          {testing ? 'Sending…' : 'Send a test email to me'}
        </button>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Cadence</h2>
        <p className="hint">
          Distribution and reminders are scheduled around these, not hard-coded weekdays.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            saveSection(
              'cadence',
              {
                distributionDayOfWeek: Number(form.get('distributionDayOfWeek')),
                distributionHour: Number(form.get('distributionHour')),
                cutOffDayOfWeek: Number(form.get('cutOffDayOfWeek')),
                cutOffHour: Number(form.get('cutOffHour')),
                reminderHoursBeforeCutOff: String(form.get('reminderHoursBeforeCutOff'))
                  .split(',')
                  .map((value) => Number(value.trim()))
                  .filter((value) => Number.isFinite(value)),
              },
              'Cadence',
            );
          }}
        >
          <div className="row">
            <div className="grow field">
              <label htmlFor="distributionDayOfWeek">Distribution day</label>
              <select id="distributionDayOfWeek" name="distributionDayOfWeek" defaultValue={config.cadence.distributionDayOfWeek}>
                {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            </div>
            <div className="grow field">
              <label htmlFor="distributionHour">Distribution hour</label>
              <input id="distributionHour" name="distributionHour" type="number" min={0} max={23} defaultValue={config.cadence.distributionHour} />
            </div>
            <div className="grow field">
              <label htmlFor="cutOffDayOfWeek">Cut-off day</label>
              <select id="cutOffDayOfWeek" name="cutOffDayOfWeek" defaultValue={config.cadence.cutOffDayOfWeek}>
                {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            </div>
            <div className="grow field">
              <label htmlFor="cutOffHour">Cut-off hour</label>
              <input id="cutOffHour" name="cutOffHour" type="number" min={0} max={23} defaultValue={config.cadence.cutOffHour} />
            </div>
            <div className="grow field">
              <label htmlFor="reminderHoursBeforeCutOff">Reminders (hours before cut-off)</label>
              <input id="reminderHoursBeforeCutOff" name="reminderHoursBeforeCutOff" type="text" defaultValue={config.cadence.reminderHoursBeforeCutOff.join(', ')} />
            </div>
          </div>
          <button type="submit">Save cadence</button>
        </form>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Committee</h2>
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">Committee members</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Team</th>
                <th scope="col">Role</th>
                <th scope="col">Active</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td>{member.name}</td>
                  <td>{member.email}</td>
                  <td>{member.team || '—'}</td>
                  <td>
                    <select
                      aria-label={`Role for ${member.name}`}
                      value={member.role}
                      onChange={async (event) => {
                        await api.saveMember({ ...member, role: event.target.value as Role });
                        await load();
                      }}
                    >
                      {(['ADMIN', 'COORDINATOR', 'COMMITTEE', 'VIEWER'] as Role[]).map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      className="secondary"
                      onClick={async () => {
                        await api.saveMember({ ...member, active: !member.active });
                        await load();
                      }}
                    >
                      {member.active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 style={{ marginTop: '1rem' }}>Add a member</h3>
        <form
          className="row"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await api.saveMember(newMember);
              setNewMember({ name: '', email: '', team: '', role: 'COMMITTEE' });
              setMessage('Member added.');
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Could not add the member');
            }
          }}
        >
          <div className="grow field">
            <label htmlFor="m-name">Name</label>
            <input id="m-name" type="text" required value={newMember.name} onChange={(e) => setNewMember({ ...newMember, name: e.target.value })} />
          </div>
          <div className="grow field">
            <label htmlFor="m-email">Email</label>
            <input id="m-email" type="email" required value={newMember.email} onChange={(e) => setNewMember({ ...newMember, email: e.target.value })} />
          </div>
          <div className="grow field">
            <label htmlFor="m-team">Team</label>
            <input id="m-team" type="text" value={newMember.team} onChange={(e) => setNewMember({ ...newMember, team: e.target.value })} />
          </div>
          <div className="grow field">
            <label htmlFor="m-role">Role</label>
            <select id="m-role" value={newMember.role} onChange={(e) => setNewMember({ ...newMember, role: e.target.value as Role })}>
              {(['ADMIN', 'COORDINATOR', 'COMMITTEE', 'VIEWER'] as Role[]).map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </div>
          <div style={{ alignSelf: 'end' }} className="field">
            <button type="submit">Add member</button>
          </div>
        </form>
      </section>
    </>
  );
}
