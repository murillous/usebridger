const b = process.argv[2];
const d = await (await fetch(b + '/openapi.json')).json();
(await import('node:fs')).writeFileSync(process.argv[3], JSON.stringify(d, null, 2));
console.log(d.openapi, Object.keys(d.paths), Object.keys(d.components?.schemas ?? {}));
console.log(JSON.stringify(d.paths['/plugins'].get.responses['200']));
console.log(JSON.stringify(d.paths['/logs/stream']?.get.responses['200']));
const r = await fetch(b + '/echo/stats'); console.log('late', r.status, await r.text());
