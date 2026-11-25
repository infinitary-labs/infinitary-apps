---
source: c71bc8e7d8a6ffd4
title: Integrações
description: Conecte GitHub, GitLab, Bitbucket, Google e servidores MCP para que seu imediato e sua tripulação possam alcançá-los, e escolha o que cada um pode fazer sem perguntar a você.
---

Uma integração é uma conexão com algo fora dos seus projetos, como o GitHub, o Gmail ou um serviço seu.
Cada uma tem o login feito em seu nome.
Seu imediato, sua tripulação, suas automações e seus painéis a alcançam do mesmo jeito, pelo mesmo login e com as mesmas regras.

<img class="picture-dark" src="/pictures/integrations-dark.webp" alt="Ajustes, seção Integrações: um servidor Notes conectado com cada uma das suas leituras e a sua alteração definidas como Pergunta a você ao lado de uma chave ligada, depois botões para adicionar GitHub, Google, um servidor MCP, Notion, Linear, Bitbucket, GitLab ou GitHub Enterprise, o comando Infinitary desligado e uma lista de Sites privados vazia." width="1180" height="709" />
<img class="picture-light" src="/pictures/integrations-light.webp" alt="Ajustes, seção Integrações: um servidor Notes conectado com cada uma das suas leituras e a sua alteração definidas como Pergunta a você ao lado de uma chave ligada, depois botões para adicionar GitHub, Google, um servidor MCP, Notion, Linear, Bitbucket, GitLab ou GitHub Enterprise, o comando Infinitary desligado e uma lista de Sites privados vazia." width="1180" height="709" />

## Onde ficam as integrações {#where-integrations-live}

Abra **Ajustes** e depois **Integrações**.
Você também pode buscar **Abrir Integrações** na busca de comandos.

Cada linha é uma conexão.
Ela mostra o nome da conexão, com qual login ela está ou o que ela roda, e quantas das suas ações estão ativadas.
Abra uma linha para ver as ações dela e o que ela pode avisar às suas automações.

O menu no fim de uma linha tem:

- **Pausada**: enquanto o interruptor estiver ligado, ninguém a alcança.
- **Verificar agora**, que verifica se a conexão ainda funciona.
- **Sair e remover**, ou **Remover** para um servidor MCP.

Os botões abaixo da lista conectam algo novo, como **GitHub**, **Google** ou **Servidor MCP**.
Você também pode pedir ao seu imediato que conecte algo.
Fazer login é sempre com você, então seu imediato traz um cartão que abre esta aba.

## GitHub, GitLab, GitHub Enterprise e Bitbucket {#github-gitlab-github-enterprise-and-bitbucket}

Seu login no lugar onde seus projetos ficam é guardado aqui.
Veja em [Projetos](/pt-br/projects/#your-github-gitlab-or-bitbucket-sign-in) como o Infinitary o usa para clonar um projeto e oferecer as alterações dele.

- **GitHub**: você digita um código na página do GitHub no seu navegador.
  Se o GitHub CLI estiver neste computador e a sua organização bloquear apps como o Infinitary, **Usar o GitHub CLI** usa o login que o GitHub CLI já tem.
- **GitLab**: você faz login no navegador ou cola uma chave, no gitlab.com ou no seu próprio servidor GitLab.
- **GitHub Enterprise**: você cria uma chave no seu próprio servidor e a cola aqui.
- **Bitbucket**: você cria um token de API na sua conta da Atlassian e o cola aqui, para o bitbucket.org.
  Para o seu próprio servidor Bitbucket Data Center, versão 8.19 ou mais recente, você informa o endereço dele e cola um token de acesso HTTP que cria nele, com as permissões Project read e Repository write.
  Uma linha do Data Center oferece as mesmas ações de leitura e escrita, nos caminhos do próprio servidor, e **Permitir pelo resto desta tarefa** vale para um repositório.

Cada linha tem duas ações: uma que lê e outra que altera algo, como **Alterar algo no GitHub**.
São elas que seu imediato e sua tripulação usam para consultar coisas ou agir ali além do trabalho da própria tarefa.
O branch de uma tarefa, a solicitação de pull dela, as verificações e a mesclagem seguem os ajustes do seu projeto.

Se outro computador roda trabalho para você, o login do GitHub dele, para clonar e fazer push ali, também tem uma linha aqui.
Veja [Seus outros computadores](/pt-br/your-other-computers/).

Sair do GitHub interrompe clones privados e solicitações de pull até você fazer login de novo.

## Google: Gmail e Agenda {#google-gmail-and-calendar}

O Google é um único login para o Gmail e para a Agenda.
O Infinitary os alcança por uma conexão com o Google que é sua: um cliente que você cria no seu próprio projeto do Google Cloud, no modo pessoal do Google.
O Google não o revisa, não mostra nenhum alerta e não encerra o login dele depois de 7 dias.

1. Aperte **Google**, que abre **Configure sua própria conexão com o Google**.
2. Aperte **Abrir a página do Google** e faça login lá com a conta do Google que você vai conectar.
   Dê um nome ao projeto, aceite a política do Google e aperte Continue.
3. Baixe o arquivo de cliente que o Google mostra, com Download JSON.
4. Solte esse arquivo em **Solte o arquivo de cliente aqui**, escolha-o com **Escolher arquivo** ou cole o conteúdo dele em **Arquivo de cliente**.
5. Aperte **Guardar e fazer login**.
6. Leia **Antes de conectar o Google**: o que o Infinitary usa da sua conta, para onde vai e por quanto tempo fica.
7. Aperte **Aceitar e continuar para o Google**, ou **Cancelar** para não pedir nada ao Google.
8. Termine o login na página do Google no seu navegador, com a conta do Google que criou seu cliente, e permita todas as permissões que ela listar.

O Infinitary guarda a chave secreta do cliente em [Segredos](/pt-br/secrets/) neste computador, e seu imediato e sua tripulação nunca a veem.
Seu cliente só atende a conta do Google que o criou.
Você o configura uma única vez: depois disso, fazer login no Google começa pelo aviso.
Se você deixar uma permissão desmarcada, o Infinitary não guarda nada e você pode fazer login de novo.
Toda vez que você faz login no Google, o aviso aparece primeiro.

A linha do Google diz quando a conexão precisa de você:

- **Configure sua própria conexão**: este login ainda passa por um cliente que o Infinitary compartilha com todos, e que vai ser desativado.
  Ele continua funcionando até lá; aperte **Configurar** para continuar conectado.
- **Para em**, com uma data: seu cliente não está no modo pessoal, então o Google encerra o login dele nessa data.
  Aperte **Configurar de novo** e crie um cliente no modo pessoal.
- **Seu cliente do Google parou**: o Google não aceita mais seu cliente, talvez porque ele foi excluído no Google Cloud.
  Aperte **Configurar de novo**.

No seu iPhone ou iPad, a configuração pela linha do Google é feita do mesmo jeito: você escolhe o arquivo de cliente ou cola o conteúdo dele.

Com o Google conectado, seu imediato e sua tripulação podem buscar e ler seus e-mails, salvar um anexo na pasta de uma tarefa, marcar ou arquivar uma mensagem, escrever um rascunho e enviar uma mensagem.
Na Agenda, eles podem listar suas agendas e eventos, ler um evento, ver quando você está ocupado e criar ou atualizar um evento.
Nenhuma ação exclui um evento da agenda.

O que seu imediato e sua tripulação leem fica nas conversas salvas deles por 30 dias.
Depois, uma nota toma o lugar disso.
Para excluir antes, aperte **Excluir** na linha **Excluir conteúdo do Gmail e da Agenda**, em **Dados**, no fim da aba.
Um anexo salvo fica na pasta da tarefa até a tarefa ser encerrada ou até passarem 30 dias.
As palavras que um tripulante leu dentro de um anexo salvo ficam na conversa dele depois dos 30 dias.
O que seu imediato e sua tripulação escreveram eles mesmos, em cartões, notas e arquivos, fica até você excluir a tarefa.
Remover o Google não exclui nada do que eles já leram.

Qualquer pessoa pode enviar a você palavras escritas para manipular uma IA.
O Infinitary entrega seus e-mails e eventos ao seu imediato e à sua tripulação marcados como informação de fora, nunca como instruções.
Mesmo assim, uma mensagem pode enganar um modelo de IA.
Um tripulante pode acessar a internet sem perguntar a você, então um tripulante enganado poderia enviar para outro lugar o que leu.

## Servidores MCP {#mcp-servers}

Um servidor MCP é um programa ou um endereço da web que oferece ações para apps de IA.

1. Aperte **Servidor MCP**.
2. Dê a ele um **Nome**.
3. Em **Executa**, digite um programa e os argumentos dele, ou o endereço https do servidor.
4. Aperte **Conectar**.

Um programa é iniciado neste computador quando alguém o usa.
O Infinitary se conecta na hora e abre a nova linha na lista de ações do próprio servidor.
Se não conseguir se conectar, o formulário diz por quê.

Se o servidor precisar de uma chave, coloque-a você mesmo no começo da linha **Executa**, como `EXAMPLE_KEY=your-key npx -y @example/mcp-server`.
O Infinitary move a chave para [Segredos](/pt-br/secrets/), e a linha guarda só uma referência a ela.
O servidor recebe a chave toda vez que é iniciado, sem perguntar a você.
Seu imediato e sua tripulação nunca a veem.
Remover o servidor esquece as chaves dele.

### Um servidor que pede login {#a-server-that-asks-you-to-sign-in}

Alguns servidores que ficam em um endereço pedem um login, não uma chave.
Para esses, **Conectar** abre a página de login do servidor no seu navegador.
O formulário pede que você termine o login lá e mostra o endereço da página, com **Abrir a página de novo** e **Cancelar**.
Quando você termina no navegador, a nova linha abre nas ações do servidor.
Se você cancelar, o Infinitary não guarda nenhuma linha nem chave.

**Notion** e **Linear**, ao lado de **Servidor MCP**, conectam esses dois serviços com um único clique.

O Infinitary guarda o login em [Segredos](/pt-br/secrets/) e o renova sozinho.
Quando o serviço o encerra, a linha diz **precisa fazer login de novo**, com **Fazer login de novo** na linha e no menu dela.
Fazer login de novo mantém o botão de cada ação como estava e volta todas as ações para **Pergunta a você**.
Remover o servidor esquece o login e o encerra no serviço, quando o serviço permite isso.
Um servidor que precisa de um app seu ainda não pode ser conectado, e o formulário avisa isso.

Seu imediato não pode abrir seu navegador.
Para um servidor que pede login, ele traz um cartão com **Abrir Integrações**, que abre o formulário já preenchido.
O que um servidor em um endereço responde chega ao seu imediato e à sua tripulação marcado como informação de fora, nunca como instruções.

## O que cada ação pode fazer sem perguntar a você {#what-each-action-may-do-without-asking-you}

Uma linha aberta lista cada ação com o que ela faz: **lê**, **altera** ou **envia**.
Toda ação começa em **Pergunta a você**, inclusive as leituras.
Aperte a regra dela para alternar entre **Pergunta a você** e **Sempre permitida**.
Só você pode mudar uma regra.
A chave ao lado de uma ação a desativa, e aí ninguém pode executá-la.

Quando seu imediato ou um tripulante usa uma ação que pergunta a você, o Infinitary mostra um cartão de aprovação próprio.
O cartão mostra exatamente o que seria executado e o motivo informado.

- **Sempre permitir** a executa, e a partir daí essa ação roda sem perguntar até você mudá-la em Ajustes, substituir a conexão ou a ação mudar.
- **Permitir pelo resto desta tarefa**, quando um tripulante pergunta, a executa e deixa esse tripulante executar a mesma ação no mesmo lugar sem perguntar até a tarefa dele ser encerrada.
  O cartão diz qual é o lugar, como um repositório no GitHub ou os destinatários de uma mensagem.
- **Só desta vez** a executa uma vez.
- **Agora não** não executa nada.

Quando um tripulante pergunta várias vezes sobre uma mesma conexão, os pedidos dividem um único cartão, com uma linha para cada um e uma caixa **Permitir** marcada.
Desmarque uma linha, e ela nunca é executada.
Deixar o cartão de lado mantém os pedidos dele esperando.

Se o Infinitary não conseguir saber se uma alteração chegou, ele nunca a envia de novo.
O que uma integração responde é informação para seu imediato e sua tripulação, nunca uma instrução.

Um painel também pode usar as integrações que ele cita.
Os pedidos dele mostram o mesmo cartão, com o nome do painel.
Veja [Painéis](/pt-br/panels/).

## Um tripulante que lê textos que qualquer pessoa pode escrever {#a-crewmate-that-reads-words-anyone-can-write}

Algumas tarefas leem textos que um desconhecido pode ter escrito, como as issues e as solicitações de pull de um projeto público.
Para uma tarefa assim, seu imediato pode iniciar um tripulante que só lê.
Ele não executa programas, não altera arquivos e não tem navegador.
Ele lê só o próprio projeto e páginas públicas da web, e não alcança mais nada no seu computador nem na sua rede privada.
Ele abre uma página da web sem login, só como texto.

Tudo o que ele lê é marcado como texto de fora, nunca como instruções, e o relatório dele ao seu imediato também.
Cada cartão dele diz “Este tripulante lê textos que qualquer pessoa pode escrever, então um link ou pedido neste cartão pode vir de um desconhecido.”

Tudo o que ele quer alterar ou chamar espera a sua decisão, em uma linha marcada de um único cartão de aprovação, como “Permitir estas chamadas?”.
Esse cartão só oferece **Só desta vez** e **Agora não**.
Uma leitura por uma integração só roda sem perguntar quando você definiu essa ação como **Sempre permitida**, e nunca em um servidor MCP.
Uma tarefa que ele propõe a partir de uma issue também espera no cartão, com **Começar agora**, **Guardar para depois** e **Não registrar**.

Enquanto não tem nada seu, ele abre na hora qualquer página pública da web.
Ele passa a ter algo seu depois de ler um projeto que não é público ou a resposta de uma integração.
A partir daí, uma página que a tarefa dele cita continua abrindo na hora.
Qualquer outro endereço espera em uma linha do cartão, “Abrir páginas da web?”, com o endereço completo, porque um endereço pode levar o que ele leu a quem mantém o site.

## O que uma integração pode avisar {#what-an-integration-can-tell}

Algumas conexões avisam quando algo acontece, e uma automação pode esperar por isso.
Uma linha aberta lista esses avisos marcados com **avisa**.

- GitHub: **Uma execução de workflow falha** e **Uma execução de workflow termina**, em um repositório que você indicar.
- Gmail: **Chega uma mensagem**.
- Agenda: **Um evento da agenda muda**.
- Um servidor MCP que ofereça isso: **Um recurso mudou**.

Escolha um em **Quando algo acontece**, em Automação.
Veja [Automação](/pt-br/automation/#when-it-runs).

## O comando Infinitary {#the-infinitary-command}

A caixa **Comando Infinitary** serve para programas que você roda neste computador e para seus próprios agentes de IA.
Com um único comando, eles podem ler e agir sobre seus cartões e tarefas e falar com seu imediato em seu nome.
Um tripulante nunca o recebe.

Ele fica desativado até você ativá-lo.
Depois de ativado, a caixa mostra a linha a executar, com **Copiar**, e **Vincular** oferece um nome mais curto quando possível.
Na primeira vez que você o ativa, ele também ativa uma automação, **Eventos da Caixa de entrada do Infinitary**, para que seu imediato seja avisado de cada nota que um programa envia.
Uma nota é informação, nunca uma instrução.

Desative-o, e o comando responde com um erro, enquanto as notas salvas ficam.
**Excluir notas da Caixa de entrada do Infinitary**, em **Dados**, remove as notas e o desativa.

## Sites privados {#private-sites}

A caixa **Sites privados** lista sites da rede do seu escritório, da sua casa ou da sua VPN que os navegadores das tarefas podem abrir.
A lista vale em todos os seus computadores.
Aperte **Site** para adicionar um, ou **Remover** para tirar um.
Seu imediato nunca adiciona um site por conta própria: ele pergunta a você em um cartão, e só o seu **Permitir** o adiciona.
Veja [O navegador da tripulação](/pt-br/the-crews-browser/#private-sites).

## Próximos passos {#next}

- [Segredos](/pt-br/secrets/)
- [Automação](/pt-br/automation/)
