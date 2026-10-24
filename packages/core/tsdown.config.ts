import { defineConfig } from 'tsdown';

// Um entry por público (ADR 0030): plugin e app (`@usebridger/core`), transports e storages
// (`@usebridger/core/adapter`) e a suíte de contrato de storage (`@usebridger/core/storage-contract`),
// separada para que quem usa o kernel em produção não carregue código de teste, e o Zod
// (`@usebridger/core/zod`), separado porque carregá-lo cria um global (ADR 0091).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    adapter: 'src/adapter.ts',
    'storage-contract': 'src/storage/contract/index.ts',
    zod: 'src/zod.ts',
    // Binário `bridger-pseudonym` (ADR 0119); ninguém o importa como biblioteca.
    'pseudonym-cli': 'src/cli/pseudonym.ts',
  },
});
