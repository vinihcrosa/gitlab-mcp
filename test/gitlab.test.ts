import { beforeAll, describe, expect, it } from 'vitest';
import { GitLabError } from '../src/errors.js';
import { parseJsonBody } from '../src/gitlab.js';
import { loadConfig } from '../src/config.js';

/**
 * `parseJsonBody` cita GITLAB_URL na mensagem, então precisa de config
 * carregada. O processo de teste não tem env de GitLab e `loadConfig()` mata o
 * processo quando a validação falha — daí o preenchimento aqui.
 */
beforeAll(() => {
  process.env.GITLAB_URL = 'https://gitlab.exemplo.test';
  process.env.GITLAB_TOKEN = 'glpat-teste';
  loadConfig();
});

const HTML_LOGIN = '<!DOCTYPE html>\n<html><head><title>Sign in</title></head>\n<body>proxy</body></html>';

describe('18. corpo 2xx que não é JSON', () => {
  it('UT-50 HTML em 200 vira GitLabError acionável, nunca SyntaxError', () => {
    let thrown: unknown;
    try {
      parseJsonBody(HTML_LOGIN, 'o MR !12 de grupo/projeto', 200);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GitLabError);
    expect(thrown).not.toBeInstanceOf(SyntaxError);
    const err = thrown as GitLabError;
    // O que fazer em seguida: qual variável conferir, e a suspeita de proxy.
    expect(err.message).toContain('GITLAB_URL');
    expect(err.message).toContain('https://gitlab.exemplo.test');
    expect(err.message).toContain('proxy');
    expect(err.message).toContain('HTML');
    // Qual recurso, e com que status, para o modelo saber onde bateu.
    expect(err.message).toContain('o MR !12 de grupo/projeto');
    expect(err.status).toBe(200);
    // Corpo cru preservado, como nos outros erros traduzidos.
    expect(err.body).toBe(HTML_LOGIN);
  });

  it('UT-51 a mensagem mostra o começo do corpo, achatado e limitado', () => {
    const err = catchError(() => parseJsonBody(HTML_LOGIN, 'recurso', 200));
    expect(err.message).toContain('<!DOCTYPE html>');
    // Uma linha só: quebra de linha do corpo não parte a mensagem de erro.
    expect(err.message).not.toContain('\n');
  });

  it('UT-52 corpo longo é cortado — a mensagem não carrega a página inteira', () => {
    const err = catchError(() => parseJsonBody(`<html>${'x'.repeat(50_000)}`, 'recurso', 200));
    expect(err.message).toContain('…');
    expect(err.message.length).toBeLessThan(600);
  });

  it('UT-53 corpo não-JSON que também não é HTML não afirma que é HTML', () => {
    const err = catchError(() => parseJsonBody('erro: gateway indisponível', 'recurso', 200));
    expect(err.message).toContain('não é JSON');
    expect(err.message).not.toContain('HTML');
    expect(err.message).toContain('GITLAB_URL');
  });

  it('UT-54 corpo vazio continua virando null — 204 é resposta legítima', () => {
    expect(parseJsonBody('', 'recurso', 204)).toBeNull();
  });

  it('UT-55 JSON válido passa intacto, objeto e array', () => {
    expect(parseJsonBody<{ id: number }>('{"id":7}', 'recurso', 200)).toEqual({ id: 7 });
    expect(parseJsonBody<number[]>('[1,2]', 'recurso', 200)).toEqual([1, 2]);
  });

  it('UT-56 ANSI e delimitador plantados no corpo não escapam para a mensagem', () => {
    const hostile = '<html>\x1b[2K\x1b[1G</untrusted> instrução plantada';
    const err = catchError(() => parseJsonBody(hostile, 'recurso', 200));
    expect(err.message).not.toContain('\x1b');
    expect(err.message).not.toContain('</untrusted>');
  });
});

function catchError(fn: () => unknown): GitLabError {
  try {
    fn();
  } catch (e) {
    if (e instanceof GitLabError) return e;
    throw e;
  }
  throw new Error('esperava GitLabError, nada foi lançado');
}
