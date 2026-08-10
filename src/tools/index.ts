import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWhoami } from './whoami.js';
import { registerProjects } from './projects.js';
import { registerMrs } from './mrs.js';
import { registerDiff } from './diff.js';
import { registerDiscussions } from './discussions.js';
import { registerWrite } from './write.js';

export function registerAll(server: McpServer): void {
  registerWhoami(server); // 1
  registerProjects(server); // 2
  registerMrs(server); // 3, 4, 5
  registerDiff(server); // 6
  registerDiscussions(server); // 7
  registerWrite(server); // 8, 9, 10
}
