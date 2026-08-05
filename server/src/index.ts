import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { assertProductionSafety, env } from './config/env.js';
import { closeDb, getDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { attachMember } from './auth/middleware.js';
import { ensureDefaultConfig, ensureSeedCategories } from './services/configService.js';
import { seedBase, seedDemo } from './db/seed.js';
import { getMemberByEmail, saveMember } from './services/memberService.js';
import authRoutes from './routes/auth.js';
import auditRoutes from './routes/audit.js';
import configRoutes from './routes/config.js';
import memberRoutes from './routes/members.js';
import roundRoutes from './routes/rounds.js';
import scoringRoutes from './routes/scoring.js';
import ticketRoutes from './routes/tickets.js';
import { errorHandler } from './routes/helpers.js';

export async function createApp() {
  assertProductionSafety();

  const db = await getDb();
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);

  // A fresh instance has no members, and sign-in requires one - so without
  // this nobody could get in to add the committee.
  if (env.bootstrapAdminEmail) {
    const existing = await getMemberByEmail(db, env.bootstrapAdminEmail);
    if (!existing) {
      const admin = await saveMember(db, {
        name: env.bootstrapAdminName || env.bootstrapAdminEmail,
        email: env.bootstrapAdminEmail,
        team: 'Administrator',
        role: 'ADMIN',
      });
      console.log(`[bis] bootstrapped admin ${admin.email}`);
    } else if (existing.role !== 'ADMIN' || !existing.active) {
      // Recovery path: if the only admin was demoted or deactivated by
      // accident, setting the variable and restarting restores access.
      await saveMember(db, { ...existing, role: 'ADMIN', active: true });
      console.log(`[bis] restored admin rights for ${existing.email}`);
    }
  }

  if (env.seedOnBoot) {
    await seedBase(db);
    // Only on a genuinely empty instance, so a restart never duplicates or
    // disturbs a round someone is part-way through.
    const rounds = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM rounds');
    if (env.seedOnBoot === 'demo' && Number(rounds?.count ?? 0) === 0) {
      const roundId = await seedDemo(db);
      console.log(`[bis] seeded sample round ${roundId}`);
    }
  }

  const app = express();
  app.set('trust proxy', 1); // Azure App Service sits behind a reverse proxy
  app.use(express.json({ limit: '4mb' }));
  app.use(cookieParser());
  app.use(
    cors({
      origin: env.publicWebOrigin,
      credentials: true,
    }),
  );
  app.use(attachMember);

  app.get('/healthz', (_req, res) => res.json({ ok: true, db: db.dialect, auth: env.auth.mode }));

  app.use('/auth', authRoutes);
  app.use('/api', memberRoutes);
  app.use('/api', configRoutes);
  app.use('/api', ticketRoutes);
  app.use('/api', roundRoutes);
  app.use('/api', scoringRoutes);
  app.use('/api', auditRoutes);

  // Single-deployment mode: serve the built React app if it is present.
  const webDist = path.resolve(env.serverRoot, '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/(api|auth|healthz)).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}

const isDirectRun = process.argv[1]?.includes('index');
if (isDirectRun) {
  const app = await createApp();
  const server = app.listen(env.port, () => {
    console.log(`[bis] API listening on :${env.port} (auth=${env.auth.mode}, db=${env.db.driver})`);
  });

  const shutdown = async () => {
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
