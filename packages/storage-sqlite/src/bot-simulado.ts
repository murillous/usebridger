// Processo filho dos testes: faz o papel do bot, gravando documentos de auth em laço no mesmo
// arquivo SQLite que o processo do teste (que faz o papel da CLI `owner-invite`).
import { sqlite } from './index.ts';

const [path, count] = [process.argv[2] as string, Number(process.argv[3])];
const storage = sqlite({ path });
const sessions = storage.forNamespace('$auth').collection('sessions');
for (let i = 0; i < count; i++) await sessions.insert({ n: i });
await storage.close();
