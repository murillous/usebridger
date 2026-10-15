/**
 * Trecho de um exemplo entre `// #region nome` e `// #endregion nome`, sem as marcas e sem a
 * indentação comum. O código mostrado no site vem dos arquivos de `examples/` (verificados no CI):
 * se a região some ou é renomeada, o build do site falha em vez de publicar um trecho vazio.
 */
export function extrairRegiao(codigo: string, nome: string): string {
  const linhas = codigo.split('\n');
  const inicio = linhas.findIndex((l) => l.trim() === `// #region ${nome}`);
  const fim = linhas.findIndex((l) => l.trim() === `// #endregion ${nome}`);
  if (inicio === -1 || fim < inicio) throw new Error(`Região "${nome}" não encontrada.`);

  const trecho = linhas.slice(inicio + 1, fim);
  const recuo = Math.min(
    ...trecho.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length),
  );
  return trecho.map((l) => l.slice(Math.min(recuo, l.length))).join('\n');
}
