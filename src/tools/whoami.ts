import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gl } from '../gitlab.js';
import { json } from '../format.js';
import { tool } from './register.js';

export interface Me {
  id: number;
  username: string;
  name: string;
  web_url: string;
}

let cached: Me | null = null;

/**
 * Cacheado no processo. Outras tools chamam isso internamente — o modelo nunca
 * precisa chamar whoami antes de list_mrs_awaiting_my_review.
 */
export async function getMe(): Promise<Me> {
  if (cached) return cached;
  const { data } = await gl<Me & Record<string, unknown>>('/user', {
    resource: 'o usuário do token (GET /user)',
  });
  cached = { id: data.id, username: data.username, name: data.name, web_url: data.web_url };
  return cached;
}

export function registerWhoami(server: McpServer): void {
  tool(
    server,
    'whoami',
    [
      'Retorna a identidade do Personal Access Token configurado (id, username, name, web_url).',
      'Use para validar que o token funciona antes de investigar outros erros, ou quando precisar saber qual é o seu username.',
      'Não use antes de list_mrs_awaiting_my_review: aquela tool já descobre o username sozinha.',
    ].join(' '),
    {},
    async () => json(await getMe()),
  );
}
