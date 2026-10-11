# create-bridger-plugin

Cria a pasta de um plugin do [Bridger](https://www.npmjs.com/package/@usebridger/core) pronta
para desenvolver, testar e publicar.

```sh
npm create bridger-plugin@latest bridger-plugin-ola
pnpm create bridger-plugin @acme/bridger-plugin-ola
```

O único argumento é o nome do pacote npm, com escopo opcional. O projeto gerado traz um comando
`!ola` de exemplo, o teste dele com o `@usebridger/testing` nos quatro perfis de plataforma, o
build com `tsdown` e o changesets configurado. Instala, testa e builda sem edição.

Requer Node 24 ou mais novo.

- [Documentação](https://github.com/murillous/usebridger/blob/main/packages/create-plugin/docs/README.md)
- [Guias para escrever um plugin](https://github.com/murillous/usebridger/blob/main/docs/guias/README.md)

Licença [Apache-2.0](https://github.com/murillous/usebridger/blob/main/LICENSE).
