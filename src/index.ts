#!/usr/bin/env node
// ============================================================================
// ⚠️  NUNCA ESCREVA EM STDOUT NESTE PROCESSO.
//
// stdout é o canal do protocolo MCP. Um único console.log corrompe a sessão
// inteira, e o sintoma é um erro de parse JSON incompreensível do lado do
// client. Todo log vai para console.error / stderr. Sem exceção.
// ============================================================================
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { initHttp, log } from './gitlab.js';
import { registerAll } from './tools/index.js';

async function main(): Promise<void> {
  const cfg = loadConfig(); // sai com código 1 se faltar GITLAB_URL/GITLAB_TOKEN
  initHttp();

  const server = new McpServer({ name: 'gitlab-mcp', version: '0.1.0' });
  registerAll(server);

  await server.connect(new StdioServerTransport());

  log(`conectado a ${cfg.url} | modo ${cfg.readOnly ? 'read-only' : 'ESCRITA HABILITADA'} | timeout ${cfg.timeoutMs}ms`);
  if (cfg.readOnly) {
    log('tools de escrita desabilitadas. Defina GITLAB_READ_ONLY=false para habilitar.');
  }
}

main().catch((e: unknown) => {
  console.error('[gitlab-mcp] falha fatal no boot:', e instanceof Error ? e.message : e);
  process.exit(1);
});
