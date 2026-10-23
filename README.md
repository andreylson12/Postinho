# Postinho Fácil — GitHub + Railway

Versão do Postinho Fácil baseada na tela verde de vendas que criamos, adaptada para um projeto normal no GitHub e banco PostgreSQL no Railway. **Edição para upload pelo celular: quatro arquivos necessários na raiz e um guia opcional, sem nenhuma pasta.**

## O que funciona nesta versão

- Tela de venda de gasolina, com botões rápidos de 1, 2, 3, 5, 10, 20 e 50 litros e campo manual.
- Cálculo do preço pelo litro; dinheiro, Pix, cartão e fiado.
- Registro único da venda com identificador próprio: após falha de internet, use **reenviar**, sem abrir outra venda.
- Registro separado do pagamento e da entrega do combustível (marcação manual).
- Área do administrador protegida por senha no servidor; tela de venda consultável sem login.
- Tablet autorizado uma vez pelo proprietário: depois pode registrar vendas sem digitar senha em cada cliente.
- Fechamento automático, litros vendidos, recebidos, lucro estimado, despesas, exportação CSV e contas fiadas.
- Dados compartilhados em PostgreSQL, independentemente do aparelho.
- Ícone e manifest para **Adicionar à tela inicial** pelo navegador Android.

**Importante:** pagamentos Pix/cartão ainda NÃO são cobrados nem confirmados pelo sistema. A Point Smart 2 ainda NÃO está conectada; a pessoa operando precisa confirmar o dinheiro/compensação na maquininha antes de marcar a venda como paga. Não existe controle automático de bomba de combustível. O lucro é estimado e não inclui taxas de cartão, impostos e despesas que não forem informadas.

## Estrutura

| Arquivo | Uso |
| --- | --- |
| `index.html` | Aplicativo visível no tablet e no celular; HTML, CSS e JS em um arquivo |
| `server.js` | Servidor, autenticação, validações e recursos de instalação do aplicativo |
| `package.json` | Dependências e comando de inicialização |
| `package-lock.json` | Versões travadas das dependências |
| `README.md` | Este passo a passo |

Os arquivos do ícone, da instalação no tablet e as regras de cálculo foram incorporados ao `server.js` sem mudança na interface.

## Passo a passo de publicação

### 1. GitHub

1. No GitHub, crie um **novo repositório privado** chamado `postinho-facil`.
2. Baixe e **extraia o ZIP no celular** usando o gerenciador de arquivos.
3. No GitHub pelo navegador, abra o repositório e escolha **Add file → Upload files** (se necessário, ative a versão para computador do navegador).
4. Selecione ou envie um por um os quatro arquivos necessários: `index.html`, `server.js`, `package.json` e `package-lock.json`. O `README.md` é apenas este guia, e seu envio é opcional. Todos devem ficar **na raiz do repositório, sem pastas**. Confirme o upload/commit.
5. **Não envie apenas o ZIP**: o Railway precisa encontrar os arquivos extraídos para executar o sistema.
6. Não suba senha, arquivo `.env` real ou token do Mercado Pago.

### 2. Railway

1. Crie um projeto no Railway e escolha **Deploy from GitHub repo** apontando para `postinho-facil`.
2. No mesmo projeto, clique em **+ New** → **Database** → **PostgreSQL**.
3. Nas variáveis do serviço do aplicativo, adicione:
   - `DATABASE_URL` → referência `${{Postgres.DATABASE_URL}}` (use o nome real do serviço PostgreSQL no Railway).
   - `ADMIN_PASSWORD` → uma senha forte exclusiva, de pelo menos 12 caracteres.
   - `NODE_ENV` → `production`.
4. O Railway deverá detectar Node.js e executar `npm start` conforme `package.json`. O `server.js` cria as tabelas automaticamente na primeira inicialização.
5. Em **Settings → Networking → Public Networking**, gere um domínio HTTPS para o aplicativo.
6. Abra esse endereço no celular ou tablet. **Esse será o link do Postinho Fácil**; o GitHub é o repositório do código. Não é preciso configurar o GitHub Pages.

### 3. Primeiro uso

1. Abra o link no seu celular e toque em **🔐 Área protegida**.
2. Informe sua `ADMIN_PASSWORD` e abra **Ajustes**.
3. Cadastre o preço por litro e o custo da gasolina.
4. No **tablet do postinho**, abra o mesmo link e entre em **🔐 Área protegida**.
5. Vá em **Ajustes → Autorizar este dispositivo** e depois use **Sair da administração**.
6. O tablet passará a registrar vendas, enquanto fechamento, fiados e ajustes só aparecem após login do administrador.
7. Para instalar um atalho, no Chrome Android abra o menu e use **Adicionar à tela inicial / Instalar aplicativo** (a opção exata depende do navegador).

### 4. Proteção, backups e testes

- Ative backups do PostgreSQL no Railway antes de usar o sistema diariamente. Faça uma venda de teste pequena, consulte o fechamento em outro celular, registre um fiado, dê baixa e confira valores.
- O login expira em oito horas; a autorização de tablet expira em até 180 dias. Se perder um aparelho, faça login e use **Revogar todos os dispositivos autorizados**.
- Não compartilhe a senha de administrador com quem opera o tablet. Use senhas diferentes das usadas em outros serviços.
- O botão **Registrar pagamento** significa apenas **confirmação manual pelo atendente**. Não é garantia de pagamento no Mercado Pago.
- Dados do Site anterior e dados de navegador da versão antiga **não são importados automaticamente**. São bancos distintos até uma migração futura.
- GitHub e Railway não tornam o sistema invulnerável. A implantação ainda requer teste real, observação de logs, configuração de backups e revisão antes de movimentar dinheiro.

## Teste local

Requisitos: Node.js 20+ e PostgreSQL acessível.

1. Instale dependências: `npm install`.
2. Ajuste `DATABASE_URL`, `ADMIN_PASSWORD` e `NODE_ENV=development` no ambiente onde o processo será iniciado. **O aplicativo não carrega um arquivo `.env` automaticamente**.
3. Rode `npm start` e abra `http://localhost:3000`.
4. Execute `npm test` para conferir a sintaxe do servidor. Os cálculos já foram comparados com a versão anterior.

## Integração futura da Point Smart 2

O Mercado Pago tem APIs oficiais para os terminais Point Smart 2, mas essa integração exige aplicação/credenciais de produção, identificação do terminal, criação de cobrança e confirmação do resultado no servidor. **Nunca coloque o Access Token no `index.html` ou em um repositório público.**

O próximo estágio será adicionar essa integração ao `server.js` e atualizar a venda para usar status comprovadamente pago antes da etapa de abastecimento.
