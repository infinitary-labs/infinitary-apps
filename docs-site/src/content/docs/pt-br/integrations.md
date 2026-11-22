---
source: 2070be28c53de438
title: Integrações
description: Conecte GitHub, GitLab, Bitbucket, Google e servidores MCP para que seu imediato e sua tripulação possam alcançá-los, e escolha o que cada um pode fazer sem perguntar a você.
---

Uma integração é uma conexão com algo fora dos seus projetos, como o GitHub, o Gmail ou um serviço seu.
Cada uma tem o login feito em seu nome.
Seu imediato, sua tripulação, suas automações e seus painéis a alcançam do mesmo jeito, pelo mesmo login e com as mesmas regras.

<img class="picture-dark" src="/pictures/integrations-dark.webp" alt="Ajustes, seção Integrações: um servidor Notes conectado com cada uma das suas leituras e a sua alteração definidas como Pergunta a você ao lado de uma chave ligada, depois botões para adicionar GitHub, Google, um servidor MCP, GitLab ou GitHub Enterprise, o comando Infinitary desligado e uma lista de Sites privados vazia." width="1180" height="709" />
<img class="picture-light" src="/pictures/integrations-light.webp" alt="Ajustes, seção Integrações: um servidor Notes conectado com cada uma das suas leituras e a sua alteração definidas como Pergunta a você ao lado de uma chave ligada, depois botões para adicionar GitHub, Google, um servidor MCP, GitLab ou GitHub Enterprise, o comando Infinitary desligado e uma lista de Sites privados vazia." width="1180" height="709" />

## Onde ficam as integrações {#where-integrations-live}

Abra **Ajustes** e depois **Integrações**.
Você também pode buscar **Abrir Integrações** na busca de comandos.

Cada linha é uma conexão.
Ela mostra o nome da conexão, com qual login ela está ou o que ela roda, e quantas das suas ações estão ativadas.
Abra uma linha para ver as ações dela e o que ela pode avisar às suas automações.

O menu no fim de uma linha tem:

- **Verificar agora**, que verifica se a conexão ainda funciona.
- **Pausar**: ninguém a alcança até você a **Retomar**.
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

1. Aperte **Google**.
2. Leia **Antes de conectar o Google**: o que o Infinitary usa da sua conta, para onde vai e por quanto tempo fica.
3. Aperte **Aceitar e continuar para o Google**, ou **Cancelar** para não pedir nada ao Google.
4. Termine o login na página do Google no seu navegador e permita todas as permissões que ela listar.

Se você deixar uma permissão desmarcada, o Infinitary não guarda nada e você pode fazer login de novo.
Toda vez que você faz login no Google, o aviso aparece primeiro.

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
