import { type CollectionEntry, getCollection } from 'astro:content';
import type { APIRoute, GetStaticPaths } from 'astro';
import { entryToSimpleMarkdown } from 'starlight-llms-txt/entryToSimpleMarkdown';

// O `.md` de cada página ao lado do HTML (`/guias/comandos/` → `/guias/comandos.md`), sem menu
// nem layout, para LLMs lerem uma página só. A conversão é a mesma do `llms-full.txt`: renderiza o
// MDX (componentes como o `<Exemplo>` inclusos) e volta a Markdown; `entry.body` traria o MDX cru.
export const getStaticPaths = (async () => {
  const docs = await getCollection('docs', (doc) => !doc.data.draft);
  // A home tem id vazio; sem nome, a rota viraria `/.md`.
  return docs.map((doc) => ({ params: { slug: doc.id || 'index' }, props: { doc } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ doc: CollectionEntry<'docs'> }> = async (context) => {
  const { doc } = context.props;
  const description = doc.data.hero?.tagline ?? doc.data.description;
  const header = [`# ${doc.data.hero?.title ?? doc.data.title}`];
  if (description) header.push(`> ${description}`);
  const body = await entryToSimpleMarkdown(doc, context);
  return new Response([...header, body].join('\n\n'), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
