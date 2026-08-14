import { useEffect, useState } from 'react';
import { ROLES, api, formatDateTime, type AppConfig, type Category, type Member, type Role, type Round } from '../api';

/**
 * §14 config-driven: categories, weights, thresholds (16 / 5 / 6 / 1.8), cadence,
 * effort mapping, JIRA field ids and the committee are all editable settings.
 */
/**
 * Freemail domains publish a strict DMARC policy, so mail sent "as" one of
 * them through an unrelated relay is rejected by the recipient - and the relay
 * still reports success. Catch it here rather than let it fail silently.
 */
const STRICT_SENDER_DOMAINS: Record<string, string> = {
  'hotmail.com': 'smtp-mail.outlook.com',
  'outlook.com': 'smtp-mail.outlook.com',
  'live.com': 'smtp-mail.outlook.com',
  'gmail.com': 'smtp.gmail.com',
  'googlemail.com': 'smtp.gmail.com',
  'yahoo.com': 'smtp.mail.yahoo.com',
  'icloud.com': 'smtp.mail.me.com',
  'aol.com': 'smtp.aol.com',
};

function dmarcMismatch(from: string | undefined, host: string | undefined): boolean {
  if (!from || !host) return false;
  const domain = from.split('@')[1]?.toLowerCase();
  const expected = domain ? STRICT_SENDER_DOMAINS[domain] : undefined;
  return Boolean(expected) && host.toLowerCase() !== expected;
}

type MemberSortKey = 'name' | 'email' | 'team' | 'role' | 'active';

const MEMBER_COLUMNS: Array<[MemberSortKey, string]> = [
  ['name', 'Name'],
  ['email', 'Email'],
  ['team', 'Team'],
  ['role', 'Role'],
  ['active', 'Active'],
];

export function SettingsPage({ member }: { member: Member }) {
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
    smtpHost: string;
    graphSendEnabled: boolean;
    authMode: string;
    aiDrafting: boolean;
    aiModel: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [newMember, setNewMember] = useState({ name: '', email: '', team: '', role: 'COMMITTEE' as Role });
  const [sort, setSort] = useState<{ key: MemberSortKey; ascending: boolean }>({ key: 'name', ascending: true });
  const [resetPhrase, setResetPhrase] = useState('');
  const [resetting, setResetting] = useState(false);
  /** Deleting one round rather than all of them. */
  const [rounds, setRounds] = useState<Round[]>([]);
  const [roundToDelete, setRoundToDelete] = useState('');
  const [deletingRound, setDeletingRound] = useState(false);
  /** What the JIRA workflow actually offers, so the name is chosen not guessed. */
  const [transitions, setTransitions] = useState<Array<{ name: string; toStatus: string }> | null>(null);

  async function load() {
    try {
      const [{ config, categories, integrations }, { members }, roundList] = await Promise.all([
        api.config(),
        api.members(),
        api.rounds().then((r) => r.rounds, () => [] as Round[]),
      ]);
      setConfig(config);
      setCategories(categories);
      setIntegrations(integrations);
      setMembers(members);
      setRounds(roundList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load settings');
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (error && !config) return <p className="status error">{error}</p>;
  if (!config) return <p>Loading…</p>;

  /** Same column twice flips the direction; a new column starts ascending. */
  function sortBy(key: MemberSortKey) {
    setSort((current) => (current.key === key ? { key, ascending: !current.ascending } : { key, ascending: true }));
  }

  const sortedMembers = [...members].sort((a, b) => {
    const direction = sort.ascending ? 1 : -1;
    if (sort.key === 'active') {
      // Booleans have no useful collation, so order by state and then by name -
      // otherwise the inactive block arrives in whatever order the API sent.
      if (a.active !== b.active) return (a.active ? -1 : 1) * direction;
      return a.name.localeCompare(b.name, 'en-GB');
    }
    const compared = a[sort.key].localeCompare(b[sort.key], 'en-GB', { sensitivity: 'base' });
    // Ties fall back to name so the order is stable and predictable: sorting by
    // role should not shuffle people about within a role.
    return (compared || a.name.localeCompare(b.name, 'en-GB')) * direction;
  });

  async function saveMemberField(input: Parameters<typeof api.saveMember>[0]) {
    setMessage('');
    setError('');
    try {
      await api.saveMember(input);
      setMessage('Member updated.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the member');
      await load();
    }
  }

  async function removeMember(member: Member) {
    setMessage('');
    setError('');
    try {
      const { count } = await api.memberSubmissionCount(member.id);
      const warning =
        count > 0
          ? `Delete ${member.name}? Their ${count} submission(s) go too, which changes the results of any round still open. Finalised rounds keep their frozen figures.`
          : `Delete ${member.name}?`;
      if (!window.confirm(warning)) return;
      const { submissionsRemoved } = await api.deleteMember(member.id, count > 0);
      setMessage(
        `${member.name} deleted${submissionsRemoved ? `, along with ${submissionsRemoved} submission(s)` : ''}.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the member');
    }
  }

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
              <p className="hint">
                How far apart the committee’s totals (out of 70) can be before a ticket is flagged for a meeting.
                Above this it is marked “Discussion needed” and held back from estimation.
              </p>
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
        <h2 style={{ marginTop: 0 }}>Card drafting</h2>
        <p className="hint">
          {integrations?.aiDrafting
            ? `On. Cards are drafted by reading the whole ticket (${integrations.aiModel}). Only the ticket's own text is sent — no scores, no committee names. Every draft still needs a coordinator to check it.`
            : 'Off. Cards are drafted from the headings in the JIRA description, which works when a ticket is written in sections and finds little when it is not. Set ANTHROPIC_API_KEY to draft from the whole ticket instead.'}
        </p>
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
              <label htmlFor="transitionName">Move the ticket on after writing the score</label>
              <input id="transitionName" name="transitionName" type="text" defaultValue={config.jira.transitionName} />
              <label htmlFor="transitionOnFinalise" style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.4rem' }}>
                <input id="transitionOnFinalise" name="transitionOnFinalise" type="checkbox" defaultChecked={config.jira.transitionOnFinalise} />
                Run this transition when the score is written (on by default)
              </label>
              <p className="hint">
                The name exactly as the JIRA workflow spells it — either the transition’s own name or the status it
                leads to. Guessing it wrong is quiet: the score writes, the move fails, and the ticket stays put.
              </p>
              <button
                type="button"
                className="secondary"
                style={{ marginTop: '0.4rem' }}
                onClick={async () => {
                  setError('');
                  setMessage('');
                  try {
                    const { jiraId, transitions } = await api.jiraTransitions();
                    setTransitions(transitions);
                    setMessage(
                      transitions.length
                        ? `${jiraId} currently offers ${transitions.length} transition(s). Pick one below.`
                        : `${jiraId} offers no transitions from its current status.`,
                    );
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Could not read the workflow');
                  }
                }}
              >
                List transitions from JIRA
              </button>
              {transitions?.length ? (
                <div className="row" style={{ flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.5rem' }}>
                  {transitions.map((t) => (
                    <button
                      type="button"
                      key={`${t.name}->${t.toStatus}`}
                      className="secondary"
                      onClick={() => {
                        const field = document.getElementById('transitionName') as HTMLInputElement | null;
                        // The status is the more stable of the two - a workflow
                        // gets its transitions renamed far more often than its
                        // statuses - so that is what gets filled in.
                        if (field) field.value = t.toStatus || t.name;
                        setMessage('Filled in. Save the JIRA configuration to keep it.');
                      }}
                    >
                      {t.name}
                      {t.toStatus && t.toStatus !== t.name ? ` → ${t.toStatus}` : ''}
                    </button>
                  ))}
                </div>
              ) : null}
              <p className="hint">
                Only tickets that cleared every gate are moved — enough responses, nobody asking to close it, no
                discussion still outstanding. If the score writes but the move fails, the write-back says so rather
                than calling the whole thing failed.
              </p>
            </div>
          </div>
          <div className="row">
            <button type="submit">Save JIRA configuration</button>
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                setError('');
                setMessage('');
                try {
                  // Look the ids up and save them, rather than printing them
                  // for the coordinator to copy across by hand.
                  const { suggestions } = await api.suggestJiraFields();
                  const found = Object.entries(suggestions).filter(([, v]) => v);
                  if (!found.length) {
                    setError('JIRA returned no matching fields. Check the field names on your site.');
                    return;
                  }
                  await api.saveConfig('jira', {
                    businessScoreFieldId: suggestions.businessScoreFieldId || undefined,
                    siteAffectedFieldId: suggestions.siteAffectedFieldId || undefined,
                    originalTestingEnvironmentFieldId: suggestions.originalTestingEnvironmentFieldId || undefined,
                    ticketPhaseFieldId: suggestions.ticketPhaseFieldId || undefined,
                  });
                  await api.saveConfig('scoring', {
                    effort: {
                      backendFieldId: suggestions.backendFieldId || undefined,
                      frontendFieldId: suggestions.frontendFieldId || undefined,
                    },
                  });
                  const missing = Object.entries(suggestions)
                    .filter(([, v]) => !v)
                    .map(([k]) => k.replace(/FieldId$/, ''));
                  setMessage(
                    `Saved ${found.length} field id(s) from JIRA.${missing.length ? ` Not found: ${missing.join(', ')}.` : ''}`,
                  );
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Could not reach JIRA');
                }
              }}
            >
              Find and save field ids from JIRA
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
            {dmarcMismatch(integrations?.emailFrom, integrations?.smtpHost) ? (
              <div className="notice warn">
                <strong>This sender will not deliver.</strong> You are sending as{' '}
                <strong>{integrations?.emailFrom}</strong> through {integrations?.smtpHost}. Providers like Hotmail,
                Outlook, Gmail and Yahoo tell the world to reject mail sent on their behalf by anyone else, so recipients
                — especially Microsoft 365 accounts — will silently discard it. The relay will still report success.
                <br />
                <br />
                Either send from an address on a domain you control and have authenticated with your provider, or use
                that mailbox&apos;s own SMTP server (for Gmail: <code>smtp.gmail.com</code> with an app password, sending
                as the same Gmail address).
              </div>
            ) : null}
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
                  ? `Handed to ${result.provider} for ${result.to}. That only means the relay accepted it — if nothing arrives, check the provider's own delivery log.`
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
        <h2 style={{ marginTop: 0 }}>Run the round automatically</h2>
        <p className="hint">
          The app can run the weekly cycle itself, on the Cadence below. Every step is separate, so you can let it
          create and chase a round long before you let it write to JIRA — and nothing here removes a button. Doing a
          step yourself just means automation finds it already done, and any round can be paused on its own page.
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const on = (name: string) => form.get(name) === 'on';
            saveSection(
              'automation',
              {
                enabled: on('enabled'),
                createRounds: on('createRounds'),
                importFromJira: on('importFromJira'),
                rollOverUnscored: on('rollOverUnscored'),
                distribute: on('distribute'),
                remind: on('remind'),
                close: on('close'),
                finalise: on('finalise'),
                writeBack: on('writeBack'),
                finaliseDelayHours: Number(form.get('finaliseDelayHours')),
              },
              'Automation',
            );
          }}
        >
          <label className="check strong">
            <input type="checkbox" name="enabled" defaultChecked={config.automation.enabled} />
            <span>
              <strong>Run the cycle automatically</strong>
              <span className="hint">
                Master switch. With this off, everything below is ignored and every step stays manual.
              </span>
            </span>
          </label>

          <div className="switches">
            {(
              [
                ['createRounds', 'Create next week’s round', 'On the distribution day, so one always exists to fill.'],
                ['importFromJira', 'Fill it from the JIRA queue', 'Imports whatever is sitting in the configured queue.'],
                [
                  'rollOverUnscored',
                  'Roll over tickets that missed the minimum',
                  'Carries forward anything that finalised on too few responses.',
                ],
                ['distribute', 'Open it and email the committee', 'At the opening time on the round.'],
                ['remind', 'Chase non-responders', 'At the reminder hours set in Cadence.'],
                ['close', 'Close scoring at the cut-off', 'Nobody can score after this.'],
                ['finalise', 'Finalise and freeze the results', 'Opens the anonymised feedback view.'],
                ['writeBack', 'Write the scores to JIRA', 'And transition the ticket, if that is switched on under JIRA.'],
              ] as const
            ).map(([name, label, hint]) => (
              <label className="check" key={name}>
                <input type="checkbox" name={name} defaultChecked={config.automation[name]} />
                <span>
                  {label}
                  <span className="hint">{hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="field" style={{ maxWidth: 280 }}>
            <label htmlFor="finaliseDelayHours">Wait before finalising (hours)</label>
            <input
              id="finaliseDelayHours"
              name="finaliseDelayHours"
              type="number"
              min={0}
              max={72}
              step={1}
              defaultValue={config.automation.finaliseDelayHours}
            />
            <p className="hint">
              Grace after the cut-off. A late submission still counts inside it, and you get a look before the results
              are frozen and sent to JIRA.
            </p>
          </div>

          <button type="submit">Save automation</button>
        </form>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Cadence</h2>
        <p className="hint">
          Distribution and reminders are scheduled around these, not hard-coded weekdays. Times are read as wall-clock
          time in the timezone below.
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
                {MEMBER_COLUMNS.map(([key, label]) => (
                  <th scope="col" key={key} aria-sort={sort.key === key ? (sort.ascending ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" className="sort" onClick={() => sortBy(key)}>
                      {label}
                      <span aria-hidden="true" className={`arrow${sort.key === key ? ' on' : ''}`}>
                        {sort.key === key && !sort.ascending ? '↓' : '↑'}
                      </span>
                    </button>
                  </th>
                ))}
                <th scope="col">
                  <span className="visually-hidden">Delete</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedMembers.map((member) => (
                <tr key={member.id}>
                  <td>
                    <input
                      type="text"
                      aria-label={`Name for ${member.name}`}
                      defaultValue={member.name}
                      onBlur={async (event) => {
                        const name = event.target.value.trim();
                        if (!name || name === member.name) return;
                        await saveMemberField({ ...member, name });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="email"
                      aria-label={`Email for ${member.name}`}
                      defaultValue={member.email}
                      onBlur={async (event) => {
                        const email = event.target.value.trim();
                        if (!email || email === member.email) return;
                        await saveMemberField({ ...member, email });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      aria-label={`Team for ${member.name}`}
                      defaultValue={member.team}
                      onBlur={async (event) => {
                        const team = event.target.value.trim();
                        if (team === member.team) return;
                        await saveMemberField({ ...member, team });
                      }}
                    />
                  </td>
                  <td>
                    <select
                      aria-label={`Role for ${member.name}`}
                      value={member.role}
                      onChange={async (event) => {
                        await api.saveMember({ ...member, role: event.target.value as Role });
                        await load();
                      }}
                    >
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <label
                      htmlFor={`member-active-${member.id}`}
                      style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center', fontWeight: 400, marginBottom: 0 }}
                    >
                      <input
                        id={`member-active-${member.id}`}
                        type="checkbox"
                        checked={member.active}
                        onChange={async (event) => {
                          await saveMemberField({ ...member, active: event.target.checked });
                        }}
                      />
                      {member.active ? 'Active' : 'Inactive'}
                    </label>
                  </td>
                  <td>
                    <button className="danger" onClick={() => removeMember(member)}>
                      Delete
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
              {ROLES.map((role) => (
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

      {member.role === 'ADMIN' ? (
        <section className="card" style={{ borderColor: 'var(--danger)' }}>
          <h2 style={{ marginTop: 0, color: 'var(--danger)' }}>Delete a round</h2>
          <p>
            Removes one round and everything recorded against it — its scores, results, discussions, emails and
            write-back history. <strong>The tickets themselves are kept</strong>, because a ticket comes from JIRA and
            usually appears in more than one round.
          </p>
          <p className="hint">
            For a test round, or one created twice. Anything already written to JIRA stays there — this database is the
            only thing being cleared.
          </p>
          {rounds.length ? (
            <div className="row">
              <div className="grow field">
                <label htmlFor="round-to-delete">Round</label>
                <select id="round-to-delete" value={roundToDelete} onChange={(e) => setRoundToDelete(e.target.value)}>
                  <option value="">Choose a round…</option>
                  {rounds.map((round) => (
                    <option key={round.id} value={round.id}>
                      {round.weekLabel} — {round.status}, {round.ticketCount ?? 0} tickets, cut-off{' '}
                      {formatDateTime(round.cutOffAt)}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ alignSelf: 'end' }} className="field">
                {/*
                  One confirm naming the round, and no phrase to type. Whoever
                  runs the process knows which round they picked; the dialog is
                  there to catch the mis-click, not to test their resolve.
                */}
                <button
                  type="button"
                  className="danger"
                  disabled={!roundToDelete || deletingRound}
                  onClick={async () => {
                    const round = rounds.find((r) => r.id === roundToDelete);
                    if (!round) return;
                    if (!window.confirm(`Delete ${round.weekLabel} and every score in it? This cannot be undone.`)) return;
                    setDeletingRound(true);
                    setMessage('');
                    setError('');
                    try {
                      const { deleted } = await api.deleteRound(round.id);
                      setMessage(
                        `${deleted.weekLabel} deleted — ${deleted.tickets} ticket(s) unlinked, ${deleted.submissions} score(s) removed${
                          deleted.writebacks
                            ? `. ${deleted.writebacks} score(s) had already gone to JIRA and are still there.`
                            : '.'
                        }`,
                      );
                      setRoundToDelete('');
                      await load();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Could not delete the round');
                    } finally {
                      setDeletingRound(false);
                    }
                  }}
                >
                  {deletingRound ? 'Deleting…' : 'Delete this round'}
                </button>
              </div>
            </div>
          ) : (
            <p className="hint">There are no rounds to delete.</p>
          )}
        </section>
      ) : null}

      {member.role === 'ADMIN' ? (
        <section className="card" style={{ borderColor: 'var(--danger)' }}>
          <h2 style={{ marginTop: 0, color: 'var(--danger)' }}>Start afresh</h2>
          <p>
            Deletes <strong>every round, ticket, score, result, email log entry and JIRA write-back record</strong>.
            Your committee, the seven categories and all settings are kept. The audit log is kept too.
          </p>
          <p className="hint">There is no undo. Type the phrase to enable the button.</p>
          <div className="row">
            <div className="grow field">
              <label htmlFor="reset-confirm">Type DELETE ALL ROUNDS</label>
              <input
                id="reset-confirm"
                type="text"
                value={resetPhrase}
                onChange={(e) => setResetPhrase(e.target.value)}
                placeholder="DELETE ALL ROUNDS"
                autoComplete="off"
              />
            </div>
            <div style={{ alignSelf: 'end' }} className="field">
              <button
                type="button"
                className="danger"
                disabled={resetPhrase !== 'DELETE ALL ROUNDS' || resetting}
                onClick={async () => {
                  if (!window.confirm('Delete every round, ticket and score? This cannot be undone.')) return;
                  setResetting(true);
                  setMessage('');
                  setError('');
                  try {
                    const { counts } = await api.resetData(resetPhrase);
                    setResetPhrase('');
                    setMessage(
                      `Cleared: ${counts.rounds} round(s), ${counts.tickets} ticket(s), ${counts.submissions} submission(s), ${counts.scores} category score(s).`,
                    );
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Could not clear the data');
                  } finally {
                    setResetting(false);
                  }
                }}
              >
                {resetting ? 'Clearing…' : 'Delete all rounds, tickets and scores'}
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
