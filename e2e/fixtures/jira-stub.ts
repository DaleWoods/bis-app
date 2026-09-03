import { createServer, type Server } from 'node:http';

interface StubIssue {
  key: string;
  fields: Record<string, unknown>;
}

/**
 * Stands in for JIRA Cloud for the write-back and queue tests. Answers only
 * the endpoints this app actually calls: field discovery, the paginated
 * search used by the queue, business-score writes, and transitions. Nothing
 * here needs to be a faithful JIRA clone - it needs to be enough for this
 * app's own client code to complete a full round trip.
 *
 * Returns a Promise that resolves once the socket is actually bound -
 * `server.listen()` returns before the 'listening' event fires, so a caller
 * that does not wait for it can reach its first request before the port is
 * really open, and see a flaky ECONNREFUSED that has nothing to do with the
 * thing the test is checking.
 */
export function startJiraStub(port: number, issues: StubIssue[] = []): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');

      if (req.url === '/rest/api/3/field' && req.method === 'GET') {
        res.end(
          JSON.stringify([
            { id: 'customfield_101', name: 'Business Score', custom: true },
            { id: 'customfield_102', name: 'Backend Poker Score', custom: true },
            { id: 'customfield_103', name: 'Frontend Poker Score', custom: true },
          ]),
        );
        return;
      }

      if (req.url === '/rest/api/3/search/jql' && req.method === 'POST') {
        res.end(JSON.stringify({ issues, isLast: true }));
        return;
      }

      if (req.url?.includes('/transitions') && req.method === 'GET') {
        res.end(JSON.stringify({ transitions: [{ id: '1', name: 'Rdy Estimation' }] }));
        return;
      }

      // Business-score writes, transitions, and anything else this app PUTs
      // or POSTs to a specific issue - a bare 200 with an empty body is a
      // valid, successful JIRA response for all of these.
      res.end(JSON.stringify({}));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}
