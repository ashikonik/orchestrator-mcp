#!/usr/bin/env node
/**
 * The entry point — the ONLY file that knows about the transport.
 *
 * Everything above this file is transport-independent, so the same server
 * can be driven over stdio here or in-process by a test.
 *
 * Nothing may be written to stdout: on the stdio transport stdout *is*
 * the protocol stream, and a stray `console.log` corrupts it. All
 * logging goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { resolveCall } from './root.js';

function log(msg: string): void {
  process.stderr.write(`[orchestrator] ${msg}\n`);
}

async function main(): Promise<void> {
  // The root is resolved per call, so a bad cwd here is normal rather
  // than fatal. The server is registered once and used in many projects.
  const res = resolveCall();
  log(`project root: ${res.root} (${res.source})`);
  if (res.note) log(res.note);

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('ready');
}

main().catch((e) => {
  log(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
