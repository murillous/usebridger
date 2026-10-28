import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { SchemaForm } from '#web/components/SchemaForm.tsx';
import { ErrorNotice } from '#web/components/ui.tsx';
import { ApiProblem, api, unwrap } from '#web/lib/client.ts';
import {
  buildOverrides,
  type ConfigView,
  configUi,
  fieldErrors,
  formSchema,
} from '#web/lib/config.ts';
import type { JsonSchema } from '#web/lib/spec.ts';
import { useCan } from '#web/lib/viewer.ts';

/**
 * Config de um plugin: formulário gerado do JSON Schema do `GET /plugins/{name}/config`. Salvar
 * manda os overrides no `PUT`, e o plugin recarrega com eles.
 */
export function PluginConfig({ name }: { name: string }) {
  const can = useCan();
  const queries = useQueryClient();
  const key = ['config', name];
  const config = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api().GET('/api/plugins/{name}/config', { params: { path: { name } } })),
  });
  // Edição guardada fora do form: um refetch não apaga o que a pessoa digitou.
  const [edited, setEdited] = useState<unknown>();
  const save = useMutation({
    mutationFn: (overrides: Record<string, unknown>) =>
      unwrap(
        api().PUT('/api/plugins/{name}/config', {
          params: { path: { name } },
          body: overrides,
        }),
      ),
    onSuccess: (data) => {
      queries.setQueryData(key, data);
      setEdited(undefined);
    },
  });

  const data = config.data;
  const view: ConfigView | undefined = data?.view
    ? { ...data.view, config: data.view.config ?? {} }
    : undefined;
  // Config inválida (`view: null`): sem as fontes, salvar substitui todos os overrides.
  const base: ConfigView = view ?? { config: {}, messages: {}, sources: {} };
  const schema = data?.schema as JsonSchema | null | undefined;
  const issues = save.error instanceof ApiProblem ? save.error.errors : (data?.issues ?? []);

  return (
    <section aria-labelledby="cfg-t">
      <div className="page-head">
        <h1 id="cfg-t">Config de {name}</h1>
        <a href="#/plugins">Voltar aos plugins</a>
      </div>
      <ErrorNotice error={config.error} />
      {data && schema === null && <p className="muted">Este plugin não tem config.</p>}
      {data && !view && (
        <p className="notice warn">
          A config atual é inválida. Corrija os campos marcados; salvar substitui todos os overrides
          deste plugin.
        </p>
      )}
      {data && !data.secretsWritable && (
        <p className="muted">
          Segredos novos pedem <span className="mono">BRIDGER_SECRET_KEY</span> no bot.
        </p>
      )}
      {schema && (
        <div className="card">
          <SchemaForm
            schema={formSchema(schema)}
            uiSchema={configUi(schema, base.sources)}
            formData={edited ?? base.config}
            extraErrors={fieldErrors(issues)}
            submitLabel="Salvar e recarregar"
            busy={save.isPending || !can('config.write')}
            onChange={setEdited}
            onSubmit={(formData) => {
              if (
                !view &&
                !window.confirm('Salvar substitui todos os overrides deste plugin. Continuar?')
              ) {
                return;
              }
              save.mutate(buildOverrides(base, formData));
            }}
          />
          <ErrorNotice error={save.error} />
          {save.isSuccess && (
            <p className="notice ok" role="status">
              Config salva; o plugin recarregou.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
