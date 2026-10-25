import { Refine, useList, useUpdate } from '@refinedev/core';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { dataProvider } from './data-provider.ts';

function Plugins() {
  const [q, setQ] = useState('');
  const { result, query } = useList({ resource: 'plugins', filters: [{ field: 'q', operator: 'eq', value: q }] });
  const { mutate } = useUpdate();
  if (query.isLoading) return <p>carregando</p>;
  return (
    <section>
      <input id="filtro" value={q} onChange={(e) => setQ(e.target.value)} placeholder="filtro" />
      <table id="plugins">
        <tbody>
          {result.data.map((p) => (
            <tr key={String(p.name)}>
              <td>{String(p.name)}</td>
              <td>{String(p.version)}</td>
              <td>
                <button type="button" onClick={() => mutate({ resource: 'plugins', id: String(p.name), values: { enabled: !p.enabled } })}>
                  {p.enabled ? 'ligado' : 'desligado'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p id="total">total {result.total}</p>
    </section>
  );
}

// Formulário de config gerado do JSON Schema que a própria spec publica (componente Plugin).
function ConfigForm() {
  const [schema, setSchema] = useState<object>();
  const [sent, setSent] = useState('');
  useEffect(() => {
    fetch('/api/openapi.json').then((r) => r.json()).then((d) => setSchema(d.components.schemas.Plugin));
  }, []);
  if (!schema) return null;
  return (
    <div id="config">
      <Form schema={schema} validator={validator} onSubmit={({ formData }) => setSent(JSON.stringify(formData))} />
      <pre id="enviado">{sent}</pre>
    </div>
  );
}

function Logs() {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const es = new EventSource('/api/logs/stream');
    es.addEventListener('log', (e) => setLines((l) => [...l, JSON.parse(e.data).msg]));
    return () => es.close();
  }, []);
  return <ul id="sse">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>;
}

createRoot(document.getElementById('root')!).render(
  <Refine dataProvider={dataProvider} resources={[{ name: 'plugins' }]}>
    <Plugins />
    <ConfigForm />
    <Logs />
  </Refine>,
);
