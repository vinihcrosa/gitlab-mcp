// Registro de tool + tradução de exceção em resultado de erro legível.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { isReadOnly } from '../config.js';
import { ToolError, messageOf } from '../errors.js';

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export function tool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: ZodRawShape,
  handler: ToolHandler,
): void {
  const cb = async (args: unknown) => {
    try {
      const text = await handler((args ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: messageOf(e) }], isError: true };
    }
  };
  // O SDK tipa o callback a partir do shape; aqui o handler é genérico de propósito.
  (server.registerTool as unknown as (n: string, c: unknown, h: unknown) => void)(
    name,
    { description, inputSchema },
    cb,
  );
}

/** Guarda das 3 tools de escrita. Mensagem exata, sem variação. */
export function assertWritable(): void {
  if (isReadOnly()) {
    throw new ToolError('Escrita desabilitada. Defina GITLAB_READ_ONLY=false para habilitar.');
  }
}
