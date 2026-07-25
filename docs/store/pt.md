<!-- lang: pt · review: translated (generic Portuguese) + light copy-edit · optional native check before 1.0 · target ≤2500 chars · store long description -->

**Proteja com senha um arquivo pequeno e valioso — e guarde-o onde ele realmente se conserve, ou onde ninguém o encontre.**

O StegoShard transforma um arquivo sensível — a exportação do seu gerenciador de senhas, a frase de recuperação de uma carteira cripto, códigos de backup, chaves privadas, uma nota confidencial — em algo que você pode guardar por anos com segurança. Criptografe-o e então escolha: salve-o como imagens robustas com correção de erros (ou uma página imprimível, ou um único arquivo) que sobrevivem à impressão, à cópia e ao novo download — ou esconda-o, invisível, dentro de uma foto de aparência comum, para que ninguém saiba que ele existe. Ou as duas coisas ao mesmo tempo.

Tudo acontece no seu próprio dispositivo. Nada é enviado, não há conta e funciona offline.

**O que você pode fazer**
- Fazer backup da exportação do seu gerenciador de senhas e guardá-la por anos sem depender de uma nuvem — e imprimi-la para que os dados não se percam se o notebook quebrar.
- Proteger a frase de recuperação de uma carteira cripto — minúscula, insubstituível e sem nenhum mecanismo de recuperação do tipo «esqueci minha senha».
- Imprimir um backup criptografado como PDF de códigos QR e restaurá-lo depois escaneando as páginas com a câmera do celular — mesmo que uma página se perca ou manche.
- Esconder um backup de senha ou chave dentro de uma foto de família deixada no seu álbum, para que até a sua existência fique discreta.
- Espalhar um segredo por várias fotos comuns e iscas — perder algumas não é problema.
- Guardar códigos de recuperação de contas e recuperar o arquivo original byte a byte, mesmo que algumas cópias estejam danificadas.

**Recursos**
- Criptografia com senha; sua chave nunca sai do dispositivo (Argon2id + AES-256-GCM)
- Esconder segredos dentro de fotos comuns — um JPEG continua um JPEG, um PNG continua um PNG
- Correção de erros em várias imagens: perca uma página ou uma foto e ainda recupere
- Exportação para papel / QR imprimível, restaurável por digitalização ou foto do celular
- Salvar no disco como imagens ou um único .zip, ou como um único arquivo cujo conteúdo não pode ser identificado
- Saída de banco de dados isca (.db) e modo Galeria (espalhado entre fotos do dia a dia)
- Três formas de lidar com a chave: embutida, um arquivo de chave separado, ou escondida numa foto
- Medidor de força e gerador de frase-senha, com orientação no primeiro uso
- Funciona no Chrome, Edge e Firefox, além de um app web equivalente sem instalação

**Projetado para a privacidade**
Gratuito e de código aberto (MIT). Sem conta, sem rastreamento, nada sai do seu dispositivo. Seus dados sobrevivem ao app: um app web gratuito e um decodificador independente sempre podem restaurar o seu cofre, e o formato de arquivo é congelado e versionado.

**Observação**
O StegoShard é feito para segredos pequenos, não para backups de discos inteiros. Não há recuperação se você perder a senha — guarde-a com cuidado. Esconder um segredo o torna discreto a um olhar casual; não é uma garantia contra uma análise forense digital profissional. É software em beta.

Código-fonte, documentação e app web: https://github.com/dlamarre-dev/StegoShard
