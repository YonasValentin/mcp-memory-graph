import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../server.js';
import { closeDatabase } from '../db/connection.js';
import { getReadWriteDb, getEmbedder } from '../lib/direct-access.js';
import { registerApiRoutes } from '../api/routes.js';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Request, Response, NextFunction } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runServe(): Promise<void> {
  const port = parseInt(process.env.MCP_PORT ?? '3100', 10);

  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const servers: Record<string, McpServer> = {};

  // Express app from SDK (handles JSON parsing, DNS rebinding protection for localhost)
  const app = createMcpExpressApp({ host: '0.0.0.0' });

  // CORS for development (Vite dev server on :5173)
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Bearer token auth middleware (optional — Cloudflare Access is the real security layer)
  if (process.env.MCP_AUTH_TOKEN) {
    app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${process.env.MCP_AUTH_TOKEN}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });
  }

  // ── REST API endpoints ────────────────────────────────────────────────
  registerApiRoutes(app, getReadWriteDb, getEmbedder);

  // Health check for Docker
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // POST /mcp — main MCP handler
  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Existing session — reuse transport
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    // New session — must be an initialize request
    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          delete transports[sid];
          delete servers[sid];
        }
      };

      const server = createServer();
      const sid = transport.sessionId;
      if (sid) {
        servers[sid] = server;
      }

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Invalid request
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Bad Request: No valid session or initialize request' },
      id: null,
    });
  });

  // GET /mcp — SSE stream for existing sessions
  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Bad Request: Invalid or missing session ID' },
        id: null,
      });
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // DELETE /mcp — session termination
  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Bad Request: Invalid or missing session ID' },
        id: null,
      });
      return;
    }
    await transports[sessionId].close();
    delete transports[sessionId];
    delete servers[sessionId];
    res.status(200).end();
  });

  // ── Static file serving for web dashboard ────────────────────────────
  const webDir = path.resolve(__dirname, '..', 'web');
  if (existsSync(webDir)) {
    const { default: express } = await import('express');
    app.use(express.static(webDir));

    // SPA fallback — serve index.html for client-side routes
    // Express v5 requires named wildcards: {*path} instead of *
    app.get('{*path}', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/mcp') || req.path === '/health') {
        return next();
      }
      const indexPath = path.join(webDir, 'index.html');
      if (existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        next();
      }
    });
    console.error(`Web dashboard: http://localhost:${port}`);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.error('Shutting down MCP HTTP server...');
    for (const sid of Object.keys(transports)) {
      await transports[sid].close();
      delete transports[sid];
      delete servers[sid];
    }
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  app.listen(port, '0.0.0.0', () => {
    console.error(`MCP Memory Server running on http://0.0.0.0:${port}`);
    console.error(`Health check: http://localhost:${port}/health`);
  });
}
