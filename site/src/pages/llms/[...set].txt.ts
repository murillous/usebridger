import { getCollection } from 'astro:content';
import type { APIRoute, GetStaticPaths } from 'astro';
import { entryToSimpleMarkdown } from 'starlight-llms-txt/entryToSimpleMarkdown';
import { LLMS_SETS, type LlmsSet, pagesOf, renderSetHeader } from '#llms';

// Um arquivo por conjunto de site/scripts/llms.ts (`/llms/topicos/plugin.txt`), com os
// relacionados no topo e as páginas na ordem de leitura. A conversão de cada página é a mesma do
// `llms-full.txt`.
export const getStaticPaths = (() =>
  LLMS_SETS.map((set) => ({ params: { set: set.id }, props: { set } }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ set: LlmsSet }> = async (context) => {
  const { set } = context.props;
  // `en/` é a tradução: os conjuntos são da língua padrão, como o full.
  const docs = await getCollection('docs', (doc) => !doc.data.draft && !doc.id.startsWith('en/'));
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const site = new URL(`${import.meta.env.BASE_URL.replace(/\/?$/, '/')}`, context.site).href;

  const segments = [renderSetHeader(set, site)];
  for (const id of pagesOf(set, [...byId.keys()])) {
    const doc = byId.get(id);
    if (!doc) continue;
    const page = [`# ${doc.data.hero?.title ?? doc.data.title}`];
    const description = doc.data.hero?.tagline ?? doc.data.description;
    if (description) page.push(`> ${description}`);
    page.push(await entryToSimpleMarkdown(doc, context));
    segments.push(page.join('\n\n'));
  }
  return new Response(`${segments.join('\n\n')}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
