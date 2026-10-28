import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import type { JsonSchema } from '#web/lib/spec.ts';

export interface SchemaFormProps {
  schema: JsonSchema;
  uiSchema?: Record<string, unknown>;
  formData?: unknown;
  submitLabel: string;
  busy?: boolean;
  /** Erros do servidor por campo (`fieldErrors`). */
  extraErrors?: Record<string, unknown>;
  onSubmit(data: unknown): void;
  onChange?(data: unknown): void;
}

// O `$schema` do draft 2020-12 (o `toJSONSchema` do Zod o põe) faria o ajv do rjsf procurar o
// meta-schema e lançar; o que o form usa é comum aos drafts.
function withoutDialect(schema: JsonSchema): JsonSchema {
  const { $schema, ...rest } = schema;
  return rest;
}

/** Formulário gerado do JSON Schema pelo `@rjsf`. O servidor segue sendo a autoridade. */
export function SchemaForm(props: SchemaFormProps) {
  return (
    <Form
      className="schema-form"
      validator={validator}
      schema={withoutDialect(props.schema)}
      uiSchema={{
        ...props.uiSchema,
        'ui:submitButtonOptions': {
          submitText: props.submitLabel,
          props: { className: 'btn primary', disabled: props.busy === true },
        },
      }}
      formData={props.formData}
      extraErrors={props.extraErrors as never}
      noHtml5Validate
      showErrorList={false}
      onChange={(event) => props.onChange?.(event.formData)}
      onSubmit={(event) => props.onSubmit(event.formData)}
    />
  );
}
